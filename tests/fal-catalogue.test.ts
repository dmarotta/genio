import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FalModelCache, loadCatalogueFile, mergeWorldCatalogue, parseModels, parsePrices, validateCatalogue } from '../src/main/fal-catalogue'
import { validEndpoint, type FetchFn } from '../src/main/fal'

const FILE = path.join(__dirname, '..', 'resources', 'fal-catalogue.json')

describe('curated catalogue data', () => {
  const cat = loadCatalogueFile(FILE)

  it('is valid and the right size', () => {
    expect(validateCatalogue(cat)).toEqual([])
    expect(cat.entries.length).toBeGreaterThanOrEqual(25)
    expect(cat.entries.length).toBeLessThanOrEqual(40)
    const core = cat.entries.filter((e) => e.tier === 'core')
    expect(core.length).toBeGreaterThanOrEqual(20)
  })

  it('covers every game-dev job with a core pick, each with one-line hints', () => {
    for (const j of cat.jobs) expect(cat.entries.some((e) => e.job === j.id && e.tier === 'core'), j.id).toBe(true)
    for (const e of cat.entries) {
      expect(validEndpoint(e.endpoint), e.endpoint).toBe(true)
      expect(e.hint).not.toMatch(/\n/)
      expect(e.price, e.endpoint).toBeDefined()
    }
    // superseded presets are gone
    for (const old of ['fal-ai/elevenlabs/sound-effects', 'fal-ai/stable-audio', 'fal-ai/ltx-video', 'fal-ai/trellis', 'fal-ai/hunyuan3d/v2']) {
      expect(cat.entries.some((e) => e.endpoint === old)).toBe(false)
    }
  })

  it('rejects broken entries', () => {
    const bad = { ...cat, entries: [...cat.entries, { ...cat.entries[0] }, { ...cat.entries[1], endpoint: 'nope', job: 'x', hint: 'a\nb', defaults: { zz: 1 } }] }
    const errs = validateCatalogue(bad)
    expect(errs.some((e) => /duplicate endpoint/.test(e))).toBe(true)
    expect(errs.some((e) => /bad endpoint id/.test(e))).toBe(true)
    expect(errs.some((e) => /unknown job/.test(e))).toBe(true)
    expect(errs.some((e) => /one short line/.test(e))).toBe(true)
    expect(errs.some((e) => /default zz is not pinned/.test(e))).toBe(true)
  })

  it("merges a world's additions and hidden entries", () => {
    const extra = { endpoint: 'acme/sprite-sheets', job: 'sprites', tier: 'alt' as const, label: 'Acme sheets', hint: 'Walk cycles', output: 'image' as const }
    const out = mergeWorldCatalogue(cat, { add: [extra, { ...extra, endpoint: 'bad id' }], hide: ['fal-ai/flux/schnell'] })
    expect(out.some((e) => e.endpoint === 'fal-ai/flux/schnell')).toBe(false)
    expect(out.find((e) => e.endpoint === 'acme/sprite-sheets')).toMatchObject({ fromWorld: true })
    expect(out.some((e) => e.endpoint === 'bad id')).toBe(false)
  })
})

describe('models and pricing API', () => {
  let dir: string
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-falcat-'))))
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fal', 'fal-ai__elevenlabs__sound-effects__v2.json'), 'utf8'))
  const SFX = 'fal-ai/elevenlabs/sound-effects/v2'
  const OLD = 'fal-ai/elevenlabs/sound-effects'

  it('parses metadata and flags endpoints FAL no longer lists', () => {
    const got = parseModels({ models: [{ endpoint_id: SFX, metadata: { display_name: 'SFX v2', status: 'active', category: 'text-to-audio' }, openapi }] }, [SFX, OLD])
    expect(got[SFX]).toMatchObject({ listed: true, status: 'active', name: 'SFX v2' })
    expect((got[SFX].schema as { required?: string[] }).required).toEqual(['text'])
    expect(got[OLD]).toMatchObject({ listed: false })
    expect(parsePrices({ prices: [{ endpoint_id: SFX, unit_price: 0.002, unit: 'seconds', currency: 'USD' }, { endpoint_id: 'x/y' }] })).toEqual({
      [SFX]: { unitPrice: 0.002, unit: 'seconds', currency: 'USD' }
    })
  })

  it('refreshes in one batched call, caches a day, and only sends the key to api.fal.ai', async () => {
    const calls: { url: string; auth?: string }[] = []
    const fetch: FetchFn = async (url, init) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization })
      if (url.startsWith('https://api.fal.ai/v1/models/pricing')) return new Response(JSON.stringify({ prices: [{ endpoint_id: SFX, unit_price: 0.002, unit: 'seconds' }] }))
      if (url.startsWith('https://api.fal.ai/v1/models?')) return new Response(JSON.stringify({ models: [{ endpoint_id: SFX, metadata: { status: 'active' }, openapi }] }))
      if (url.startsWith('https://fal.ai/api/openapi/queue/openapi.json')) return new Response(JSON.stringify(openapi))
      throw new Error(`unexpected ${url}`)
    }
    const cache = new FalModelCache(dir, fetch, () => 'k-123')
    expect(cache.stale([SFX, OLD])).toBe(true)
    await cache.refresh([SFX, OLD])
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['https://api.fal.ai/v1/models', 'https://api.fal.ai/v1/models/pricing'])
    expect(calls[0].url).toContain(`endpoint_id=${encodeURIComponent(SFX)}&endpoint_id=${encodeURIComponent(OLD)}&expand=openapi-3.0`)
    const c = cache.read()
    expect(c.models[SFX]).toMatchObject({ listed: true, price: { unitPrice: 0.002, unit: 'seconds' } })
    expect(c.models[OLD].listed).toBe(false)
    expect(cache.stale([SFX, OLD])).toBe(false)
    expect(cache.stale([SFX], Date.now() + 25 * 3600_000)).toBe(true)

    // an unlisted endpoint still gets its schema from the per-endpoint OpenAPI doc, without the key
    calls.length = 0
    const m = await cache.model(OLD)
    expect(m.schema).toBeDefined()
    const doc = calls.find((x) => x.url.startsWith('https://fal.ai/'))!
    expect(doc.auth).toBeUndefined()
    for (const x of calls) if (x.auth) expect(new URL(x.url).hostname).toBe('api.fal.ai')
    expect(fs.readFileSync(cache.file, 'utf8')).not.toContain('k-123')
  })

  it('keeps cached data and records the error when FAL rate-limits', async () => {
    const fetch: FetchFn = async () => new Response('slow down', { status: 429 })
    const cache = new FalModelCache(dir, fetch, () => undefined)
    await cache.refresh([SFX])
    expect(cache.read().error).toMatch(/rate-limited/)
  })
})
