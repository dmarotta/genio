import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, ChevronDown, ChevronRight, FileImage, Film, Folder, FolderOpen, Grid2X2, List, Music, RefreshCw, Search } from 'lucide-react'
import type { AssetKind, InventoryAsset, InventoryFolder, InventoryInfo, InventoryQuery, InventoryState } from '@shared/inventory'
import { api, errText, go, op, useStore } from '../store'
import { cx } from '../lib/format'
import { assetBytes, breadcrumbs, previewKind, thumbnailUrl, virtualWindow } from '../lib/inventory'
import { GlbViewer } from '../components/GlbViewer'
import '../styles/inventory.css'

const TYPES: [AssetKind, string][] = [['image', 'Image'], ['audio', 'Audio'], ['video', 'Video'], ['model', '3D'], ['animation', 'Animation'], ['material', 'Material']]
const ICONS = { image: FileImage, audio: Music, video: Film, model: Box, animation: Box, material: Box }
// Serialize watcher ownership, including React StrictMode's setup/cleanup/setup cycle.
let lifecycle: Promise<unknown> = Promise.resolve()
function inventoryLifecycle(fn: () => Promise<unknown>): Promise<unknown> {
  lifecycle = lifecycle.catch(() => undefined).then(fn)
  return lifecycle
}

export function Inventory() {
  const projects = useStore(s => s.snap.projects)
  const requested = useStore(s => s.inventoryWorld)
  const world = projects.find(p => p.name === requested)?.name
    ?? projects.find(p => p.name === localStorage.getItem('genio.inventory.world'))?.name ?? projects[0]?.name
  useEffect(() => { if (world) localStorage.setItem('genio.inventory.world', world) }, [world])
  return <div className="inventory">
    <header className="inventory-head">
      <div><div className="label">WORLD ASSETS</div><h1>Inventory</h1></div>
      <select className="select" aria-label="Inventory world" value={world ?? ''} onChange={e => go('inventory', { world: e.target.value })}>
        {!projects.length && <option value="">No worlds</option>}
        {projects.map(p => <option key={p.name}>{p.name}</option>)}
      </select>
      <span className="dim">Explore · select · preview</span>
    </header>
    {world ? <WorldInventory key={world} world={world} root={projects.find(p => p.name === world)!.path} />
      : <div className="inventory-empty"><FolderOpen size={42} /><h2>No worlds loaded</h2><p>Add a world to browse its media.</p><button className="btn" onClick={() => go('worlds')}>Open Worlds</button></div>}
  </div>
}

function WorldInventory({ world, root }: { world: string; root: string }) {
  const [state, setIndex] = useState<InventoryState>()
  const [error, setError] = useState('')
  const [folder, setFolder] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<AssetKind[]>([])
  const [scope, setScope] = useState<InventoryQuery['scope']>('ours')
  const [tags, setTags] = useState('')
  const [generated, setGenerated] = useState(false)
  const [sort, setSort] = useState<InventoryQuery['sort']>('name')
  const [descending, setDescending] = useState(false)
  const [list, setList] = useState(false)
  const [tile, setTile] = useState(150)
  const [selected, setSelected] = useState<InventoryAsset>()
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
  const filters = useMemo<InventoryQuery>(() => ({ query, kinds, scope, tags: tags.split(',').map(t => t.trim()).filter(Boolean), generated: generated || undefined, sort, descending }), [query, kinds, scope, tags, generated, sort, descending])
  const filterKey = JSON.stringify(filters)
  const browseQuery = useMemo(() => ({ ...filters, folder }), [filters, folder])
  const revision = state?.revision ?? 0
  return <>
    <div className="inventory-toolbar">
      <label className="inventory-search"><Search size={16} /><input aria-label="Search assets" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or path · t:sfx  ext:png  in:UI" /></label>
      <select className="select compact" aria-label="Asset scope" value={scope} onChange={e => setScope(e.target.value as InventoryQuery['scope'])}><option value="ours">Ours</option><option value="all">All assets</option><option value="vendor">Vendor packs</option></select>
      <button className={cx('btn sm', generated && 'on')} aria-pressed={generated} onClick={() => setGenerated(!generated)}>✦ Generated</button>
      <button className="btn sm" aria-label="Refresh Inventory" disabled={state?.refreshing} onClick={() => { setError(''); void op('Refresh Inventory', () => api().inventoryRefresh(world)) }}><RefreshCw size={14} className={state?.refreshing ? 'spin' : ''} /></button>
    </div>
    <div className="inventory-toolbar inventory-filters">
      {TYPES.map(([kind, label]) => <button className={cx('btn sm ghost', kinds.includes(kind) && 'on')} key={kind} aria-pressed={kinds.includes(kind)} onClick={() => setKinds(kinds.includes(kind) ? kinds.filter(k => k !== kind) : [...kinds, kind])}>{label}</button>)}
      <input className="input inventory-tags" aria-label="Asset tags" placeholder="Tags: sfx, sprite…" value={tags} onChange={e => setTags(e.target.value)} />
      <div className="inventory-spacer" />
      <select className="select compact" aria-label="Sort assets" value={sort} onChange={e => setSort(e.target.value as InventoryQuery['sort'])}><option value="name">Name</option><option value="type">Type</option><option value="size">Size</option><option value="modified">Modified</option></select>
      <button className="btn sm" aria-label="Reverse sort" aria-pressed={descending} onClick={() => setDescending(!descending)}>{descending ? '↓' : '↑'}</button>
      <button className={cx('btn sm', !list && 'on')} aria-label="Grid view" aria-pressed={!list} onClick={() => setList(false)}><Grid2X2 size={15} /></button>
      <button className={cx('btn sm', list && 'on')} aria-label="List view" aria-pressed={list} onClick={() => setList(true)}><List size={15} /></button>
      {!list && <input className="inventory-size" type="range" min="120" max="220" step="10" aria-label="Thumbnail size" value={tile} onChange={e => setTile(Number(e.target.value))} />}
    </div>
    {(error || state?.error) && <div className="inventory-error" role="alert">{error || state?.error}</div>}
    <nav className="inventory-breadcrumb" aria-label="Asset folder">{breadcrumbs(folder).map((b, i) => <span key={b.path}>{i > 0 && <ChevronRight size={12} />}<button onClick={() => setFolder(b.path)}>{b.name}</button></span>)}</nav>
    <div className="inventory-body">
      <aside className="inventory-tree" aria-label="Asset folders">
        <div className="label">PROJECT HIERARCHY</div>
        <button className={cx('inventory-folder', !folder && 'on')} onClick={() => setFolder('')}><FolderOpen size={15} /><span>All assets</span></button>
        {state ? <FolderChildren key={filterKey} world={world} parent="" filters={filters} revision={revision} selected={folder} select={setFolder} depth={0} /> : <p className="dim">Indexing world…</p>}
      </aside>
      {state ? <AssetBrowser key={filterKey + folder + list + tile} world={world} query={browseQuery} revision={revision} list={list} tile={tile} selected={selected?.path} select={setSelected} /> : <div className="inventory-empty">Indexing supported media…</div>}
      <Inspector key={selected?.path ?? 'empty'} world={world} root={root} asset={selected} revision={revision} />
    </div>
    <footer className="inventory-status"><span>{(state?.total ?? 0).toLocaleString()} indexed media</span><span>{state?.refreshing ? 'Refreshing…' : state?.watching ? '● Watching for changes' : 'Refreshes on focus'}</span><span>{state?.engine}{state?.engineRoot ? ` · ${state.engineRoot}` : ''}</span><span className="dim">Vendor packs excluded from Ours</span></footer>
  </>
}

function FolderChildren({ world, parent, filters, revision, selected, select, depth }: { world: string; parent: string; filters: InventoryQuery; revision: number; selected: string; select: (path: string) => void; depth: number }) {
  const [folders, setFolders] = useState<InventoryFolder[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api().inventoryList(world, { ...filters, folder: parent, limit: 1 }).then(r => { if (alive) { setFolders(r.folders); setError('') } }).catch(e => { if (alive) setError(errText(e)) })
    return () => { alive = false }
  }, [world, parent, filters, revision])
  return <>{error && <p role="alert">{error}</p>}{folders.map(f => {
    const open = expanded.has(f.path) || selected.startsWith(f.path + '/')
    return <div key={f.path}>
      <div className={cx('inventory-folder', selected === f.path && 'on')} style={{ paddingLeft: 6 + depth * 12 }}>
        <button aria-label={`${open ? 'Collapse' : 'Expand'} ${f.name}`} aria-expanded={open} onClick={() => setExpanded(prev => { const next = new Set(prev); if (open) next.delete(f.path); else next.add(f.path); return next })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
        <button className="inventory-folder-name" title={f.path} onClick={() => { select(f.path); setExpanded(prev => new Set([...prev, f.path])) }}><Folder size={14} /><span>{f.name}</span>{f.vendor && <small title="Vendor pack">ⓥ</small>}<small>{f.count}</small></button>
      </div>
      {open && <FolderChildren world={world} parent={f.path} filters={filters} revision={revision} selected={selected} select={select} depth={depth + 1} />}
    </div>
  })}</>
}

function AssetBrowser({ world, query, revision, list, tile, selected, select }: { world: string; query: InventoryQuery; revision: number; list: boolean; tile: number; selected?: string; select: (asset: InventoryAsset) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 600, height: 500, top: 0 })
  const [page, setPage] = useState<{ items: InventoryAsset[]; offset: number; total: number }>()
  const [error, setError] = useState('')
  const range = virtualWindow(page?.total ?? 0, size.width, size.height, size.top, tile, list)
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
    <div className="inventory-result-count">{page ? `${page.total.toLocaleString()} matching assets` : 'Loading assets…'}<span className="dim">Includes subfolders</span></div>
    {list && <div className="inventory-list-head"><span>Name</span><span>Type</span><span>Size</span></div>}
    <div ref={ref} className="inventory-scroll" onScroll={e => { const top = e.currentTarget.scrollTop; setSize(s => ({ ...s, top })) }}>
      {error ? <p className="inventory-error" role="alert">{error}</p> : page?.total === 0 ? <div className="inventory-empty"><Search size={32} /><h3>No matching media</h3><p>Try another folder, scope or search.</p></div> : <div style={{ height: range.height, position: 'relative' }} role="group" aria-label="Assets">
        <div className={cx('inventory-tiles', list && 'is-list')} style={{ top: Math.floor((page?.offset ?? 0) / range.columns) * range.rowHeight, gridTemplateColumns: `repeat(${range.columns}, minmax(0, 1fr))`, gridAutoRows: range.rowHeight }}>
          {page?.items.map(asset => <button key={asset.path} title={asset.path} className={cx('inventory-tile', selected === asset.path && 'selected')} aria-pressed={selected === asset.path} onClick={() => select(asset)}>
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
  const [failed, setFailed] = useState(false)
  const Icon = ICONS[asset.kind]
  return <span className="inventory-thumb">{url && !failed ? <img src={url} loading="lazy" alt="" onError={() => setFailed(true)} /> : <Icon size={30} strokeWidth={1.2} />}</span>
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
      {info ? <AssetPreview key={info.mediaUrl + info.mtimeMs} info={info} /> : !error && <p className="dim">Loading preview…</p>}
      <div className="inventory-path">{asset.path}</div>
      <dl><dt>Type</dt><dd>{asset.kind} · {asset.ext.toUpperCase()}</dd><dt>Size</dt><dd>{assetBytes(asset.lfsSize ?? asset.size)}</dd><dt>Modified</dt><dd>{new Date(asset.mtimeMs).toLocaleString()}</dd><dt>Source</dt><dd>{asset.vendor ? 'Vendor pack' : 'World asset'} · {asset.tracked ? 'Tracked' : 'Untracked'}</dd>
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

function AssetPreview({ info }: { info: InventoryInfo }) {
  const kind = previewKind(info)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [loop, setLoop] = useState(false)
  if (failed) return <div className="inventory-preview-info">This file could not be previewed. Open it in its default app to inspect the format or codec.</div>
  if (kind === 'image') return <><div className="inventory-image"><img src={info.mediaUrl} alt={info.name} onError={() => setFailed(true)} style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} /></div><label className="inventory-zoom">Zoom <input type="range" aria-label="Image zoom" min="1" max="4" step="0.1" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label></>
  if (kind === 'glb') return <GlbViewer url={info.mediaUrl} />
  if (kind === 'audio' || kind === 'video') return <div className="inventory-media">
    {kind === 'audio' ? <><Music size={50} strokeWidth={1} /><audio controls preload="metadata" loop={loop} src={info.mediaUrl} onError={() => setFailed(true)} /></> : <video controls preload="metadata" loop={loop} src={info.mediaUrl} onError={() => setFailed(true)} />}
    <label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} /> Loop</label>
  </div>
  return <div className="inventory-preview-info">{info.thumbnailUrl && <img src={info.thumbnailUrl} alt={info.name} onError={e => { e.currentTarget.hidden = true }} />}<Box size={32} /><strong>{info.lfs ? 'Git LFS file not pulled' : `${info.ext.toUpperCase()} · preview coming later`}</strong><p>{info.lfs ? 'The local file is an LFS pointer. Pull the asset in your Git client to preview it.' : 'Metadata is available. Open this asset in its default app for a full preview.'}</p></div>
}
