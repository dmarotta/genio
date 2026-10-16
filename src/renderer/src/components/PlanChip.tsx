import { useMemo, useRef, useState, type RefObject } from 'react'
import { ChevronDown, ListOrdered, Pause, X } from 'lucide-react'
import type { PlanStep, WorkPlan } from '@shared/types'
import { planSummary, planView, stepChipLabel, stepStateText, stepTone, type PlanStepView, type PlanView } from '@shared/work-plan'
import { api, op, useStore } from '../store'
import { Popover } from './Layer'
import { useNow } from './ui'
import { ago, clock, cx, dateShort } from '../lib/format'

/** One plan as the chips show it: each step's state derived from its quest and unit. */
export function usePlanView(planId?: string): PlanView | undefined {
  const plan = useStore((s) => (planId ? s.snap.plans?.find((p) => p.id === planId) : undefined))
  const backlog = useStore((s) => s.snap.backlog)
  const tasks = useStore((s) => s.snap.tasks)
  return useMemo(() => (plan ? planView(plan, backlog, tasks) : undefined), [plan, backlog, tasks])
}

const MARK: Record<PlanStepView['state'], string> = {
  merged: '✓', 'in-flight': '●', ready: '●', blocked: '!', discarded: '✕', queued: '○', waiting: '○'
}

/** "Step 2/3 · New Play ▾": a click opens the plan popover (steps, Pause plan, Cancel plan). */
export function PlanChip({ plan, step, label, className }: { plan: WorkPlan; step?: PlanStep; label?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const text = label ?? (step ? stepChipLabel(plan, step) : plan.title)
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx('chip qk-chip plan-chip', open && 'on', className)}
        title={`${text}\nPlan steps, Pause plan and Cancel plan`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >
        <ListOrdered size={10} /> <span className="plan-chip-text">{text}</span> <ChevronDown size={10} />
      </button>
      {open && <PlanPopover planId={plan.id} current={step?.key} anchor={ref} onClose={() => setOpen(false)} />}
    </>
  )
}

function stepWhen(v: PlanStepView, startedAt: string | undefined, now: number): string {
  if (v.state === 'merged' && v.landedAt) {
    return new Date(v.landedAt).toDateString() === new Date(now).toDateString() ? clock(v.landedAt) : dateShort(v.landedAt)
  }
  if ((v.state === 'in-flight' || v.state === 'ready') && startedAt) return ago(startedAt, now)
  return ''
}

function PlanPopover({ planId, current, anchor, onClose }: {
  planId: string; current?: string; anchor: RefObject<HTMLElement | null>; onClose: () => void
}) {
  const v = usePlanView(planId)
  const tasks = useStore((s) => s.snap.tasks)
  const now = useNow(30_000)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!v) return null
  const open = v.state === 'active' || v.state === 'paused'
  const run = async (action: 'pause' | 'cancel'): Promise<void> => {
    setBusy(true)
    const r = await op(action === 'pause' ? 'Pause plan' : 'Cancel plan', () => api().planControl(v.id, action))
    setBusy(false)
    if (r?.ok) onClose()
  }
  return (
    // the popover is portalled, but React still bubbles its clicks to the card that holds the chip
    <Popover anchor={anchor} gap={4} className="plan-pop panel" role="dialog" aria-label={`Plan ${v.title}`} onClose={onClose} onClick={(e) => e.stopPropagation()}>
      <div className="plan-pop-head">
        <span className="plan-pop-title">{v.title}</span>
        <span className="mute">{planSummary(v)}</span>
      </div>
      {v.pause && <div className="plan-pop-pause">Paused: {v.pause.reason}</div>}
      <ol className="plan-steps">
        {v.steps.map((s) => {
          const tone = stepTone(s)
          const color = tone === 'mute' ? 'var(--text-mute)' : `var(--${tone})`
          const when = stepWhen(s, tasks.find((t) => t.id === s.taskId)?.createdAt, now)
          return (
            <li key={s.key} className={cx('plan-step', s.key === current && 'current')} title={[s.acceptance && `Acceptance: ${s.acceptance}`, s.note].filter(Boolean).join('\n') || undefined}>
              <span className="plan-mark" style={{ color }}>{MARK[s.state]}</span>
              <span className="plan-idx mono mute">{s.index}</span>
              <span className="plan-title">{s.title}</span>
              <span className="plan-st" style={{ color }}>{stepStateText(s, v.steps)}{when && <span className="mute"> {when}</span>}</span>
            </li>
          )
        })}
      </ol>
      {open && (
        <div className="plan-pop-actions">
          <button className="btn sm ghost" disabled={busy || v.state !== 'active'} title={v.state === 'paused' ? 'Already paused' : 'No new step starts; running units keep running'} onClick={() => void run('pause')}>
            <Pause size={12} /> Pause plan
          </button>
          <button className={cx('btn sm', confirmCancel ? 'alert' : 'ghost')} disabled={busy} onClick={() => (confirmCancel ? void run('cancel') : setConfirmCancel(true))}>
            <X size={12} /> {confirmCancel ? 'Cancel the plan' : 'Cancel plan'}
          </button>
        </div>
      )}
      {open && confirmCancel && <div className="plan-pop-note mute">Drops the steps that have not started. Running units keep running; nothing that landed is undone.</div>}
    </Popover>
  )
}
