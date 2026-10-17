import { squadAttention, squadState, squadTone, unitClockShort } from '@shared/squad-display'
import { pendingDecision } from '@shared/decisions'
import type { Task } from '@shared/types'
import { focusTask, liveTasks, useStore } from '../store'
import { Dot, NeedsYou, useNow } from './ui'
import { unitKindLabel } from '../lib/vocab'
import { UnitKindIcon } from './UnitKind'

/** The active units; finished ones are in the Quest log's Done column. */
export function Roster() {
  const active = useStore(liveTasks)
  const now = useNow(1000)
  return <div className="side-block">
    <div className="side-head"><span className="label">Squad</span></div>
    {active.length === 0 ? <div className="side-empty mute">No units deployed.</div>
      : <div className="roster roster-active">{active.map(t => <RosterRow key={t.id} t={t} now={now} />)}</div>}
  </div>
}

function RosterRow({ t, now }: { t: Task; now: number }) {
  const terminal = useStore(s => t.terminalId ? s.terminals[t.terminalId] : undefined)
  const pending = useStore(s => s.snap.decisions.some(d => d.taskId === t.id && pendingDecision(d, now)))
  const state = squadState(t, terminal)
  const tone = squadTone(t, terminal)
  const attention = squadAttention(t, terminal, pending)
  return <button className="roster-row" onClick={() => focusTask(t.id)}>
    <Dot tone={tone} pulse={state === 'WORKING'} />
    <div className="roster-main">
      <div className="roster-title">{t.title}</div>
      <div className="roster-sub mute"><UnitKindIcon t={t} size={10} /> {unitKindLabel(t)}</div>
    </div>
    <div className="roster-right">
      <span className="roster-state" style={{ color: `var(--${tone})` }}>{attention && <NeedsYou compact />}{state}</span>
      <span className="mono mute">{unitClockShort(t, terminal, now)}</span>
    </div>
  </button>
}
