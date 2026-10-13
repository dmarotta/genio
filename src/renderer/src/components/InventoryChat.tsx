import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Columns2, MessageCircle, Minus, Move, PanelRightClose, ExternalLink } from 'lucide-react'
import { createPortal } from 'react-dom'
import { CHAT_POPOUT_HASH } from '@shared/chat-popout'
import { ChatDocument } from './ChatDocument'
import type { InventoryContext } from '@shared/inventory-context'
import { ChatPanel } from '../views/Comms'
import { PROJECT_WKSP, useStore } from '../store'
import { clampFloatingChat, readFloatingChat } from '../lib/inventory-chat'
import '../styles/inventory-chat.css'

export function InventoryChat(props: { context: InventoryContext; inspector: ReactNode }) {
  return PROJECT_WKSP ? <ProjectInventoryChat {...props} /> : <>{props.inspector}</>
}

function ProjectInventoryChat({ context, inspector }: { context: InventoryContext; inspector: ReactNode }) {
  const wksp = PROJECT_WKSP!
  const [state, setState] = useState(readFloatingChat)
  const [inspect, setInspect] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const [chatHost] = useState(() => document.createElement('div'))
  const [popout, setPopout] = useState<Window | null>(null)
  const pendingWindow = useRef<Window | null>(null)
  const [popoutError, setPopoutError] = useState('')
  const dock = () => {
    slot.current?.append(chatHost)
    setPopout(null)
    pendingWindow.current?.close()
    pendingWindow.current = null
  }
  useLayoutEffect(() => {
    chatHost.className = 'inventory-chat-content'
    slot.current?.append(chatHost)
    return () => { chatHost.remove(); pendingWindow.current?.close() }
  }, [chatHost])
  useEffect(() => {
    if (!popout) return
    const closed = () => {
      slot.current?.append(chatHost)
      pendingWindow.current = null
      setPopout(null)
    }
    popout.addEventListener('beforeunload', closed)
    return () => popout.removeEventListener('beforeunload', closed)
  }, [popout, chatHost])
  const detach = () => {
    if (pendingWindow.current && !pendingWindow.current.closed) { pendingWindow.current.focus(); return }
    const url = new URL(window.location.href); url.hash = CHAT_POPOUT_HASH
    const child = window.open(url.href, '_blank', `width=${state.width},height=${state.height + 44}`)
    if (!child) { setPopoutError('Could not open chat window. Try again.'); return }
    pendingWindow.current = child
    const ready = () => {
      if (child.closed || pendingWindow.current !== child) return
      child.document.title = `Genio chat · ${context.world}`
      for (const style of document.querySelectorAll('style, link[rel="stylesheet"]')) child.document.head.append(style.cloneNode(true))
      const root = child.document.getElementById('root')!
      root.className = 'inventory-chat popout'
      root.append(chatHost)
      setPopoutError(''); setPopout(child)
    }
    child.addEventListener('load', ready, { once: true })
  }
  const info = useStore(s => s.snap.wksps.find(m => m.name === wksp))
  const last = useStore(s => s.chats[wksp]?.at(-1)?.id)
  const generating = useStore(s => (s.chats[wksp] ?? []).reduce((n, m) => n + (m.generating ?? 0)
    + (m.generation?.status === 'running' || m.generation?.status === 'placing' ? 1 : 0), 0))
  const seen = useRef(last)
  if (popout || !state.collapsed && !(state.snapped && inspect)) seen.current = last
  useEffect(() => { sessionStorage.setItem('genio.inventory.chat', JSON.stringify(state)) }, [state])
  useLayoutEffect(() => {
    const host = panel.current!.parentElement!
    const fit = () => setState(s => clampFloatingChat(s, Math.max(0, host.clientWidth - 320), host.clientHeight))
    fit()
    const ro = new ResizeObserver(fit); ro.observe(host)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); setState(s => ({ ...s, collapsed: !s.collapsed })) } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const gesture = useRef<{ x: number; y: number; state: typeof state; resize: boolean } | null>(null)
  const start = (e: PointerEvent, resize: boolean) => {
    if (state.snapped || e.button !== 0) return
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { x: e.clientX, y: e.clientY, state, resize }
  }
  const move = (e: PointerEvent) => {
    const g = gesture.current, host = panel.current?.parentElement
    if (!g || !host) return
    const dx = e.clientX - g.x, dy = e.clientY - g.y
    setState(clampFloatingChat({ ...g.state, ...(g.resize ? { width: g.state.width + dx, height: g.state.height + dy } : { x: g.state.x + dx, y: g.state.y + dy }) }, host.clientWidth - 320, host.clientHeight))
  }
  const end = (e: PointerEvent) => {
    if (gesture.current && !gesture.current.resize && e.clientX > (panel.current!.parentElement!.getBoundingClientRect().right - 90)) setState(s => ({ ...s, snapped: true }))
    gesture.current = null
  }
  const nudge = (e: React.KeyboardEvent, resize: boolean) => {
    const host = panel.current?.parentElement
    if (state.snapped || !host || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const dx = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0
    const dy = e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0
    setState(s => clampFloatingChat({ ...s, ...(resize ? { width: s.width + dx, height: s.height + dy } : { x: s.x + dx, y: s.y + dy }) }, host.clientWidth - 320, host.clientHeight))
  }
  return <>
    <div className="inventory-right" style={{ visibility: !popout && state.snapped && !state.collapsed && !inspect ? 'hidden' : undefined, paddingTop: !popout && state.snapped && !state.collapsed ? 42 : 0 }}>{inspector}</div>
    <div ref={panel} className={`inventory-chat ${state.snapped && !popout ? 'snapped' : 'floating'} ${state.collapsed || popout ? 'collapsed' : ''} ${inspect && state.snapped && !popout ? 'inspecting' : ''}`}
      style={!state.snapped && !state.collapsed && !popout ? { left: state.x, top: state.y, width: state.width, height: state.height } : undefined}>
      {popout && <div className="inventory-chat-pill"><button className="btn sm ghost" onClick={() => popout.focus()}>Focus Genio chat</button><button className="btn sm ghost" onClick={dock}>Return chat</button></div>}
      {state.collapsed && !popout && <button className="inventory-chat-pill" aria-label="Expand Genio chat" onClick={() => setState(s => ({ ...s, collapsed: false }))}><MessageCircle size={17} /><span className={`activity ${info?.activity}`}>●</span> Genio {seen.current !== last && <b>• New</b>}{info?.queued ? ` · ${info.queued} queued` : ''}{generating ? ` · ${generating} generating` : ''}<kbd>Ctrl Space</kbd></button>}
      <div className="inventory-chat-expanded" hidden={state.collapsed || !!popout}>
        <header className="inventory-chat-bar">
          <button className="inventory-chat-grip" aria-label="Move Genio chat" title="Drag or use arrow keys to move; drag to the right edge to snap" onKeyDown={e => nudge(e, false)} onPointerDown={e => start(e, false)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null }}><Move size={13} /> Genio · {context.world}</button>
          {state.snapped && <button className="btn sm ghost" onClick={() => setInspect(!inspect)}>{inspect ? 'Chat' : 'Inspector'}</button>}
          <button className="btn sm ghost icon" aria-label="Pop out Genio chat" title="Move chat outside Genio (always on top)" onClick={detach}><ExternalLink size={15} /></button>
          <button className="btn sm ghost icon" aria-label={state.snapped ? 'Float Genio chat' : 'Snap Genio chat'} onClick={() => { setInspect(false); setState(s => ({ ...s, snapped: !s.snapped })) }}>{state.snapped ? <PanelRightClose size={15} /> : <Columns2 size={15} />}</button>
          <button className="btn sm ghost icon" aria-label="Collapse Genio chat" onClick={() => setState(s => ({ ...s, collapsed: true }))}><Minus size={15} /></button>
        </header>
        {popoutError && <div role="alert">{popoutError}</div>}
        <div ref={slot} className="inventory-chat-content" hidden={state.snapped && inspect} />
        {!state.snapped && <button className="inventory-chat-resize" aria-label="Resize Genio chat" title="Drag or use arrow keys to resize" onKeyDown={e => nudge(e, true)} onPointerDown={e => start(e, true)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null }} />}
      </div>
    </div>
    {createPortal(<ChatDocument.Provider value={popout?.document}><ChatPanel wksp={wksp} context={context} active={!!popout || !state.collapsed && !(state.snapped && inspect)} /></ChatDocument.Provider>, chatHost)}
    {popout && createPortal(<header className="inventory-chat-bar popout-bar"><span>Genio · {context.world} · Always on top</span><button className="btn sm ghost" onClick={dock}>Return chat</button></header>, popout.document.getElementById('root')!)}
  </>
}
