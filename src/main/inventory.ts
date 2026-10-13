import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import type { InventoryAsset, InventoryInfo, InventoryQuery, InventoryResult, InventoryState } from '@shared/inventory'
import { inventoryMediaUrl, NATIVE_THUMB_EXTS, THUMB_MAX_BYTES } from '@shared/inventory'
import { assetKind, assetTags, ignoredAssetPath, queryInventory, under, vendorPath } from './inventory-query'
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
  thumbnail(world: string, asset: string): Promise<string | undefined>
  stop(): void
}
export type ThumbnailDecoder = (url: string) => Promise<Buffer | undefined>
type Candidate = InventoryAsset & { sidecar?: string; record?: string }
interface WorldIndex {
  root: string
  assets: Map<string, InventoryAsset>
  state: InventoryState
  initialized: boolean
  loading?: Promise<void>
  saving?: Promise<void>
  metadata?: Promise<void>
  refreshing?: Promise<InventoryState>
  watcher?: fs.FSWatcher
  watchError?: string
  open: boolean
  pending: Set<string>
  timer?: NodeJS.Timeout
}

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
  for (const line of r.stdout.split('\0')) {
    const p = line.slice(2)
    if (validInventoryPath(p) && !ignoredAssetPath(p)) files.set(p, files.get(p) || line[0] !== '?')
  }
  return { files, ms: performance.now() - start }
}

export function createInventoryService(getCtx: () => AppCtx, decode?: ThumbnailDecoder, thumbCap = 1024 ** 3): InventoryService {
  const worlds = new Map<string, WorldIndex>(), workers = new Set<Worker>()
  const thumbs = new Map<string, Promise<string | undefined>>()
  const thumbCaches = new Map<string, Promise<Map<string, { size: number; time: number }>>>()
  let stopped = false, thumbQueue: Promise<unknown> = Promise.resolve()
  const worker = <T>(data: unknown): Promise<T> => new Promise((resolve, reject) => {
    if (stopped) return reject(new Error('Inventory stopped'))
    const w = new Worker(INVENTORY_WORKER, { eval: true, workerData: data })
    workers.add(w)
    w.once('message', resolve)
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
      await fsp.writeFile(path.join(dir, 'index.json.tmp'), JSON.stringify({ version: 1, root: w.root, updatedAt: w.state.updatedAt, assets: [...w.assets.values()] }))
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
      w = { root: proj.path, assets: new Map(), initialized: false, open: false, pending: new Set(), state: { world, revision: 0, total: 0, refreshing: false, watching: false } }
      worlds.set(world, w)
      const fresh = w
      fresh.loading = (async () => {
        try {
          const c = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'))
          if (c.version === 1 && c.root === fresh.root && Array.isArray(c.assets)) {
            fresh.assets = new Map(c.assets.filter((a: InventoryAsset) => validInventoryPath(a.path) && !ignoredAssetPath(a.path)).map((a: InventoryAsset) => [a.path, a]))
            fresh.state = { ...fresh.state, total: fresh.assets.size, updatedAt: c.updatedAt }
            fresh.initialized = true
          }
        } catch { /* absent or obsolete cache */ }
      })()
    }
    await w.loading
    w.state.engine = proj.engine
    w.state.engineRoot = proj.engineRoot
    return w
  }
  const refreshIndex = (w: WorldIndex, changed?: Set<string>): Promise<InventoryState> => {
    if (w.refreshing) return w.refreshing
    w.refreshing = (async () => {
      const started = performance.now(), { files, ms } = await enumerateInventory(w.root)
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
      const candidates: Candidate[] = [], next = new Map<string, InventoryAsset>()
      const changes = [...changed ?? []]
      const full = !changed || changes.length > 128 || changes.some(p => /(?:^|\/)(?:\.gitignore|\.gitmodules|\.git)$/.test(p) || p === '.genio/assets.json')
      for (const [p, tracked] of files) {
        const kind = assetKind(p)
        if (!kind || p.startsWith('.genio/') || ignore.some(f => under(p, f))) continue
        const prev = w.assets.get(p), vendorFlag = vendorPath(p, vendor)
        const dirty = full || changes.some(c => under(p, c) || c === `${p}.meta` || c === `${p}.import` || c === `.genio/provenance/${p}.json` || under(`.genio/provenance/${p}.json`, c))
        if (prev && !dirty) { next.set(p, { ...prev, tracked, vendor: vendorFlag }); continue }
        candidates.push({ path: p, name: path.posix.basename(p), folder: path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p),
          ext: path.posix.extname(p).slice(1).toLowerCase(), kind, size: 0, mtimeMs: 0, tracked, lfs: false, vendor: vendorFlag, tags: assetTags(p, kind), generated: false,
          meta: prev?.meta,
          sidecar: files.has(p + '.meta') ? p + '.meta' : files.has(p + '.import') ? p + '.import' : undefined,
          record: files.has(`.genio/provenance/${p}.json`) ? `.genio/provenance/${p}.json` : undefined })
      }
      if (candidates.length) for (const a of await worker<InventoryAsset[]>({ root: w.root, assets: candidates })) next.set(a.path, a)
      if (stopped || worlds.get(w.state.world) !== w) return state(w)
      w.assets = next; w.initialized = true
      w.state = { ...w.state, total: next.size, revision: w.state.revision + 1, updatedAt: new Date().toISOString(), error: undefined, enumerationMs: ms, scanMs: performance.now() - started }
      await saveCache(w)
      bus.publish({ type: 'feature-used', feature: 'inventory-index' })
      return state(w)
    })().catch(e => { w.state.error = String((e as Error).message); throw e }).finally(() => {
      w.refreshing = undefined; publish(w)
      if (w.open && w.pending.size) schedule(w)
      if (w.open) void metadata(w).catch(() => undefined)
    })
    publish(w)
    return w.refreshing.then(() => state(w))
  }
  const schedule = (w: WorldIndex): void => {
    if (w.timer || !w.open) return
    w.timer = setTimeout(() => {
      w.timer = undefined
      if (w.refreshing) return // refresh's finally schedules the pending batch
      const changed = new Set(w.pending); w.pending.clear()
      void refreshIndex(w, changed.has('') ? undefined : changed).catch(() => undefined)
    }, 300)
  }
  const close = (world: string): void => {
    const w = worlds.get(world)
    if (!w) return
    w.open = false; w.watcher?.close(); w.watcher = undefined
    if (w.timer) clearTimeout(w.timer)
    w.timer = undefined; w.pending.clear(); publish(w)
  }
  const ready = async (world: string): Promise<WorldIndex> => { const w = await get(world); if (!w.initialized) await refreshIndex(w); return w }
  const mediaPath = async (world: string, asset: string): Promise<string | undefined> => {
    const proj = getCtx().projects.get(world)
    if (!proj) return
    return guardedWorldFile(proj.path, asset)
  }
  const thumbnail = async (world: string, asset: string): Promise<string | undefined> => {
    const w = await ready(world), a = w.assets.get(asset)
    if (!decode || !a || a.lfs || !NATIVE_THUMB_EXTS.has(a.ext)) return
    const file = await mediaPath(world, asset)
    if (!file) return
    const stat = await fsp.stat(file)
    if (!stat.size || stat.size > THUMB_MAX_BYTES) return
    const key = createHash('sha256').update(`${w.root}\0${asset}\0${stat.size}\0${stat.mtimeMs}`).digest('hex')
    const dir = cacheDir(world, 'thumbs'), dest = path.join(dir, key + '.webp')
    const entries = await thumbCache(dir)
    try {
      await fsp.utimes(dest, new Date(), new Date())
      const entry = entries.get(dest)
      if (entry) entry.time = Date.now()
      return dest
    } catch { entries.delete(dest) }
    if (thumbs.has(dest)) return thumbs.get(dest)
    const task = thumbQueue.then(async () => {
      if (stopped) return
      const data = await decode(inventoryMediaUrl('world', world, asset))
      if (!data || data.length > 1024 * 1024 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP') return
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
    thumbs.set(dest, task); thumbQueue = task
    return task
  }
  return {
    async open(world) {
      const w = await get(world)
      w.open = true
      if (!w.watcher) {
        try {
          w.watchError = undefined
          w.watcher = fs.watch(w.root, { recursive: true }, (_event, file) => {
            const p = file?.toString().replace(/\\/g, '/') ?? ''
            if (ignoredAssetPath(p)) return
            if (p.startsWith('.genio/') && p !== '.genio/assets.json' && !p.startsWith('.genio/provenance/')) return
            w.pending.add(p); schedule(w)
          })
          w.watcher.on('error', e => { w.watcher?.close(); w.watcher = undefined; w.watchError = e.message; publish(w) })
        } catch (e) { w.watchError = `Watcher unavailable; refresh on focus: ${(e as Error).message}` }
      }
      const refreshing = refreshIndex(w)
      if (!w.initialized) await refreshing
      else void refreshing.catch(() => undefined)
      return state(w)
    },
    close,
    async refresh(world) { return refreshIndex(await get(world)) },
    async list(world, query = {}) {
      const w = await ready(world)
      if (query.tags?.length || /(?:^|\s)(?:l:|t:(?:sprite|normal|texture))/i.test(query.query ?? '')) await metadata(w)
      return { state: state(w), ...queryInventory([...w.assets.values()], query) }
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
