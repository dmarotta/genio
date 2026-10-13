import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FalRun } from '@shared/api'
import { budgetCheck, estimateRun, filterRuns, worldSpend } from '@shared/fal'
import type { GenioEvent } from '@shared/types'

vi.mock('../src/main/secrets', () => ({ getSecret: () => 'fal-key-world-test' }))

import { bus } from '../src/main/bus'
import { createFalService } from '../src/main/fal-service'
import { appendSpend, ensureGenioDir, provenanceInput, provenancePath, readSpend, readWorldConfig, writeWorldConfig } from '../src/main/fal-world'
import type { FetchFn } from '../src/main/fal'
import type { AppCtx } from '../src/main/services'

let base: string
let world: string
let godot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-falworld-'))
  world = path.join(base, 'golem')
  godot = path.join(base, 'moss')
  fs.mkdirSync(world)
  fs.mkdirSync(godot)
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

const ctx = (): AppCtx =>
  ({
    appRoot: path.join(__dirname, '..'),
    main: { home: { data: path.join(base, 'data') } },
    projects: {
      get: (n: string) => (n === 'golem' ? { name: 'golem', path: world, engine: 'unity' } : n === 'moss' ? { name: 'moss', path: godot, engine: 'godot' } : undefined)
    }
  }) as unknown as AppCtx

const json = (v: unknown): Response => new Response(JSON.stringify(v))
const EP = 'fal-ai/elevenlabs/sound-effects/v2'
const Q = `https://queue.fal.run/fal-ai/elevenlabs/requests/r1`
const fetchFn: FetchFn = async (url) => {
  const u = url.split('?')[0]
  if (u === `https://queue.fal.run/${EP}`) return json({ request_id: 'r1', status_url: `${Q}/status`, response_url: Q, cancel_url: `${Q}/cancel` })
  if (u === `${Q}/status`) return json({ status: 'COMPLETED', logs: [] })
  if (u === Q) return json({ audio: { url: 'https://v3.fal.media/files/x/wind.wav', content_type: 'audio/wav', file_name: 'wind.wav' } })
  if (u === 'https://v3.fal.media/files/x/wind.wav') return new Response(Buffer.from('RIFFwind'), { headers: { 'content-type': 'audio/wav' } })
  if (u.startsWith('https://api.fal.ai/')) return new Response('offline', { status: 503 })
  throw new Error(`unexpected ${url}`)
}

const finished = (id: string): Promise<FalRun> =>
  new Promise((resolve) => {
    const off = bus.onEvent((ev: GenioEvent) => {
      if (ev.type === 'fal-run' && ev.run.id === id && !['submitting', 'queued', 'running'].includes(ev.run.status)) {
        off()
        resolve(ev.run)
      }
    })
  })

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('world-tied runs and Save to world', () => {
  it('tags runs with the world, estimates them, and history filters by world', async () => {
    const svc = createFalService(ctx, fetchFn)
    const a = svc.run({ endpoint: EP, input: { text: 'wind', duration_seconds: 20 }, world: 'golem' })
    await finished(a.id)
    const b = svc.run({ endpoint: EP, input: { text: 'rain', duration_seconds: 5 } })
    await finished(b.id)
    expect(a).toMatchObject({ world: 'golem', estUsd: 0.04 })
    expect(b.world).toBeUndefined()
    const runs = svc.runs()
    expect(filterRuns(runs, 'golem', 'world').map((r) => r.id)).toEqual([a.id])
    expect(filterRuns(runs, null, 'world').map((r) => r.id)).toEqual([b.id])
    expect(filterRuns(runs, 'golem', 'all')).toHaveLength(2)
    expect(() => svc.run({ endpoint: EP, input: { text: 'x' }, world: 'nowhere' })).toThrow(/No world/)
    // nothing was written into the world by running
    expect(fs.readdirSync(world)).toEqual([])
    expect(svc.world('golem').spentUsd).toBeCloseTo(0.04)
  })

  it('writes the asset, its provenance and one spend line on Save, uncommitted, and never touches root git files', async () => {
    git(world, 'init', '-q')
    fs.writeFileSync(path.join(world, '.gitignore'), '/output/\n')
    fs.writeFileSync(path.join(world, '.gitattributes'), '*.png filter=lfs diff=lfs merge=lfs -text\n')
    git(world, 'add', '-A')
    git(world, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    const head = git(world, 'rev-parse', 'HEAD')
    const rootIgnore = fs.readFileSync(path.join(world, '.gitignore'))
    const rootAttrs = fs.readFileSync(path.join(world, '.gitattributes'))

    const svc = createFalService(ctx, fetchFn)
    const input = { text: 'wind', duration_seconds: 20, image_url: `@file:${path.join(world, 'ref', 'a.png')}`, other: '@file:C:/elsewhere/b.png' }
    fs.mkdirSync(path.join(world, 'ref'))
    fs.writeFileSync(path.join(world, 'ref', 'a.png'), 'png')
    fs.mkdirSync(path.join(base, 'elsewhere'))
    const outside = path.join(base, 'elsewhere', 'b.png')
    fs.writeFileSync(outside, 'png')
    const run = svc.run({ endpoint: EP, input: { ...input, other: `@file:${outside}` }, world: 'golem' })
    await finished(run.id)

    const res = await svc.save({ runId: run.id, output: 0, project: 'golem', folder: 'Assets/Audio/Generated', fileName: 'wind.wav' })
    expect(res).toMatchObject({ ok: true, provenance: '.genio/provenance/Assets/Audio/Generated/wind.wav.json' })
    // .wav is not covered by the world's LFS patterns
    expect(res.warnings?.[0]).toMatch(/Git LFS.*\.wav/)

    const prov = JSON.parse(fs.readFileSync(path.join(world, res.provenance!), 'utf8'))
    expect(prov).toMatchObject({
      schema: 'genio.provenance.v1',
      path: 'Assets/Audio/Generated/wind.wav',
      provider: 'fal',
      endpoint: EP,
      request_id: 'r1',
      by: 'player',
      recipe: null,
      price: { estimated_usd: 0.04 }
    })
    expect(prov.sha256).toMatch(/^[0-9a-f]{64}$/)
    // no machine paths in a committed record
    expect(prov.input.image_url).toBe('@file:ref/a.png')
    expect(prov.input.other).toBe('@file:local:b.png')
    expect(JSON.stringify(prov)).not.toContain(base.replace(/\\/g, '\\\\'))
    expect(prov.derived_from).toEqual(['ref/a.png', 'local:b.png'])

    // .genio carries its own ignore/attributes; Unity world: no .gdignore
    expect(fs.readFileSync(path.join(world, '.genio', '.gitignore'), 'utf8')).toBe('cache/\n')
    expect(fs.readFileSync(path.join(world, '.genio', '.gitattributes'), 'utf8')).toBe('*.jsonl merge=union\n')
    expect(fs.existsSync(path.join(world, '.genio', 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(world, '.genio', '.gdignore'))).toBe(false)
    expect(readSpend(world)).toEqual([expect.objectContaining({ provider: 'fal', endpoint: EP, request_id: 'r1', est_usd: 0.04, by: 'player' })])

    // saving a second copy of the same run does not double-count the spend
    await svc.save({ runId: run.id, output: 0, project: 'golem', folder: 'Assets/Audio/Generated', fileName: 'wind-2.wav' })
    expect(readSpend(world)).toHaveLength(1)

    // root files untouched, nothing committed
    expect(fs.readFileSync(path.join(world, '.gitignore'))).toEqual(rootIgnore)
    expect(fs.readFileSync(path.join(world, '.gitattributes'))).toEqual(rootAttrs)
    expect(git(world, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(world, 'status', '--porcelain')).toMatch(/\?\? \.genio\//)
  })

  it('adds .gdignore for Godot worlds and keeps hand-edited config keys', () => {
    ensureGenioDir(godot, 'godot')
    expect(fs.existsSync(path.join(godot, '.genio', '.gdignore'))).toBe(true)
    fs.mkdirSync(path.join(godot, '.genio', 'fal'), { recursive: true })
    fs.writeFileSync(path.join(godot, '.genio', 'fal', 'config.json'), JSON.stringify({ providers: { codex: { enabled: true } }, budget: { monthly_usd: 5 } }))
    writeWorldConfig(godot, { budget: { monthly_usd: 20, confirm_over_usd: 0.5 }, folders: { image: ' assets/gen ' } }, 'godot')
    expect(readWorldConfig(godot)).toEqual({
      schema: 'genio.fal-config.v1',
      providers: { codex: { enabled: true } },
      budget: { monthly_usd: 20, confirm_over_usd: 0.5 },
      folders: { image: 'assets/gen', audio: 'assets/generated/audio', model: 'assets/generated/models', video: 'assets/generated/video', other: 'assets/generated/generated' }
    })
  })

  it('keeps provenance inside .genio/provenance and appends spend lines once per request', () => {
    expect(provenancePath(world, 'a/b.png')).toBe(path.join(world, '.genio', 'provenance', 'a', 'b.png.json'))
    expect(() => provenancePath(world, '../../x.png')).toThrow(/escapes/)
    expect(() => provenancePath(world, '.genio/fal/config.json')).toThrow(/inside \.genio/)
    expect(appendSpend(world, { t: '2026-10-01T00:00:00Z', provider: 'fal', request_id: 'q', est_usd: 1 })).toBe(true)
    expect(appendSpend(world, { t: '2026-10-01T00:00:00Z', provider: 'fal', request_id: 'q', est_usd: 1 })).toBe(false)
    expect(provenanceInput({ a: [`@file:${path.join(world, 'x.png')}`] }, world).input).toEqual({ a: ['@file:x.png'] })
  })
})

describe('budget and cost', () => {
  it('warns and asks above the confirm threshold or the monthly cap, never otherwise', () => {
    expect(budgetCheck(0, 0.04, undefined)).toEqual({ confirm: false, reasons: [] })
    expect(budgetCheck(0, 0.04, { monthly_usd: 20, confirm_over_usd: 0.5 }).confirm).toBe(false)
    const big = budgetCheck(1, 0.8, { monthly_usd: 20, confirm_over_usd: 0.5 }, 'golem')
    expect(big.confirm).toBe(true)
    expect(big.reasons[0]).toMatch(/\$0\.80.*\$0\.50 confirm threshold/)
    const cap = budgetCheck(19.9, 0.2, { monthly_usd: 20 }, 'golem')
    expect(cap.reasons).toEqual(['This run would bring golem to $20.10 of its $20.00 monthly cap.'])
    expect(budgetCheck(21, undefined, { monthly_usd: 20 }, 'golem').reasons[0]).toMatch(/already \$21\.00 of its \$20\.00 cap/)
    // unknown estimate: only the cap that is already reached asks
    expect(budgetCheck(5, undefined, { monthly_usd: 20, confirm_over_usd: 0.1 }).confirm).toBe(false)
  })

  it("sums this month's ledger plus unsaved runs, without double counting", () => {
    const mk = (id: string, p: Partial<FalRun>): FalRun => ({ id, endpoint: EP, input: {}, status: 'completed', logs: [], outputs: [], createdAt: '2026-10-05T10:00:00Z', ...p })
    const lines = [
      { t: '2026-10-02T00:00:00Z', provider: 'fal', request_id: 'r1', est_usd: 0.5, by: 'unit:abc' },
      { t: '2026-09-30T23:00:00Z', provider: 'fal', est_usd: 9, by: 'player' }
    ]
    const runs = [mk('a', { world: 'golem', requestId: 'r1', estUsd: 0.5 }), mk('b', { world: 'golem', estUsd: 0.25 }), mk('c', { world: 'golem', estUsd: 3, status: 'failed' }), mk('d', { estUsd: 7 })]
    expect(worldSpend(lines, runs, 'golem', '2026-10')).toBeCloseTo(0.75)
    expect(worldSpend([], runs, null, '2026-10')).toBeCloseTo(7)
  })

  it('estimates from the unit price and the input, falling back to page prices', () => {
    expect(estimateRun(undefined, { unitPrice: 0.002, unit: 'seconds' }, { duration_seconds: 20 }).usd).toBeCloseTo(0.04)
    expect(estimateRun(undefined, { unitPrice: 0.03, unit: 'images' }, { num_images: 4 }).usd).toBeCloseTo(0.12)
    expect(estimateRun(undefined, { unitPrice: 0.024, unit: 'megapixels' }, { image_size: 'square_hd' }).usd).toBeCloseTo(0.024 * 1.048576)
    expect(estimateRun(undefined, { unitPrice: 0.024, unit: 'megapixels' }, { image_size: { width: 2000, height: 1000 } }).usd).toBeCloseTo(0.048)
    expect(estimateRun(undefined, { unitPrice: 0.6, unit: 'minutes' }, { music_length_ms: 90_000 }).usd).toBeCloseTo(0.9)
    expect(estimateRun(undefined, { unitPrice: 0.08, unit: '1000 characters' }, { text: 'x'.repeat(500) }).usd).toBeCloseTo(0.04)
    expect(estimateRun({ unitsPerRun: 6, pagePrice: '$0.30 at 1024' }, { unitPrice: 0.05, unit: 'units' }, {}).usd).toBeCloseTo(0.3)
    // seconds left empty: FAL's default from the schema counts
    expect(estimateRun(undefined, { unitPrice: 0.112, unit: 'seconds' }, {}, { duration: '5' }).usd).toBeCloseTo(0.56)
    // unknowable: show the page price instead of a number
    expect(estimateRun({ pagePrice: 'unit-billed' }, { unitPrice: 0.01, unit: 'units' }, {})).toEqual({ text: 'unit-billed' })
    expect(estimateRun({ accepts: 'image' }, { unitPrice: 0.001, unit: 'megapixels' }, {}).usd).toBeUndefined()
  })
})
