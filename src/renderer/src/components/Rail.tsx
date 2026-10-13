import { useEffect, useRef, useState } from 'react'
import { BookOpen, Cpu, Crosshair, Gauge, Globe, MessageSquare, PersonStanding, ScrollText, Sparkles, Swords, WandSparkles, type LucideIcon } from 'lucide-react'
import { go, openDecisions, readyTasks, useStore, type ViewId } from '../store'
import { cx } from '../lib/format'
import { RAIL, entryActive, initialIndex, menuKey, navItems, opensMenu, type RailEntry } from '../lib/railmenu'
import '../styles/railmenu.css'

const ICON: Record<string, LucideIcon> = {
  comms: MessageSquare,
  squad: Swords,
  quests: ScrollText,
  move: Crosshair,
  status: Gauge,
  worlds: Globe,
  lore: BookOpen,
  fal: Sparkles,
  animation: PersonStanding,
  systems: Cpu,
  assets: WandSparkles
}

/** Every screen with its shortcut, submenus flattened (command palette). */
export const NAV = navItems()

export function Rail() {
  const view = useStore((s) => s.view)
  const moves = useStore((s) => openDecisions(s).length + readyTasks(s).length)
  const live = useStore((s) => s.snap.tasks.filter((t) => t.state === 'working' || t.state === 'spawning' || t.state === 'validating').length)
  const mail = useStore((s) => s.snap.inbox.filter((n) => !n.ackedAt).length)
  const thinking = useStore((s) => s.snap.wksps.some((m) => m.activity === 'thinking' || m.activity === 'tool'))
  const badge: Partial<Record<ViewId, { n: number; tone: string }>> = {
    move: { n: moves, tone: 'amber' },
    squad: { n: live, tone: 'neon' },
    lore: { n: mail, tone: 'violet' }
  }
  return (
    <nav className="rail">
      {RAIL.map((e) => {
        if (e.kind === 'menu') return <RailMenu key={e.id} entry={e} view={view} />
        const n = e.item
        const b = badge[n.id]
        const Icon = ICON[n.id]
        return (
          <button key={n.id} className={cx('rail-btn', view === n.id && 'on')} onClick={() => go(n.id)} aria-label={n.label}>
            <Icon size={20} strokeWidth={1.6} />
            {n.id === 'comms' && thinking && <span className="rail-ping" />}
            {b && b.n > 0 && <span className={cx('rail-badge', b.tone)}>{b.n > 99 ? '99' : b.n}</span>}
            <span className="rail-tip">
              {n.label}
              <kbd>Ctrl {n.key}</kbd>
            </span>
          </button>
        )
      })}
      <div className="rail-foot label">v0.1</div>
    </nav>
  )
}

/** A rail button that opens a submenu of screens, anchored to its right. */
function RailMenu({ entry, view }: { entry: RailEntry & { kind: 'menu' }; view: ViewId }) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const Icon = ICON[entry.id]

  const show = (): void => {
    setSel(initialIndex(entry.items, view))
    setOpen(true)
  }
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) btn.current?.focus()
  }
  const pick = (i: number): void => {
    setOpen(false)
    go(entry.items[i].id)
  }

  useEffect(() => {
    if (open) items.current[sel]?.focus()
  }, [open, sel])

  // a shortcut or the palette switching screens closes the menu
  useEffect(() => setOpen(false), [view])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(true)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="rail-menu-wrap" ref={wrap}>
      <button
        ref={btn}
        className={cx('rail-btn', entryActive(entry, view) && 'on', open && 'open')}
        aria-label={entry.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open && opensMenu(e.key)) {
            e.preventDefault()
            show()
          }
        }}
      >
        <Icon size={20} strokeWidth={1.6} />
        {!open && <span className="rail-tip">{entry.label}</span>}
      </button>
      {open && (
        <div
          className="rail-menu panel glow"
          role="menu"
          aria-label={entry.label}
          onKeyDown={(e) => {
            const a = menuKey(e.key, sel, entry.items.length)
            if (!a) return
            e.preventDefault()
            e.stopPropagation()
            if (a.type === 'move') setSel(a.index)
            else if (a.type === 'pick') pick(a.index)
            else close(true)
          }}
        >
          <div className="rail-menu-title label">{entry.label}</div>
          {entry.items.map((it, i) => {
            const ItIcon = ICON[it.id]
            return (
              <button
                key={it.id}
                ref={(el) => {
                  items.current[i] = el
                }}
                role="menuitem"
                tabIndex={i === sel ? 0 : -1}
                className={cx('rail-menu-item', i === sel && 'sel', view === it.id && 'on')}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
              >
                <ItIcon size={16} strokeWidth={1.6} />
                <span>{it.label}</span>
                <kbd>Ctrl {it.key}</kbd>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
