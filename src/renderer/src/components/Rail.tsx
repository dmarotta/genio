import { Backpack, IdCard, Globe, Lightbulb, MessageSquare, Palette, ScrollText, Settings, Swords, Gamepad2, type LucideIcon } from 'lucide-react'
import { PROJECT_WINDOW, go, useStore, runningUnits, playAvailable, type ViewId } from '../store'
import { cx } from '../lib/format'
import { navItems, windowRail, type NavItem } from '../lib/railmenu'
import { signInLines } from '@shared/api'
import { openSettings } from '../lib/settings-nav'

const ICON: Record<string, LucideIcon> = {
  play: Gamepad2,
  comms: MessageSquare,
  squad: Swords,
  quests: ScrollText,
  design: Lightbulb,
  status: IdCard,
  worlds: Globe,
  systems: Settings,
  inventory: Backpack,
  'art-bible': Palette
}

/** This window's rail with and without Play, built once so selectors stay referentially stable. */
const RAILS = { play: windowRail(!!PROJECT_WINDOW, true), noPlay: windowRail(!!PROJECT_WINDOW, false) }
const NAVS = { play: navItems(RAILS.play), noPlay: navItems(RAILS.noPlay) }

/** Every screen this window offers with its shortcut (command palette, shortcuts). */
export const navFor = (play: boolean): NavItem[] => (play ? NAVS.play : NAVS.noPlay)
export const useNav = (): NavItem[] => navFor(useStore(playAvailable))

export function Rail() {
  const view = useStore((s) => s.view)
  const nav = useNav()
  const live = useStore(runningUnits)
  const mail = useStore((s) => s.snap.inbox.filter((n) => !n.ackedAt).length)
  const thinking = useStore((s) => s.snap.wksps.some((m) => m.activity === 'thinking' || m.activity === 'tool'))
  const signIn = useStore((s) => s.signIn)
  const badge: Partial<Record<ViewId, { n: number; tone: string }>> = {
    squad: { n: live, tone: 'neon' },
    systems: signIn.length ? { n: signIn.length, tone: 'amber' } : { n: mail, tone: 'violet' }
  }
  return (
    <nav className="rail">
      {nav.map((n) => {
        const b = badge[n.id]
        const Icon = ICON[n.id]
        // While Claude or Codex needs a sign-in, the Systems button leads straight to Accounts.
        const warn = n.id === 'systems' && signIn.length > 0
        return (
          <button key={n.id} className={cx('rail-btn', view === n.id && 'on')} onClick={() => (warn ? openSettings('accounts') : go(n.id))} aria-label={warn ? `${n.label}: ${signInLines(signIn).join(', ')}` : n.label}>
            <Icon size={20} strokeWidth={1.6} />
            {n.id === 'comms' && thinking && <span className="rail-ping" />}
            {b && b.n > 0 && <span className={cx('rail-badge', b.tone)}>{b.n > 99 ? '99' : b.n}</span>}
            <span className="rail-tip">
              {n.label}
              {warn && signInLines(signIn).map((line) => <span key={line}>{line}</span>)}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
