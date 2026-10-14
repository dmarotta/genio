import { Crosshair, Users } from 'lucide-react'
import { PROJECT_WINDOW, api, go, op, openDecisions, runningUnits, setState, toggleAnswers, useStore } from '../store'
import { useNow } from './ui'
import { FileMenu } from './FileMenu'
import { PRESENCE } from '../lib/vocab'
import { cx, usd } from '../lib/format'
import { playSfx } from '../lib/sfx'
import type { AwayMode } from '@shared/types'

export function TitleBar() {
  useNow(30_000)
  const away = useStore((s) => s.snap.away)
  const stats = useStore((s) => s.snap.stats)
  const units = useStore(runningUnits)
  const moves = useStore((s) => openDecisions(s).length)
  const answersOpen = useStore(s => s.answersOpen && (openDecisions(s).length > 0 || !!s.answerHistory))
  const settings = useStore((s) => s.settings)
  const pct = stats.xpNext > 0 ? Math.min(100, (stats.xp / stats.xpNext) * 100) : 0

  const setPresence = async (mode: AwayMode): Promise<void> => {
    if (mode === away.mode) return
    playSfx('blip', settings)
    await op('Presence', () => api().setAway(mode), () => undefined)
  }

  return (
    <div className="titlebar">
      <FileMenu />
      <div className="wordmark" onClick={() => go('comms')} title="Genio">
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

      <div className="tb-spacer" />

      <div className="hud-stats">
        <button className="hud-stat hud-units" title="Units in action" onClick={() => go('squad')}>
          <Users size={14} />
          <span className="num">{units}</span>
        </button>
        <button className={cx('hud-stat', moves > 0 && 'amber')} title="Pending answers" aria-label="Pending answers" aria-controls="answers" aria-expanded={answersOpen} onClick={toggleAnswers}>
          <Crosshair size={14} />
          <span className="num">{moves}</span>
        </button>
        <div className="hud-stat hud-cost" title="Estimated chat, Bot and review cost today; excludes unit costs and is not subscription spend">
          <span className="mute label" style={{ letterSpacing: '0.1em' }}>
            Chat/review
          </span>
          <span className="num">{usd(stats.costTodayUsd)}</span>
        </div>
        <button className="level" title={`${stats.xp} / ${stats.xpNext} XP`} onClick={() => setState({ view: 'status' })}>
          <span className="level-badge num">
            <small>LV</small>
            {stats.level}
          </span>
          <span className="level-xp">
            <span className="bar" style={{ ['--c' as string]: 'var(--volt)' }}>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="label">{stats.xp} XP</span>
          </span>
        </button>
      </div>
      <div className="wc-gap" />
    </div>
  )
}
