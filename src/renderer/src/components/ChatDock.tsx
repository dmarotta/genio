import { Fragment, createContext, useContext, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Check, Globe, Plus, Users, X } from 'lucide-react'
import { go, setDock, useStore } from '../store'
import {
  MAIN_PANEL, canClose, closePanel, dragSash, focusPanel, hasUnread, isOpen, minSize, movePanel, openPanel, resizeSplit,
  type DockGroup, type DockNode, type DockSplit, type DropZone
} from '../lib/dock'
import { cx } from '../lib/format'
import { requestSystemsSection } from '../views/Systems'

/**
 * Unity-style dock for the chat screen: every chat is a tab that can be
 * reordered, grouped with others, or docked on any edge of a pane to split it.
 * Every class here is dock- prefixed: bare names like .row or .ally are global
 * utilities in app.css and would leak their layout into the dock.
 */

const DRAG_MIME = 'application/x-genio-chat'

const ZONE_LABEL: Record<DropZone, string> = {
  center: 'Add as tab',
  left: 'Dock left',
  right: 'Dock right',
  top: 'Dock top',
  bottom: 'Dock bottom'
}

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
        {/* Never smaller than every pane's minimum: past that the dock scrolls instead of crushing panes. */}
        <div className="dock-root" style={{ minWidth: minSize(root, 'row'), minHeight: minSize(root, 'column') }}>
          <Node node={root} />
        </div>
      </div>
    </Ctx.Provider>
  )
}

function Node({ node }: { node: DockNode }) {
  return node.type === 'group' ? <Group g={node} /> : <Split s={node} />
}

function Split({ s }: { s: DockSplit }) {
  const cells = useRef<(HTMLDivElement | null)[]>([])
  const [resizing, setResizing] = useState<number | null>(null)
  const row = s.dir === 'row'
  const startDrag = (i: number, e: ReactPointerEvent<HTMLDivElement>): void => {
    const a = cells.current[i]?.getBoundingClientRect()
    const b = cells.current[i + 1]?.getBoundingClientRect()
    if (!a || !b || e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const px: [number, number] = row ? [a.width, b.width] : [a.height, b.height]
    const min: [number, number] = [minSize(s.children[i], s.dir), minSize(s.children[i + 1], s.dir)]
    const origin = row ? e.clientX : e.clientY
    const start = s.sizes.slice()
    setResizing(i)
    const move = (ev: PointerEvent): void => {
      setDock((d) => resizeSplit(d, s.id, dragSash(start, i, px, (row ? ev.clientX : ev.clientY) - origin, min)))
    }
    const up = (): void => {
      setResizing(null)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const even = (i: number): void => {
    const sizes = s.sizes.slice()
    sizes[i] = sizes[i + 1] = (s.sizes[i] + s.sizes[i + 1]) / 2
    setDock((d) => resizeSplit(d, s.id, sizes))
  }
  return (
    <div className={cx('dock-split', `dock-${s.dir}`)}>
      {s.children.map((c, i) => {
        // grow by the stored ratio from a zero basis, so content never sizes a pane
        const flex = `${s.sizes[i] * 100} 1 0px`
        const min = minSize(c, s.dir)
        return (
          <Fragment key={c.id}>
            <div
              ref={(el) => {
                cells.current[i] = el
              }}
              className="dock-cell"
              style={row ? { flex, minWidth: min } : { flex, minHeight: min }}
            >
              <Node node={c} />
            </div>
            {i < s.children.length - 1 && (
              <div
                className={cx('dock-sash', `dock-${s.dir}`, resizing === i && 'on')}
                title="Drag to resize · double-click to split evenly"
                role="separator"
                aria-orientation={row ? 'vertical' : 'horizontal'}
                onPointerDown={(e) => startDrag(i, e)}
                onDoubleClick={() => even(i)}
              />
            )}
          </Fragment>
        )
      })}
    </div>
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
  // A pane's only tab cannot be dropped onto its own body: there is nothing to split or join.
  const ownOnlyTab = dragging !== null && g.tabs.length === 1 && g.tabs[0] === dragging

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
          if (!dragging || ownOnlyTab) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setZone(zoneAt(e))
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (!ownOnlyTab) drop(zoneAt(e))
        }}
      >
        {render(g.active)}
        {dragging && <div className="dock-catch" />}
        {dragging && zone && !ownOnlyTab && (
          <div className={cx('dock-zone', `dock-zone-${zone}`)}>
            <span>{ZONE_LABEL[zone]}</span>
          </div>
        )}
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
        className={cx('dock-tab', active && 'on', main ? 'dock-tab-main' : 'dock-tab-ally')}
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
