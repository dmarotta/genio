import { Radar, Rocket } from 'lucide-react'
import { squadState, squadTone } from '@shared/squad-display'
import { pendingDecision } from '@shared/decisions'
import type { Task } from '@shared/types'
import { focusTask, liveTasks, openDeploy, useStore } from '../store'
import { Dot, useNow } from './ui'
import { KIND_LABEL } from '../lib/vocab'
import { elapsed } from '../lib/format'

export function Roster() {
  const tasks = useStore(liveTasks)
  const now = useNow(1000)
  return <div className="side-block">
    <div className="side-head"><span className="label">Squad</span><span className="num dim">{tasks.length}</span></div>
    {tasks.length === 0 ? <div className="side-empty mute">No units deployed. <button className="link-btn" onClick={() => openDeploy()}>Deploy one</button></div>
      : <div className="roster">{tasks.map(t => <RosterRow key={t.id} t={t} now={now} />)}</div>}
  </div>
}

function RosterRow({ t, now }: { t: Task; now: number }) {
  const terminal = useStore(s => t.terminalId ? s.terminals[t.terminalId] : undefined)
  const attention = useStore(s => s.snap.decisions.some(d => d.taskId === t.id && pendingDecision(d, now)))
  const state = squadState(t, terminal)
  const tone = squadTone(t, terminal, attention)
  return <button className="roster-row" onClick={() => focusTask(t.id)} title={t.stateReason}>
    <Dot tone={tone} pulse={state === 'WORKING'} />
    <div className="roster-main">
      <div className="roster-title">{t.title}</div>
      <div className="roster-sub mute">{t.kind === 'scout' ? <Radar size={10} /> : <Rocket size={10} />} {KIND_LABEL[t.kind]} · {t.project}</div>
    </div>
    <div className="roster-right">
      <span className="roster-state" style={{ color: `var(--${tone})` }}>{state}</span>
      <span className="mono mute">{elapsed(t.createdAt, now)}</span>
    </div>
  </button>
}
