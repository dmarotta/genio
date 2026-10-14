import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ExternalLink, MessageCircle, Minus, Move } from 'lucide-react'
import { createPortal } from 'react-dom'
import { CHAT_POPOUT_HASH } from '@shared/chat-popout'
import { ChatDocument } from './ChatDocument'
import { ChatPanel } from '../views/Comms'
import { PROJECT_WKSP, PROJECT_WINDOW, useStore } from '../store'
import { clampFloatingPanel, PANEL_MIN, readFloatingPanel, writeFloatingPanel, type FloatingPanelState } from '../lib/floating-panel'
import { PANEL_OPEN_EVENT, panelVisibleOn, screenContextFor, screenLabel, usePublishedScreen } from '../lib/screen-context'
import '../styles/genio-panel.css'

/** The project's full Genio chat, floating over every screen but Chat. Mounted once in the window shell. */
export function GenioPanel() {
  return PROJECT_WKSP && PROJECT_WINDOW ? <ProjectGenioPanel wksp={PROJECT_WKSP} project={PROJECT_WINDOW} /> : null
}

type Edge = 'move' | 'se' | 'nw'

function ProjectGenioPanel({ wksp, project }: { wksp: string; project: string }) {
  const view = useStore(s => s.view)
  const visible = panelVisibleOn(view)
  const published = usePublishedScreen(view)
  const context = useMemo(() => screenContextFor(view, project, published), [view, project, published])
  const [state, setState] = useState(() => readFloatingPanel(project))
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const panel = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const [chatHost] = useState(() => document.createElement('div'))
  const [popout, setPopout] = useState<Window | null>(null)
  const pendingWindow = useRef<Window | null>(null)
  const [popoutError, setPopoutError] = useState('')
  // The preferred geometry is kept; what is drawn is always clamped to the current stage.
  const shown = clampFloatingPanel(state, bounds.width, bounds.height)

  useEffect(() => { writeFloatingPanel(project, state) }, [project, state])
  useLayoutEffect(() => {
    const host = panel.current!.parentElement!
    const fit = (): void => setBounds(b => b.width === host.clientWidth && b.height === host.clientHeight ? b : { width: host.clientWidth, height: host.clientHeight })
    fit()
    const ro = new ResizeObserver(fit); ro.observe(host)
    window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit) }
  }, [])

  // The chat lives in one detached node that moves between the panel and the native pop-out.
  const mounted = visible || !!popout
  useLayoutEffect(() => {
    chatHost.className = 'genio-panel-content'
    if (!popout && slot.current && chatHost.parentElement !== slot.current) slot.current.append(chatHost)
  })
  useEffect(() => () => { chatHost.remove(); pendingWindow.current?.close() }, [chatHost])
  const dock = (): void => {
    slot.current?.append(chatHost)
    setPopout(null)
    pendingWindow.current?.close()
    pendingWindow.current = null
  }
  useEffect(() => {
    if (!popout) return
    const closed = (): void => {
      slot.current?.append(chatHost)
      pendingWindow.current = null
      setPopout(null)
    }
    popout.addEventListener('beforeunload', closed)
    return () => popout.removeEventListener('beforeunload', closed)
  }, [popout, chatHost])
  const detach = (): void => {
    if (pendingWindow.current && !pendingWindow.current.closed) { pendingWindow.current.focus(); return }
    const url = new URL(window.location.href); url.hash = CHAT_POPOUT_HASH
    const child = window.open(url.href, '_blank', `width=${shown.width},height=${shown.height + 44}`)
    if (!child) { setPopoutError('Could not open chat window. Try again.'); return }
    pendingWindow.current = child
    const ready = (): void => {
      if (child.closed || pendingWindow.current !== child) return
      child.document.title = `Genio chat · ${project}`
      for (const style of document.querySelectorAll('style, link[rel="stylesheet"]')) child.document.head.append(style.cloneNode(true))
      const root = child.document.getElementById('root')!
      root.className = 'genio-panel popout'
      root.append(chatHost)
      setPopoutError(''); setPopout(child)
    }
    child.addEventListener('load', ready, { once: true })
  }

  const info = useStore(s => s.snap.wksps.find(m => m.name === wksp))
  const last = useStore(s => s.chats[wksp]?.at(-1)?.id)
  const generating = useStore(s => s.generating[wksp]?.length ?? 0)
  const seen = useRef(last)
  if (popout || (visible && !state.collapsed)) seen.current = last

  useEffect(() => {
    const open = (): void => { if (popout) popout.focus(); else setState(s => ({ ...s, collapsed: false })) }
    const key = (e: globalThis.KeyboardEvent): void => {
      if (!e.ctrlKey || e.code !== 'Space' || !visible) return
      e.preventDefault()
      if (popout) popout.focus(); else setState(s => ({ ...s, collapsed: !s.collapsed }))
    }
    window.addEventListener('keydown', key)
    window.addEventListener(PANEL_OPEN_EVENT, open)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener(PANEL_OPEN_EVENT, open) }
  }, [visible, popout])

  const gesture = useRef<{ x: number; y: number; from: FloatingPanelState; edge: Edge } | null>(null)
  const reshape = (from: FloatingPanelState, edge: Edge, dx: number, dy: number): FloatingPanelState => {
    if (edge === 'move') return { ...from, x: from.x + dx, y: from.y + dy }
    if (edge === 'se') return { ...from, width: from.width + dx, height: from.height + dy }
    const width = Math.min(from.x + from.width, Math.max(PANEL_MIN.width, from.width - dx)), height = Math.min(from.y + from.height, Math.max(PANEL_MIN.height, from.height - dy))
    return { ...from, x: from.x + from.width - width, y: from.y + from.height - height, width, height }
  }
  const start = (e: PointerEvent, edge: Edge): void => {
    if (e.button !== 0) return
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { x: e.clientX, y: e.clientY, from: shown, edge }
  }
  const move = (e: PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    setState(clampFloatingPanel(reshape(g.from, g.edge, e.clientX - g.x, e.clientY - g.y), bounds.width, bounds.height))
  }
  const end = (): void => { gesture.current = null }
  const nudge = (e: KeyboardEvent, edge: Edge): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const dx = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0
    const dy = e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0
    setState(clampFloatingPanel(reshape(shown, edge, dx, dy), bounds.width, bounds.height))
  }
  const handlers = (edge: Edge) => ({ onKeyDown: (e: KeyboardEvent) => nudge(e, edge), onPointerDown: (e: PointerEvent) => start(e, edge), onPointerMove: move, onPointerUp: end, onPointerCancel: end })

  const where = screenLabel(view)
  const expanded = !state.collapsed && !popout
  return <>
    <div ref={panel} hidden={!visible} className={`genio-panel ${expanded ? 'floating' : 'collapsed'}`} aria-label="Genio panel"
      style={expanded ? { left: shown.x, top: shown.y, width: shown.width, height: shown.height } : undefined}>
      {popout && <div className="genio-panel-pill"><span>Genio is in its own window</span><button className="btn sm ghost" onClick={() => popout.focus()}>Focus Genio chat</button><button className="btn sm ghost" onClick={dock}>Return chat</button></div>}
      {state.collapsed && !popout && <button className="genio-panel-pill" aria-label="Expand Genio chat" onClick={() => setState(s => ({ ...s, collapsed: false }))}>
        <MessageCircle size={17} /><span className={`activity ${info?.activity ?? ''}`}>●</span> Genio {seen.current !== last && <b>• New</b>}{info?.queued ? ` · ${info.queued} queued` : ''}{generating ? ` · ${generating} generating` : ''}<kbd>Ctrl Space</kbd>
      </button>}
      <div className="genio-panel-expanded" hidden={!expanded}>
        <header className="genio-panel-bar">
          <button className="genio-panel-grip" aria-label="Move Genio chat" title="Drag anywhere, or use the arrow keys" {...handlers('move')}><Move size={13} /> Genio · {where}</button>
          {generating > 0 && <span className="genio-panel-busy">{generating} generating</span>}
          <button className="btn sm ghost icon" aria-label="Pop out Genio chat" title="Move chat outside Genio (always on top)" onClick={detach}><ExternalLink size={15} /></button>
          <button className="btn sm ghost icon" aria-label="Collapse Genio chat" title="Collapse (Ctrl+Space)" onClick={() => setState(s => ({ ...s, collapsed: true }))}><Minus size={15} /></button>
        </header>
        {popoutError && <div role="alert" className="genio-panel-error">{popoutError}</div>}
        <div ref={slot} className="genio-panel-slot" />
        <button className="genio-panel-resize nw" aria-label="Resize Genio chat from top left" title="Drag or use arrow keys to resize" {...handlers('nw')} />
        <button className="genio-panel-resize se" aria-label="Resize Genio chat" title="Drag or use arrow keys to resize" {...handlers('se')} />
      </div>
    </div>
    {mounted && createPortal(<ChatDocument.Provider value={popout?.document}><ChatPanel wksp={wksp} context={context} surface="panel" active={!!popout || expanded} /></ChatDocument.Provider>, chatHost)}
    {popout && createPortal(<header className="genio-panel-bar popout-bar"><span>Genio · {project} · {where} · Always on top</span><button className="btn sm ghost" onClick={dock}>Return chat</button></header>, popout.document.getElementById('root')!)}
  </>
}
