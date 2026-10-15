import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Backpack, Box, ChevronDown, ChevronRight, FileImage, Film, Folder, FolderOpen, Grid2X2, List, Music, RefreshCw, Search, Settings } from 'lucide-react'
import type { AssetKind, InventoryAsset, InventoryFolder, InventoryInfo, InventoryQuery, InventoryState } from '@shared/inventory'
import { PROJECT_WINDOW, api, errText, op, useStore } from '../store'
import { GENERATION_ANCHOR } from '../components/GenerationSettings'
import { openSettings } from '../lib/settings-nav'
import { cx } from '../lib/format'
import { assetBytes, breadcrumbs, previewKind, thumbnailUrl, unavailablePreview, virtualWindow } from '../lib/inventory'
import { PreviewUnavailable } from '../components/PreviewUnavailable'
import { contextAsset, toggleSelection } from '@shared/inventory-context'
import { listFact, useScreenContext } from '../lib/screen-context'
import '../styles/inventory.css'

const TYPES: [AssetKind, string][] = [['image', 'Image'], ['audio', 'Audio'], ['video', 'Video'], ['model', '3D'], ['animation', 'Animation'], ['material', 'Material']]
const ICONS = { image: FileImage, audio: Music, video: Film, model: Box, animation: Box, material: Box }
type AssetScope = 'all' | 'ours' | 'generated'
// Loaded only when a model is selected; three itself loads inside the viewer frame, never in this bundle.
const ModelViewer = lazy(() => import('../components/ModelViewer').then(m => ({ default: m.ModelViewer })))
const REFRESH_LABEL = 'Refresh the asset list (rescan, includes newly generated assets)'
// Serialize watcher ownership, including React StrictMode's setup/cleanup/setup cycle.
let lifecycle: Promise<unknown> = Promise.resolve()
function inventoryLifecycle(fn: () => Promise<unknown>): Promise<unknown> {
  lifecycle = lifecycle.catch(() => undefined).then(fn)
  return lifecycle
}

/** Each project window is bound to one project; Inventory always browses that one. */
export function Inventory() {
  const project = useStore(s => s.snap.projects.find(p => p.name === PROJECT_WINDOW))
  return <div className="inventory">
    <header className="inventory-head">
      <div><div className="label">PROJECT ASSETS</div><h1>Inventory</h1></div>
      {project && <button className="btn sm ghost" onClick={() => openSettings('project-assets', GENERATION_ANCHOR)}><Settings size={14} /> Generation settings</button>}
      <span className="dim">Explore · select · preview</span>
    </header>
    {project ? <WorldInventory key={project.name} world={project.name} root={project.path} />
      : <div className="inventory-empty"><Backpack size={42} /><h2>Project not loaded</h2><p>Open this project from the Hub to browse its media.</p></div>}
  </div>
}

function WorldInventory({ world, root }: { world: string; root: string }) {
  const [state, setIndex] = useState<InventoryState>()
  const [error, setError] = useState('')
  const [folder, setFolder] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<AssetKind[]>([])
  const [scope, setScope] = useState<AssetScope>('all')
  const [tags, setTags] = useState('')
  const [sort, setSort] = useState<InventoryQuery['sort']>('name')
  const [descending, setDescending] = useState(false)
  const [list, setList] = useState(false)
  const [tile, setTile] = useState(150)
  const [selected, setSelected] = useState<InventoryAsset>()
  const [selection, setSelection] = useState<InventoryAsset[]>([])
  const browseFolder = (path: string) => { setFolder(path); setSelected(undefined); setSelection([]) }
  const select = (asset: InventoryAsset, multiple: boolean) => { setSelected(asset); setSelection(s => toggleSelection(s, asset, multiple)) }
  useEffect(() => { const t = setTimeout(() => setQuery(search), 180); return () => clearTimeout(t) }, [search])
  useEffect(() => {
    let alive = true
    const off = window.genio.on(e => { if (alive && e.type === 'inventory' && e.state.world === world) setIndex(e.state) })
    void inventoryLifecycle(async () => {
      const next = await api().inventoryOpen(world)
      if (alive) setIndex(next)
    }).catch(e => { if (alive) setError(errText(e)) })
    const focus = (): void => { void api().inventoryRefresh(world).catch(e => { if (alive) setError(errText(e)) }) }
    window.addEventListener('focus', focus)
    return () => { alive = false; off(); window.removeEventListener('focus', focus); void inventoryLifecycle(() => api().inventoryClose(world)).catch(() => undefined) }
  }, [world])
  const filters = useMemo<InventoryQuery>(() => ({ query, kinds, scope: scope === 'ours' ? 'ours' : 'all', tags: tags.split(',').map(t => t.trim()).filter(Boolean), generated: scope === 'generated' || undefined, sort, descending }), [query, kinds, scope, tags, sort, descending])
  const filterKey = JSON.stringify(filters)
  const browseQuery = useMemo(() => ({ ...filters, folder }), [filters, folder])
  const revision = state?.revision ?? 0
  const [visible, setVisible] = useState<{ names: string[]; total: number }>()
  const filtered = [query && `search "${query}"`, kinds.length && kinds.join('/'), scope === 'ours' && 'ours', scope === 'generated' && 'generated only', tags.trim() && `tags ${tags.trim()}`].filter(Boolean).join(', ')
  useScreenContext('inventory', { world, engine: state?.engine, engineRoot: state?.engineRoot, folder, preview: selected && contextAsset(selected), selection: selection.length > 1 ? selection.map(contextAsset) : undefined,
    facts: [visible && { label: 'Visible', value: `${visible.total} matching: ${listFact(visible.names, visible.total)}` }, !!filtered && { label: 'Filters', value: filtered }] })
  const selectedPaths = JSON.stringify(selection.map(a => a.path))
  useEffect(() => {
    let alive = true
    const paths = [...new Set([...selection.map(a => a.path), ...(selected ? [selected.path] : [])])]
    if (!paths.length) return
    void Promise.all(paths.map(path => api().inventoryInfo(world, path))).then(infos => {
      if (!alive) return
      const fresh = new Map(infos.filter((a): a is InventoryInfo => !!a).map(a => [a.path, a]))
      setSelection(prev => prev.flatMap(a => fresh.get(a.path) ?? []))
      setSelected(prev => prev && fresh.get(prev.path))
    }).catch(() => undefined)
    return () => { alive = false }
  }, [world, revision, selectedPaths, selected?.path])
  return <>
    <div className="inventory-toolbar">
      <label className="inventory-search"><Search size={16} /><input aria-label="Search assets" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or path · t:sfx  ext:png  in:UI" /></label>
      <select className="select compact" aria-label="Asset scope" value={scope} onChange={e => setScope(e.target.value as AssetScope)}><option value="all">All</option><option value="ours">Ours</option><option value="generated">AI Generated</option></select>
      <button className="btn sm" title={REFRESH_LABEL} aria-label={REFRESH_LABEL} disabled={state?.refreshing} onClick={() => { setError(''); void op('Refresh Inventory', () => api().inventoryRefresh(world)) }}><RefreshCw size={14} className={state?.refreshing ? 'spin' : ''} /></button>
    </div>
    <div className="inventory-toolbar inventory-filters">
      {TYPES.map(([kind, label]) => <button className={cx('btn sm ghost', kinds.includes(kind) && 'on')} key={kind} aria-pressed={kinds.includes(kind)} onClick={() => setKinds(kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind])}>{label}</button>)}
      <input className="input inventory-tags" aria-label="Asset tags" placeholder="Tags: sfx, sprite…" value={tags} onChange={e => setTags(e.target.value)} />
      <div className="inventory-view-controls">
        <select className="select compact" aria-label="Sort assets" value={sort} onChange={e => setSort(e.target.value as InventoryQuery['sort'])}><option value="name">Name</option><option value="type">Type</option><option value="size">Size</option><option value="modified">Modified</option></select>
        <button className="btn sm" aria-label="Reverse sort" aria-pressed={descending} onClick={() => setDescending(!descending)}>{descending ? '↓' : '↑'}</button>
        <button className={cx('btn sm', !list && 'on')} aria-label="Grid view" aria-pressed={!list} onClick={() => setList(false)}><Grid2X2 size={15} /></button>
        <button className={cx('btn sm', list && 'on')} aria-label="List view" aria-pressed={list} onClick={() => setList(true)}><List size={15} /></button>
        {!list && <input className="inventory-size" type="range" min="120" max="220" step="10" aria-label="Thumbnail size" value={tile} onChange={e => setTile(Number(e.target.value))} />}
      </div>
    </div>
    {(error || state?.error) && <div className="inventory-error" role="alert">{error || state?.error}</div>}
    <nav className="inventory-breadcrumb" aria-label="Asset folder">{breadcrumbs(folder).map((b, i) => <span key={b.path}>{i > 0 && <ChevronRight size={12} />}<button onClick={() => browseFolder(b.path)}>{b.name}</button></span>)}</nav>
    <div className="inventory-body">
      <aside className="inventory-tree" aria-label="Asset folders">
        <div className="label">PROJECT HIERARCHY</div>
        <button className={cx('inventory-folder', !folder && 'on')} onClick={() => browseFolder('')}><FolderOpen size={15} /><span>All assets</span></button>
        {state ? <FolderChildren key={filterKey} world={world} parent="" filters={filters} revision={revision} selected={folder} select={browseFolder} depth={0} /> : <p className="dim">Indexing project…</p>}
      </aside>
      {state ? <AssetBrowser key={filterKey + folder + list + tile} world={world} query={browseQuery} revision={revision} indexing={state.indexing} list={list} tile={tile} selected={selection.map(a => a.path)} select={select} onVisible={setVisible} /> : <div className="inventory-empty">Indexing supported media…</div>}
      <Inspector key={selected?.path ?? 'empty'} world={world} root={root} asset={selected} revision={revision} />
    </div>
    <footer className="inventory-status"><span>{(state?.total ?? 0).toLocaleString()} indexed media</span><span>{state?.indexing ? indexingText(state.indexing) : state?.refreshing ? 'Refreshing…' : state?.watching ? '● Watching for changes' : 'Refreshes on focus'}</span><span>{state?.engine}{state?.engineRoot ? ` · ${state.engineRoot}` : ''}</span>{scope === 'ours' && <span className="dim">Vendor packs excluded from Ours</span>}</footer>
  </>
}

function FolderChildren({ world, parent, filters, revision, selected, select, depth }: { world: string; parent: string; filters: InventoryQuery; revision: number; selected: string; select: (path: string) => void; depth: number }) {
  const [folders, setFolders] = useState<InventoryFolder[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(breadcrumbs(selected).map(b => b.path)))
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api().inventoryList(world, { ...filters, folder: parent, limit: 1 }).then(r => { if (alive) { setFolders(r.folders); setError('') } }).catch(e => { if (alive) setError(errText(e)) })
    return () => { alive = false }
  }, [world, parent, filters, revision])
  return <>{error && <p role="alert">{error}</p>}{folders.map(f => {
    const open = expanded.has(f.path)
    return <div key={f.path}>
      <div className={cx('inventory-folder', selected === f.path && 'on')} style={{ paddingLeft: 6 + depth * 12 }}>
        <button aria-label={`${open ? 'Collapse' : 'Expand'} ${f.name}`} aria-expanded={open} onClick={() => setExpanded(prev => { const next = new Set(prev); if (open) next.delete(f.path); else next.add(f.path); return next })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        <button className="inventory-folder-name" title={f.path} onClick={() => { select(f.path); setExpanded(prev => new Set([...prev, f.path])) }}><Folder size={14} /><span>{f.name}</span>{f.vendor && <small title="Vendor pack">ⓥ</small>}<small>{f.count}</small></button>
      </div>
      {open && <FolderChildren world={world} parent={f.path} filters={filters} revision={revision} selected={selected} select={select} depth={depth + 1} />}
    </div>
  })}</>
}

function indexingText(p: NonNullable<InventoryState['indexing']>): string {
  return p.total ? `Indexing ${p.done.toLocaleString()} / ${p.total.toLocaleString()}…` : 'Listing project files…'
}

function AssetBrowser({ world, query, revision, indexing, list, tile, selected, select, onVisible }: { world: string; query: InventoryQuery; revision: number; indexing?: InventoryState['indexing']; list: boolean; tile: number; selected: string[]; select: (asset: InventoryAsset, multiple: boolean) => void; onVisible: (v: { names: string[]; total: number }) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 600, height: 500, top: 0 })
  const [page, setPage] = useState<{ items: InventoryAsset[]; offset: number; total: number }>()
  const [error, setError] = useState('')
  const range = virtualWindow(page?.total ?? 0, size.width, size.height, size.top, tile, list)
  // What the player can see in the grid, for the Genio panel's screen context.
  const shown = page?.items.slice(Math.max(0, range.offset - page.offset)).map(a => a.name) ?? []
  const shownKey = JSON.stringify([shown.slice(0, 6), page?.total])
  useEffect(() => { if (page) onVisible({ names: shown.slice(0, 6), total: page.total }) }, [shownKey])
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setSize(s => ({ ...s, width: el.clientWidth, height: el.clientHeight })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => { void api().inventoryList(world, { ...query, offset: range.offset, limit: range.limit }).then(r => { if (alive) { setPage({ items: r.items, total: r.total, offset: range.offset }); setError('') } }).catch(e => { if (alive) setError(errText(e)) }) }, 50)
    return () => { alive = false; clearTimeout(t) }
  }, [world, query, revision, range.offset, range.limit])
  return <section className="inventory-browser">
    <div className="inventory-result-count">{page ? `${page.total.toLocaleString()} matching assets` : 'Loading assets…'}<span className="dim">Ctrl click to select up to 20</span></div>
    {list && <div className="inventory-list-head"><span>Name</span><span>Type</span><span>Size</span></div>}
    <div ref={ref} className="inventory-scroll" onScroll={e => { const top = e.currentTarget.scrollTop; setSize(s => ({ ...s, top })) }}>
      {error ? <p className="inventory-error" role="alert">{error}</p> : page?.total === 0 ? indexing ? <div className="inventory-empty"><RefreshCw size={32} className="spin" /><h3>{indexingText(indexing)}</h3><p>Assets appear here as they are indexed.</p></div> : <div className="inventory-empty"><Search size={32} /><h3>No matching media</h3><p>Try another folder, scope or search.</p></div> : <div style={{ height: range.height, position: 'relative' }} role="group" aria-label="Assets">
        <div className={cx('inventory-tiles', list && 'is-list')} style={{ top: Math.floor((page?.offset ?? 0) / range.columns) * range.rowHeight, gridTemplateColumns: `repeat(${range.columns}, minmax(0, 1fr))`, gridAutoRows: range.rowHeight }}>
          {page?.items.map(asset => <button key={asset.path} title={asset.path} className={cx('inventory-tile', selected.includes(asset.path) && 'selected')} aria-pressed={selected.includes(asset.path)} onClick={e => select(asset, e.ctrlKey || e.metaKey || e.shiftKey)}>
            <AssetThumbnail world={world} asset={asset} />
            <span className="inventory-asset-name">{asset.generated && <b className="accent">✦ </b>}{asset.name}</span>
            <span className="inventory-asset-type">{asset.vendor ? 'ⓥ ' : ''}{asset.lfs ? 'Not pulled' : asset.ext.toUpperCase()}</span>
            {list && <span className="inventory-asset-size">{assetBytes(asset.size)}</span>}
          </button>)}
        </div>
      </div>}
    </div>
  </section>
}

function AssetThumbnail({ world, asset }: { world: string; asset: InventoryAsset }) {
  const url = thumbnailUrl(world, asset)
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const el = ref.current!
    // Request only after the tile stays near the viewport briefly, so fast scrolling queues no decodes.
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new IntersectionObserver(entries => {
      clearTimeout(timer)
      if (entries.at(-1)?.isIntersecting) timer = setTimeout(() => { setVisible(true); observer.disconnect() }, 120)
    }, { root: el.closest('.inventory-scroll'), rootMargin: '100px' })
    observer.observe(el)
    return () => { clearTimeout(timer); observer.disconnect() }
  }, [])
  const Icon = ICONS[asset.kind]
  return <span ref={ref} className="inventory-thumb">{(!loaded || failed) && <Icon size={30} strokeWidth={1.2} />}{url && visible && !failed && <img src={url} alt="" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} style={{ display: loaded ? 'block' : 'none' }} />}</span>
}

function Inspector({ world, root, asset, revision }: { world: string; root: string; asset?: InventoryAsset; revision: number }) {
  const [info, setInfo] = useState<InventoryInfo | null>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!asset) return
    let alive = true
    void api().inventoryInfo(world, asset.path).then(i => { if (alive) { setInfo(i); setError(i ? '' : 'This asset is no longer available.') } }).catch(e => { if (alive) setError(errText(e)) })
    return () => { alive = false }
  }, [world, asset?.path, revision])
  const fullPath = asset ? root.replace(/[\\/]$/, '') + '/' + asset.path : ''
  return <aside className="inventory-inspector" aria-label="Asset inspector"><div className="label">INSPECTOR</div>
    {!asset ? <div className="inventory-empty"><Box size={40} /><h3>Select an asset</h3><p>Preview media and inspect its source.</p></div> : <>
      <h2>{asset.name}</h2>
      {error && <p className="inventory-error" role="alert">{error}</p>}
      {info ? <AssetPreview key={info.mediaUrl + info.mtimeMs} world={world} info={info} path={fullPath} /> : !error && <p className="dim">Loading preview…</p>}
      <div className="inventory-path">{asset.path}</div>
      <dl><dt>Type</dt><dd>{asset.kind} · {asset.ext.toUpperCase()}</dd><dt>Size</dt><dd>{assetBytes(asset.lfsSize ?? asset.size)}</dd><dt>Modified</dt><dd>{new Date(asset.mtimeMs).toLocaleString()}</dd><dt>Source</dt><dd>{asset.vendor ? 'Vendor pack' : 'Project asset'} · {asset.tracked ? 'Tracked' : 'Untracked'}</dd>
        {!!info?.tags.length && <><dt>Tags</dt><dd>{info.tags.join(', ')}</dd></>}
        {info?.meta?.importer && <><dt>Importer</dt><dd>{info.meta.importer}</dd></>}
      </dl>
      {info?.provenance && <div className="inventory-provenance"><div className="label accent">✦ GENERATED BY GENIO</div><p>{info.provenance.provider} · {info.provenance.endpoint}</p><p>By {info.provenance.by} · {info.provenance.created}</p></div>}
      <button className="btn sm" onClick={() => { void op('Copy path', () => navigator.clipboard.writeText(fullPath), () => 'Path copied') }}>Copy path</button>
      <button className="btn sm" onClick={() => { void op('Open asset', () => api().openPath(fullPath)) }}>Open in default app</button>
      <button className="btn sm ghost" onClick={() => { void op('Open folder', () => api().openPath(root + '/' + asset.folder)) }}>Open containing folder</button>
    </>}
  </aside>
}

function AssetPreview({ world, info, path }: { world: string; info: InventoryInfo; path: string }) {
  const kind = previewKind(info)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [loop, setLoop] = useState(false)
  if (failed) return <PreviewUnavailable title="This file could not be previewed" reason={`Its ${info.ext.toUpperCase()} data or codec isn't one Genio can show. Open it in its default app.`} path={path} />
  if (kind === 'image') return <><div className="inventory-image"><img src={info.mediaUrl} alt={info.name} onError={() => setFailed(true)} style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} /></div><label className="inventory-zoom">Zoom <input type="range" aria-label="Image zoom" min="1" max="4" step="0.1" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label></>
  if (kind === 'model') return <Suspense fallback={<p className="dim">Loading 3D viewer…</p>}><ModelViewer world={world} info={info} path={path} /></Suspense>
  if (kind === 'audio' || kind === 'video') return <div className="inventory-media">
    {kind === 'audio' ? <><Music size={50} strokeWidth={1} /><audio controls preload="metadata" loop={loop} src={info.mediaUrl} onError={() => setFailed(true)} /></> : <video controls preload="metadata" loop={loop} src={info.mediaUrl} onError={() => setFailed(true)} />}
    <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} /> Loop</label>
  </div>
  return <PreviewUnavailable {...unavailablePreview(info)} path={path} />
}
