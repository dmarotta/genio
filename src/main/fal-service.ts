/**
 * FAL screen backend: runs FAL requests from the main process with the stored
 * key, keeps the history, downloads outputs into Genio's data dir (served to
 * the renderer over genio-media://) and copies them into a world on request.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type {
  FalCatalogue, FalCatalogueEntry, FalOutput, FalRecipe, FalRun, FalRunRequest, FalSaveRequest, FalSaveResult, FalWorldConfig, FalWorldState, OpResult
} from '@shared/api'
import { estimateRun, monthKey, worldSpend } from '@shared/fal'
import { schemaDefaults, type JsonSchema } from '@shared/fal-schema'
import type { Project } from '@shared/types'
import { bus } from './bus'
import { FalClient, extractCost, extractOutputs, inlineData, pollResult, validEndpoint, type FalSubmit, type FetchFn } from './fal'
import { FalModelCache, catalogueFile, loadCatalogueFile, mergeWorldCatalogue, type CatalogueFile } from './fal-catalogue'
import { FalHistory, IN_FLIGHT } from './fal-history'
import {
  appendSpend, genioPath, lfsWarnings, provenanceInput, readRecipesFile, readSpend, readWorldCatalogue, readWorldConfig, sha256File,
  worldRecipesFile, writeProvenance, writeWorldConfig, cleanConfig, ensureGenioDir
} from './fal-world'
import { getSecret } from './secrets'
import type { AppCtx, FalService } from './services'
import { ensureDir, exists, isSubPath, nowIso, readJson, rid, slugify, writeJson } from './util'

export const MEDIA_SCHEME = 'genio-media'
const MAX_DOWNLOAD = 1024 * 1024 * 1024
const MAX_INLINE = 20 * 1024 * 1024
const LOG_KEEP = 40

export const mediaUrl = (runId: string, fileName: string): string => `${MEDIA_SCHEME}://fal/${runId}/${encodeURIComponent(fileName)}`

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A plain file name: no folders, no characters Windows refuses, no leading dots. */
export function safeFileName(name: string, fallback = 'output'): string {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
  return base || fallback
}

/** Absolute target inside a world; throws when it would escape the world or land in .git. */
export function worldTarget(root: string, folder: string, fileName: string): string {
  const name = safeFileName(fileName, '')
  if (!name) throw new Error('The file name is empty.')
  const dir = path.resolve(root, folder.trim().replace(/^[\\/]+/, ''))
  if (!isSubPath(dir, root)) throw new Error('That folder is outside the world.')
  if (path.relative(path.resolve(root), dir).split(/[\\/]/)[0].toLowerCase() === '.git') throw new Error('Refusing to write inside .git.')
  return path.join(dir, name)
}

function uniqueName(name: string, used: Set<string>): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let n = name
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${stem}-${i}${ext}`
  used.add(n.toLowerCase())
  return n
}

function decodeDataUri(uri: string): Buffer {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri)
  if (!m) throw new Error('bad data URI')
  return m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'utf8')
}

/** Fetch one output (no key: FAL's CDN URLs are public) into the run folder. */
export async function downloadOutput(o: FalOutput, dest: string, fetchFn: FetchFn): Promise<{ size: number; contentType?: string }> {
  ensureDir(path.dirname(dest))
  const data = inlineData(o)
  let buf: Buffer
  let contentType = o.contentType
  if (data) buf = decodeDataUri(data)
  else {
    if (!o.url.startsWith('https://')) throw new Error('not an https URL')
    const res = await fetchFn(o.url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_DOWNLOAD) throw new Error('file is larger than 1 GB')
    buf = Buffer.from(await res.arrayBuffer())
    contentType ??= res.headers.get('content-type')?.split(';')[0] || undefined
  }
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, dest)
  return { size: buf.length, contentType }
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.txt': 'text/plain'
}

/** Serve a local output with Range support (video/audio seeking). */
export function mediaResponse(file: string, range: string | null): Response {
  const size = fs.statSync(file).size
  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  }
  const body = (start?: number, end?: number): ReadableStream =>
    Readable.toWeb(fs.createReadStream(file, start === undefined ? undefined : { start, end })) as ReadableStream
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    return new Response(body(start, end), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
  }
  return new Response(body(), { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
}

/** "@file:<absolute path>" strings anywhere in an input → data URIs (what the unit helper's @file: does). */
export function resolveFileRefs(v: unknown): unknown {
  if (typeof v === 'string' && v.startsWith('@file:')) {
    const p = v.slice(6)
    if (!path.isAbsolute(p) || !exists(p)) throw new Error(`Input file not found: ${p}`)
    const size = fs.statSync(p).size
    if (size > MAX_INLINE) throw new Error(`${path.basename(p)} is larger than 20 MB; use a URL instead.`)
    const mime = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
  }
  if (Array.isArray(v)) return v.map(resolveFileRefs)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveFileRefs(x)]))
  return v
}

/** World config defaults become pinned essentials of the matching entries. */
export function applyWorldDefaults(entries: FalCatalogueEntry[], config: FalWorldConfig): FalCatalogueEntry[] {
  const d = config.defaults ?? {}
  return entries.map((e) => {
    const extra = d[e.endpoint]
    if (!extra || typeof extra !== 'object') return e
    return { ...e, defaults: { ...e.defaults, ...extra }, pin: [...new Set([...(e.pin ?? []), ...Object.keys(extra)])] }
  })
}

/** Recipes are shared through the world: never keep machine-local file refs in them. */
function cleanRecipe(r: FalRecipe): FalRecipe {
  const label = String(r.label ?? '').trim()
  if (!label) throw new Error('A recipe needs a name.')
  if (!validEndpoint(String(r.endpoint ?? ''))) throw new Error(`Not a FAL endpoint id: ${r.endpoint}`)
  const input = Object.fromEntries(
    Object.entries(r.input ?? {}).filter(([, v]) => !(typeof v === 'string' && /^(@file:|data:)/.test(v)) && !(Array.isArray(v) && v.some((x) => typeof x === 'string' && /^(@file:|data:)/.test(x))))
  )
  const out: FalRecipe = { id: slugify(r.id || label, 40) || `recipe-${rid(2)}`, label, endpoint: r.endpoint, input }
  if (r.prompt_template) out.prompt_template = r.prompt_template
  if (r.save_to) out.save_to = r.save_to
  if (r.then?.length) out.then = r.then
  return out
}

export function createFalService(getCtx: () => AppCtx, fetchFn: FetchFn = (u, i) => fetch(u, i)): FalService {
  let hist: FalHistory | undefined
  const falDir = (): string => path.join(getCtx().main.home.data, 'fal')
  const history = (): FalHistory => (hist ??= new FalHistory(falDir()))
  const key = (): string | undefined => getSecret('fal', getCtx().main.home.data)
  const client = (): FalClient => new FalClient(key, fetchFn)
  let models: FalModelCache | undefined
  const cache = (): FalModelCache => (models ??= new FalModelCache(falDir(), fetchFn, key))
  let base: CatalogueFile | undefined
  const catalogueBase = (): CatalogueFile => (base ??= loadCatalogueFile(catalogueFile(getCtx().appRoot)))

  const project = (name: string): Project => {
    const p = getCtx().projects.get(name)
    if (!p) throw new Error(`No world named ${name}.`)
    return p
  }
  const scratchRecipes = (): string => path.join(falDir(), 'recipes.json')
  const scratchConfig = (): string => path.join(falDir(), 'scratch-config.json')
  const recipesFile = (world: string | null): string => (world ? worldRecipesFile(project(world).path) : scratchRecipes())
  const configOf = (world: string | null): FalWorldConfig => (world ? readWorldConfig(project(world).path) : readJson<FalWorldConfig>(scratchConfig(), {}))

  const entriesFor = (world: string | null): FalCatalogueEntry[] => {
    const b = catalogueBase()
    if (!world) return b.entries
    const root = project(world).path
    return applyWorldDefaults(mergeWorldCatalogue(b, readWorldCatalogue(root)), readWorldConfig(root))
  }

  /** Estimate from the live (or snapshot) unit price; undefined when FAL bills in units Genio can't count. */
  const estimate = (endpoint: string, input: Record<string, unknown>, world: string | null): number | undefined => {
    try {
      const entry = entriesFor(world).find((e) => e.endpoint === endpoint)
      const info = cache().read().models[endpoint]
      return estimateRun(entry, info?.price ?? entry?.price, input, schemaDefaults(info?.schema as JsonSchema | undefined)).usd
    } catch {
      return undefined
    }
  }
  /** runs being polled in this session */
  const active = new Set<string>()
  /** runs the player cancelled; pollers stop at their next check */
  const stopped = new Set<string>()

  const set = (id: string, patch: Partial<FalRun>): FalRun | undefined => {
    const r = history().update(id, patch)
    if (r) bus.publish({ type: 'fal-run', run: r })
    return r
  }
  const fail = (id: string, error: string): void => {
    set(id, { status: 'failed', error, completedAt: nowIso(), queuePosition: undefined })
  }

  async function fetchOutputs(id: string, outputs: FalOutput[]): Promise<FalOutput[]> {
    const used = new Set<string>()
    const out: FalOutput[] = []
    for (const o of outputs) {
      const name = uniqueName(safeFileName(o.fileName), used)
      const dest = history().filePath(id, name)
      if (!dest) {
        out.push({ ...o, fileName: name, downloadError: 'bad file name' })
        continue
      }
      try {
        const d = await downloadOutput(o, dest, fetchFn)
        out.push({ ...o, fileName: name, localPath: dest, mediaUrl: mediaUrl(id, name), size: o.size ?? d.size, contentType: d.contentType })
      } catch (e) {
        out.push({ ...o, fileName: name, downloadError: errMsg(e) })
      }
    }
    return out
  }

  async function drive(id: string, input?: Record<string, unknown>): Promise<void> {
    if (active.has(id)) return
    active.add(id)
    const c = client()
    try {
      const r = history().get(id)
      if (!r) return
      let sub: FalSubmit
      if (r.requestId && r.statusUrl && r.responseUrl) {
        sub = { requestId: r.requestId, statusUrl: r.statusUrl, responseUrl: r.responseUrl, cancelUrl: r.cancelUrl ?? '' }
      } else if (input) {
        sub = await c.submit(r.endpoint, input)
        const ids = { requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl, cancelUrl: sub.cancelUrl }
        if (stopped.has(id)) {
          // cancelled while submitting: cancel the request FAL just accepted
          await c.cancel(sub.cancelUrl).catch(() => false)
          set(id, { ...ids, status: 'cancelled', completedAt: nowIso() })
          return
        }
        set(id, { ...ids, status: 'queued', queuePosition: sub.queuePosition })
      } else {
        fail(id, 'Interrupted before FAL accepted the request.')
        return
      }
      const result = await pollResult(c, sub, {
        stopped: () => stopped.has(id),
        onStatus: (st) => {
          if (stopped.has(id)) return
          const cur = history().get(id)
          if (!cur) return
          const patch: Partial<FalRun> = {}
          if (st.status === 'IN_QUEUE' && (cur.status !== 'queued' || cur.queuePosition !== st.queuePosition)) {
            patch.status = 'queued'
            patch.queuePosition = st.queuePosition
          }
          if (st.status !== 'IN_QUEUE' && cur.status !== 'running') {
            patch.status = 'running'
            patch.queuePosition = undefined
            patch.startedAt = cur.startedAt ?? nowIso()
          }
          const logs = st.logs.slice(-LOG_KEEP)
          if (logs.length && logs.join('\n') !== cur.logs.join('\n')) patch.logs = logs
          if (Object.keys(patch).length) set(id, patch)
        }
      })
      if (result === undefined || stopped.has(id)) return
      const found = extractOutputs(result)
      set(id, { result, costUsd: extractCost(result) })
      const outputs = await fetchOutputs(id, found)
      set(id, { status: 'completed', outputs, completedAt: nowIso(), queuePosition: undefined })
      bus.publish({ type: 'sfx', sound: 'ready' })
    } catch (e) {
      if (!stopped.has(id)) fail(id, errMsg(e))
    } finally {
      active.delete(id)
      stopped.delete(id)
    }
  }

  const svc: FalService = {
    runs: () => history().list(),

    run(req: FalRunRequest): FalRun {
      const endpoint = req.endpoint.trim().replace(/^https?:\/\/(?:queue\.)?fal\.run\//i, '').replace(/^\/+|\/+$/g, '')
      if (!validEndpoint(endpoint)) throw new Error(`Not a FAL endpoint id: "${req.endpoint}". Use the form owner/app[/path], e.g. fal-ai/flux/dev.`)
      if (!req.input || typeof req.input !== 'object' || Array.isArray(req.input)) throw new Error('Input must be a JSON object.')
      if (!key()) throw new Error('No FAL.ai key set. Add one in Systems → Accounts.')
      const world = req.world?.trim() || undefined
      if (world) project(world)
      // local files go up inline; history keeps the short @file: refs
      const body = resolveFileRefs(req.input) as Record<string, unknown>
      const run: FalRun = {
        id: `fal-${Date.now().toString(36)}-${rid(2)}`,
        endpoint,
        input: req.input,
        status: 'submitting',
        logs: [],
        outputs: [],
        estUsd: estimate(endpoint, req.input, world ?? null),
        world,
        recipe: req.recipe || undefined,
        createdAt: nowIso()
      }
      const rec = history().add(run)
      bus.publish({ type: 'fal-run', run: rec })
      void drive(run.id, body)
      return rec
    },

    catalogue(world: string | null, refresh = false): FalCatalogue {
      const b = catalogueBase()
      const entries = entriesFor(world)
      const ids = [...new Set([...b.entries, ...entries].map((e) => e.endpoint))]
      const c = cache()
      if ((refresh || c.stale(ids)) && !c.isRefreshing) {
        void c.refresh(ids).then(() => bus.publish({ type: 'fal-catalogue' }))
      }
      const data = c.read()
      return { jobs: b.jobs, entries, info: data.models, refreshedAt: data.modelsAt, refreshing: c.isRefreshing, error: data.error }
    },

    model: (endpoint: string) => cache().model(endpoint.trim()),

    search: (q: string) => cache().search(q),

    world(world: string | null): FalWorldState {
      const month = monthKey()
      if (!world) {
        return { world: null, config: configOf(null), recipes: readRecipesFile(scratchRecipes()), spentUsd: worldSpend([], history().list(), null, month), month, hasGenioDir: false }
      }
      const p = project(world)
      return {
        world,
        config: readWorldConfig(p.path),
        recipes: readRecipesFile(worldRecipesFile(p.path)),
        spentUsd: worldSpend(readSpend(p.path), history().list(), world, month),
        month,
        hasGenioDir: exists(genioPath(p.path)),
        engine: p.engine,
        engineRoot: p.engineRoot
      }
    },

    saveWorldConfig(world: string | null, config: FalWorldConfig): FalWorldState {
      if (world) {
        const p = project(world)
        writeWorldConfig(p.path, config, p.engine, p.engineRoot)
      } else writeJson(scratchConfig(), cleanConfig(config))
      return svc.world(world)
    },

    saveRecipe(world: string | null, recipe: FalRecipe): FalRecipe[] {
      const r = cleanRecipe(recipe)
      const file = recipesFile(world)
      if (world) ensureGenioDir(project(world).path, project(world).engine)
      const list = readRecipesFile(file).filter((x) => x.id !== r.id)
      const next = [...list, r]
      writeJson(file, next)
      return next
    },

    deleteRecipe(world: string | null, id: string): FalRecipe[] {
      const file = recipesFile(world)
      const list = readRecipesFile(file)
      const next = list.filter((x) => x.id !== id)
      if (next.length !== list.length) writeJson(file, next)
      return next
    },

    async cancel(id: string): Promise<OpResult> {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (!IN_FLIGHT.has(r.status)) return { ok: false, message: `This run is already ${r.status}.` }
      stopped.add(id)
      if (r.cancelUrl) {
        let accepted: boolean
        try {
          accepted = await client().cancel(r.cancelUrl)
        } catch (e) {
          stopped.delete(id)
          return { ok: false, message: errMsg(e) }
        }
        if (!accepted) {
          stopped.delete(id)
          if (!active.has(id)) void drive(id)
          return { ok: false, message: 'FAL already finished this request; fetching the result.' }
        }
      }
      set(id, { status: 'cancelled', completedAt: nowIso(), queuePosition: undefined })
      return { ok: true, message: 'Run cancelled.' }
    },

    remove(id: string): OpResult {
      const r = history().get(id)
      if (!r) return { ok: false, message: 'No such run.' }
      if (IN_FLIGHT.has(r.status)) return { ok: false, message: 'Cancel the run before deleting it.' }
      history().remove(id)
      return { ok: true, message: 'Run and its files deleted.' }
    },

    async save(req: FalSaveRequest): Promise<FalSaveResult> {
      const r = history().get(req.runId)
      const o = r?.outputs[req.output]
      if (!r || !o) throw new Error('No such output.')
      const proj = project(req.project)
      let src = o.localPath
      if (!src || !exists(src)) {
        // the local copy is missing (download failed or was deleted): fetch it again
        const [again] = await fetchOutputs(r.id, [o])
        if (!again.localPath) return { ok: false, message: `The output could not be downloaded: ${again.downloadError ?? 'unknown error'}` }
        set(r.id, { outputs: r.outputs.map((x, i) => (i === req.output ? again : x)) })
        src = again.localPath
      }
      const target = worldTarget(proj.path, req.folder, req.fileName)
      const rel = path.relative(proj.path, target).replace(/\\/g, '/')
      if (exists(target) && !req.overwrite) return { ok: false, exists: true, path: target, message: `${rel} already exists in ${proj.name}.` }
      ensureDir(path.dirname(target))
      fs.copyFileSync(src, target, req.overwrite ? 0 : fs.constants.COPYFILE_EXCL)

      // provenance + spend line next to the asset, left uncommitted like the asset itself
      const prov = provenanceInput(r.input, proj.path)
      const info = cache().read().models[r.endpoint]
      const entry = (() => {
        try {
          return entriesFor(proj.name).find((e) => e.endpoint === r.endpoint)
        } catch {
          return undefined
        }
      })()
      const price = info?.price ?? entry?.price
      const est = r.costUsd ?? r.estUsd
      const res = (r.result ?? {}) as Record<string, unknown>
      const seed = typeof res.seed === 'number' && r.input.seed === undefined ? res.seed : undefined
      const provenance = writeProvenance(
        proj.path,
        {
          schema: 'genio.provenance.v1',
          path: rel,
          sha256: sha256File(target),
          provider: 'fal',
          endpoint: r.endpoint,
          request_id: r.requestId ?? null,
          input: prov.input,
          ...(seed !== undefined ? { seed } : {}),
          price: { unit: price?.unit ?? null, unit_price_usd: price?.unitPrice ?? null, estimated_usd: est ?? null, checked: (info?.checkedAt ?? nowIso()).slice(0, 10) },
          recipe: r.recipe ?? null,
          derived_from: prov.derivedFrom,
          by: 'player',
          created: r.completedAt ?? r.createdAt
        },
        proj.engine
      )
      appendSpend(
        proj.path,
        { t: r.createdAt, provider: 'fal', endpoint: r.endpoint, request_id: r.requestId ?? null, units: null, unit: price?.unit ?? null, est_usd: est ?? 0, by: 'player' },
        proj.engine
      )
      const warnings = await lfsWarnings(proj.path, rel)
      return { ok: true, path: target, provenance, warnings, message: `Saved to ${proj.name}/${rel}` }
    },

    resume(): void {
      for (const r of history().inFlight()) {
        if (r.requestId && r.statusUrl && r.responseUrl) void drive(r.id)
        else fail(r.id, 'Interrupted before FAL accepted the request (Genio restarted).')
      }
    },

    mediaPath(id: string, fileName: string): string | undefined {
      const p = history().filePath(id, fileName)
      return p && exists(p) ? p : undefined
    }
  }
  return svc
}
