import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Columns2, MessageCircle, Minus, Move, PanelRightClose } from 'lucide-react'
import type { InventoryContext } from '@shared/inventory-context'
import { ChatPanel } from '../views/Comms'
import { useStore } from '../store'
import { clampFloatingChat, readFloatingChat } from '../lib/inventory-chat'
import '../styles/inventory-chat.css'

export function InventoryChat({ context, inspector }: { context: InventoryContext; inspector: ReactNode }) {
  const [state, setState] = useState(readFloatingChat)
  const [inspect, setInspect] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const info = useStore(s => s.snap.wksps.find(m => m.name === 'main'))
  const last = useStore(s => s.chats.main?.at(-1)?.id)
  const generating = useStore(s => (s.chats.main ?? []).reduce((n, m) => n + (m.generating ?? 0)
    + (m.generation?.status === 'running' || m.generation?.status === 'placing' ? 1 : 0), 0))
  const seen = useRef(last)
  if (!state.collapsed && !(state.snapped && inspect)) seen.current = last
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
    <div className="inventory-right" style={{ visibility: state.snapped && !state.collapsed && !inspect ? 'hidden' : undefined, paddingTop: state.snapped && !state.collapsed ? 42 : 0 }}>{inspector}</div>
    <div ref={panel} className={`inventory-chat ${state.snapped ? 'snapped' : 'floating'} ${state.collapsed ? 'collapsed' : ''} ${inspect && state.snapped ? 'inspecting' : ''}`}
      style={!state.snapped && !state.collapsed ? { left: state.x, top: state.y, width: state.width, height: state.height } : undefined}>
      {state.collapsed && <button className="inventory-chat-pill" aria-label="Expand Genio chat" onClick={() => setState(s => ({ ...s, collapsed: false }))}><MessageCircle size={17} /><span className={`activity ${info?.activity}`}>●</span> Genio {seen.current !== last && <b>• New</b>}{info?.queued ? ` · ${info.queued} queued` : ''}{generating ? ` · ${generating} generating` : ''}<kbd>Ctrl Space</kbd></button>}
      <div className="inventory-chat-expanded" hidden={state.collapsed}>
        <header className="inventory-chat-bar">
          <button className="inventory-chat-grip" aria-label="Move Genio chat" title="Drag or use arrow keys to move; drag to the right edge to snap" onKeyDown={e => nudge(e, false)} onPointerDown={e => start(e, false)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null }}><Move size={13} /> Genio · {context.world}</button>
          {state.snapped && <button className="btn sm ghost" onClick={() => setInspect(!inspect)}>{inspect ? 'Chat' : 'Inspector'}</button>}
          <button className="btn sm ghost icon" aria-label={state.snapped ? 'Float Genio chat' : 'Snap Genio chat'} onClick={() => { setInspect(false); setState(s => ({ ...s, snapped: !s.snapped })) }}>{state.snapped ? <PanelRightClose size={15} /> : <Columns2 size={15} />}</button>
          <button className="btn sm ghost icon" aria-label="Collapse Genio chat" onClick={() => setState(s => ({ ...s, collapsed: true }))}><Minus size={15} /></button>
        </header>
        <div className="inventory-chat-content" hidden={state.snapped && inspect}><ChatPanel wksp="main" context={context} active={!state.collapsed && !(state.snapped && inspect)} /></div>
        {!state.snapped && <button className="inventory-chat-resize" aria-label="Resize Genio chat" title="Drag or use arrow keys to resize" onKeyDown={e => nudge(e, true)} onPointerDown={e => start(e, true)} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { gesture.current = null }} />}
      </div>
    </div>
  </>
}
