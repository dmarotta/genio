import { useMemo, useState } from 'react'
import { ListOrdered, Pause, Play, X } from 'lucide-react'
import type { Priority } from '@shared/types'
import { PRIORITIES } from '@shared/api'
import { planCanDispatch, planColumn, planProgress, planView, stepStateText, stepTone, type PlanStepView, type PlanView } from '@shared/work-plan'
import { api, op, useStore } from '../store'
import { Field, Modal } from './ui'
import { clock, cx, dateShort, trunc } from '../lib/format'

export const PRIORITY_LABEL: Record<Priority, string> = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' }

/** Every plan in this window as the Quest log shows it: one derived view per plan, steps read from their quests and units. */
export function usePlanViews(): PlanView[] {
  const plans = useStore((s) => s.snap.plans)
  const backlog = useStore((s) => s.snap.backlog)
  const tasks = useStore((s) => s.snap.tasks)
  return useMemo(() => (plans ?? []).map((p) => planView(p, backlog, tasks)), [plans, backlog, tasks])
}

const MARK: Record<PlanStepView['state'], string> = {
  merged: '✓', 'in-flight': '●', ready: '●', blocked: '!', discarded: '✕', queued: '○', waiting: '○'
}

const dispatchPlan = (v: PlanView) => op('Dispatch', () => api().planControl(v.id, 'dispatch'))
const dropPlan = (v: PlanView) => op('Drop', () => api().planControl(v.id, 'cancel'))

/** Drop asks once before it cancels the plan: a plan is several quests, and Drop cannot be undone. */
function DropButton({ v, onDone }: { v: PlanView; onDone?: () => void }) {
  const [sure, setSure] = useState(false)
  return (
    <button
      className={cx('btn sm', sure ? 'alert' : 'ghost')}
      title={sure ? 'Drops the steps that have not started. Running units keep running; nothing that landed is undone.' : undefined}
      onClick={(e) => { e.stopPropagation(); if (!sure) setSure(true); else void dropPlan(v).then((r) => r?.ok && onDone?.()) }}
      onBlur={() => setSure(false)}
    >
      <X size={11} /> {sure ? 'Drop the plan' : 'Drop'}
    </button>
  )
}

function DispatchButton({ v, onDone }: { v: PlanView; onDone?: () => void }) {
  return (
    <button className="btn sm volt" onClick={(e) => { e.stopPropagation(); void dispatchPlan(v).then((r) => r?.ok && onDone?.()) }}>
      <Play size={11} /> Dispatch
    </button>
  )
}

/** The one card a plan is on the board: plan mark, progress and its current step; Drop and Dispatch sit on it. */
export function PlanCard({ v, onOpen }: { v: PlanView; onOpen: () => void }) {
  const column = planColumn(v)
  const stuck = v.steps.some((s) => s.state === 'blocked')
  const why = v.pause ? `paused: ${v.pause.reason}` : stuck ? 'a step is blocked' : undefined
  const open = column !== 'done'
  return (
    <div className={cx('quest qk-ticket panel qk-plan-card', column === 'done' && 'qk-done')} onClick={onOpen}>
      <div className="quest-top">
        {!open && <span className="qk-outcome" style={{ color: v.state === 'done' ? 'var(--volt)' : 'var(--amber)' }}>{v.state === 'done' ? 'done' : 'dropped'}</span>}
        <span className="quest-title">{v.title}</span>
      </div>
      <div className="quest-meta">
        <span className="chip neon plan-mark-chip"><ListOrdered size={10} /> Plan</span>
        {open && why && <span className="chip qk-chip amber" title={why}><Pause size={10} /> {trunc(why, 48)}</span>}
      </div>
      <div className="qk-progress mute" title={planProgress(v)}>{planProgress(v)}</div>
      {open ? (
        <div className="qk-foot">
          <span className="qk-actions">
            {planCanDispatch(v) && <DispatchButton v={v} />}
            <DropButton v={v} />
          </span>
        </div>
      ) : (
        <div className="qk-foot mute"><span>{dateShort(v.endedAt)} {clock(v.endedAt)}</span></div>
      )}
    </div>
  )
}

/** The plan's dialog: its steps read-only, Priority, Drop and Dispatch. Step quests are not cards. */
export function PlanDetails({ planId, onClose }: { planId: string; onClose: () => void }) {
  const views = usePlanViews()
  const v = views.find((x) => x.id === planId)
  if (!v) return null
  const open = v.state === 'active' || v.state === 'paused'
  return (
    <Modal
      kicker={v.state === 'cancelled' ? 'dropped' : v.state === 'done' ? 'done' : planColumn(v) === 'in-flight' ? 'plan · in flight' : 'plan · queued'}
      title={v.title}
      onClose={onClose}
      width={680}
      footer={open && (
        <>
          <DropButton v={v} onDone={onClose} />
          <span style={{ flex: 1 }} />
          {planCanDispatch(v) && <DispatchButton v={v} onDone={onClose} />}
        </>
      )}
    >
      {v.pause && <div className="hold-box"><div><div className="label amber-text">Paused</div><div>{v.pause.reason}</div></div></div>}
      <div className="form-grid">
        <Field label="Progress">
          <span>{planProgress(v)}</span>
        </Field>
        <Field label="Priority">
          {open ? (
            <select className="select" value={v.priority}
              onChange={(e) => void op('Priority', () => api().planPriority(v.id, e.target.value as Priority))}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
          ) : (
            <span className={cx('prio-label', `p-${v.priority}`)}>{PRIORITY_LABEL[v.priority]}</span>
          )}
        </Field>
      </div>
      <ol className="plan-steps">
        {v.steps.map((s) => {
          const tone = stepTone(s)
          const color = tone === 'mute' ? 'var(--text-mute)' : `var(--${tone})`
          return (
            <li key={s.key} className="plan-step">
              <span className="plan-mark" style={{ color }}>{MARK[s.state]}</span>
              <span className="plan-title">{s.title}</span>
              <span className="plan-st" style={{ color }}>{stepStateText(s, v.steps)}</span>
            </li>
          )
        })}
      </ol>
    </Modal>
  )
}
