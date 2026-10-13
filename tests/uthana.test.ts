import { describe, expect, it } from 'vitest'
import type { FalRun } from '@shared/api'
import {
  estimateUthana, exportFileName, exportProblems, exportQuery, exportWarnings, jobError, jobMotionIds, motionFileUrl, motionOnlyUrl, runStatusOfJob,
  textParamErrors, textParamsFor, uthanaWorldSpend, worldCharacters, type UthanaCharacterRecord, type UthanaRun
} from '@shared/uthana'
import type { FetchFn } from '../src/main/fal'
import { UthanaClient, UthanaError, pollJob } from '../src/main/uthana'

const KEY = 'uth-key-1234abcd:0123456789abcdefWXYZ'
const BASIC = `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`
const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

interface Call {
  url: string
  init?: RequestInit
  body?: { query: string; variables: Record<string, unknown> }
}

/** A fake Uthana: answers GraphQL by operation, records every call. */
function fake(answer: (op: string, vars: Record<string, unknown>, call: Call) => Response | Promise<Response>): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchFn = async (url, init) => {
    const call: Call = { url, init }
    if (typeof init?.body === 'string') call.body = JSON.parse(init.body)
    calls.push(call)
    const op = /(?:query|mutation)\s+(\w+)/.exec(call.body?.query ?? '')?.[1] ?? (init?.body instanceof FormData ? 'upload' : url)
    return answer(op, call.body?.variables ?? {}, call)
  }
  return { fetch, calls }
}

const client = (f: FetchFn): UthanaClient => new UthanaClient(() => KEY, f)
const noSleep = async (): Promise<void> => undefined

describe('Uthana GraphQL client', () => {
  it('posts JSON to uthana.com/graphql with Basic auth (key as user, empty password)', async () => {
    const f = fake(() => json({ data: { __typename: 'Query' } }))
    expect(await client(f.fetch).ping()).toBe(true)
    const [c] = f.calls
    expect(c.url).toBe('https://uthana.com/graphql')
    expect(c.init?.method).toBe('POST')
    const h = c.init?.headers as Record<string, string>
    expect(h.Authorization).toBe(BASIC)
    expect(h['Content-Type']).toBe('application/json')
    expect(c.body).toEqual({ query: '{ __typename }', variables: {} })
  })

  it('maps text-to-motion parameters per model', async () => {
    const f = fake((op) => (op === 'CreateTextToMotion' ? json({ data: { create_text_to_motion: { motion: { id: 'm1', name: 'walk' } } } }) : json({}, 500)))
    const c = client(f.fetch)
    const p = { prompt: 'walk', length: 5, steps: 40, cfg_scale: 2.5, seed: 7, foot_ik: true, retargeting_ik: true }
    expect(await c.textToMotion({ ...p, model: 'text-to-motion-bucmd', characterId: 'cXi2eAP19XwQ' })).toEqual({ id: 'm1', name: 'walk' })
    expect(f.calls[0].body!.variables).toEqual({ ...p, model: 'text-to-motion-bucmd', character_id: 'cXi2eAP19XwQ' })
    // 1.0 has no advanced parameters: they are not sent
    await c.textToMotion({ ...p, model: 'text-to-motion' })
    expect(f.calls[1].body!.variables).toEqual({ prompt: 'walk', model: 'text-to-motion', foot_ik: true })
  })

  it('submits a 3.0 job and polls it to the motion id (result as a JSON string)', async () => {
    const seen: string[] = []
    let polls = 0
    const f = fake((op, vars) => {
      if (op === 'CreateTextToMotionJob') return json({ data: { create_text_to_motion_job: { job: { id: 'j1', status: 'RESERVED', est_processing_time: 42 } } } })
      if (op === 'GetJob') {
        expect(vars).toEqual({ job_id: 'j1' })
        polls++
        const status = ['RESERVED', 'READY', 'FINISHED'][Math.min(polls - 1, 2)]
        return json({ data: { job: { id: 'j1', status, result: status === 'FINISHED' ? JSON.stringify({ result: { id: 'mJOB' } }) : null } } })
      }
      return json({}, 500)
    })
    const c = client(f.fetch)
    const job = await c.textToMotionJob({ prompt: 'jumping jacks', model: 'text-to-motion-3.0', length: 6, rewrite_prompt: false })
    expect(job).toMatchObject({ id: 'j1', status: 'RESERVED', est_processing_time: 42 })
    expect(f.calls[0].body!.variables).toEqual({ prompt: 'jumping jacks', model: 'text-to-motion-3.0', length: 6, rewrite_prompt: false, fast: false })
    const done = await pollJob(c, job.id, { sleep: noSleep, onStatus: (j) => seen.push(j.status) })
    expect(done?.motionIds).toEqual(['mJOB'])
    expect(seen).toEqual(['RESERVED', 'READY', 'FINISHED'])
  })

  it('reports a failed job with its reason, retries transient poll errors and can be stopped', async () => {
    let n = 0
    const f = fake(() => {
      n++
      if (n === 1) return new Response('bad gateway', { status: 502 })
      return json({ data: { job: { id: 'j2', status: 'FAILED', result: { message: 'No person found in the video' } } } })
    })
    await expect(pollJob(client(f.fetch), 'j2', { sleep: noSleep })).rejects.toThrow(/No person found/)
    expect(n).toBe(2)
    const stopped = await pollJob(client(fake(() => json({ data: { job: { id: 'j3', status: 'READY' } } })).fetch), 'j3', { sleep: noSleep, stopped: () => true })
    expect(stopped).toBeUndefined()
  })

  it('turns GraphQL and HTTP errors into messages that never carry the key', async () => {
    const gqlErr = fake(() => json({ errors: [{ message: 'Maximum number of characters reached', extensions: { code: 'LIMIT' } }] }))
    await expect(client(gqlErr.fetch).ping()).rejects.toMatchObject({ message: 'Uthana: Maximum number of characters reached', code: 'LIMIT' })
    const unauthorized = fake(() => new Response(`invalid key ${KEY}`, { status: 401 }))
    const e = (await client(unauthorized.fetch).ping().catch((x) => x)) as UthanaError
    expect(e.message).toMatch(/Settings → Accounts/)
    expect(e.message).not.toContain(KEY)
    // no key: nothing is sent
    const none = fake(() => json({}))
    await expect(new UthanaClient(() => undefined, none.fetch).ping()).rejects.toThrow(/No Uthana key/)
    expect(none.calls).toHaveLength(0)
  })

  it('uploads files with the GraphQL multipart spec', async () => {
    const f = fake(() => json({ data: { create_character: { character: { id: 'cNEW', name: 'Knight' }, auto_rig_confidence: 0.92, message: null } } }))
    const created = await client(f.fetch).createCharacter({ bytes: new Uint8Array([1, 2, 3]), fileName: 'knight.fbx' }, { name: 'Knight', autoRig: true, rerigTarget: 'r15' })
    expect(created).toEqual({ id: 'cNEW', name: 'Knight', autoRigConfidence: 0.92, message: undefined })
    const body = f.calls[0].init!.body as FormData
    const ops = JSON.parse(String(body.get('operations')))
    expect(ops.query).toMatch(/create_character\(/)
    expect(ops.variables).toEqual({ name: 'Knight', auto_rig: true, rerig_target: 'r15', file: null })
    expect(JSON.parse(String(body.get('map')))).toEqual({ '0': ['variables.file'] })
    const file = body.get('0') as File
    expect(file.name).toBe('knight.fbx')
    expect(file.size).toBe(3)
    // multipart: fetch sets the boundary itself
    expect((f.calls[0].init!.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('downloads with the key on uthana.com only, never on a CDN redirect', async () => {
    const auth: Record<string, string | undefined> = {}
    const f: FetchFn = async (url, init) => {
      auth[new URL(url).host] = (init?.headers as Record<string, string>)?.Authorization
      if (url.startsWith('https://uthana.com/')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/signed/motion.fbx?sig=1' } })
      return new Response(new Uint8Array([7, 7, 7]))
    }
    const bytes = await client(f).download(motionFileUrl('cXi2eAP19XwQ', 'm1', 'fbx', { fps: 30 }))
    expect([...bytes]).toEqual([7, 7, 7])
    expect(auth['uthana.com']).toBe(BASIC)
    expect(auth['cdn.example.com']).toBeUndefined()
    await expect(client(f).download('https://evil.example.com/x')).rejects.toThrow(/outside uthana.com/)
  })
})

describe('Uthana export options', () => {
  it('maps every option onto the documented query parameters', () => {
    expect(motionFileUrl('cXi2eAP19XwQ', 'm1', 'fbx')).toBe('https://uthana.com/motion/file/motion_viewer/cXi2eAP19XwQ/m1/fbx/motion.fbx')
    expect(motionFileUrl('cFB7NoFCUCvf', 'm1', 'fbx', { fps: 60, inPlace: true, torsoOnly: true, robloxCompatible: true, speed: 0.5 }, 'Walk Cycle')).toBe(
      'https://uthana.com/motion/file/motion_viewer/cFB7NoFCUCvf/m1/fbx/Walk-Cycle.fbx?fps=60&in_place=true&torso_only=true&roblox_compatible=true&speed_multiplier=0.5'
    )
    expect(exportQuery({ noMesh: 'minimal' })).toBe('?no_mesh=minimal')
    expect(exportQuery({ noMesh: true })).toBe('?no_mesh=true')
    // defaults are left to Uthana
    expect(exportQuery({ inPlace: false, torsoOnly: false, noMesh: false, speed: 1 })).toBe('')
    expect(motionFileUrl('c1', 'm1', 'bvh', { fps: 24 })).toMatch(/\/bvh\/motion\.bvh\?fps=24$/)
    expect(motionOnlyUrl('c1', 'm1', 30)).toBe('https://uthana.com/motion/animation/motion_viewer/c1/m1/glb/motion.glb?fps=30')
    expect(() => motionFileUrl('c1/../x', 'm1', 'glb')).toThrow(/Not an Uthana id/)
  })

  it('flags combinations Uthana refuses', () => {
    expect(exportProblems('fbx', { fps: 30, robloxCompatible: true })).toEqual([])
    expect(exportProblems('glb', { robloxCompatible: true })).toEqual(['Roblox-compatible export is FBX only.'])
    expect(exportProblems('bvh', { noMesh: 'minimal', fps: 25, speed: 3 })).toHaveLength(3)
    expect(exportWarnings('fbx', { robloxCompatible: true }, 'cXi2eAP19XwQ')).toHaveLength(1)
    expect(exportWarnings('fbx', { robloxCompatible: true }, 'cFB7NoFCUCvf')).toEqual([])
  })

  it('names files after the motion and the options that change it', () => {
    expect(exportFileName('A person walks, then waves!', 'fbx', { fps: 30, inPlace: true })).toBe('a-person-walks-then-waves-30fps-inplace.fbx')
    expect(exportFileName(undefined, 'glb', {})).toBe('motion.glb')
  })
})

describe('Uthana runs, jobs and spend', () => {
  it('finds motion ids in job results and maps job states', () => {
    expect(jobMotionIds({ result: { id: 'm1' } })).toEqual(['m1'])
    expect(jobMotionIds('{"result":{"id":"m1"}}')).toEqual(['m1'])
    expect(jobMotionIds({ result: { id: 'm1', refined_motion_ids: ['m2', 'm3'] } })).toEqual(['m1', 'm2', 'm3'])
    expect(jobMotionIds({ motion: { id: 'm9' } })).toEqual(['m9'])
    expect(jobMotionIds(null)).toEqual([])
    expect(jobError({ error: 'too short' })).toBe('too short')
    expect(runStatusOfJob('RESERVED')).toBe('queued')
    expect(runStatusOfJob('READY')).toBe('running')
    expect(runStatusOfJob('FINISHED')).toBe('completed')
    expect(runStatusOfJob('FAILED')).toBe('failed')
  })

  it('sends each text model only the parameters it takes', () => {
    const all = { prompt: ' walk ', length: 6, steps: 40, cfg_scale: 2, seed: 3, foot_ik: true, retargeting_ik: true, rewrite_prompt: false, fast: true }
    expect(textParamsFor('text-to-motion', all)).toEqual({ prompt: 'walk', foot_ik: true })
    expect(textParamsFor('text-to-motion-3.0', all)).toEqual({ prompt: 'walk', length: 6, rewrite_prompt: false, fast: true })
    expect(Object.keys(textParamsFor('text-to-motion-bucmd', all)).sort()).toEqual(['cfg_scale', 'foot_ik', 'length', 'prompt', 'retargeting_ik', 'seed', 'steps'])
    // 1.0 picks its own length: a stale length from another model does not change its estimate
    expect(estimateUthana('text-to-motion', { length: 2 })).toMatchObject({ usd: 0.2, upTo: true })
  })

  it('validates text parameters per model', () => {
    expect(textParamErrors('text-to-motion-3.0', { prompt: 'walk', length: 6 })).toEqual({})
    expect(Object.keys(textParamErrors('text-to-motion-3.0', { prompt: ' ', length: 3.5 }))).toEqual(['prompt', 'length'])
    expect(Object.keys(textParamErrors('text-to-motion-bucmd', { prompt: 'x', steps: 151, cfg_scale: -1, seed: 0, length: 0.1 }))).toEqual(['length', 'steps', 'cfg_scale', 'seed'])
  })

  it('estimates from the published per-second rates', () => {
    expect(estimateUthana('text-to-motion-3.0', { length: 6 }).usd).toBeCloseTo(0.6)
    expect(estimateUthana('text-to-motion-3.0').usd).toBeCloseTo(0.8)
    expect(estimateUthana('text-to-motion-bucmd', { length: 4 }).usd).toBeCloseTo(0.12)
    expect(estimateUthana('text-to-motion')).toMatchObject({ usd: 0.2, upTo: true })
    expect(estimateUthana('video-to-motion-2.0', { seconds: 12 }).usd).toBeCloseTo(0.6)
    expect(estimateUthana('video-to-motion-2.1')).toMatchObject({ usd: 3, upTo: true })
    expect(estimateUthana('auto-rig', { autoRig: false }).usd).toBe(0)
  })

  const run = (p: Partial<UthanaRun>): UthanaRun => ({ id: p.id ?? 'r', kind: 'text', model: 'text-to-motion-3.0', input: {}, characterId: 'c1', status: 'completed', files: [], createdAt: new Date().toISOString(), ...p })

  it('keeps characters per world', () => {
    const ch = (id: string, world: string | undefined, createdAt: string): UthanaCharacterRecord => ({ id, name: id, world, createdAt })
    const list = [ch('c1', 'golem', '2026-10-01'), ch('c2', 'golem', '2026-10-05'), ch('c1', 'golem', '2026-09-01'), ch('c3', undefined, '2026-10-02')]
    expect(worldCharacters(list, 'golem').map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(worldCharacters(list, null).map((c) => c.id)).toEqual(['c3'])
  })

  it('counts unsaved runs in the world spend once, measured length first', () => {
    const t = new Date().toISOString()
    const runs = [
      run({ id: 'a', world: 'golem', motionId: 'm1', outputSeconds: 5, estUsd: 0.8 }),
      run({ id: 'b', world: 'golem', motionId: 'm2', estUsd: 0.8 }),
      run({ id: 'c', world: 'golem', status: 'failed', estUsd: 0.8 })
    ]
    const fal: FalRun[] = [{ id: 'f', endpoint: 'x/y', input: {}, status: 'completed', logs: [], outputs: [], costUsd: 0.05, world: 'golem', createdAt: t }]
    expect(uthanaWorldSpend([], fal, runs, 'golem')).toBeCloseTo(0.5 + 0.8 + 0.05)
    // a run already in the ledger is not counted again
    expect(uthanaWorldSpend([{ t, provider: 'uthana', request_id: 'uthana:m1', est_usd: 0.5 }], [], runs, 'golem')).toBeCloseTo(0.5 + 0.8)
  })
})
