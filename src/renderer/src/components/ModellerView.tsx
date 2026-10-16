import { useEffect, useRef, useState } from 'react'
import { DEFAULT_VIEWER_SETTINGS, VIEWER_APP_URL, readViewerMessage, type ModelLoaded, type ToViewer, type ViewerSettings } from '@shared/model-viewer'
import type { ModellerLive } from '@shared/modeller'
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

/** A unit's Modeller state, read again every `everyMs` while `poll` (its terminal is live); null while it has no model. */
export function useModellerLive(id: string, poll: boolean, everyMs = 1000): ModellerLive | null {
  const [live, setLive] = useState<ModellerLive | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api().modellerLive(id).then(l => { if (alive) setLive(prev => prev?.stamp === l?.stamp ? prev : l) }, () => {})
    }
    load()
    const iv = poll ? window.setInterval(load, everyMs) : undefined
    return () => { alive = false; if (iv) window.clearInterval(iv) }
  }, [id, poll, everyMs])
  return live
}

const firstLine = (s: string): string => s.split(/\r?\n/).map(x => x.trim()).find(Boolean) ?? ''

/**
 * The Modeller's live view: the sandboxed viewer frame showing the head step, hot swapped as each step
 * lands (the camera stays, changed parts glow), with the running step's caption as a live status.
 * Without `live` (no model started yet) the frame shows the viewer's empty scene.
 */
export function ModellerView({ live }: { live: ModellerLive | null }) {
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
  // Before the first step the scene stays empty: no caption.
  const status = run ? `Step ${run.n} · ${run.caption}…` : failed ? `Step ${failed.n} failed · ${failed.caption}` : head ? `Step ${head.n} · ${head.caption}` : ''
  const d = model?.diff
  const parts = d && d.added + d.changed + d.removed > 0
    ? `+${d.added} added · ${d.changed} changed · −${d.removed} removed${d.names.length ? `: ${d.names.slice(0, 4).join(', ')}${d.names.length > 4 ? '…' : ''}` : ''}`
    : ''
  return <div className="modeller-view">
    <div className="modeller-view-stage">
      <iframe ref={frame} src={VIEWER_APP_URL} sandbox="allow-scripts" title={live ? `Live view of ${live.model}` : 'Live 3D view'} referrerPolicy="no-referrer" />
      {status && <div className={cx('modeller-view-caption', failed && !run && 'warn')} role="status">
        {run && <i className="dot pulse" />}
        <span className="modeller-view-text" title={status}>{status}</span>
        {run && <span className="mute">{Math.max(0, Math.round((now - run.startedAt) / 1000))} s</span>}
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
