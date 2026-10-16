import { useEffect, useRef, useState } from 'react'
import { DEFAULT_VIEWER_SETTINGS, VIEWER_APP_URL, readViewerMessage, type ModelLoaded, type ToViewer, type ViewerSettings } from '@shared/model-viewer'
import { modellerCaption, type ModellerActivity, type ModellerLive } from '@shared/modeller'
import { api } from '../store'
import { cx } from '../lib/format'
import { useNow } from './ui'
import '../styles/modeller-view.css'

type Toggle = 'wireframe' | 'clay' | 'turntable'
const TOGGLES: [Toggle, string, string][] = [
  ['wireframe', 'Wireframe', 'Draw triangle edges'], ['clay', 'Clay', 'Plain clay material instead of the model\'s colours'], ['turntable', 'Turntable', 'Slowly orbit the model']
]
// The toggles carry over from unit to unit.
let remembered: Pick<ViewerSettings, Toggle> = { wireframe: false, clay: false, turntable: false }

/** How often the unit page reads the model while Blender runs: a batch lands a step every 600 ms or so. */
const RUNNING_POLL_MS = 250

/**
 * A unit's Modeller state; null while it has no model. While `poll` (its terminal is live) main pushes
 * each change as it happens (a step lands, the next starts, a script appears), and the state is also read
 * again every `everyMs` as the fallback: at 1 s or faster (the unit page) every 250 ms while a step runs.
 */
export function useModellerLive(id: string, poll: boolean, everyMs = 1000): ModellerLive | null {
  const [live, setLive] = useState<ModellerLive | null>(null)
  const ms = live?.running && everyMs <= 1000 ? RUNNING_POLL_MS : everyMs
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api().modellerLive(id).then(l => { if (alive) setLive(prev => prev?.stamp === l?.stamp ? prev : l) }, () => {})
    }
    if (ms === everyMs) load()
    const iv = poll ? window.setInterval(load, ms) : undefined
    return () => { alive = false; if (iv) window.clearInterval(iv) }
  }, [id, poll, everyMs, ms])
  useEffect(() => {
    if (!poll) return
    return window.genio?.on(e => { if (e.type === 'modeller-live' && e.taskId === id) setLive(prev => prev?.stamp === e.live?.stamp ? prev : e.live) })
  }, [id, poll])
  return live
}

const firstLine = (s: string): string => s.split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? ''

/**
 * The Modeller's live view: the sandboxed viewer frame showing the head step, hot swapped as each step
 * lands (the camera stays, changed parts glow), with the running step's caption as a live status.
 * Without `live` (no model started yet) the frame shows the viewer's empty scene. With `activity` (the
 * unit is working) the caption also says what it does while no step runs (see modellerCaption).
 */
export function ModellerView({ live, activity }: { live: ModellerLive | null; activity?: ModellerActivity | null }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)
  const request = useRef(0)
  const sent = useRef<string | undefined>(undefined)
  const [model, setModel] = useState<ModelLoaded>()
  const [error, setError] = useState('')
  const [settings, setSettings] = useState<ViewerSettings>(() => ({ ...DEFAULT_VIEWER_SETTINGS, ...remembered }))
  const now = useNow(1000)
  const head = live?.steps.at(-1)
  const target = useRef({ url: head?.glb ?? undefined, name: '', settings })
  target.current = { url: head?.glb ?? undefined, name: head && live ? `${live.model} step ${head.n}` : live?.model ?? '', settings }
  const send = (message: ToViewer): void => frame.current?.contentWindow?.postMessage(message, '*')
  const show = (): void => {
    const { url, name } = target.current
    if (!ready.current || !url || sent.current === url) return
    sent.current = url
    send({ type: 'open', url, name, requestId: ++request.current, keep: true })
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return
      const m = readViewerMessage(event.data)
      if (m?.type === 'ready') {
        if (ready.current) return
        ready.current = true
        send({ type: 'settings', settings: target.current.settings })
        show()
      } else if (m?.type === 'failed' && (m.requestId === undefined || m.requestId === request.current)) setError(m.reason)
      else if (m?.type === 'loaded' && m.requestId === request.current) { setModel(m.model); setError('') }
    }
    window.addEventListener('message', onMessage)
    send({ type: 'hello' })
    return () => window.removeEventListener('message', onMessage)
  }, [])
  useEffect(show, [head?.glb])

  const change = (k: Toggle): void => {
    const next = { ...settings, [k]: !settings[k] }
    remembered = { wireframe: next.wireframe, clay: next.clay, turntable: next.turntable }
    setSettings(next)
    send({ type: 'settings', settings: next })
  }

  const run = live?.running, failed = live?.failure
  // Before the first step the scene is empty: the caption is what the unit is doing, while it works.
  const caption = modellerCaption(live, activity, now)
  const d = model?.diff
  const parts = d && d.added + d.changed + d.removed > 0
    ? `+${d.added} added · ${d.changed} changed · −${d.removed} removed${d.names.length ? `: ${d.names.slice(0, 4).join(', ')}${d.names.length > 4 ? '…' : ''}` : ''}`
    : ''
  return <div className="modeller-view">
    <div className="modeller-view-stage">
      <iframe ref={frame} src={VIEWER_APP_URL} sandbox="allow-scripts" title={live ? `Live view of ${live.model}` : 'Live 3D view'} referrerPolicy="no-referrer" />
      {caption && <div className={cx('modeller-view-caption', caption.tone === 'warn' && 'warn')} role="status">
        {caption.tone === 'run' && <i className="dot pulse" />}
        <span className="modeller-view-text" title={caption.text}>{caption.text}</span>
        {caption.side && <span className="modeller-view-side" title={caption.side}>{caption.side}</span>}
        {caption.clock && <span className="modeller-view-clock">{caption.side ? `· ${caption.clock}` : caption.clock}</span>}
      </div>}
    </div>
    <div className="modeller-view-tools" role="toolbar" aria-label="View options">
      {TOGGLES.map(([k, label, title]) =>
        <button key={k} className={cx('btn sm ghost', settings[k] && 'on')} title={title} aria-pressed={settings[k]} onClick={() => change(k)}>{label}</button>)}
    </div>
    {failed && !run && <p className="modeller-view-note warn" title={failed.error}>{firstLine(failed.error)}</p>}
    {error && <p className="modeller-view-note warn">{error}</p>}
    {model && <p className="modeller-view-note">{model.stats.triangles.toLocaleString()} triangles · {model.stats.meshes.toLocaleString()} parts{live && live.branch !== 'main' ? ` · branch ${live.branch}` : ''}</p>}
    {parts && <p className="modeller-view-note">{parts}</p>}
  </div>
}
