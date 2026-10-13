import { BookOpen, Cpu, Crosshair, Gauge, Globe, MessageSquare, ScrollText, Sparkles, Swords, Film, type LucideIcon } from 'lucide-react'
import { go, openDecisions, readyTasks, useStore, type ViewId } from '../store'
import { cx } from '../lib/format'

export const NAV: { id: ViewId; label: string; icon: LucideIcon; key: string }[] = [
  { id: 'comms', label: 'Comms', icon: MessageSquare, key: '1' },
  { id: 'squad', label: 'Squad', icon: Swords, key: '2' },
  { id: 'quests', label: 'Quests', icon: ScrollText, key: '3' },
  { id: 'move', label: 'Your Move', icon: Crosshair, key: '4' },
  { id: 'status', label: 'Status', icon: Gauge, key: '5' },
  { id: 'worlds', label: 'Worlds', icon: Globe, key: '6' },
  { id: 'lore', label: 'Lore', icon: BookOpen, key: '7' },
  { id: 'fal', label: 'FAL.ai', icon: Sparkles, key: '9' },
  { id: 'sprites', label: 'Sprites', icon: Film, key: '0' },
  { id: 'systems', label: 'Systems', icon: Cpu, key: '8' }
]

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
      {NAV.map((n) => {
        const b = badge[n.id]
        const Icon = n.icon
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
