import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Check, Globe, Plus, Users, X } from 'lucide-react'
import { go, setDock, useStore } from '../store'
import {
  MAIN_PANEL, canClose, closePanel, focusPanel, hasUnread, isOpen, movePanel, openPanel, resizeSplit,
  type DockGroup, type DockNode, type DockSplit, type DropZone
} from '../lib/dock'
import { cx } from '../lib/format'
import { requestSystemsSection } from '../views/Systems'

/**
 * Unity-style dock for the chat screen: every chat is a tab that can be
 * reordered, grouped with others, or docked on any edge of a pane to split it.
 */

const DRAG_MIME = 'application/x-genio-chat'

interface DragCtx {
  dragging: string | null
  setDragging: (p: string | null) => void
  render: (panel: string) => ReactNode
}

const Ctx = createContext<DragCtx>({ dragging: null, setDragging: () => undefined, render: () => null })

export function ChatDock({ render }: { render: (panel: string) => ReactNode }) {
  const root = useStore((s) => s.dock.root)
  const [dragging, setDragging] = useState<string | null>(null)
  return (
    <Ctx.Provider value={{ dragging, setDragging, render }}>
      <div className={cx('dock', dragging && 'dragging')}>
        <Node node={root} />
      </div>
    </Ctx.Provider>
  )
}

function Node({ node }: { node: DockNode }) {
  return node.type === 'group' ? <Group g={node} /> : <Split s={node} />
}

function Split({ s }: { s: DockSplit }) {
  const ref = useRef<HTMLDivElement>(null)
  const startDrag = (i: number, e: ReactPointerEvent<HTMLDivElement>): void => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const total = s.dir === 'row' ? box.width : box.height
    const origin = s.dir === 'row' ? e.clientX : e.clientY
    const start = s.sizes.slice()
    const move = (ev: PointerEvent): void => {
      const delta = ((s.dir === 'row' ? ev.clientX : ev.clientY) - origin) / (total || 1)
      const pair = start[i] + start[i + 1]
      const a = Math.min(pair - 0.08, Math.max(0.08, start[i] + delta))
      const sizes = start.slice()
      sizes[i] = a
      sizes[i + 1] = pair - a
      setDock((d) => resizeSplit(d, s.id, sizes))
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  return (
    <div ref={ref} className={cx('dock-split', s.dir)}>
      {s.children.map((c, i) => (
        <SplitChild key={c.id} grow={s.sizes[i]} last={i === s.children.length - 1} dir={s.dir} onResize={(e) => startDrag(i, e)}>
          <Node node={c} />
        </SplitChild>
      ))}
    </div>
  )
}

function SplitChild({ grow, last, dir, onResize, children }: { grow: number; last: boolean; dir: DockSplit['dir']; onResize: (e: ReactPointerEvent<HTMLDivElement>) => void; children: ReactNode }) {
  return (
    <>
      <div className="dock-cell" style={{ flex: `${grow} 1 0` }}>
        {children}
      </div>
      {!last && <div className={cx('dock-sash', dir)} onPointerDown={onResize} role="separator" aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'} />}
    </>
  )
}

function zoneAt(e: DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  const y = (e.clientY - r.top) / r.height
  const edges: [DropZone, number][] = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y]
  ]
  const [zone, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  return dist < 0.25 ? zone : 'center'
}

function Group({ g }: { g: DockGroup }) {
  const { dragging, setDragging, render } = useContext(Ctx)
  const focused = useStore((s) => s.dock.focused)
  const [zone, setZone] = useState<DropZone | null>(null)
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dragging) {
      setZone(null)
      setInsertAt(null)
    }
  }, [dragging])

  const tabIndexAt = (clientX: number): number => {
    const tabs = strip.current ? [...strip.current.querySelectorAll<HTMLElement>('.dock-tab')] : []
    const i = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect()
      return clientX < r.left + r.width / 2
    })
    return i < 0 ? tabs.length : i
  }

  const drop = (z: DropZone, index?: number): void => {
    if (dragging) setDock((d) => movePanel(d, dragging, g.id, z, index))
    setDragging(null)
  }

  return (
    <div className={cx('dock-group', g.tabs.includes(focused) && 'focused')} onMouseDownCapture={() => setDock((d) => focusPanel(d, g.active))}>
      <div
        ref={strip}
        className="dock-strip"
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setInsertAt(tabIndexAt(e.clientX))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInsertAt(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          drop('center', tabIndexAt(e.clientX))
        }}
      >
        {g.tabs.map((p, i) => (
          <Tab key={p} panel={p} active={p === g.active} insertBefore={insertAt === i} onDragStart={() => setDragging(p)} onDragEnd={() => setDragging(null)} />
        ))}
        {insertAt === g.tabs.length && <span className="dock-insert" />}
        <OpenAllyMenu groupId={g.id} />
      </div>
      <div
        className="dock-body"
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setZone(zoneAt(e))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          drop(zoneAt(e))
        }}
      >
        {render(g.active)}
        {dragging && <div className="dock-catch" />}
        {dragging && zone && <div className={cx('dock-zone', zone)} />}
      </div>
    </div>
  )
}

function Tab({ panel, active, insertBefore, onDragStart, onDragEnd }: { panel: string; active: boolean; insertBefore: boolean; onDragStart: () => void; onDragEnd: () => void }) {
  const info = useStore((s) => s.snap.wksps.find((m) => m.name === panel))
  const unread = useStore((s) => !active && hasUnread(s.dock, panel, s.chats[panel] ?? []))
  const scope = useStore((s) => s.snap.allies.find((a) => a.name === panel)?.scope)
  const busy = info?.activity === 'thinking' || info?.activity === 'tool' || info?.activity === 'starting'
  const main = panel === MAIN_PANEL
  return (
    <>
      {insertBefore && <span className="dock-insert" />}
      <div
        className={cx('dock-tab', active && 'on', main ? 'main' : 'ally')}
        draggable
        title={main ? 'Genio — always open' : `Ally · ${panel}${scope ? `\n${scope}` : ''}`}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, panel)
          e.dataTransfer.effectAllowed = 'move'
          // Defer: re-rendering the dock inside dragstart can abort the drag.
          window.setTimeout(onDragStart, 0)
        }}
        onDragEnd={onDragEnd}
        onClick={() => setDock((d) => focusPanel(d, panel))}
        onAuxClick={(e) => {
          if (e.button === 1 && canClose(panel)) setDock((d) => closePanel(d, panel))
        }}
      >
        <span className={cx('dock-tab-dot', busy && 'busy', info?.activity === 'error' && 'err')} />
        <span className="dock-tab-label">{main ? 'Genio' : panel}</span>
        {unread && <span className="dock-unread" title="New messages" />}
        {canClose(panel) && (
          <button
            className="dock-tab-x"
            title="Close tab (the ally keeps running)"
            aria-label={`Close ${panel}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setDock((d) => closePanel(d, panel))
            }}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </>
  )
}

/** "+" in every tab strip: reopen closed allies (with unread marks) or focus open ones. */
function OpenAllyMenu({ groupId }: { groupId: string }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const open = at !== null
  const ref = useRef<HTMLDivElement>(null)
  const allies = useStore((s) => s.snap.allies)
  const dock = useStore((s) => s.dock)
  const chats = useStore((s) => s.chats)
  const live = allies.filter((a) => !a.retiredAt)
  const closedUnread = live.some((a) => !isOpen(dock, a.name) && hasUnread(dock, a.name, chats[a.name] ?? []))

  useEffect(() => {
    if (!open) return undefined
    const off = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAt(null)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAt(null)
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div className="dock-add" ref={ref}>
      <button className={cx('dock-add-btn', open && 'on')} title="Open ally…" aria-label="Open ally" onClick={(e) => {
          // Fixed position so the menu escapes the tab strip's horizontal scroll clip.
          const r = e.currentTarget.getBoundingClientRect()
          setAt(open ? null : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 330)) })
        }}>
        <Plus size={13} />
        {closedUnread && <span className="dock-unread" />}
      </button>
      {open && (
        <div className="dock-menu panel" style={at}>
          <div className="dock-menu-head label">Allies</div>
          {live.length === 0 && <div className="dock-menu-empty mute">No allies yet. Spawn one from a world, or recruit one in Systems.</div>}
          {live.map((a) => {
            const on = isOpen(dock, a.name)
            const unread = hasUnread(dock, a.name, chats[a.name] ?? [])
            return (
              <button
                key={a.name}
                className={cx('dock-menu-item', on && 'open')}
                onClick={() => {
                  setDock((d) => (on ? focusPanel(d, a.name) : openPanel(d, a.name, groupId)))
                  setAt(null)
                }}
              >
                <Users size={13} className="violet-text" />
                <span className="dock-menu-main">
                  <b>{a.name}</b>
                  {unread && <span className="dock-unread" title="New messages" />}
                  <span className="mute">{a.scope}</span>
                </span>
                {on ? (
                  <span className="dock-menu-state neon-text">
                    <Check size={12} /> open
                  </span>
                ) : (
                  <span className="dock-menu-state mute">closed</span>
                )}
              </button>
            )
          })}
          <div className="dock-menu-foot">
            <button
              className="link-btn"
              onClick={() => {
                setAt(null)
                go('worlds')
              }}
            >
              <Globe size={11} /> Spawn for a world
            </button>
            <button
              className="link-btn"
              onClick={() => {
                setAt(null)
                requestSystemsSection('allies')
                go('systems')
              }}
            >
              <Users size={11} /> Recruit ally
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
