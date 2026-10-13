import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenioEvent } from '@shared/types'
import type { UthanaRun } from '@shared/uthana'

const secret = vi.hoisted(() => ({ key: 'uth-key-1234abcd:0123456789abcdefWXYZ' as string | undefined }))
vi.mock('../src/main/secrets', () => ({ getSecret: (id: string) => (id === 'uthana' ? secret.key : undefined) }))

import { bus } from '../src/main/bus'
import type { FetchFn } from '../src/main/fal'
import type { AppCtx } from '../src/main/services'
import { createUthanaService, mp4Seconds } from '../src/main/uthana-service'
import { animatedGlb } from './helpers/anim-glb'

let base: string
let world: string
beforeEach(() => {
  secret.key = 'uth-key-1234abcd:0123456789abcdefWXYZ'
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-uthana-'))
  world = path.join(base, 'world')
  fs.mkdirSync(world)
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx = (): AppCtx =>
  ({
    main: { home: { data: path.join(base, 'data') } },
    projects: { get: (n: string) => (n === 'golem' ? { name: 'golem', path: world, engine: 'unity' } : undefined) }
  }) as unknown as AppCtx

const json = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })

/** A fake Uthana that runs one 3.0 job, uploads characters and serves GLB / FBX downloads. */
function uthana(): { fetch: FetchFn; urls: string[]; auth: (string | undefined)[] } {
  const urls: string[] = []
  const auth: (string | undefined)[] = []
  let polls = 0
  const fetch: FetchFn = async (url, init) => {
    urls.push(url)
    auth.push((init?.headers as Record<string, string> | undefined)?.Authorization)
    if (url === 'https://uthana.com/graphql') {
      if (init?.body instanceof FormData) return json({ data: { create_character: { character: { id: 'cKNIGHT', name: 'Knight' }, auto_rig_confidence: 0.9 } } })
      const { query } = JSON.parse(String(init?.body))
      if (/create_text_to_motion_job/.test(query)) return json({ data: { create_text_to_motion_job: { job: { id: 'j1', status: 'RESERVED', est_processing_time: 30 } } } })
      if (/job\(job_id/.test(query)) return json({ data: { job: { id: 'j1', status: ++polls < 2 ? 'READY' : 'FINISHED', result: polls < 2 ? null : { result: { id: 'mDONE' } } } } })
      if (/create_text_to_motion\(/.test(query)) return json({ data: { create_text_to_motion: { motion: { id: 'mSYNC', name: 'wave' } } } })
      throw new Error(`unexpected query ${query}`)
    }
    if (url.startsWith('https://uthana.com/motion/animation/') || /\/glb\//.test(url)) return new Response(animatedGlb())
    if (/\/fbx\//.test(url)) return new Response(Buffer.from('Kaydara FBX Binary  fake'))
    throw new Error(`unexpected ${url}`)
  }
  return { fetch, urls, auth }
}

function settled(id: string, pred: (r: UthanaRun) => boolean = (r) => !['submitting', 'queued', 'running'].includes(r.status)): Promise<UthanaRun> {
  return new Promise((resolve) => {
    const off = bus.onEvent((ev: GenioEvent) => {
      if (ev.type === 'uthana-run' && ev.run.id === id && pred(ev.run)) {
        off()
        resolve(ev.run)
      }
    })
  })
}

describe('Uthana service', () => {
  it('runs a 3.0 job (submit → poll → motion), measures the clip and keeps the history per world', async () => {
    const u = uthana()
    const svc = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const run = svc.generate({ world: 'golem', model: 'text-to-motion-3.0', characterId: 'cXi2eAP19XwQ', characterName: 'Tar', text: { prompt: ' jumping jacks ', length: 6 } })
    expect(run).toMatchObject({ status: 'submitting', world: 'golem', estUsd: expect.closeTo(0.6, 5) })
    const done = await settled(run.id)
    expect(done).toMatchObject({ status: 'completed', jobId: 'j1', motionId: 'mDONE', motionIds: ['mDONE'], input: { prompt: 'jumping jacks', length: 6 } })
    // the free motion-only preview lands right after and gives the real length
    const measured = await settled(run.id, (r) => r.outputSeconds !== undefined)
    expect(measured.outputSeconds).toBe(1)
    expect(measured.files[0]).toMatchObject({ preview: 'skeleton', mediaUrl: `genio-media://uthana/${run.id}/preview-skeleton-mDONE.glb` })
    expect(svc.mediaPath(run.id, 'preview-skeleton-mDONE.glb')).toBe(measured.files[0].localPath)
    expect(u.urls).toContain('https://uthana.com/motion/animation/motion_viewer/cXi2eAP19XwQ/mDONE/glb/motion.glb?fps=30')

    // a Scratch run sits in a separate history
    const sync = svc.generate({ model: 'text-to-motion', characterId: 'cXi2eAP19XwQ', text: { prompt: 'wave' } })
    expect(await settled(sync.id)).toMatchObject({ status: 'completed', motionId: 'mSYNC' })
    const all = svc.runs()
    expect(all.filter((r) => r.world === 'golem').map((r) => r.id)).toEqual([run.id])
    expect(all.filter((r) => !r.world).map((r) => r.id)).toEqual([sync.id])
    // reloaded from disk by a fresh service
    expect(createUthanaService(ctx, u.fetch).runs().map((r) => r.id)).toEqual(all.map((r) => r.id))
    // spend this month: the measured second at $0.10/s, plus the 1.0 run's ceiling in Scratch
    expect(svc.world('golem').spentUsd).toBeCloseTo(0.1)
    await settled(sync.id, (r) => r.outputSeconds !== undefined)
    expect(svc.world(null).spentUsd).toBeCloseTo(0.02)
  })

  it('uploads a character and remembers it for that world only', async () => {
    const u = uthana()
    const svc = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const fbx = path.join(world, 'Art', 'knight.fbx')
    fs.mkdirSync(path.dirname(fbx), { recursive: true })
    fs.writeFileSync(fbx, 'Kaydara FBX Binary  knight')
    expect(() => svc.upload({ world: 'golem', path: path.join(world, 'knight.obj'), name: 'x' })).toThrow(/not found|takes/)
    const run = svc.upload({ world: 'golem', path: fbx, name: '' })
    expect(run).toMatchObject({ kind: 'character', model: 'auto-rig', status: 'running', estUsd: 0.15, estUpTo: true, characterName: 'knight' })
    const done = await settled(run.id)
    expect(done).toMatchObject({ status: 'completed', characterId: 'cKNIGHT', character: { id: 'cKNIGHT', world: 'golem', source: 'Art/knight.fbx', autoRigConfidence: 0.9 } })
    expect(svc.world('golem').characters.map((c) => c.id)).toEqual(['cKNIGHT'])
    expect(svc.world(null).characters).toEqual([])
    expect(svc.forgetCharacter('golem', 'cKNIGHT').characters).toEqual([])
  })

  it('saves an export into the world with provenance and one spend line, never overwriting unasked', async () => {
    const u = uthana()
    const svc = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const run = svc.generate({ world: 'golem', model: 'text-to-motion-3.0', characterId: 'cXi2eAP19XwQ', characterName: 'Tar', text: { prompt: 'jumping jacks' } })
    await settled(run.id, (r) => r.outputSeconds !== undefined)
    expect(svc.world('golem').folder).toBe('Assets/Animations/Generated')
    const req = { runId: run.id, format: 'fbx' as const, options: { fps: 30, inPlace: true }, dest: 'world' as const, project: 'golem', fileName: 'jacks.fbx' }
    const r1 = await svc.saveToWorld(req)
    expect(r1).toMatchObject({ ok: true, provenance: '.genio/provenance/Assets/Animations/Generated/jacks.fbx.json' })
    const target = path.join(world, 'Assets', 'Animations', 'Generated', 'jacks.fbx')
    expect(fs.readFileSync(target, 'utf8')).toContain('Kaydara')
    expect(u.urls.some((x) => x.startsWith('https://uthana.com/motion/file/motion_viewer/cXi2eAP19XwQ/mDONE/fbx/jacks.fbx?fps=30&in_place=true'))).toBe(true)
    const prov = JSON.parse(fs.readFileSync(path.join(world, r1.provenance!), 'utf8'))
    expect(prov).toMatchObject({
      schema: 'genio.provenance.v1',
      path: 'Assets/Animations/Generated/jacks.fbx',
      provider: 'uthana',
      endpoint: 'uthana/text-to-motion-3.0',
      request_id: 'mDONE',
      input: { prompt: 'jumping jacks', character_id: 'cXi2eAP19XwQ', character_name: 'Tar', job_id: 'j1', download: { format: 'fbx', fps: 30, inPlace: true } },
      price: { unit: 'seconds', unit_price_usd: 0.1, estimated_usd: expect.closeTo(0.1, 5) },
      by: 'player'
    })

    // same name again: refused until confirmed
    const r2 = await svc.saveToWorld(req)
    expect(r2).toMatchObject({ ok: false, exists: true })
    expect((await svc.saveToWorld({ ...req, overwrite: true })).ok).toBe(true)
    // a second format of the same run: no second spend line
    await svc.saveToWorld({ ...req, format: 'glb', options: {}, fileName: 'jacks.glb' })
    const spend = fs.readFileSync(path.join(world, '.genio', 'spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(spend).toEqual([expect.objectContaining({ provider: 'uthana', request_id: 'uthana:mDONE', unit: 'seconds', by: 'player' })])
    // exports are cached per options in the run folder: one FBX download for three saves
    expect(u.urls.filter((x) => /\/fbx\//.test(x))).toHaveLength(1)
    // refuses options Uthana would reject before downloading anything
    await expect(svc.saveToWorld({ ...req, format: 'glb', options: { robloxCompatible: true }, fileName: 'r.glb' })).rejects.toThrow(/FBX only/)
  })

  it('never exposes the key: only uthana.com gets it, and no file or state holds it', async () => {
    const u = uthana()
    const svc = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const run = svc.generate({ world: 'golem', model: 'text-to-motion-3.0', characterId: 'cXi2eAP19XwQ', text: { prompt: 'walk' } })
    await settled(run.id, (r) => r.outputSeconds !== undefined)
    u.urls.forEach((x, i) => expect(Boolean(u.auth[i])).toBe(new URL(x).host === 'uthana.com'))
    const state = svc.world('golem')
    expect(state.keySet).toBe(true)
    for (const v of [state, svc.runs()]) expect(JSON.stringify(v)).not.toContain(secret.key)
    for (const p of fs.readdirSync(path.join(base, 'data'), { recursive: true }) as string[]) {
      const full = path.join(base, 'data', p)
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'latin1')).not.toContain(secret.key)
    }
    // without a key nothing runs
    secret.key = undefined
    expect(svc.world('golem').keySet).toBe(false)
    expect(() => svc.generate({ model: 'text-to-motion', characterId: 'cXi2eAP19XwQ', text: { prompt: 'walk' } })).toThrow(/No Uthana key/)
  })

  it('stops waiting on request, resumes jobs after a restart and fails calls that never reached Uthana', async () => {
    const u = uthana()
    const svc = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const run = svc.generate({ model: 'text-to-motion-3.0', characterId: 'cXi2eAP19XwQ', text: { prompt: 'walk' } })
    expect(svc.cancel(run.id)).toMatchObject({ ok: true })
    expect(svc.runs()[0]).toMatchObject({ status: 'cancelled' })
    expect(svc.remove(run.id).ok).toBe(true)

    // a restart: one job in flight, one call that had not answered
    const file = path.join(base, 'data', 'uthana', 'runs.json')
    const t = new Date().toISOString()
    const stale = (id: string, extra: Partial<UthanaRun>): UthanaRun => ({ id, kind: 'text', model: 'text-to-motion-3.0', input: { prompt: 'x' }, characterId: 'c1', status: 'running', files: [], createdAt: t, ...extra })
    fs.writeFileSync(file, JSON.stringify([stale('uth-a', { jobId: 'j1' }), stale('uth-b', {})]))
    const again = createUthanaService(ctx, u.fetch, { pollMs: 1 })
    const resumed = settled('uth-a')
    again.resume()
    expect(again.runs().find((r) => r.id === 'uth-b')).toMatchObject({ status: 'failed' })
    expect(await resumed).toMatchObject({ status: 'completed', motionId: 'mDONE' })
  })

  it('reads a video length from its movie header', () => {
    const b = new Uint8Array(64)
    const dv = new DataView(b.buffer)
    b.set([0x6d, 0x76, 0x68, 0x64], 8) // 'mvhd' at 8, version 0
    dv.setUint32(8 + 16, 600) // timescale
    dv.setUint32(8 + 20, 7200) // duration → 12 s
    expect(mp4Seconds(b)).toBe(12)
    expect(mp4Seconds(new Uint8Array(40))).toBeUndefined()
  })
})
