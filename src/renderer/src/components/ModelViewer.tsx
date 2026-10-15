import { useEffect, useRef, useState } from 'react'
import { Crosshair, Focus, Maximize2, Minimize2, Pause, Play, Repeat } from 'lucide-react'
import type { InventoryInfo } from '@shared/inventory'
import { DEFAULT_VIEWER_SETTINGS, MODEL_PREVIEW_TIMEOUT_MS, VIEWER_APP_URL, formatLength, readViewerMessage, type ModelFailure, type ModelLoaded, type ModelPlayback, type ToViewer, type ViewerBackground, type ViewerSettings } from '@shared/model-viewer'
import { api, errText } from '../store'
import { cx } from '../lib/format'
import { modelTooLarge, type PreviewUnavailable as Unavailable } from '../lib/inventory'
import { PreviewUnavailable } from './PreviewUnavailable'
import '../styles/model-viewer.css'

const SPEEDS = [0.25, 0.5, 1, 1.5, 2]
const BACKGROUNDS: ViewerBackground[] = ['dark', 'light', 'checker']
const FAILED: Record<ModelFailure, string> = { 'too-large': 'Too large to preview', timeout: 'Preview stopped', unreadable: 'This model can\'t be previewed', 'no-webgl': '3D previews need WebGL' }
type Toggle = 'wireframe' | 'grid' | 'bounds' | 'skeleton' | 'clay'
const TOGGLES: [Toggle, string, string][] = [
  ['wireframe', 'Wireframe', 'Draw triangle edges'], ['grid', 'Grid', 'Floor grid under the model'], ['bounds', 'Bounds', 'Bounding box with its dimensions'],
  ['skeleton', 'Skeleton', 'Draw the bones over the mesh'], ['clay', 'Clay', 'Plain clay material instead of the file\'s materials']
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
 * Removing the frame (failure, timeout, another selection) stops its work and frees its WebGL context.
 */
export function ModelViewer({ world, info, path }: { world: string; info: InventoryInfo; path: string }) {
  const tooLarge = modelTooLarge(info)
  const frame = useRef<HTMLIFrameElement>(null)
  const [url, setUrl] = useState<string>()
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
    if (tooLarge) return
    let alive = true
    api().inventoryModelUrl(world, info.path).then(u => { if (alive) setUrl(u) }, e => { if (alive) setFailure({ title: FAILED.unreadable, reason: errText(e) }) })
    return () => { alive = false }
  }, [world, info.path])

  useEffect(() => {
    if (!url || failure) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const m = readViewerMessage(event.data)
      if (m?.type === 'ready') {
        send({ type: 'settings', settings: current.current })
        send({ type: 'open', url, name: info.name })
        clearTimeout(timer)
        timer = setTimeout(() => setFailure({ title: `${FAILED.timeout} after ${MODEL_PREVIEW_TIMEOUT_MS / 1000} s`, reason: 'The model took too long to load, so loading was cancelled. Open it in your 3D app instead.' }), MODEL_PREVIEW_TIMEOUT_MS)
      } else if (m?.type === 'loaded') {
        clearTimeout(timer)
        // The viewer starts some files turned (3DS is Z-up by convention).
        if (m.model.upAxis !== current.current.upAxis) { current.current = { ...current.current, upAxis: m.model.upAxis }; setSettings(current.current) }
        setModel(m.model); setPlayback(p => ({ ...p, follow: !m.model.animationOnly }))
      }
      else if (m?.type === 'failed') { clearTimeout(timer); setFailure({ title: FAILED[m.code], reason: m.reason }) }
      else if (m?.type === 'time') setPlayback(p => ({ ...p, clip: m.clip, time: m.time, playing: m.playing }))
      else if (m?.type === 'texture-previews') setPreviews(Object.fromEntries(m.previews.map(p => [p.id, p.url])))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timer) }
  }, [url, failure])

  useEffect(() => {
    if (!popped) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setPopped(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popped])

  useEffect(() => { if (tab === 'textures' && model?.textures.length && !previews) send({ type: 'texture-previews' }) }, [tab, model, previews])

  if (tooLarge) return <PreviewUnavailable {...tooLarge} path={path} />
  if (failure) return <PreviewUnavailable {...failure} path={path} />

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
        {url && <iframe ref={frame} src={VIEWER_APP_URL} sandbox="allow-scripts" title={`3D preview of ${info.name}`} referrerPolicy="no-referrer" />}
        {!model && <div className="model-viewer-loading">Loading model…</div>}
        <div className="model-viewer-corner">
          <button className="btn sm ghost icon" title="Frame the model (or double-click it)" aria-label="Frame the model" disabled={!model} onClick={() => send({ type: 'frame' })}><Focus size={13} /></button>
          <button className="btn sm ghost icon" title={popped ? 'Back to the inspector (Esc)' : 'Pop out a larger view'} aria-label={popped ? 'Close the larger view' : 'Pop out a larger view'} onClick={() => setPopped(!popped)}>{popped ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        </div>
      </div>
      {model && <div className="model-viewer-side">
        <div className="model-viewer-tools" role="toolbar" aria-label="View options">
          {TOGGLES.filter(([k]) => k !== 'skeleton' || model.stats.bones > 0 && !model.animationOnly).map(([k, label, title]) =>
            <button key={k} className={cx('btn sm ghost', settings[k] && 'on')} title={title} aria-pressed={settings[k]} onClick={() => change({ [k]: !settings[k] })}>{label}</button>)}
          <button className="btn sm ghost" title="Background" onClick={() => change({ background: BACKGROUNDS[(BACKGROUNDS.indexOf(settings.background) + 1) % BACKGROUNDS.length] })}>BG: {settings.background[0].toUpperCase() + settings.background.slice(1)}</button>
          <button className={cx('btn sm ghost', settings.upAxis === 'z' && 'on')} title="Turn a Z-up model upright (glTF is Y-up; FBX, Collada and USD files that state Z-up are turned already)" aria-pressed={settings.upAxis === 'z'} onClick={() => change({ upAxis: settings.upAxis === 'z' ? 'y' : 'z' })}>Z-up</button>
        </div>
        {clip && <div className="model-viewer-player">
          <button className="btn sm ghost icon" title={playback.playing ? 'Pause' : 'Play'} aria-label={playback.playing ? 'Pause' : 'Play'} onClick={() => play({ playing: !playback.playing })}>{playback.playing ? <Pause size={13} /> : <Play size={13} />}</button>
          <input type="range" aria-label="Animation time" min={0} max={clip.duration} step={0.001} value={Math.min(playback.time, clip.duration)} onChange={e => play({ time: Number(e.target.value), playing: false })} />
          <span className="model-viewer-time">{playback.time.toFixed(2)} / {clip.duration.toFixed(2)} s</span>
          <select className="select compact" aria-label="Playback speed" value={playback.speed} onChange={e => play({ speed: Number(e.target.value) })}>{SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}</select>
          {model.clips.length > 1 && <select className="select compact" aria-label="Animation clip" value={playback.clip} onChange={e => play({ clip: Number(e.target.value), time: 0, playing: true })}>{model.clips.map((c, i) => <option key={i} value={i}>{c.name}</option>)}</select>}
          <button className={cx('btn sm ghost icon', playback.loop && 'on')} title="Loop" aria-label="Loop" aria-pressed={playback.loop} onClick={() => play({ loop: !playback.loop })}><Repeat size={13} /></button>
          <button className={cx('btn sm ghost icon', playback.follow && 'on')} title={playback.follow ? 'Camera follows the root (click to let it travel)' : 'Camera fixed (click to follow the root)'} aria-label="Follow the root" aria-pressed={playback.follow} onClick={() => play({ follow: !playback.follow })}><Crosshair size={13} /></button>
        </div>}
        {model.animationOnly && <p className="model-viewer-note">No meshes in this file: showing its skeleton{model.clips.length ? ' and animation' : ''}.</p>}
        {model.unityClips && <p className="model-viewer-note">Clip names and frame ranges come from the model's Unity .meta.</p>}
        {model.missing.length > 0 && <p className="model-viewer-note warn">{count(model.missing.length, 'file')} did not load: {model.missing.slice(0, 4).join(', ')}{model.missing.length > 4 ? '…' : ''}</p>}
        {model.clayFallback > 0 && <p className="model-viewer-note warn">{count(model.clayFallback, 'material')} shown in clay because {model.clayFallback === 1 ? 'its texture' : 'their textures'} did not load.</p>}
        <div className="model-viewer-tabs" role="tablist" aria-label="Model details">
          <button role="tab" aria-selected={tab === 'stats'} onClick={() => setTab('stats')}>Stats</button>
          <button role="tab" aria-selected={tab === 'textures'} onClick={() => setTab('textures')}>Textures ({model.textures.length})</button>
        </div>
        {tab === 'stats' ? <dl className="model-viewer-stats">
          <dt>Triangles</dt><dd>{model.stats.triangles.toLocaleString()}</dd>
          <dt>Vertices</dt><dd>{model.stats.vertices.toLocaleString()}</dd>
          <dt>Meshes</dt><dd>{model.stats.meshes.toLocaleString()}</dd>
          <dt>Materials</dt><dd>{model.stats.materials.toLocaleString()}</dd>
          <dt>Textures</dt><dd>{model.stats.textures.toLocaleString()}</dd>
          <dt>Bones</dt><dd>{model.stats.bones.toLocaleString()}</dd>
          <dt>Clips</dt><dd>{model.clips.length ? model.clips.map(c => `${c.name} (${c.duration.toFixed(2)} s)`).join(', ') : 'None'}</dd>
          <dt>Size</dt><dd>{formatLength(w)} × {formatLength(h)} × {formatLength(d)}</dd>
          <dt>Format</dt><dd>{model.format}</dd>
          <dt>Units</dt><dd>{model.units}{settings.upAxis !== model.upAxis ? settings.upAxis === 'z' ? '; turned from Z-up' : '; shown as stored' : ''}</dd>
          <dt>Loaded in</dt><dd>{model.loadMs.toLocaleString()} ms</dd>
        </dl> : <ul className="model-viewer-textures">
          {model.textures.map(t => <li key={t.id}>
            <span className="model-viewer-thumb">{previews?.[t.id] && <img src={previews[t.id]} alt="" />}</span>
            <div><strong>{t.name}</strong>
              <small>{t.width} × {t.height}{t.compressed ? ' · KTX2' : ''}{t.original ? ` · downscaled from ${t.original.width} × ${t.original.height}` : ''}</small>
              <small>{t.uses.join(', ')}</small></div>
          </li>)}
          {model.missing.map(name => <li key={`missing-${name}`} className="missing"><span className="model-viewer-thumb">?</span><div><strong>{name}</strong><small>{missingReason(name)}</small></div></li>)}
          {!model.textures.length && !model.missing.length && <li className="dim">This model has no textures.</li>}
        </ul>}
      </div>}
    </div>
  </div>
}
