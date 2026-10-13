import { describe, expect, it } from 'vitest'
import {
  FalClient, appId, extractCost, extractOutputs, falErrorMessage, inlineData, isFalQueueUrl, outputKind, parseStatus,
  parseSubmit, pollResult, trimForHistory, validEndpoint, type FetchFn
} from '../src/main/fal'

const KEY = 'fal-key-1234abcd:0123456789abcdefWXYZ'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Scripted fetch: each URL (without query) answers from its queue of responses. */
function fakeFetch(routes: Record<string, (Response | (() => Response))[]>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined })
    const q = routes[url.split('?')[0]]
    if (!q?.length) throw new Error(`unexpected fetch ${url}`)
    const r = q.length > 1 ? q.shift()! : q[0]
    return typeof r === 'function' ? r() : r.clone()
  }
  return { fetch, calls }
}

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

const BASE = 'https://queue.fal.run/fal-ai/flux/requests/req-1'
const SUBMIT = {
  request_id: 'req-1',
  status_url: `${BASE}/status`,
  response_url: BASE,
  cancel_url: `${BASE}/cancel`,
  queue_position: 2
}

describe('endpoint and url guards', () => {
  it('accepts FAL endpoint ids and rejects anything else', () => {
    expect(validEndpoint('fal-ai/flux/dev')).toBe(true)
    expect(validEndpoint('fal-ai/stable-audio')).toBe(true)
    expect(validEndpoint('cassetteai/sound-effects-generator')).toBe(true)
    expect(validEndpoint('flux')).toBe(false)
    expect(validEndpoint('fal-ai/../secrets')).toBe(false)
    expect(validEndpoint('https://evil.example/x')).toBe(false)
    expect(validEndpoint('fal-ai/flux dev')).toBe(false)
  })

  it('only treats https fal.run hosts as queue urls', () => {
    expect(isFalQueueUrl('https://queue.fal.run/fal-ai/flux/requests/x')).toBe(true)
    expect(isFalQueueUrl('http://queue.fal.run/x')).toBe(false)
    expect(isFalQueueUrl('https://queue.fal.run.evil.com/x')).toBe(false)
    expect(isFalQueueUrl('https://evil.com/?h=queue.fal.run')).toBe(false)
    expect(isFalQueueUrl('nope')).toBe(false)
  })

  it('derives the app id from an endpoint path', () => {
    expect(appId('fal-ai/flux/dev')).toBe('fal-ai/flux')
    expect(appId('fal-ai/trellis')).toBe('fal-ai/trellis')
  })
})

describe('parsing', () => {
  it('reads the submit response', () => {
    expect(parseSubmit(SUBMIT, 'fal-ai/flux/dev')).toEqual({ requestId: 'req-1', statusUrl: `${BASE}/status`, responseUrl: BASE, cancelUrl: `${BASE}/cancel`, queuePosition: 2 })
  })

  it('builds queue urls from the app id when FAL omits them or returns a foreign host', () => {
    const s = parseSubmit({ request_id: 'abc', status_url: 'https://evil.example/status' }, 'fal-ai/flux/dev')
    expect(s.statusUrl).toBe('https://queue.fal.run/fal-ai/flux/requests/abc/status')
    expect(s.responseUrl).toBe('https://queue.fal.run/fal-ai/flux/requests/abc')
    expect(s.cancelUrl).toBe('https://queue.fal.run/fal-ai/flux/requests/abc/cancel')
    expect(() => parseSubmit({}, 'fal-ai/flux')).toThrow(/request id/)
  })

  it('reads status, queue position, logs and errors', () => {
    expect(parseStatus({ status: 'IN_QUEUE', queue_position: 3 })).toEqual({ status: 'IN_QUEUE', queuePosition: 3, logs: [], error: undefined })
    const p = parseStatus({ status: 'IN_PROGRESS', logs: [{ message: 'step 1', level: 'INFO' }, { message: 'step 2' }, null] })
    expect(p.logs).toEqual(['step 1', 'step 2'])
    expect(parseStatus({ status: 'COMPLETED', error: 'CUDA out of memory' }).error).toBe('CUDA out of memory')
    expect(() => parseStatus({ status: 'WAT' })).toThrow(/Unexpected/)
  })

  it('turns FAL error bodies into readable messages', () => {
    const v = JSON.stringify({ detail: [{ loc: ['body', 'prompt'], msg: 'field required', type: 'missing' }] })
    expect(falErrorMessage(422, v)).toBe('FAL error 422: prompt: field required')
    expect(falErrorMessage(401, JSON.stringify({ detail: 'No user found for Key ID and Secret' }))).toMatch(/rejected the key \(401\).*Settings → Accounts/)
    expect(falErrorMessage(500, 'Internal Server Error')).toBe('FAL error 500: Internal Server Error')
  })
})

describe('FalClient', () => {
  it('submits with the key header only to queue.fal.run, polls, then fetches the result', async () => {
    const result = { images: [{ url: 'https://v3.fal.media/files/a/out.png', content_type: 'image/png', width: 1024, height: 768 }], seed: 42 }
    const { fetch, calls } = fakeFetch({
      'https://queue.fal.run/fal-ai/flux/dev': [json(SUBMIT)],
      [`${BASE}/status`]: [json({ status: 'IN_QUEUE', queue_position: 1 }), json({ status: 'IN_PROGRESS', logs: [{ message: 'denoising' }] }), json({ status: 'COMPLETED' })],
      [BASE]: [json(result)]
    })
    const client = new FalClient(() => KEY, fetch)
    const sub = await client.submit('fal-ai/flux/dev', { prompt: 'a golem' })
    expect(sub.requestId).toBe('req-1')
    const seen: string[] = []
    const out = await pollResult(client, sub, { intervalMs: 0, sleep: async () => undefined, onStatus: (s) => seen.push(s.status) })
    expect(out).toEqual(result)
    expect(seen).toEqual(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'])

    expect(calls[0]).toMatchObject({ url: 'https://queue.fal.run/fal-ai/flux/dev', method: 'POST', body: JSON.stringify({ prompt: 'a golem' }) })
    expect(calls[1].url).toBe(`${BASE}/status?logs=1`)
    for (const c of calls) {
      expect(new URL(c.url).hostname).toBe('queue.fal.run')
      expect(c.headers.Authorization).toBe(`Key ${KEY}`)
    }
  })

  it('surfaces a failed request from the status or the result', async () => {
    const failed = fakeFetch({ [`${BASE}/status`]: [json({ status: 'COMPLETED', error: 'NSFW content detected' })] })
    await expect(pollResult(new FalClient(() => KEY, failed.fetch), parseSubmit(SUBMIT, 'fal-ai/flux'), { sleep: async () => undefined })).rejects.toThrow('NSFW content detected')

    const bad = fakeFetch({
      [`${BASE}/status`]: [json({ status: 'COMPLETED' })],
      [BASE]: [json({ detail: [{ loc: ['body', 'image_url'], msg: 'field required' }] }, 422)]
    })
    await expect(pollResult(new FalClient(() => KEY, bad.fetch), parseSubmit(SUBMIT, 'fal-ai/flux'), { sleep: async () => undefined })).rejects.toThrow('image_url: field required')
  })

  it('stops polling when cancelled and times out', async () => {
    const { fetch, calls } = fakeFetch({ [`${BASE}/status`]: [json({ status: 'IN_QUEUE' })] })
    const client = new FalClient(() => KEY, fetch)
    let n = 0
    expect(await pollResult(client, parseSubmit(SUBMIT, 'fal-ai/flux'), { sleep: async () => undefined, stopped: () => ++n > 2 })).toBeUndefined()
    expect(calls).toHaveLength(2)
    await expect(pollResult(client, parseSubmit(SUBMIT, 'fal-ai/flux'), { sleep: async () => undefined, timeoutMs: -1 })).rejects.toThrow(/Timed out/)
  })

  it('refuses without a key, refuses foreign hosts and never puts the key in errors', async () => {
    const { fetch, calls } = fakeFetch({ 'https://queue.fal.run/fal-ai/flux/dev': [json({ detail: `bad key ${KEY}`.replace(KEY, '***') }, 401)] })
    await expect(new FalClient(() => undefined, fetch).submit('fal-ai/flux/dev', {})).rejects.toThrow(/No FAL.ai key/)
    expect(calls).toHaveLength(0)
    const client = new FalClient(() => KEY, fetch)
    await expect(client.status('https://evil.example/status')).rejects.toThrow(/Refusing/)
    expect(calls).toHaveLength(0)
    const err = await client.submit('fal-ai/flux/dev', {}).catch((e: Error) => e)
    expect(String(err)).toMatch(/rejected the key/)
    expect(String(err)).not.toContain(KEY)
    await expect(client.submit('not an endpoint', {})).rejects.toThrow(/Not a FAL endpoint/)
  })

  it('cancel reports whether FAL accepted it', async () => {
    const ok = fakeFetch({ [`${BASE}/cancel`]: [json({ status: 'CANCELLATION_REQUESTED' }, 202)] })
    expect(await new FalClient(() => KEY, ok.fetch).cancel(`${BASE}/cancel`)).toBe(true)
    expect(ok.calls[0].method).toBe('PUT')
    const late = fakeFetch({ [`${BASE}/cancel`]: [json({ status: 'ALREADY_COMPLETED' }, 400)] })
    expect(await new FalClient(() => KEY, late.fetch).cancel(`${BASE}/cancel`)).toBe(false)
  })
})

describe('outputs', () => {
  it('finds File objects and *_url strings across result shapes', () => {
    const outs = extractOutputs({
      images: [
        { url: 'https://v3.fal.media/files/a/one.png', content_type: 'image/png', width: 512, height: 512 },
        { url: 'https://v3.fal.media/files/a/two.jpg' }
      ],
      audio_file: { url: 'https://v3.fal.media/files/b/sfx.wav', content_type: 'audio/wav', file_name: 'sfx.wav', file_size: 1234 },
      model_mesh: { url: 'https://v3.fal.media/files/c/mesh.glb', content_type: 'application/octet-stream', file_name: 'mesh.glb' },
      video: { url: 'https://v3.fal.media/files/d/clip.mp4' },
      preview_url: 'https://v3.fal.media/files/e/preview.webp',
      seed: 7,
      prompt: 'https://not-a-file-field.example/x.png'
    })
    expect(outs.map((o) => [o.kind, o.field, o.fileName])).toEqual([
      ['image', 'images[0]', 'one.png'],
      ['image', 'images[1]', 'two.jpg'],
      ['audio', 'audio_file', 'sfx.wav'],
      ['model', 'model_mesh', 'mesh.glb'],
      ['video', 'video', 'clip.mp4'],
      ['image', 'preview_url', 'preview.webp']
    ])
    expect(outs[0]).toMatchObject({ width: 512, height: 512, contentType: 'image/png' })
    expect(outs[2].size).toBe(1234)
  })

  it('keeps inline data URIs beside the output, not in it', () => {
    const uri = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
    const [o] = extractOutputs({ images: [{ url: uri }] })
    expect(o).toMatchObject({ kind: 'image', url: '', fileName: 'images-0.png' })
    expect(JSON.stringify(o)).not.toContain('base64')
    expect(inlineData(o)).toBe(uri)
  })

  it('ignores non-https urls and duplicates', () => {
    expect(extractOutputs({ a: { url: 'http://x/y.png' }, b_url: 'file:///etc/passwd', c: [{ url: 'https://h/f.png' }, { url: 'https://h/f.png' }] })).toHaveLength(1)
  })

  it('classifies by content type, then extension', () => {
    expect(outputKind('audio/mpeg', 'x')).toBe('audio')
    expect(outputKind('model/gltf-binary', 'x')).toBe('model')
    expect(outputKind(undefined, 'https://h/a/b.GLB?x=1')).toBe('model')
    expect(outputKind(undefined, 'thing.bin')).toBe('other')
  })

  it('reports cost only when FAL includes one', () => {
    expect(extractCost({ images: [] })).toBeUndefined()
    expect(extractCost({ cost: 0.025 })).toBe(0.025)
    expect(extractCost({ billing: { cost_usd: 0.4 } })).toBe(0.4)
    expect(extractCost('x')).toBeUndefined()
  })

  it('trims long strings for history', () => {
    const t = trimForHistory({ image_url: 'data:' + 'A'.repeat(5000), n: 1, list: ['ok'] }) as Record<string, unknown>
    expect(String(t.image_url).length).toBeLessThan(120)
    expect(t.n).toBe(1)
    expect(t.list).toEqual(['ok'])
  })
})
