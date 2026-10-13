import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppCtx } from '../src/main/services'
import type { FalRun } from '../src/shared/api'
import { estimateRun } from '../src/shared/fal'
import { fixture, png } from './sprite-fixtures'

vi.mock('../src/main/chat-imagegen', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/chat-imagegen')>(),
  chatImageGen: (ctx: AppCtx) => ({ run: { script: 'mock-script', scratch: path.join(ctx.main.home.data, 'codex-scratch') } })
}))
import { createSpriteService, SPRITE_ENDPOINTS, spritePrompt } from '../src/main/sprites'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-sprite-service-')) })
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const state = { spentUsd: 0, config: { budget: { monthly_usd: .2, confirm_over_usd: .1 }, providers: {} as Record<string, unknown> } }
  const entries = [
    { endpoint: SPRITE_ENDPOINTS.video, price: { unitPrice: .05, unit: 'seconds' } },
    { endpoint: SPRITE_ENDPOINTS.cutout, price: { unitPrice: .0008, unit: 'compute seconds' }, unitsPerRun: 3 },
    { endpoint: SPRITE_ENDPOINTS.pixel, price: { unitPrice: .00017, unit: 'compute seconds' }, unitsPerRun: 10 }
  ]
  const run = vi.fn((req) => ({ id: 'fal-1', ...req, outputs: [], status: 'queued' } as FalRun))
  const model = vi.fn(async (endpoint: string) => ({ price: entries.find(e => e.endpoint === endpoint)?.price }))
  const ctx = { main: { home: { data: dir } }, projects: { get: (world: string) => world === 'garden' ? { name: world, path: path.join(dir, 'world') } : undefined },
    fal: { world: () => state, catalogue: () => ({ entries }), model, run, runs: () => [] }, homes: new Map()
  } as unknown as AppCtx
  return { ctx, state, entries, run, model }
}
describe('sprite provider orchestration (mock providers only)', () => {
  it('prices all directions, background removal and pixel calls, showing world budget reasons', async () => {
    const f = setup(), svc = createSpriteService(() => f.ctx), p = fixture(); p.settings.directions = 4
    const q = await svc.quote(p)
    expect(q.calls).toBe(20)
    expect(q.usd).toBeCloseTo(4 * (.2 + 2 * .0024 + 2 * .0017))
    expect(q.reasons).toHaveLength(2)
    expect(q.breakdown.map(b => b.calls)).toEqual([4, 8, 8])
    expect(f.run).not.toHaveBeenCalled()
  })
  it('requires confirmation before any paid request and consumes each displayed step once', async () => {
    const f = setup(), svc = createSpriteService(() => f.ctx), q = await svc.quote(fixture())
    expect(() => svc.paidStep(q.id, false, 0, png())).toThrow(/Confirm/)
    expect(() => svc.paidStep('fake', true, 0, png())).toThrow(/Confirm/)
    expect(f.run).not.toHaveBeenCalled()
    svc.paidStep(q.id, true, 0, png())
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.run.mock.calls[0][0]).toMatchObject({ endpoint: SPRITE_ENDPOINTS.video, world: 'garden', input: { duration: '4s', resolution: '720p', generate_audio: false } })
    expect(() => svc.paidStep(q.id, true, 0, png())).toThrow(/already submitted/)
    expect(() => svc.paidStep(q.id, true, 2, png())).toThrow(/out of order/)
    svc.paidStep(q.id, true, 1, png())
    expect(f.run.mock.calls[1][0].endpoint).toBe(SPRITE_ENDPOINTS.cutout)
    svc.paidStep(q.id, true, 2, png())
    expect(f.run.mock.calls[2][0].endpoint).toBe(SPRITE_ENDPOINTS.pixel)
  })
  it('requires a new quote if spend changed, the ticket expired, or it was abandoned', async () => {
    vi.useFakeTimers()
    const f = setup(), svc = createSpriteService(() => f.ctx), q = await svc.quote(fixture())
    f.state.spentUsd = 1
    expect(() => svc.paidStep(q.id, true, 0, png())).toThrow(/changed/)
    const fresh = await svc.quote(fixture()); vi.advanceTimersByTime(5 * 60_000 + 1)
    expect(() => svc.paidStep(fresh.id, true, 0, png())).toThrow(/fresh/)
    const abandoned = await svc.quote(fixture()); svc.abandon(abandoned.id)
    expect(() => svc.paidStep(abandoned.id, true, 0, png())).toThrow(/Confirm/)
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not retry uncertain provider submissions and stops after the plan is exhausted', async () => {
    const f = setup(), svc = createSpriteService(() => f.ctx), p = fixture(); p.settings.count = 1; p.settings.style = 'hd'
    const q = await svc.quote(p)
    expect(q.calls).toBe(2)
    f.run.mockImplementationOnce(() => { throw new Error('uncertain submission') })
    expect(() => svc.paidStep(q.id, true, 0, png())).toThrow(/uncertain/)
    expect(() => svc.paidStep(q.id, true, 0, png())).toThrow(/already/)
    svc.paidStep(q.id, true, 1, png())
    expect(() => svc.paidStep(q.id, true, 2, png())).toThrow(/out of order/)
    expect(f.run).toHaveBeenCalledTimes(2)
  })
  it('rejects unknown costs, invalid images and unknown worlds without spending', async () => {
    const f = setup(), svc = createSpriteService(() => f.ctx)
    await expect(svc.quote({ ...fixture(), world: 'missing' })).rejects.toThrow(/No world/)
    const q = await svc.quote(fixture())
    expect(() => svc.paidStep(q.id, true, 0, 'data:image/png;base64,abc')).toThrow(/PNG/)
    f.entries[0].price.unit = 'tokens'
    await expect(svc.quote(fixture())).rejects.toThrow(/No usable price/)
    expect(f.run).not.toHaveBeenCalled()
  })
  it('uses the source and both neighbours for single-frame regeneration with a direction-local phase', async () => {
    const f = setup(), p = fixture(); p.settings.directions = 4; p.settings.count = 3
    p.frames = [0, 0, 0, 1, 1, 1].map((direction, i) => ({ id: `f-${i}`, direction, image: png() }))
    const generate = vi.fn(async (_run, outs: readonly string[], prompt: string, transparent: boolean, refs: readonly string[]) => {
      expect(transparent).toBe(true); expect(refs).toHaveLength(3)
      expect(prompt).toContain('pose 2 of 3'); expect(prompt).toContain('facing west')
      refs.forEach(r => expect(fs.existsSync(r)).toBe(true))
      fs.writeFileSync(outs[0], Buffer.from(png().split(',')[1], 'base64'))
      return { result: { images: [{ out: outs[0], ok: true }] } }
    })
    const svc = createSpriteService(() => f.ctx, generate)
    const result = await svc.codex(p, 'frame', 1, 4)
    expect(result.image).toBe(png()); expect(result.generation.sha256).toMatch(/^[a-f\d]{64}$/)
    expect(f.run).not.toHaveBeenCalled()
  })
  it('respects world opt-out before starting Codex', async () => {
    const f = setup(); f.state.config.providers.codex = { enabled: false }
    const generate = vi.fn(), svc = createSpriteService(() => f.ctx, generate)
    await expect(svc.codex(fixture(), 'source', 0)).rejects.toThrow(/disabled/)
    expect(generate).not.toHaveBeenCalled()
  })
  it('prompts a regular grid and understands FAL duration enum values in persisted cost estimates', () => {
    const p = fixture(); p.settings.count = 8
    expect(spritePrompt(p, 'grid', 0)).toContain('3-column by 3-row')
    expect(spritePrompt(p, 'grid', 0)).toContain('Empty final cells transparent')
    expect(estimateRun(undefined, { unitPrice: .05, unit: 'seconds' }, { duration: '4s' }).usd).toBe(.2)
  })
})
