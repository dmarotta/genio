/**
 * WorkPlans shared by main and renderer: the step graph checks and order, each
 * step's state derived from its quest and unit (never from what an agent says
 * it did), and the plan view that plan_status returns and the step chips render.
 */
import type { BacklogItem, PlanStep, Priority, Task, TaskKind, WorkPlan } from './types'
import { unitDiscarded, unitFinished } from './quest-board'

/** waiting: a prerequisite has not merged · queued: free to start · ready: waits for its merge. */
export type StepState = 'waiting' | 'queued' | 'in-flight' | 'ready' | 'merged' | 'blocked' | 'discarded'

export interface StepGraphInput {
  key: string
  after?: string[]
}

/** Problems with a plan's step graph: bad or duplicate keys, unknown prerequisites, cycles. */
export function stepGraphProblems(steps: StepGraphInput[]): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const s of steps) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(s.key)) problems.push(`step key "${s.key}" must be 1-40 letters, digits, - or _`)
    else if (keys.has(s.key)) problems.push(`step key "${s.key}" is used twice`)
    keys.add(s.key)
  }
  for (const s of steps) {
    for (const a of s.after ?? []) {
      if (a === s.key) problems.push(`step "${s.key}" cannot come after itself`)
      else if (!keys.has(a)) problems.push(`step "${s.key}" comes after unknown step "${a}"`)
    }
  }
  if (!problems.length && !topoOrder(steps)) problems.push('the steps form a cycle: every chain of "after" must end at a step with no prerequisite')
  return problems
}

/** Step keys with every prerequisite first, keeping the given order among equals; undefined on a cycle. */
export function topoOrder(steps: StepGraphInput[]): string[] | undefined {
  const order: string[] = []
  const placed = new Set<string>()
  const keys = new Set(steps.map((s) => s.key))
  while (order.length < steps.length) {
    const next = steps.find((s) => !placed.has(s.key) && (s.after ?? []).every((a) => placed.has(a) || !keys.has(a)))
    if (!next) return undefined
    placed.add(next.key)
    order.push(next.key)
  }
  return order
}

/** The step's work landed: a merged Build, a delivered Recon. A despawned Build only counts once it landed. */
export function workLanded(kind: TaskKind, t: Task): boolean {
  if (unitDiscarded(t)) return false
  if (kind === 'scout') return t.state === 'done' || t.state === 'cleaned' || t.state === 'merged'
  return t.state === 'merged' || !!t.landedAt || t.pr?.state === 'MERGED' || t.state === 'cleaned'
}

/** The unit currently (or last) working a step. */
export function stepTask(step: Pick<PlanStep, 'taskIds'>, quest: BacklogItem | undefined, tasks: Task[]): Task | undefined {
  const ids = [...step.taskIds].reverse()
  if (quest?.taskId && !ids.includes(quest.taskId)) ids.unshift(quest.taskId)
  for (const id of ids) {
    const t = tasks.find((x) => x.id === id)
    if (t) return t
  }
  return undefined
}

const STOPPED = ['failed', 'exited', 'blocked', 'needs-decision']

/** A step's state from its quest and unit. */
export function stepState(step: Pick<PlanStep, 'kind' | 'after'>, quest: BacklogItem | undefined, task: Task | undefined, prerequisitesMerged: boolean): StepState {
  if (!quest || quest.state === 'dropped') return 'discarded'
  if (quest.state === 'done') return 'merged'
  if (quest.state === 'blocked') return task && unitDiscarded(task) ? 'discarded' : 'blocked'
  if (quest.state === 'in-flight') {
    if (!task) return 'in-flight'
    if (unitDiscarded(task)) return 'discarded'
    if (unitFinished(task) && workLanded(step.kind, task)) return 'merged'
    if (task.state === 'ready') return 'ready'
    if (STOPPED.includes(task.state)) return 'blocked'
    return 'in-flight'
  }
  return prerequisitesMerged ? 'queued' : 'waiting'
}

export interface PlanStepView {
  key: string
  index: number
  title: string
  kind: TaskKind
  state: StepState
  questId: string
  taskId?: string
  after: string[]
  /** prerequisite step keys that have not merged yet */
  waitsOn: string[]
  acceptance: string
  files: string[]
  landedCommit?: string
  landedPr?: string
  landedAt?: string
  /** why a startable step has not started (capacity, quota, closed project window), or the unit's own reason */
  note?: string
}

export interface PlanView {
  id: string
  title: string
  world: string
  state: WorkPlan['state']
  autoAdvance: boolean
  maxParallel: number
  priority: Priority
  /** when the plan last changed; a finished plan's date on the board */
  endedAt: string
  total: number
  merged: number
  steps: PlanStepView[]
  /** step keys Genio releases next (every prerequisite merged, not started yet) */
  next: string[]
  /** step keys with a unit at work (ready-to-merge excluded) */
  running: string[]
  /** what stops the plan from moving on by itself */
  blockers: string[]
  pause?: WorkPlan['pause']
}

/** The plan as the player and the main chat see it: one derived state per step. */
export function planView(plan: WorkPlan, backlog: BacklogItem[], tasks: Task[]): PlanView {
  const quest = (id: string): BacklogItem | undefined => backlog.find((b) => b.id === id)
  const states = new Map<string, StepState>()
  const steps = [...plan.steps].sort((a, b) => a.index - b.index)
  // steps are stored in topological order, so every prerequisite is settled first
  const views: PlanStepView[] = steps.map((s) => {
    const q = quest(s.questId)
    const task = stepTask(s, q, tasks)
    const waitsOn = s.after.filter((a) => states.get(a) !== 'merged')
    const state = stepState(s, q, task, waitsOn.length === 0)
    states.set(s.key, state)
    const note = state === 'queued' ? s.lastAttempt?.message
      : state === 'blocked' || state === 'discarded' ? task?.stateReason ?? q?.outcome
        : undefined
    return {
      key: s.key, index: s.index, title: s.title, kind: s.kind, state, questId: s.questId, taskId: task?.id, after: s.after, waitsOn,
      acceptance: s.acceptance, files: s.files, landedCommit: s.landedCommit, landedPr: s.landedPr, landedAt: s.landedAt,
      ...(note ? { note } : {})
    }
  })
  const label = (v: PlanStepView): string => `step ${v.index} "${v.title}"`
  const blockers: string[] = []
  if (plan.pause) blockers.push(`paused: ${plan.pause.reason}`)
  else if (plan.state === 'active' && !plan.autoAdvance) blockers.push('auto-advance is off: steps start only when deployed')
  for (const v of views) {
    if (v.state === 'blocked') blockers.push(`${label(v)} is blocked${v.note ? `: ${v.note}` : ''}`)
    else if (v.state === 'discarded') blockers.push(`${label(v)} was discarded`)
    else if (v.state === 'ready') blockers.push(`${label(v)} waits for its merge`)
    else if (v.state === 'queued' && v.note) blockers.push(`${label(v)} not started: ${v.note}`)
  }
  return {
    id: plan.id, title: plan.title, world: plan.world, state: plan.state, autoAdvance: plan.autoAdvance, maxParallel: plan.maxParallel,
    priority: plan.priority ?? 'normal', endedAt: plan.doneAt ?? plan.updatedAt,
    total: views.length, merged: views.filter((v) => v.state === 'merged').length, steps: views,
    next: views.filter((v) => v.state === 'queued').map((v) => v.key),
    running: views.filter((v) => v.state === 'in-flight').map((v) => v.key),
    blockers, ...(plan.pause ? { pause: plan.pause } : {})
  }
}

/** The plan and step a quest belongs to. */
export function planStepOf(plans: WorkPlan[], questId: string): { plan: WorkPlan; step: PlanStep } | undefined {
  for (const plan of plans) {
    const step = plan.steps.find((s) => s.questId === questId)
    if (step) return { plan, step }
  }
  return undefined
}

// ---------------------------------------------------------------- plan card

export type PlanColumn = 'queued' | 'in-flight' | 'done'

/** The Quest log column a plan's one card sits in: In flight while a unit has a step, Done once it ended, else Queued. */
export function planColumn(v: Pick<PlanView, 'state' | 'steps'>): PlanColumn {
  if (v.state === 'done' || v.state === 'cancelled') return 'done'
  return v.steps.some((s) => s.state === 'in-flight' || s.state === 'ready' || s.state === 'blocked') ? 'in-flight' : 'queued'
}

/** The step the card names: the one at work (or stuck), else the one that starts next. */
export function currentStep(v: Pick<PlanView, 'steps'>): PlanStepView | undefined {
  return v.steps.find((s) => s.state === 'blocked') ?? v.steps.find((s) => s.state === 'in-flight' || s.state === 'ready') ??
    v.steps.find((s) => s.state === 'queued') ?? v.steps.find((s) => s.state === 'waiting')
}

/** The card's one progress line: "1/3 merged · step 2 Door sounds". */
export function planProgress(v: Pick<PlanView, 'merged' | 'total' | 'steps' | 'state'>): string {
  const base = `${v.merged}/${v.total} merged`
  const cur = v.state === 'active' || v.state === 'paused' ? currentStep(v) : undefined
  return cur ? `${base} · step ${cur.index} ${cur.title}` : base
}

/** Dispatch starts a plan that is paused, or whose steps wait to be started; a plan with a step at work needs no button. */
export function planCanDispatch(v: Pick<PlanView, 'state' | 'steps' | 'autoAdvance'>): boolean {
  if (v.state === 'paused') return true
  return v.state === 'active' && planColumn(v) === 'queued' && (!v.autoAdvance || v.steps.some((s) => s.state === 'queued'))
}
/** One step's state in words: "merged", "working", "waits on step 2". */
export function stepStateText(v: Pick<PlanStepView, 'state' | 'waitsOn' | 'kind'>, steps: Pick<PlanStepView, 'key' | 'index'>[]): string {
  switch (v.state) {
    case 'merged': return v.kind === 'scout' ? 'delivered' : 'merged'
    case 'in-flight': return 'working'
    case 'ready': return v.kind === 'scout' ? 'report ready' : 'ready to merge'
    case 'blocked': return 'blocked'
    case 'discarded': return 'discarded'
    case 'queued': return 'starts next'
    case 'waiting': {
      const idx = v.waitsOn.map((k) => steps.find((s) => s.key === k)?.index ?? k)
      return `waits on step ${idx.join(', ')}`
    }
  }
}

/** The Squad's colors for a step: green landed or ready, blue/purple at work, red discarded, yellow blocked. */
export function stepTone(v: Pick<PlanStepView, 'state' | 'kind'>): 'volt' | 'blue' | 'violet' | 'alert' | 'amber' | 'mute' {
  switch (v.state) {
    case 'merged': case 'ready': return 'volt'
    case 'in-flight': return v.kind === 'scout' ? 'violet' : 'blue'
    case 'blocked': return 'amber'
    case 'discarded': return 'alert'
    default: return 'mute'
  }
}
