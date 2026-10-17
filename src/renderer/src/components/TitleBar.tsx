import { Crosshair, GitMerge, SquareTerminal } from 'lucide-react'
import { PROJECT_WINDOW, api, go, op, openDecisions, toggleAnswers, useStore } from '../store'
import { useNow } from './ui'
import { FileMenu } from './FileMenu'
import { PRESENCE } from '../lib/vocab'
import { clock, cx } from '../lib/format'
import { playSfx } from '../lib/sfx'
import { PANE_SHORTCUT, togglePane } from '../lib/terminal-pane'
import type { AwayMode, FleetSnapshot } from '@shared/types'

export function TitleBar() {
  useNow(30_000)
  const away = useStore((s) => s.snap.away)
  const moves = useStore((s) => openDecisions(s).length)
  const answersOpen = useStore(s => s.answersOpen && (openDecisions(s).length > 0 || !!s.answerHistory))
  const settings = useStore((s) => s.settings)
  const paneOpen = useStore((s) => s.paneOpen)

  const setPresence = async (mode: AwayMode): Promise<void> => {
    if (mode === away.mode) return
    playSfx('blip', settings)
    await op('Presence', () => api().setAway(mode), () => undefined)
  }

  return (
    <div className="titlebar">
      <FileMenu />
      <div className="wordmark" onClick={() => go('comms')}>
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden>
          <polygon points="10,1 18,5.5 18,14.5 10,19 2,14.5 2,5.5" fill="none" stroke="var(--neon)" strokeWidth="1.6" />
          <rect x="7" y="8.5" width="6" height="3" fill="var(--neon)" />
        </svg>
        <span className="wordmark-text" data-text="GENIO">
          GENIO
        </span>
      </div>

      <span className="label dim tb-project" title={PROJECT_WINDOW}>{PROJECT_WINDOW ?? 'Hub'}</span>
      <div className="presence" role="radiogroup" aria-label="Presence">
        {PRESENCE.map((p) => (
          <button
            key={p.mode}
            role="radio"
            aria-checked={away.mode === p.mode}
            className={cx('presence-opt', `p-${p.mode}`, away.mode === p.mode && 'on')}
            title={p.hint}
            onClick={() => void setPresence(p.mode)}
          >
            <i />
            {p.label}
          </button>
        ))}
      </div>

      <StandingChips />
      <div className="tb-spacer" />

      <div className="hud-stats">
        {PROJECT_WINDOW && (
          <button className={cx('hud-stat hud-terminal', paneOpen && 'on')} title={`Terminal (${PANE_SHORTCUT})`} aria-label="Terminal" aria-pressed={paneOpen} onClick={togglePane}>
            <SquareTerminal size={15} />
          </button>
        )}
        <button className={cx('hud-stat', moves > 0 && 'amber')} title="Pending answers (Ctrl+J)" aria-label="Pending answers" aria-controls="answers" aria-expanded={answersOpen} onClick={toggleAnswers}>
          <Crosshair size={14} />
          <span className="num">{moves}</span>
        </button>
      </div>
      <div className="wc-gap" />
    </div>
  )
}

/** One empty list: a new [] per store change would re-render the chips on every streamed delta. */
const NO_APPROVALS: NonNullable<FleetSnapshot['standing']> = []

/** "Standing merge approval until 21:40 · Revoke": the player's "keep merging everything", visible and one click to end. */
function StandingChips() {
  const now = useNow(30_000)
  const standing = useStore((s) => s.snap.standing ?? NO_APPROVALS)
  const active = standing.filter((a) => Date.parse(a.expiresAt) > now)
  if (!active.length) return null
  return (
    <div className="tb-standing">
      {active.map((a) => (
        <span key={a.id} className="chip volt tb-standing-chip" title={`From your message: "${a.text}"\nGenio may merge ${a.project} Builds as they become ready and pass their checks. Never destructive actions. Ends at ${clock(a.expiresAt)} or when Genio restarts.`}>
          <GitMerge size={11} /> Standing merge approval{PROJECT_WINDOW ? '' : ` · ${a.project}`} until {clock(a.expiresAt)} ·{' '}
          <button className="link-btn" onClick={() => void op('Revoke', () => api().revokeStandingApproval(a.id))}>Revoke</button>
        </span>
      ))}
    </div>
  )
}
