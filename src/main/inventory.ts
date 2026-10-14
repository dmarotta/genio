import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import type { InventoryAsset, InventoryInfo, InventoryQuery, InventoryResult, InventoryState } from '@shared/inventory'
import { inventoryMediaUrl, NATIVE_THUMB_EXTS, THUMB_MAX_BYTES } from '@shared/inventory'
import { effectiveEngine } from '@shared/engine'
import { assetKind, assetTags, ignoredAssetPath, matchInventory, pageInventory, under, vendorPath, type InventoryMatch } from './inventory-query'
import { INVENTORY_WORKER } from './inventory-worker'
import { bus } from './bus'
import { run } from './util'
import { isRepo } from './git'
import type { AppCtx } from './services'

export interface InventoryService {
  open(world: string): Promise<InventoryState>
  close(world: string): void
  refresh(world: string): Promise<InventoryState>
  list(world: string, query?: InventoryQuery): Promise<InventoryResult>
  info(world: string, asset: string, verifyHash?: boolean): Promise<InventoryInfo | null>
  mediaPath(world: string, asset: string): Promise<string | undefined>
  thumbnail(world: string, asset: string, signal?: AbortSignal): Promise<string | undefined>
  stop(): void
}
export type ThumbnailDecoder = (url: string) => Promise<Buffer | undefined>
type Candidate = InventoryAsset & { sidecar?: string; record?: string; stamp?: string }
type ScanResult = (InventoryAsset & { stamp: string }) | { path: string; same: true } | { path: string; skip: true; stamp: string }
/** Watcher batch: `enumerate` when a path may have appeared or vanished (rename events, ignore/config files). */
interface ChangeBatch { paths: Set<string>; enumerate: boolean }
interface WorldIndex {
  root: string
  assets: Map<string, InventoryAsset>
  /** size:mtime:sidecar-mtime:record-mtime per indexed (or deliberately skipped) path; equal stamps skip all reads. */
  stamps: Map<string, string>
  /** Last enumeration and world config, reused by change-only watcher batches. */
  files?: Map<string, boolean>
  config?: { vendor: string[]; ignore: string[] }
  state: InventoryState
  initialized: boolean
  loading?: Promise<void>
  saving?: Promise<void>
  metadata?: Promise<void>
  refreshing?: Promise<InventoryState>
  refreshFull?: boolean
  watcher?: fs.FSWatcher
  watchError?: string
  open: boolean
  pending: Set<string>
  structural: boolean
  /** Recent sorted query results keyed by revision and filters (LRU). */
  matches: Map<string, InventoryMatch>
  timer?: NodeJS.Timeout
}
const INDEX_VERSION = 2
const SCAN_CHUNK = 256
const yieldLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const STRUCTURAL = /(?:^|\/)(?:\.gitignore|\.gitmodules|\.git)$/

/** Reject ambiguous Windows paths, traversal and hidden/control folders before resolving. */
export function validInventoryPath(rel: string): boolean {
  return !!rel && !/[\\:\x00-\x1f]/.test(rel) && rel.split('/').every(p => !!p && p !== '.' && p !== '..' && !/[. ]$/.test(p))
}
export async function guardedWorldFile(root: string, rel: string, internal = false): Promise<string | undefined> {
  if (!validInventoryPath(rel) || ignoredAssetPath(rel) || !internal && rel.toLowerCase().split('/').includes('.genio')) return
  try {
    const [base, file] = await Promise.all([fsp.realpath(root), fsp.realpath(path.join(root, rel))])
    const resolved = path.relative(base, file).replace(/\\/g, '/')
    if (!validInventoryPath(resolved) || ignoredAssetPath(resolved) || !internal && resolved.toLowerCase().split('/').includes('.genio')) return
    if (!(await fsp.lstat(path.join(root, rel))).isFile() || !(await fsp.stat(file)).isFile()) return
    return file
  } catch { return }
}

/** Git honors ignore rules; ordinary folders use a symlink-free walk with the same cache exclusions. */
export async function enumerateInventory(root: string): Promise<{ files: Map<string, boolean>; ms: number }> {
  const start = performance.now()
  const excludes = ['Library/', 'Temp/', 'Logs/', 'obj/', 'Build/', 'Builds/', 'BuildOutput/', 'UserSettings/', '.godot/', '.import/', 'Intermediate/', 'Saved/', 'DerivedDataCache/', 'Binaries/', 'node_modules/']
  const r = await run('git', ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard', ...excludes.map(x => `--exclude=${x}`)], { cwd: root })
  const files = new Map<string, boolean>()
  if (r.code) {
    if (await isRepo(root)) throw new Error(`Could not read Inventory: ${r.stderr.trim()}`)
    const dirs = ['']
    for (const dir of dirs) {
      const entries = await fsp.opendir(path.join(root, dir))
      for await (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name
        if (!validInventoryPath(rel) || ignoredAssetPath(rel) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) dirs.push(rel)
        else if (entry.isFile()) files.set(rel, false)
      }
    }
    return { files, ms: performance.now() - start }
  }
  const lines = r.stdout.split('\0')
  for (let i = 0; i < lines.length; i++) {
    if (i && i % 5000 === 0) await yieldLoop()
    const p = lines[i].slice(2)
    if (validInventoryPath(p) && !ignoredAssetPath(p)) files.set(p, files.get(p) || lines[i][0] !== '?')
  }
  return { files, ms: performance.now() - start }
}

export function createInventoryService(getCtx: () => AppCtx, decode?: ThumbnailDecoder, thumbCap = 1024 ** 3): InventoryService {
  const worlds = new Map<string, WorldIndex>(), workers = new Set<Worker>()
  const thumbs = new Map<string, { task: Promise<string | undefined>; waiters: (AbortSignal | undefined)[] }>()
  const thumbCaches = new Map<string, Promise<Map<string, { size: number; time: number }>>>()
  let stopped = false, thumbQueue: Promise<unknown> = Promise.resolve()
  /** One-shot worker; with `onChunk`, results stream in pages until the worker reports `done`. */
  const worker = <T>(data: unknown, onChunk?: (items: T) => void): Promise<T> => new Promise((resolve, reject) => {
    if (stopped) return reject(new Error('Inventory stopped'))
    const w = new Worker(INVENTORY_WORKER, { eval: true, workerData: data })
    workers.add(w)
    w.on('message', (m: T | { chunk: T; done?: boolean }) => {
      if (!onChunk) return resolve(m as T)
      const { chunk, done } = m as { chunk: T; done?: boolean }
      try { onChunk(chunk) } catch (e) { reject(e); void w.terminate(); return }
      if (done) resolve(chunk)
    })
    w.once('error', reject)
    w.once('exit', code => { workers.delete(w); if (code) reject(new Error(`Inventory worker exited (${code})`)) })
  })
  const cacheDir = (world: string, kind = 'inventory'): string => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(world)) throw new Error('Invalid project name')
    return path.join(getCtx().main.home.data, kind, world)
  }
  const thumbCache = (dir: string): Promise<Map<string, { size: number; time: number }>> => {
    let cached = thumbCaches.get(dir)
    if (!cached) {
      cached = (async () => {
        const entries = new Map<string, { size: number; time: number }>()
        for (const n of await fsp.readdir(dir).catch(() => [] as string[])) {
          if (!/^[a-f0-9]{64}\.webp$/.test(n)) continue
          const p = path.join(dir, n)
          try { const s = await fsp.stat(p); entries.set(p, { size: s.size, time: s.mtimeMs }) } catch {}
        }
        return entries
      })()
      thumbCaches.set(dir, cached)
    }
    return cached
  }
  const state = (w: WorldIndex): InventoryState => ({ ...w.state, error: w.state.error ?? w.watchError, watching: !!w.watcher, refreshing: !!w.refreshing })
  const publish = (w: WorldIndex): void => { if (!stopped) bus.publish({ type: 'inventory', state: state(w) }) }
  const saveCache = (w: WorldIndex): Promise<void> => {
    w.saving = (w.saving ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (stopped || worlds.get(w.state.world) !== w) return
      const dir = cacheDir(w.state.world)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, 'index.json.tmp'), JSON.stringify({ version: INDEX_VERSION, root: w.root, updatedAt: w.state.updatedAt, assets: [...w.assets.values()], stamps: [...w.stamps] }))
      await fsp.rename(path.join(dir, 'index.json.tmp'), path.join(dir, 'index.json'))
    })
    return w.saving
  }
  const metadata = async (w: WorldIndex, selected?: string): Promise<void> => {
    if (w.metadata) await w.metadata
    const pending = [...w.assets.values()].filter(a => a.meta && !a.meta.loaded && (!selected || selected === a.path))
    if (!pending.length) return
    w.metadata = (async () => {
      const originals = new Map(pending.map(a => [a.path, a]))
      const results = await worker<InventoryAsset[]>({ root: w.root, assets: pending, metadataOnly: true })
      let changed = false
      for (const a of results) if (w.assets.get(a.path) === originals.get(a.path)) { w.assets.set(a.path, a); changed = true }
      if (changed) { w.state.revision++; publish(w); await saveCache(w) }
    })().finally(() => { w.metadata = undefined })
    await w.metadata
  }
  const get = async (world: string): Promise<WorldIndex> => {
    if (stopped) throw new Error('Inventory stopped')
    const proj = getCtx().projects.get(world)
    if (!proj) throw new Error(`No project named ${world}.`)
    const dir = cacheDir(world)
    let w = worlds.get(world)
    if (w && w.root !== proj.path) { close(world); worlds.delete(world); w = undefined }
    if (!w) {
      w = { root: proj.path, assets: new Map(), stamps: new Map(), initialized: false, open: false, pending: new Set(), structural: false, matches: new Map(), state: { world, revision: 0, total: 0, refreshing: false, watching: false } }
      worlds.set(world, w)
      const fresh = w
      fresh.loading = (async () => {
        try {
          const c = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'))
          // Version 1 has no stamps: its assets show at once and the first refresh re-reads them.
          if ((c.version === 1 || c.version === INDEX_VERSION) && c.root === fresh.root && Array.isArray(c.assets)) {
            fresh.assets = new Map(c.assets.filter((a: InventoryAsset) => validInventoryPath(a.path) && !ignoredAssetPath(a.path)).map((a: InventoryAsset) => [a.path, a]))
            if (Array.isArray(c.stamps)) fresh.stamps = new Map(c.stamps.filter((s: unknown) => Array.isArray(s) && typeof s[0] === 'string' && typeof s[1] === 'string'))
            fresh.state = { ...fresh.state, total: fresh.assets.size, updatedAt: c.updatedAt }
            fresh.initialized = true
          }
        } catch { /* absent or obsolete cache */ }
      })()
    }
    await w.loading
    const { engine, root } = effectiveEngine(proj)
    w.state.engine = engine
    w.state.engineRoot = root
    return w
  }
  const readConfig = async (w: WorldIndex, files: Map<string, boolean>): Promise<{ vendor: string[]; ignore: string[] }> => {
    let config: { vendor?: string[]; ignore?: string[] } = {}
    const configPath = await guardedWorldFile(w.root, '.genio/assets.json', true)
    if (configPath) { try { config = JSON.parse(await fsp.readFile(configPath, 'utf8')) } catch {} }
    const paths = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.replace(/\\/g, '/').replace(/\/$/, '')) : []
    const vendor = paths(config?.vendor), ignore = paths(config?.ignore)
    // Conservative pack shape: documentation AND demo/scenes, alongside art.
    const docs = new Set<string>(), demos = new Set<string>()
    for (const p of files.keys()) {
      const m = /^(.*)\/(Documentation|Demo|Scenes)\//i.exec(p)
      if (m) (m[2].toLowerCase() === 'documentation' ? docs : demos).add(m[1])
    }
    vendor.push(...[...docs].filter(p => demos.has(p)))
    return { vendor, ignore }
  }
  /**
   * Full refreshes enumerate with Git and stat-diff every asset; watcher batches only revisit affected paths, and skip
   * Git entirely when no path can have appeared or vanished. Reads happen only for changed stamps, and a refresh that
   * changes nothing keeps the revision, so the screen does not re-query (this also stops access-time watcher echoes).
   */
  const refreshIndex = (w: WorldIndex, batch?: ChangeBatch): Promise<InventoryState> => {
    if (w.refreshing) {
      // An explicit refresh must not settle for a narrower watcher batch that is already running.
      if (!batch && !w.refreshFull) return w.refreshing.catch(() => undefined).then(() => refreshIndex(w))
      return w.refreshing.then(() => state(w))
    }
    w.refreshFull = !batch
    const cold = !w.initialized
    if (cold) w.state.indexing = { done: 0, total: 0 }
    w.refreshing = (async () => {
      const started = performance.now(), enumerate = !batch || batch.enumerate || !w.files || !w.config
      let files = w.files!, config = w.config!, ms = 0
      if (enumerate) {
        ({ files, ms } = await enumerateInventory(w.root))
        config = await readConfig(w, files)
      }
      const changes = batch ? batch.paths : new Set<string>()
      const all = !batch || changes.size > 128 || [...changes].some(p => STRUCTURAL.test(p) || p === '.genio/assets.json')
      const hit = (p: string): boolean => {
        for (let q = p; ; q = q.slice(0, q.lastIndexOf('/'))) { if (changes.has(q)) return true; if (!q.includes('/')) return false }
      }
      const dirty = (p: string): boolean => all || hit(p) || changes.has(p + '.meta') || changes.has(p + '.import') || hit(`.genio/provenance/${p}.json`)
      const candidates = new Map<string, Candidate>(), next = new Map<string, InventoryAsset>(), stamps = new Map<string, string>()
      const candidate = (p: string, tracked: boolean): void => {
        const kind = assetKind(p)
        if (!kind || p.startsWith('.genio/') || config.ignore.some(f => under(p, f))) return
        const prev = w.assets.get(p), vendor = vendorPath(p, config.vendor)
        if (prev && !dirty(p)) {
          next.set(p, prev.tracked === tracked && prev.vendor === vendor ? prev : { ...prev, tracked, vendor })
          const stamp = w.stamps.get(p)
          if (stamp) stamps.set(p, stamp)
          return
        }
        candidates.set(p, { path: p, name: path.posix.basename(p), folder: path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p),
          ext: path.posix.extname(p).slice(1).toLowerCase(), kind, size: 0, mtimeMs: 0, tracked, lfs: false, vendor, tags: assetTags(p, kind), generated: false,
          meta: prev?.meta, stamp: w.stamps.get(p),
          sidecar: files.has(p + '.meta') ? p + '.meta' : files.has(p + '.import') ? p + '.import' : undefined,
          record: files.has(`.genio/provenance/${p}.json`) ? `.genio/provenance/${p}.json` : undefined })
      }
      if (enumerate) {
        let i = 0
        for (const [p, tracked] of files) {
          if (++i % 2000 === 0) await yieldLoop()
          candidate(p, tracked)
        }
      } else {
        // Change-only batch: modifications (or access-time noise) to known paths; nothing can appear or vanish.
        for (const [p, a] of w.assets) next.set(p, a)
        for (const [p, s] of w.stamps) stamps.set(p, s)
        for (const c of changes) {
          const p = c.startsWith('.genio/provenance/') && c.endsWith('.json') ? c.slice(18, -5) : c.replace(/\.(?:meta|import)$/, '')
          for (const q of new Set([c, p])) {
            if (!files.has(q) || !(w.assets.has(q) || w.stamps.has(q))) continue
            next.delete(q); stamps.delete(q); candidate(q, files.get(q)!)
          }
        }
      }
      if (cold) { w.assets = next; w.state.indexing = { done: 0, total: candidates.size } }
      let done = 0, published = performance.now()
      const merge = (items: ScanResult[]): void => {
        if (stopped || worlds.get(w.state.world) !== w) return
        for (const r of items) {
          const c = candidates.get(r.path)
          if (!c) continue
          if ('same' in r) {
            const prev = w.assets.get(r.path)
            if (prev) next.set(r.path, prev.tracked === c.tracked && prev.vendor === c.vendor ? prev : { ...prev, tracked: c.tracked, vendor: c.vendor })
            if (c.stamp) stamps.set(r.path, c.stamp)
          } else if ('skip' in r) stamps.set(r.path, r.stamp)
          else { const { stamp, ...asset } = r; next.set(asset.path, asset); stamps.set(asset.path, stamp) }
        }
        done += items.length
        // A first scan streams into the visible index so the screen fills while it runs.
        if (cold && performance.now() - published > 250) {
          published = performance.now()
          w.state = { ...w.state, total: next.size, revision: w.state.revision + 1, indexing: { done, total: candidates.size } }
          publish(w)
        }
      }
      if (candidates.size) await worker<ScanResult[]>({ root: w.root, assets: [...candidates.values()], chunk: SCAN_CHUNK }, merge)
      if (stopped || worlds.get(w.state.world) !== w) return state(w)
      let changed = cold || next.size !== w.assets.size
      if (!changed) for (const [p, a] of next) if (w.assets.get(p) !== a) { changed = true; break }
      w.files = files; w.config = config; w.stamps = stamps; w.initialized = true
      const timing = { enumerationMs: enumerate ? ms : w.state.enumerationMs, scanMs: performance.now() - started }
      if (changed) {
        w.assets = next
        w.state = { ...w.state, ...timing, total: next.size, revision: w.state.revision + 1, updatedAt: new Date().toISOString(), error: undefined, indexing: undefined }
        await saveCache(w)
      } else w.state = { ...w.state, ...timing, error: undefined, indexing: undefined }
      bus.publish({ type: 'feature-used', feature: 'inventory-index' })
      return state(w)
    })().catch(e => { w.state.error = String((e as Error).message); w.state.indexing = undefined; throw e }).finally(() => {
      w.refreshing = undefined; w.refreshFull = undefined; publish(w)
      if (w.open && w.pending.size) schedule(w)
    })
    publish(w)
    return w.refreshing.then(() => state(w))
  }
  const schedule = (w: WorldIndex): void => {
    if (w.timer || !w.open) return
    w.timer = setTimeout(() => {
      w.timer = undefined
      if (w.refreshing) return // refresh's finally schedules the pending batch
      const paths = new Set(w.pending), enumerate = w.structural
      w.pending.clear(); w.structural = false
      void refreshIndex(w, paths.has('') ? undefined : { paths, enumerate }).catch(() => undefined)
    }, 300)
  }
  const close = (world: string): void => {
    const w = worlds.get(world)
    if (!w) return
    w.open = false; w.watcher?.close(); w.watcher = undefined
    if (w.timer) clearTimeout(w.timer)
    w.timer = undefined; w.pending.clear(); w.structural = false; publish(w)
  }
  /** An open screen reads the partial index while its first scan streams in; other callers wait for a complete index. */
  const ready = async (world: string): Promise<WorldIndex> => {
    const w = await get(world)
    if (!w.initialized && !(w.open && w.refreshing)) await refreshIndex(w)
    return w
  }
  const mediaPath = async (world: string, asset: string): Promise<string | undefined> => {
    const proj = getCtx().projects.get(world)
    if (!proj) return
    return guardedWorldFile(proj.path, asset)
  }
  const thumbnail = async (world: string, asset: string, signal?: AbortSignal): Promise<string | undefined> => {
    const w = await ready(world), a = w.assets.get(asset)
    if (!decode || !a || a.lfs || !NATIVE_THUMB_EXTS.has(a.ext)) return
    const file = await mediaPath(world, asset)
    if (!file) return
    const stat = await fsp.stat(file)
    if (!stat.size || stat.size > THUMB_MAX_BYTES) return
    const key = createHash('sha256').update(`${w.root}\0${asset}\0${stat.size}\0${stat.mtimeMs}`).digest('hex')
    const dir = cacheDir(world, 'thumbs'), dest = path.join(dir, key + '.webp')
    // Cache hits never wait for the one-off cache walk; LRU entries load only when a thumbnail must be written.
    try {
      await fsp.utimes(dest, new Date(), new Date())
      void thumbCaches.get(dir)?.then(entries => { const entry = entries.get(dest); if (entry) entry.time = Date.now() })
      return dest
    } catch { void thumbCaches.get(dir)?.then(entries => entries.delete(dest)) }
    const queued = thumbs.get(dest)
    if (queued) { queued.waiters.push(signal); return queued.task }
    const waiters = [signal]
    const task = thumbQueue.then(async () => {
      // Requests for tiles scrolled away before their turn are dropped instead of decoded.
      if (stopped || waiters.every(s => s?.aborted)) return
      const data = await decode(inventoryMediaUrl('world', world, asset))
      if (!data || data.length > 1024 * 1024 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return
      const entries = await thumbCache(dir)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(dest, data)
      entries.set(dest, { size: data.length, time: Date.now() })
      // Walk only Genio's cache, once per world; subsequent LRU bookkeeping is in memory.
      let total = [...entries.values()].reduce((n, e) => n + e.size, 0)
      for (const [p, e] of [...entries].sort((a, b) => a[1].time - b[1].time)) {
        if (total <= thumbCap) break
        await fsp.unlink(p).catch(() => undefined); total -= e.size; entries.delete(p)
      }
      return total <= thumbCap && data.length <= thumbCap ? dest : undefined
    }).catch(() => undefined).finally(() => thumbs.delete(dest))
    thumbs.set(dest, { task, waiters }); thumbQueue = task
    return task
  }
  return {
    async open(world) {
      const w = await get(world)
      w.open = true
      if (!w.watcher) {
        try {
          w.watchError = undefined
          w.watcher = fs.watch(w.root, { recursive: true }, (event, file) => {
            const p = file?.toString().replace(/\\/g, '/') ?? ''
            if (ignoredAssetPath(p)) return
            if (p.startsWith('.genio/') && p !== '.genio/assets.json' && !p.startsWith('.genio/provenance/')) return
            // Only renames (create/delete/move) and ignore/config edits can change the set of paths.
            if (event === 'rename' || !p || STRUCTURAL.test(p) || p === '.genio/assets.json') w.structural = true
            w.pending.add(p); schedule(w)
          })
          w.watcher.on('error', e => { w.watcher?.close(); w.watcher = undefined; w.watchError = e.message; publish(w) })
        } catch (e) { w.watchError = `Watcher unavailable; refresh on focus: ${(e as Error).message}` }
      }
      // Never wait for the scan: the cached index (or a streaming first scan) serves the screen immediately.
      void refreshIndex(w).catch(() => undefined)
      return state(w)
    },
    close,
    async refresh(world) { return refreshIndex(await get(world)) },
    async list(world, query = {}) {
      const w = await ready(world)
      if (query.tags?.length || /(?:^|\s)(?:l:|t:(?:sprite|normal|texture))/i.test(query.query ?? '')) await metadata(w)
      // Tree, grid and every scrolled page of one filter share a single filter+sort per revision.
      const { offset: _offset, limit: _limit, ...filters } = query, key = `${w.state.revision}\0${JSON.stringify(filters)}`
      let match = w.matches.get(key)
      if (!match) {
        match = matchInventory(w.assets.values(), query)
        if (w.matches.size >= 8) w.matches.delete(w.matches.keys().next().value!)
      }
      w.matches.delete(key); w.matches.set(key, match)
      return { state: state(w), ...pageInventory(match, query) }
    },
    async info(world, asset, verifyHash = false) {
      const w = await ready(world)
      await metadata(w, asset)
      const a = w.assets.get(asset)
      if (!a || !await mediaPath(world, asset)) return null
      const editedSinceGeneration = verifyHash && a.provenance && !a.lfs ? await worker<string>({ root: w.root, hash: asset }) !== a.provenance.sha256 : undefined
      return { ...a, mediaUrl: inventoryMediaUrl('world', world, asset), thumbnailUrl: !a.lfs && a.size <= THUMB_MAX_BYTES && NATIVE_THUMB_EXTS.has(a.ext) ? inventoryMediaUrl('thumb', world, asset) : undefined, editedSinceGeneration }
    },
    mediaPath, thumbnail,
    stop() { stopped = true; for (const world of worlds.keys()) close(world); for (const w of workers) void w.terminate() }
  }
}
