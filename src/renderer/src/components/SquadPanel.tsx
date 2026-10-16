import { Radar, Rocket } from 'lucide-react'
import { finishedAt, outcomeTone, squadAttention, squadOutcome, squadState, squadTone } from '@shared/squad-display'
import { pendingDecision } from '@shared/decisions'
import { mergeApprovalLabel } from '@shared/merge-approval'
import type { Task } from '@shared/types'
import { focusTask, openDeploy, squadRoster, useStore } from '../store'
import { Dot, NeedsYou, useNow } from './ui'
import { KIND_LABEL } from '../lib/vocab'
import { clock, cx, dateShort, elapsed } from '../lib/format'

export function Roster() {
  const { active, done } = useStore(squadRoster)
  const now = useNow(1000)
  return <div className="side-block">
    <div className="side-head"><span className="label">Squad</span><span className="num dim">{active.length}</span></div>
    {active.length === 0 ? <div className={cx('side-empty mute', done.length > 0 && 'above-done')}>No units deployed. <button className="link-btn" onClick={() => openDeploy()}>Deploy one</button></div>
      : <div className="roster roster-active">{active.map(t => <RosterRow key={t.id} t={t} now={now} />)}</div>}
    {done.length > 0 && <>
      <div className="roster-divider label">Recently done ({done.length})</div>
      <div className="roster roster-done">{done.map(t => <DoneRow key={t.id} t={t} now={now} />)}</div>
    </>}
  </div>
}

function RosterRow({ t, now }: { t: Task; now: number }) {
  const terminal = useStore(s => t.terminalId ? s.terminals[t.terminalId] : undefined)
  const pending = useStore(s => s.snap.decisions.some(d => d.taskId === t.id && pendingDecision(d, now)))
  const state = squadState(t, terminal)
  const tone = squadTone(t, terminal)
  const attention = squadAttention(t, terminal, pending)
  return <button className="roster-row" onClick={() => focusTask(t.id)} title={t.stateReason}>
    <Dot tone={tone} pulse={state === 'WORKING'} />
    <div className="roster-main">
      <div className="roster-title">{t.title}</div>
      <div className="roster-sub mute">{t.kind === 'scout' ? <Radar size={10} /> : <Rocket size={10} />} {KIND_LABEL[t.kind]} · {t.project}</div>
    </div>
    <div className="roster-right">
      <span className="roster-state" style={{ color: `var(--${tone})` }}>{attention && <NeedsYou compact />}{state}</span>
      <span className="mono mute">{elapsed(t.createdAt, now)}</span>
    </div>
  </button>
}

/** Finish time: clock today, date before. */
function finishLabel(iso: string, now: number): string {
  return new Date(iso).toDateString() === new Date(now).toDateString() ? clock(iso) : `${dateShort(iso)} ${clock(iso)}`
}

/** A finished unit: title, outcome, finish time and duration. Opens its record (report, PR, commit). */
function DoneRow({ t, now }: { t: Task; now: number }) {
  const terminal = useStore(s => t.terminalId ? s.terminals[t.terminalId] : undefined)
  const outcome = squadOutcome(t, terminal)
  const tone = outcomeTone(outcome)
  const end = finishedAt(t)
  const detail = [t.stateReason, mergeApprovalLabel(t.mergeApproval, 300), t.pr?.url, t.landedCommit && `commit ${t.landedCommit.slice(0, 10)}`].filter(Boolean).join('\n')
  return <button className="roster-row done-row" onClick={() => focusTask(t.id)} title={detail || undefined}>
    <Dot tone={tone} />
    <div className="roster-main">
      <div className="roster-title">{t.title}</div>
      <div className="roster-sub mute">{t.kind === 'scout' ? <Radar size={10} /> : <Rocket size={10} />} {KIND_LABEL[t.kind]} · {t.project}</div>
    </div>
    <div className="roster-right">
      <span className="roster-state" style={{ color: `var(--${tone})` }}>{outcome}</span>
      <span className="mono mute" title={new Date(end).toLocaleString()}>{finishLabel(end, now)} · {elapsed(t.createdAt, Date.parse(end))}</span>
    </div>
  </button>
}
