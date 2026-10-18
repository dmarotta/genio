import { useEffect, useRef, useState } from 'react'
import { Focus, Maximize2, Minimize2, Pause, Play } from 'lucide-react'
import type { InventoryInfo } from '@shared/inventory'
import { formatDuration } from '@shared/duration'
import { DEFAULT_VIEWER_SETTINGS, MODEL_PREVIEW_TIMEOUT_MS, VIEWER_APP_URL, formatLength, readViewerMessage, type ModelFailure, type ModelLoaded, type ModelPlayback, type ToViewer, type ViewerSettings } from '@shared/model-viewer'
import { api, errText } from '../store'
import { cx } from '../lib/format'
import { modelTooLarge, type PreviewUnavailable as Unavailable } from '../lib/inventory'
import { PreviewUnavailable } from './PreviewUnavailable'
import '../styles/model-viewer.css'

const FAILED: Record<ModelFailure, string> = { 'too-large': 'Too large to preview', timeout: 'Preview stopped', unreadable: 'This model can\'t be previewed', 'no-webgl': '3D previews need WebGL' }
type Toggle = 'wireframe' | 'bounds' | 'skeleton'
const TOGGLES: [Toggle, string, string][] = [
  ['wireframe', 'Wireframe', 'Draw triangle edges'], ['bounds', 'Bounds', 'Bounding box with its dimensions'], ['skeleton', 'Skeleton', 'Draw the bones over the mesh']
]
// View toggles carry over from model to model; the up axis belongs to each file.
let remembered: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS }
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
/** Image types models reference that the viewer does not decode (it reads PNG, JPEG, TGA, BMP, GIF, WebP, AVIF and KTX2). */
const UNDECODED = ['psd', 'tif', 'tiff', 'exr', 'hdr', 'dds', 'iff', 'sgi', 'rgb']
function missingReason(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (name === 'embedded image') return 'Could not be decoded'
  return UNDECODED.includes(ext) ? `Genio's viewer cannot decode .${ext} images` : 'Not found beside or below the model, or not a readable image'
}

/**
 * Inventory's 3D preview. Three.js runs in a sandboxed frame (genio-viewer://app) with its own CSP;
 * this component only exchanges validated messages with it and draws the controls around it.
 * Selections reuse a warm frame. Failure, cancellation and the host watchdog discard a stuck frame.
 */
export function ModelViewer({ world, info, active = true }: { world: string; info: InventoryInfo; active?: boolean }) {
  const tooLarge = modelTooLarge(info)
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const request = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const [progress, setProgress] = useState('Starting viewer')
  const [geometry, setGeometry] = useState(false)
  const cancel = useRef<() => void>(() => {})
  const [failure, setFailure] = useState<Unavailable>()
  const [model, setModel] = useState<ModelLoaded>()
  const [settings, setSettings] = useState<ViewerSettings>(() => ({ ...remembered, upAxis: 'y' }))
  const current = useRef(settings)
  const [playback, setPlayback] = useState<ModelPlayback>({ clip: 0, playing: true, time: 0, speed: 1, loop: true, follow: true })
  const [tab, setTab] = useState<'stats' | 'textures'>('stats')
  const [previews, setPreviews] = useState<Record<number, string>>()
  const [popped, setPopped] = useState(false)
  const send = (message: ToViewer): void => frame.current?.contentWindow?.postMessage(message, '*')

  useEffect(() => {
    setModel(undefined); setPreviews(undefined); setFailure(undefined); setGeometry(false)
    current.current = { ...remembered, upAxis: 'y' }; setSettings(current.current)
    setProgress('Starting viewer')
    if (tooLarge) { ready.current = false; return }
    if (!active) return
    let alive = true
    let url: string | undefined, sent = false, phase = 'requesting access to the file'
    const id = ++request.current
    const release = (completeOnly = false): void => { if (url) void api().inventoryModelRelease(url, completeOnly).catch(() => {}) }
    const fail = (error: Unavailable): void => {
      if (!alive) return
      alive = false; ready.current = false
      clearTimeout(timer); send({ type: 'cancel' }); release()
      setFailure(error)
    }
    // Covers IPC/grant, chunk startup and ready handshake as well as parsing and textures.
    const timer = setTimeout(() => fail({ title: `${FAILED.timeout} after ${formatDuration(MODEL_PREVIEW_TIMEOUT_MS)}`, reason: `Loading stopped while ${phase}. Retry the preview or open the file in your 3D app.` }), MODEL_PREVIEW_TIMEOUT_MS)
    cancel.current = () => fail({ title: 'Preview cancelled', reason: `Loading was cancelled while ${phase}.` })
    const open = (): void => {
      if (!alive || !ready.current || !url || sent) return
      sent = true; phase = 'reading the model'; setProgress('Reading model')
      send({ type: 'settings', settings: current.current })
      send({ type: 'open', url, name: info.name, requestId: id })
    }
    const onMessage = (event: MessageEvent): void => {
      if (!alive || !frame.current || event.source !== frame.current.contentWindow) return
      const m = readViewerMessage(event.data)
      if (m?.type === 'ready') {
        ready.current = true; open(); return
      }
      if (m?.type === 'failed' && m.requestId === undefined && !sent) { fail({ title: FAILED[m.code], reason: m.reason }); return }
      if (m?.requestId !== id) return
      if (m.type === 'progress') {
        const p = m.progress
        phase = p.phase === 'textures' ? `loading textures (${p.completed} of ${p.total})` : p.phase === 'geometry' ? 'drawing the first frame' : `${p.phase} the model`
        if (p.phase === 'geometry') setGeometry(true)
        setProgress(p.phase === 'textures' ? `Textures ${p.completed} of ${p.total}` : p.phase === 'geometry' ? 'Geometry ready' : p.phase === 'parsing' ? 'Parsing model' : 'Reading model')
      } else if (m?.type === 'loaded') {
        clearTimeout(timer)
        release(true); setGeometry(true)
        // The viewer starts some files turned (3DS is Z-up by convention).
        if (m.model.upAxis !== current.current.upAxis) { current.current = { ...current.current, upAxis: m.model.upAxis }; setSettings(current.current) }
        setModel(m.model); setPlayback(p => ({ ...p, follow: !m.model.animationOnly }))
      }
      else if (m?.type === 'failed') fail({ title: FAILED[m.code], reason: m.reason })
      else if (m?.type === 'time') setPlayback(p => ({ ...p, clip: m.clip, time: m.time, playing: m.playing }))
      else if (m?.type === 'texture-previews') setPreviews(Object.fromEntries(m.previews.map(p => [p.id, p.url])))
    }
    window.addEventListener('message', onMessage)
    send({ type: 'hello' })
    void api().inventoryModelUrl(world, info.path).then(u => {
      url = u
      if (!alive) { release(); return }
      phase = ready.current ? 'reading the model' : 'starting the viewer'; open()
    }, e => fail({ title: FAILED.unreadable, reason: errText(e) }))
    return () => { alive = false; window.removeEventListener('message', onMessage); clearTimeout(timer); send({ type: 'cancel' }); release() }
  }, [world, info.path, info.mtimeMs, attempt, !!tooLarge, active])

  useEffect(() => {
    if (!popped) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPopped(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popped])

  useEffect(() => { if (tab === 'textures' && model?.textures.length && !previews) send({ type: 'texture-previews' }) }, [tab, model, previews])

  if (tooLarge) return <PreviewUnavailable {...tooLarge} />
  if (failure) return <><PreviewUnavailable {...failure} /><button className="btn sm" onClick={() => { ready.current = false; setAttempt(a => a + 1) }}>Retry</button></>

  const change = (patch: Partial<ViewerSettings>): void => {
    const next = { ...current.current, ...patch }
    current.current = next
    remembered = { ...next, upAxis: 'y' }
    setSettings(next)
    send({ type: 'settings', settings: next })
  }
  const play = (patch: Partial<ModelPlayback>): void => {
    setPlayback(p => ({ ...p, ...patch }))
    send({ type: 'playback', playback: patch })
  }
  const clip = model?.clips[playback.clip]
  const [w, h, d] = model?.stats.size ?? [0, 0, 0]
  return <div className={cx('model-viewer', popped && 'popped')}>
    {popped && <div className="model-viewer-backdrop" onClick={() => setPopped(false)} />}
    <div className="model-viewer-panel" role={popped ? 'dialog' : undefined} aria-label={popped ? `3D preview of ${info.name}` : undefined}>
      <div className="model-viewer-stage">
        <iframe ref={frame} src={VIEWER_APP_URL} sandbox="allow-scripts" title={`3D preview of ${info.name}`} referrerPolicy="no-referrer" />
        {!model && <div className={cx('model-viewer-loading', geometry && 'geometry-ready')} role="status"><span>{progress}</span><button className="btn sm" onClick={() => cancel.current()}>Cancel</button></div>}
        <div className="model-viewer-corner">
          <button className="btn sm ghost icon" title="Frame the model (or double-click it)" aria-label="Frame the model" disabled={!model} onClick={() => send({ type: 'frame' })}><Focus size={13} /></button>
          <button className="btn sm ghost icon" title={popped ? 'Back to the inspector (Esc)' : 'Pop out a larger view'} aria-label={popped ? 'Close the larger view' : 'Pop out a larger view'} onClick={() => setPopped(!popped)}>{popped ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        </div>
      </div>
      {model && <div className="model-viewer-side">
        <div className="model-viewer-tools" role="toolbar" aria-label="View options">
          {TOGGLES.filter(([k]) => k !== 'skeleton' || model.stats.bones > 0 && !model.animationOnly).map(([k, label, title]) =>
            <button key={k} className={cx('btn sm ghost', settings[k] && 'on')} title={title} aria-pressed={settings[k]} onClick={() => change({ [k]: !settings[k] })}>{label}</button>)}
          <button className={cx('btn sm ghost', settings.upAxis === 'z' && 'on')} title="Turn a Z-up model upright (glTF is Y-up; FBX, Collada and USD files that state Z-up are turned already)" aria-pressed={settings.upAxis === 'z'} onClick={() => change({ upAxis: settings.upAxis === 'z' ? 'y' : 'z' })}>Z-up</button>
        </div>
        {clip && <div className="model-viewer-player">
          <button className="btn sm ghost icon" title={playback.playing ? 'Pause' : 'Play'} aria-label={playback.playing ? 'Pause' : 'Play'} onClick={() => play({ playing: !playback.playing })}>{playback.playing ? <Pause size={13} /> : <Play size={13} />}</button>
          <input type="range" aria-label="Animation time" min={0} max={clip.duration} step={0.001} value={Math.min(playback.time, clip.duration)} onChange={e => play({ time: Number(e.target.value), playing: false })} />
          {model.clips.length > 1 && <select className="select compact" aria-label="Animation clip" value={playback.clip} onChange={e => play({ clip: Number(e.target.value), time: 0, playing: true })}>{model.clips.map((c, i) => <option key={i} value={i}>{c.name}</option>)}</select>}
        </div>}
        {model.animationOnly && <p className="model-viewer-note">No meshes in this file: showing its skeleton{model.clips.length ? ' and animation' : ''}.</p>}
        {model.missing.length > 0 && <p className="model-viewer-note warn">{count(model.missing.length, 'file')} did not load: {model.missing.slice(0, 4).join(', ')}{model.missing.length > 4 ? '…' : ''}</p>}
        {model.clayFallback > 0 && <p className="model-viewer-note warn">{count(model.clayFallback, 'material')} shown in clay because {model.clayFallback === 1 ? 'its texture' : 'their textures'} did not load.</p>}
        <div className="model-viewer-tabs" role="tablist" aria-label="Model details">
          <button role="tab" aria-selected={tab === 'stats'} onClick={() => setTab('stats')}>Stats</button>
          <button role="tab" aria-selected={tab === 'textures'} onClick={() => setTab('textures')}>Textures</button>
        </div>
        {tab === 'stats' ? <dl className="model-viewer-stats">
          <dt>Triangles</dt><dd>{model.stats.triangles.toLocaleString()}</dd>
          <dt>Materials</dt><dd>{model.stats.materials.toLocaleString()}</dd>
          <dt>Bones</dt><dd>{model.stats.bones.toLocaleString()}</dd>
          <dt>Size</dt><dd>{formatLength(w)} × {formatLength(h)} × {formatLength(d)}</dd>
        </dl> : <ul className="model-viewer-textures">
          {model.textures.map(t => <li key={t.id}>
            <span className="model-viewer-thumb">{previews?.[t.id] && <img src={previews[t.id]} alt="" />}</span>
            <div><strong>{t.name}</strong>
              <small>{t.width} × {t.height}</small>
              <small>{t.uses.join(', ')}</small></div>
          </li>)}
          {model.missing.map(name => <li key={`missing-${name}`} className="missing"><span className="model-viewer-thumb">?</span><div><strong>{name}</strong><small>{missingReason(name)}</small></div></li>)}
          {!model.textures.length && !model.missing.length && <li className="dim">This model has no textures.</li>}
        </ul>}
      </div>}
    </div>
  </div>
}
