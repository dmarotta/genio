import { squadAttention, squadBadge, squadState, unitClockShort } from '@shared/squad-display'
import { pendingDecision } from '@shared/decisions'
import type { Task } from '@shared/types'
import { focusTask, squadRoster, useStore } from '../store'
import { Dot, NeedsYou, useNow } from './ui'
import { unitKindLabel } from '../lib/vocab'
import { UnitKindIcon } from './UnitKind'

/** Active units, then a quiet, bounded history of finished units. */
export function Roster() {
  const { active, done } = useStore(squadRoster)
  const now = useNow(1000)
  return <div className="side-block">
    <div className="side-head"><span className="label">Squad</span></div>
    {active.length === 0 ? <div className={`side-empty mute${done.length ? ' above-done' : ''}`}>No units deployed.</div>
      : <div className="roster roster-active">{active.map(t => <RosterRow key={t.id} t={t} now={now} />)}</div>}
    {done.length > 0 && <div className="roster roster-done">{done.map(t => <RosterRow key={t.id} t={t} now={now} />)}</div>}
  </div>
}

function RosterRow({ t, now }: { t: Task; now: number }) {
  const terminal = useStore(s => t.terminalId ? s.terminals[t.terminalId] : undefined)
  const pending = useStore(s => s.snap.decisions.some(d => d.taskId === t.id && pendingDecision(d, now)))
  const state = squadState(t, terminal)
  const { label, tone } = squadBadge(t, terminal)
  const attention = squadAttention(t, terminal, pending)
  return <button className={`roster-row${state === 'DONE' ? ' done-row' : ''}`} onClick={() => focusTask(t.id)}>
    <Dot tone={tone} pulse={state === 'WORKING'} />
    <div className="roster-main">
      <div className="roster-title">{t.title}</div>
      <div className="roster-sub mute"><UnitKindIcon t={t} size={10} /> {unitKindLabel(t)}</div>
    </div>
    <div className="roster-right">
      <span className="roster-state" style={{ color: `var(--${tone})` }}>{attention && <NeedsYou compact />}{label}</span>
      <span className="mono mute">{unitClockShort(t, terminal, now)}</span>
    </div>
  </button>
}
