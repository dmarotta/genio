import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FalRun } from '@shared/api'
import type { GenioEvent } from '@shared/types'

const secret = vi.hoisted(() => ({ key: 'fal-key-1234abcd:0123456789abcdefWXYZ' as string | undefined }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => secret.key }))

import { bus } from '../src/main/bus'
import { createFalService, mediaResponse, safeFileName, worldTarget } from '../src/main/fal-service'
import type { FetchFn } from '../src/main/fal'
import type { AppCtx } from '../src/main/services'

let base: string
let world: string
beforeEach(() => {
  secret.key = 'fal-key-1234abcd:0123456789abcdefWXYZ'
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-falsvc-'))
  world = path.join(base, 'world')
  fs.mkdirSync(world)
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx = (): AppCtx =>
  ({
    main: { home: { data: path.join(base, 'data') } },
    projects: { get: (n: string) => (n === 'golem' ? { name: 'golem', path: world } : undefined) }
  }) as unknown as AppCtx

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status })
const Q = 'https://queue.fal.run/fal-ai/stable-audio/requests/r1'

function audioFetch(): { fetch: FetchFn; urls: string[]; auth: (string | undefined)[] } {
  const urls: string[] = []
  const auth: (string | undefined)[] = []
  const fetch: FetchFn = async (url, init) => {
    urls.push(url)
    auth.push((init?.headers as Record<string, string> | undefined)?.Authorization)
    const u = url.split('?')[0]
    if (u === 'https://queue.fal.run/fal-ai/stable-audio') return json({ request_id: 'r1', status_url: `${Q}/status`, response_url: Q, cancel_url: `${Q}/cancel` })
    if (u === `${Q}/status`) return json({ status: 'COMPLETED', logs: [{ message: 'done' }] })
    if (u === Q) return json({ audio_file: { url: 'https://v3.fal.media/files/x/boom.wav', content_type: 'audio/wav', file_name: 'boom.wav' } })
    if (u === 'https://v3.fal.media/files/x/boom.wav') return new Response(Buffer.from('RIFFfakewav'), { headers: { 'content-type': 'audio/wav' } })
    throw new Error(`unexpected ${url}`)
  }
  return { fetch, urls, auth }
}

async function finished(id: string): Promise<FalRun> {
  return new Promise((resolve) => {
    const off = bus.onEvent((ev: GenioEvent) => {
      if (ev.type === 'fal-run' && ev.run.id === id && !['submitting', 'queued', 'running'].includes(ev.run.status)) {
        off()
        resolve(ev.run)
      }
    })
  })
}

describe('FAL service', () => {
  it('runs submit → poll → result, downloads outputs without the key, and records history', async () => {
    const f = audioFetch()
    const svc = createFalService(ctx, f.fetch)
    const run = svc.run({ endpoint: ' fal-ai/stable-audio ', input: { prompt: 'explosion', seconds_total: 2 } })
    expect(run.status).toBe('submitting')
    const done = await finished(run.id)
    expect(done.status).toBe('completed')
    expect(done.outputs).toHaveLength(1)
    const o = done.outputs[0]
    expect(o).toMatchObject({ kind: 'audio', fileName: 'boom.wav', mediaUrl: `genio-media://fal/${run.id}/boom.wav`, size: 11 })
    expect(fs.readFileSync(o.localPath!, 'utf8')).toBe('RIFFfakewav')
    expect(svc.mediaPath(run.id, 'boom.wav')).toBe(o.localPath)
    expect(svc.runs()[0]).toMatchObject({ id: run.id, status: 'completed', requestId: 'r1' })

    // the key went only to the queue host; the CDN download carried no Authorization header
    f.urls.forEach((u, i) => expect(Boolean(f.auth[i])).toBe(new URL(u).hostname === 'queue.fal.run'))
    // and never touched disk
    const all = fs.readdirSync(path.join(base, 'data', 'fal'), { recursive: true }) as string[]
    for (const p of all) {
      const full = path.join(base, 'data', 'fal', p)
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8')).not.toContain(secret.key)
    }
  })

  it('refuses without a key and with a bad endpoint', () => {
    const svc = createFalService(ctx, audioFetch().fetch)
    expect(() => svc.run({ endpoint: 'nope', input: {} })).toThrow(/endpoint id/)
    secret.key = undefined
    expect(() => svc.run({ endpoint: 'fal-ai/stable-audio', input: {} })).toThrow(/No FAL.ai key/)
    expect(svc.runs()).toEqual([])
  })

  it('records FAL failures on the run', async () => {
    const fetch: FetchFn = async () => json({ detail: 'User is locked. Reason: Exhausted balance.' }, 403)
    const svc = createFalService(ctx, fetch)
    const run = svc.run({ endpoint: 'fal-ai/flux/dev', input: { prompt: 'x' } })
    const done = await finished(run.id)
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/Exhausted balance/)
    expect(done.error).not.toContain(secret.key!)
  })

  it('saves an output into a world and never overwrites without confirmation', async () => {
    const svc = createFalService(ctx, audioFetch().fetch)
    const run = svc.run({ endpoint: 'fal-ai/stable-audio', input: { prompt: 'explosion' } })
    await finished(run.id)
    const req = { runId: run.id, output: 0, project: 'golem', folder: 'Assets/Audio', fileName: 'boom.wav' }
    const first = await svc.save(req)
    expect(first).toMatchObject({ ok: true, path: path.join(world, 'Assets', 'Audio', 'boom.wav') })
    fs.writeFileSync(first.path!, 'player edits')
    const again = await svc.save(req)
    expect(again).toMatchObject({ ok: false, exists: true })
    expect(fs.readFileSync(first.path!, 'utf8')).toBe('player edits')
    expect(await svc.save({ ...req, overwrite: true })).toMatchObject({ ok: true })
    expect(fs.readFileSync(first.path!, 'utf8')).toBe('RIFFfakewav')
    await expect(svc.save({ ...req, folder: '../outside' })).rejects.toThrow(/outside the world/)
    await expect(svc.save({ ...req, project: 'missing' })).rejects.toThrow(/No world/)
  })

  it('deletes finished runs only', async () => {
    const svc = createFalService(ctx, audioFetch().fetch)
    const run = svc.run({ endpoint: 'fal-ai/stable-audio', input: { prompt: 'x' } })
    expect(svc.remove(run.id).ok).toBe(false)
    const done = await finished(run.id)
    expect(svc.remove(run.id).ok).toBe(true)
    expect(fs.existsSync(done.outputs[0].localPath!)).toBe(false)
    expect(svc.runs()).toEqual([])
  })
})

describe('helpers', () => {
  it('keeps targets inside the world and out of .git', () => {
    expect(worldTarget(world, '', 'a.png')).toBe(path.join(world, 'a.png'))
    expect(worldTarget(world, '/Assets/Art/', 'a.png')).toBe(path.join(world, 'Assets', 'Art', 'a.png'))
    expect(() => worldTarget(world, '..', 'a.png')).toThrow(/outside/)
    expect(() => worldTarget(world, '.git/hooks', 'a.png')).toThrow(/\.git/)
    expect(worldTarget(world, 'x', '../../evil.png')).toBe(path.join(world, 'x', 'evil.png'))
    expect(() => worldTarget(world, 'x', '  ')).toThrow(/empty/)
  })

  it('sanitises file names', () => {
    expect(safeFileName('a/b\\c:d?.png')).toBe('c_d_.png')
    expect(safeFileName('..')).toBe('output')
    expect(safeFileName('.hidden')).toBe('hidden')
  })

  it('serves media with byte ranges', async () => {
    const f = path.join(base, 'clip.mp4')
    fs.writeFileSync(f, '0123456789')
    const full = mediaResponse(f, null)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(await full.text()).toBe('0123456789')
    const part = mediaResponse(f, 'bytes=2-5')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    expect(await mediaResponse(f, 'bytes=-3').text()).toBe('789')
    expect(mediaResponse(f, 'bytes=20-').status).toBe(416)
  })
})
