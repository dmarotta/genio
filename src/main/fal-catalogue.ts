/**
 * The curated game-dev FAL catalogue (resources/fal-catalogue.json) and its
 * live side: FAL's models API (metadata, status, OpenAPI input schema; up to
 * 50 ids per call) and pricing API, cached a day in data/fal/models-cache.json.
 * Entries FAL stops listing are kept and flagged (listed=false). The key is
 * only ever sent to api.fal.ai (it raises the rate limit; pricing needs it).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FalCatalogueEntry, FalModelInfo, FalOutputKind, FalPrice, FalSearchHit } from '@shared/api'
import { inputSchemaFromOpenApi } from '@shared/fal-schema'
import { falErrorMessage, validEndpoint, type FetchFn } from './fal'
import { nowIso, readJson, writeJson } from './util'

export const MODELS_API = 'https://api.fal.ai/v1/models'
export const PRICING_API = 'https://api.fal.ai/v1/models/pricing'
export const openApiUrl = (endpoint: string): string => `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(endpoint)}`
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const BATCH = 50

export interface CatalogueFile {
  schema: string
  checked?: string
  jobs: { id: string; label: string }[]
  entries: FalCatalogueEntry[]
}

/** <world>/.genio/fal/catalogue.json: per-world additions and hidden entries. */
export interface WorldCatalogue {
  add?: FalCatalogueEntry[]
  hide?: string[]
}

const KINDS: FalOutputKind[] = ['image', 'audio', 'video', 'model', 'other']
const TIERS = ['core', 'alt', 'post']

/** Problems with a catalogue file; [] when it is valid. */
export function validateCatalogue(data: unknown): string[] {
  const errs: string[] = []
  const d = data as Partial<CatalogueFile> | undefined
  if (!d || typeof d !== 'object') return ['not an object']
  if (d.schema !== 'genio.fal-catalogue.v1') errs.push(`unknown schema ${String(d.schema)}`)
  const jobs = new Set((d.jobs ?? []).map((j) => j?.id))
  if (!jobs.size) errs.push('no jobs')
  if (!Array.isArray(d.entries) || !d.entries.length) return [...errs, 'no entries']
  const seen = new Set<string>()
  d.entries.forEach((e, i) => errs.push(...validateEntry(e, jobs).map((m) => `entry ${i} (${e?.endpoint ?? '?'}): ${m}`)))
  for (const e of d.entries) {
    if (seen.has(e.endpoint)) errs.push(`duplicate endpoint ${e.endpoint}`)
    seen.add(e.endpoint)
  }
  return errs
}

export function validateEntry(e: FalCatalogueEntry, jobs: Set<string | undefined>): string[] {
  const errs: string[] = []
  if (!e || typeof e !== 'object') return ['not an object']
  if (typeof e.endpoint !== 'string' || !validEndpoint(e.endpoint)) errs.push('bad endpoint id')
  if (!jobs.has(e.job)) errs.push(`unknown job ${e.job}`)
  if (!TIERS.includes(e.tier)) errs.push(`bad tier ${e.tier}`)
  if (typeof e.label !== 'string' || !e.label.trim()) errs.push('no label')
  if (typeof e.hint !== 'string' || !e.hint.trim() || /\n/.test(e.hint) || e.hint.length > 90) errs.push('hint must be one short line')
  if (!KINDS.includes(e.output)) errs.push(`bad output kind ${e.output}`)
  if (e.accepts !== undefined && !KINDS.includes(e.accepts)) errs.push(`bad accepts kind ${e.accepts}`)
  if (e.pin !== undefined && (!Array.isArray(e.pin) || e.pin.some((k) => typeof k !== 'string'))) errs.push('pin must list field names')
  if (e.hide !== undefined && (!Array.isArray(e.hide) || e.hide.some((k) => typeof k !== 'string'))) errs.push('hide must list field names')
  if (e.defaults !== undefined) {
    if (!e.defaults || typeof e.defaults !== 'object' || Array.isArray(e.defaults)) errs.push('defaults must be an object')
    // a Genio default is shown as an essential, so it has to be pinned
    else for (const k of Object.keys(e.defaults)) if (!e.pin?.includes(k)) errs.push(`default ${k} is not pinned`)
  }
  if (e.price !== undefined && (typeof e.price.unitPrice !== 'number' || e.price.unitPrice < 0 || typeof e.price.unit !== 'string')) errs.push('bad price')
  if (e.unitsPerRun !== undefined && !(typeof e.unitsPerRun === 'number' && e.unitsPerRun > 0)) errs.push('bad unitsPerRun')
  return errs
}

export function loadCatalogueFile(file: string): CatalogueFile {
  const data = readJson<unknown>(file, undefined)
  const errs = validateCatalogue(data)
  if (errs.length) throw new Error(`FAL catalogue ${file} is invalid: ${errs.slice(0, 3).join('; ')}`)
  return data as CatalogueFile
}

/** Built-in entries plus the world's own additions, minus what it hides. */
export function mergeWorldCatalogue(base: CatalogueFile, world: WorldCatalogue | undefined): FalCatalogueEntry[] {
  const hide = new Set(world?.hide ?? [])
  const jobs = new Set(base.jobs.map((j) => j.id))
  const out = base.entries.filter((e) => !hide.has(e.endpoint))
  for (const e of world?.add ?? []) {
    if (validateEntry(e, jobs).length || hide.has(e.endpoint)) continue
    const i = out.findIndex((x) => x.endpoint === e.endpoint)
    const rec = { ...e, fromWorld: true }
    if (i >= 0) out[i] = { ...out[i], ...rec }
    else out.push(rec)
  }
  return out
}

// ---------------------------------------------------------------- API parsing

type Obj = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function listOf(json: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(json)) return json
  const o = (json ?? {}) as Obj
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[]
  return []
}

/** One models-API item → info (schema included when expand=openapi-3.0 was asked). */
export function modelInfoFrom(item: unknown, at = nowIso()): FalModelInfo | undefined {
  const o = (item ?? {}) as Obj
  const endpoint = str(o.endpoint_id)
  if (!endpoint) return undefined
  const m = (o.metadata ?? {}) as Obj
  const status = str(m.status)
  return {
    endpoint,
    name: str(m.display_name),
    category: str(m.category),
    description: str(m.description),
    status,
    // FAL's own listing: a missing status means it is no longer listed
    listed: Boolean(status),
    thumbnail: str(m.thumbnail_url),
    license: str(m.license_type),
    schema: o.openapi ? (inputSchemaFromOpenApi(o.openapi, endpoint) as Obj | undefined) : undefined,
    checkedAt: at
  }
}

/** Models API page for the requested ids; ids FAL did not return are flagged unlisted. */
export function parseModels(json: unknown, requested: string[], at = nowIso()): Record<string, FalModelInfo> {
  const out: Record<string, FalModelInfo> = {}
  for (const item of listOf(json, 'models', 'items', 'data')) {
    const info = modelInfoFrom(item, at)
    if (info) out[info.endpoint] = info
  }
  for (const id of requested) if (!out[id]) out[id] = { endpoint: id, listed: false, checkedAt: at }
  return out
}

export function parsePrices(json: unknown): Record<string, FalPrice> {
  const out: Record<string, FalPrice> = {}
  for (const item of listOf(json, 'prices', 'items', 'data')) {
    const o = (item ?? {}) as Obj
    const id = str(o.endpoint_id)
    const unitPrice = typeof o.unit_price === 'number' ? o.unit_price : Number(o.unit_price)
    const unit = str(o.unit)
    if (id && unit && Number.isFinite(unitPrice)) out[id] = { unitPrice, unit, currency: str(o.currency) }
  }
  return out
}

export function parseSearch(json: unknown): FalSearchHit[] {
  return listOf(json, 'models', 'items', 'data')
    .map((x) => modelInfoFrom(x))
    .filter((m): m is FalModelInfo => !!m && m.listed !== false)
    .map((m) => ({ endpoint: m.endpoint, name: m.name ?? m.endpoint, category: m.category, description: m.description, thumbnail: m.thumbnail }))
}

// ---------------------------------------------------------------- cache

interface CacheFile {
  modelsAt?: string
  pricesAt?: string
  error?: string
  models: Record<string, FalModelInfo>
}

export class FalModelCache {
  readonly file: string
  private refreshing: Promise<void> | null = null

  constructor(
    dir: string,
    private readonly fetchFn: FetchFn,
    private readonly key: () => string | undefined,
    private readonly ttl = CACHE_TTL_MS
  ) {
    this.file = path.join(dir, 'models-cache.json')
  }

  read(): CacheFile {
    const c = readJson<CacheFile>(this.file, { models: {} })
    return c && typeof c === 'object' && c.models && typeof c.models === 'object' ? c : { models: {} }
  }

  private write(c: CacheFile): void {
    writeJson(this.file, c)
  }

  get isRefreshing(): boolean {
    return this.refreshing !== null
  }

  /** a day old, or an id was never fetched */
  stale(ids: string[], now = Date.now()): boolean {
    const c = this.read()
    if (!c.modelsAt || now - new Date(c.modelsAt).getTime() > this.ttl) return true
    return ids.some((id) => !c.models[id])
  }

  private headers(): Record<string, string> {
    const k = this.key()
    return { Accept: 'application/json', ...(k ? { Authorization: `Key ${k}` } : {}) }
  }

  private async getJson(url: string, withKey: boolean): Promise<unknown> {
    const u = new URL(url)
    // the key only ever goes to FAL's API host
    const auth = withKey && u.protocol === 'https:' && u.hostname === 'api.fal.ai'
    const res = await this.fetchFn(url, { headers: auth ? this.headers() : { Accept: 'application/json' } })
    const text = await res.text()
    if (res.status === 429) throw new Error('FAL rate-limited the catalogue refresh; showing cached data.')
    if (!res.ok) throw new Error(falErrorMessage(res.status, text))
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('FAL returned a response that is not JSON.')
    }
  }

  /** Batched metadata + schema, then prices. Keeps what it had on failure. One refresh at a time. */
  refresh(ids: string[]): Promise<void> {
    this.refreshing ??= this.doRefresh(ids).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(ids: string[]): Promise<void> {
    const c = this.read()
    const at = nowIso()
    const unique = [...new Set(ids)].filter(validEndpoint)
    try {
      for (let i = 0; i < unique.length; i += BATCH) {
        const chunk = unique.slice(i, i + BATCH)
        const q = chunk.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join('&')
        const got = parseModels(await this.getJson(`${MODELS_API}?${q}&expand=openapi-3.0`, true), chunk, at)
        for (const [id, info] of Object.entries(got)) {
          const prev = c.models[id]
          c.models[id] = { ...info, schema: info.schema ?? prev?.schema, price: prev?.price }
        }
      }
      c.modelsAt = at
      c.error = undefined
      if (this.key()) {
        for (let i = 0; i < unique.length; i += BATCH) {
          const chunk = unique.slice(i, i + BATCH)
          const q = chunk.map((id) => `endpoint_id=${encodeURIComponent(id)}`).join('&')
          const prices = parsePrices(await this.getJson(`${PRICING_API}?${q}`, true))
          for (const [id, p] of Object.entries(prices)) if (c.models[id]) c.models[id].price = p
        }
        c.pricesAt = at
      }
    } catch (e) {
      c.error = e instanceof Error ? e.message : String(e)
    }
    this.write(c)
  }

  /** One endpoint with its input schema: cached, else the batched API, else the single OpenAPI doc. */
  async model(endpoint: string, now = Date.now()): Promise<FalModelInfo> {
    if (!validEndpoint(endpoint)) throw new Error(`Not a FAL endpoint id: ${endpoint}`)
    const c = this.read()
    const hit = c.models[endpoint]
    if (hit?.schema && now - new Date(hit.checkedAt).getTime() < this.ttl) return hit
    let info: FalModelInfo = hit ?? { endpoint, checkedAt: nowIso() }
    try {
      const got = parseModels(await this.getJson(`${MODELS_API}?endpoint_id=${encodeURIComponent(endpoint)}&expand=openapi-3.0`, true), [endpoint])
      info = { ...got[endpoint], price: hit?.price, schema: got[endpoint].schema ?? hit?.schema }
    } catch {
      /* fall through to the per-endpoint document */
    }
    if (!info.schema) {
      // unlisted endpoints (e.g. a retired version) still serve their queue schema here
      const doc = await this.getJson(openApiUrl(endpoint), false)
      const schema = inputSchemaFromOpenApi(doc, endpoint)
      if (!schema) throw new Error(`FAL has no input schema for ${endpoint}.`)
      info = { ...info, schema: schema as Record<string, unknown>, checkedAt: nowIso() }
    }
    const fresh = this.read()
    fresh.models[endpoint] = info
    this.write(fresh)
    return info
  }

  async search(q: string): Promise<FalSearchHit[]> {
    const t = q.trim()
    if (!t) return []
    return parseSearch(await this.getJson(`${MODELS_API}?q=${encodeURIComponent(t)}&status=active&limit=30`, true))
  }
}

export const catalogueFile = (appRoot: string): string => path.join(appRoot, 'resources', 'fal-catalogue.json')
export const hasCatalogue = (appRoot: string): boolean => fs.existsSync(catalogueFile(appRoot))
