/**
 * The Quest log board shared by main and renderer: one order for the queue and
 * dispatch, the column a quest belongs in, the In flight set (the Squad's active
 * units, via the Squad display mapping), the durable Done history, duplicate
 * detection and the legacy held/program migration.
 */
import type { BacklogItem, Decision, Priority, Task, TerminalInfo, WorkPlan } from './types'
import { pendingDecision } from './decisions'
import { squadAttention, squadState, squadTone, type SquadState, type SquadTone } from './squad-display'

export const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'normal', 'low']
export const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 }

/** Queue and dispatch order: priority, then the manual rank within it, then age (oldest first). */
export function questOrder(a: BacklogItem, b: BacklogItem): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

export const isClosed = (q: Pick<BacklogItem, 'state'>): boolean => q.state === 'done' || q.state === 'dropped'

// ------------------------------------------------------------------ duplicates

/** Two open quests with the same title filed this close together are one piece of work. */
export const DUPLICATE_WINDOW_MS = 15 * 60_000

export const titleKey = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * The quest `item` duplicates, if any: a finished quest with the same title, or
 * an earlier open one filed within minutes. Never flags closed quests.
 */
export function findDuplicate(item: BacklogItem, items: BacklogItem[]): BacklogItem | undefined {
  if (isClosed(item)) return undefined
  const key = titleKey(item.title)
  if (!key) return undefined
  const at = Date.parse(item.createdAt) || 0
  const same = items.filter((o) => o.id !== item.id && titleKey(o.title) === key && (o.project ?? '') === (item.project ?? ''))
  const earlier = same.find((o) => {
    if (isClosed(o)) return false
    const oAt = Date.parse(o.createdAt) || 0
    return (oAt < at || (oAt === at && o.id < item.id)) && at - oAt <= DUPLICATE_WINDOW_MS
  })
  return earlier ?? same.find((o) => o.state === 'done')
}

// ------------------------------------------------------------------ columns

export type QuestColumn = 'queued' | 'in-flight' | 'done'

/** The unit's work is over and counted as finished (landed, delivered or despawned). */
export const unitFinished = (t: Task): boolean =>
  t.state === 'merged' || t.state === 'done' || t.state === 'cleaned' || !!t.landedAt || t.pr?.state === 'MERGED'

/**
 * Despawned without landing: the player discarded the work, or a Recon ended
 * without a report. Such a unit finished, but its plan step did not: the steps
 * after it must not start. Older records only say so in the despawn reason.
 */
export const unitDiscarded = (t: Task): boolean =>
  t.state === 'cleaned' && !t.landedAt && t.pr?.state !== 'MERGED' &&
  (!!t.discarded || /despawned: (forced by the player|recon ended without a report)/.test(t.stateReason ?? ''))

/**
 * Column for a quest given its unit. A quest follows its unit: a live unit puts
 * it In flight, a landed one puts an in-flight quest in Done, and an in-flight
 * quest whose unit failed, exited or vanished stays In flight (red) until resolved.
 */
export function questColumn(q: BacklogItem, task?: Task, terminal?: TerminalInfo): QuestColumn {
  if (isClosed(q)) return 'done'
  if (q.state === 'in-flight' && task && unitFinished(task)) return 'done'
  if (task && squadState(task, terminal) !== 'DONE') return 'in-flight'
  if (q.state === 'in-flight') return 'in-flight'
  return 'queued'
}

export interface FlightCard {
  key: string
  quest?: BacklogItem
  task?: Task
  /** the Squad label, or FAILED for a quest whose unit ended without landing */
  state: SquadState | 'FAILED'
  tone: SquadTone
  attention: boolean
}

export type UnitOutcome = 'merged' | 'done' | 'failed' | 'exited'
export type DoneOutcome = UnitOutcome | 'dropped'

/** How a finished unit ended; a despawn keeps the landing it was cleaned up after. */
export function unitOutcome(t: Task): UnitOutcome {
  if (t.state === 'merged' || t.landedAt || t.pr?.state === 'MERGED') return 'merged'
  if (t.state === 'failed' || t.state === 'exited') return t.state
  return 'done'
}

export interface DoneEntry {
  key: string
  title: string
  quest?: BacklogItem
  task?: Task
  outcome: DoneOutcome
  at: string
  startedAt: string
  tone: SquadTone
}

export interface QuestBoard {
  queued: BacklogItem[]
  inFlight: FlightCard[]
  done: DoneEntry[]
}

export interface BoardInput {
  backlog: BacklogItem[]
  tasks: Task[]
  terminals?: Record<string, TerminalInfo>
  decisions?: Decision[]
  now?: number
}

const flightRank = (c: FlightCard): number =>
  c.state === 'FAILED' || c.tone === 'alert' ? 0 : c.attention ? 1 : c.state === 'READY TO MERGE' ? 2 : 3

/** Every quest and unit lands in exactly one column; finished units are history in Done. */
export function buildBoard({ backlog, tasks, terminals = {}, decisions = [], now = Date.now() }: BoardInput): QuestBoard {
  const term = (t?: Task): TerminalInfo | undefined => (t?.terminalId ? terminals[t.terminalId] : undefined)
  const live = (t: Task): boolean => squadState(t, term(t)) !== 'DONE'
  const byQuest = new Map<string, Task[]>()
  for (const t of [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!t.backlogId) continue
    byQuest.set(t.backlogId, [...(byQuest.get(t.backlogId) ?? []), t])
  }
  const asking = new Set(decisions.filter((d) => d.taskId && pendingDecision(d, now)).map((d) => d.taskId!))
  const unitOf = (q: BacklogItem): Task | undefined => {
    const own = byQuest.get(q.id) ?? []
    return own.find(live) ?? (q.taskId ? tasks.find((t) => t.id === q.taskId) : undefined) ?? own[0]
  }

  const used = new Set<string>()
  const board: QuestBoard = { queued: [], inFlight: [], done: [] }
  const doneEntry = (task: Task | undefined, quest?: BacklogItem): DoneEntry => {
    const outcome: DoneOutcome = quest?.state === 'dropped' ? 'dropped' : task ? unitOutcome(task) : 'done'
    const at = quest && isClosed(quest)
      ? quest.doneAt ?? quest.updatedAt
      : task?.landedAt ?? task?.cleanedAt ?? task?.updatedAt ?? quest?.updatedAt ?? ''
    const tone: SquadTone = outcome === 'failed' || outcome === 'exited' ? 'alert' : outcome === 'dropped' ? 'amber' : 'volt'
    return {
      key: quest ? `quest-${quest.id}` : `unit-${task!.id}`, title: quest?.title ?? task!.title, quest, task,
      outcome, at, startedAt: task?.createdAt ?? quest?.createdAt ?? at, tone
    }
  }

  for (const q of backlog) {
    const task = unitOf(q)
    const column = questColumn(q, task, term(task))
    if (column === 'queued') {
      board.queued.push(q)
      continue
    }
    if (column === 'done') {
      // a unit still at work on a closed quest stays In flight on its own card
      const ended = task && !live(task) ? task : undefined
      if (ended) used.add(ended.id)
      board.done.push(doneEntry(ended, q))
      continue
    }
    if (task) used.add(task.id)
    const running = task && live(task) ? task : undefined
    const attention = !!q.hold || (running ? squadAttention(running, term(running), asking.has(running.id)) : !!task && asking.has(task.id))
    board.inFlight.push({
      key: `quest-${q.id}`, quest: q, task, attention,
      state: running ? squadState(running, term(running)) : 'FAILED',
      tone: running ? squadTone(running, term(running)) : 'alert'
    })
  }
  for (const t of tasks) {
    if (used.has(t.id)) continue
    if (live(t)) {
      const attention = squadAttention(t, term(t), asking.has(t.id))
      board.inFlight.push({ key: `unit-${t.id}`, task: t, attention, state: squadState(t, term(t)), tone: squadTone(t, term(t)) })
    } else board.done.push(doneEntry(t))
  }

  board.queued.sort(questOrder)
  board.inFlight.sort((a, b) => flightRank(a) - flightRank(b) ||
    (b.task?.createdAt ?? b.quest?.createdAt ?? '').localeCompare(a.task?.createdAt ?? a.quest?.createdAt ?? ''))
  board.done.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
  return board
}

// ------------------------------------------------------------------ queue reasons

export interface QueueChip {
  kind: 'duplicate' | 'waiting' | 'later' | 'depends' | 'quota' | 'cap' | 'ready' | 'plan'
  label: string
  title?: string
  /** shown after the label as a short date */
  date?: string
  tone: 'amber' | 'alert' | 'mute' | 'neon' | 'violet'
}

export interface QueueContext {
  backlog: BacklogItem[]
  tasks: Task[]
  terminals?: Record<string, Pick<TerminalInfo, 'alive'>>
  /** per-project unit limits: a project's own capacity or Usage mode cap */
  worldCaps?: Record<string, number | undefined>
  global?: { cap: number; used: number }
  quota?: { reason: string; until?: string }
  /** a plan step waits on "step N" and stops while its plan is paused */
  plans?: WorkPlan[]
  now?: number
}

/** Why a queued quest is not running yet, most decisive first. "ready" when nothing holds it. */
export function queueChips(q: BacklogItem, ctx: QueueContext): QueueChip[] {
  const now = ctx.now ?? Date.now()
  const chips: QueueChip[] = []
  const find = (id: string): BacklogItem | undefined => ctx.backlog.find((b) => b.id === id)
  if (q.duplicateOf) {
    const d = find(q.duplicateOf)
    chips.push({ kind: 'duplicate', label: `duplicate of "${d?.title ?? q.duplicateOf}"`, title: d ? `${d.id} (${d.state})` : undefined, tone: 'amber' })
  }
  const deferred = q.hold?.until && Date.parse(q.hold.until) > now
  if (deferred) chips.push({ kind: 'later', label: 'later', date: q.hold!.until, title: q.hold!.reason, tone: 'mute' })
  else if ((q.hold && !q.hold.until) || (q.kind === 'choice' && !q.hold)) {
    chips.push({ kind: 'waiting', label: 'waiting for you', title: q.hold?.reason ?? 'A choice only you can make', tone: 'amber' })
  }
  const plan = q.planId ? ctx.plans?.find((p) => p.id === q.planId) : undefined
  if (plan && (plan.state === 'paused' || plan.state === 'cancelled')) {
    chips.push({ kind: 'plan', label: `plan ${plan.state}`, title: plan.pause?.reason ?? `Plan "${plan.title}" is ${plan.state}`, tone: 'amber' })
  }
  const deps = q.dependsOn.filter((id) => find(id)?.state !== 'done')
  if (deps.length) {
    const first = find(deps[0])
    const steps = plan ? deps.map((id) => plan.steps.find((s) => s.questId === id)?.index) : []
    chips.push({
      kind: 'depends',
      label: steps.length && steps.every((i) => i !== undefined) ? `waits on step ${steps.join(', ')}`
        : `waits on ${first ? `"${first.title}"` : deps[0]}${deps.length > 1 ? ` +${deps.length - 1}` : ''}`,
      title: deps.map((id) => find(id)?.title ?? `${id} (missing)`).join('\n'), tone: 'mute'
    })
  }
  if (q.notBefore && Date.parse(q.notBefore) > now) chips.push({ kind: 'later', label: 'not before', date: q.notBefore, tone: 'mute' })
  if (ctx.quota) chips.push({ kind: 'quota', label: 'until plan reset', date: ctx.quota.until, title: ctx.quota.reason, tone: 'violet' })
  if (chips.length || (q.kind !== 'ship' && q.kind !== 'scout')) return chips
  const worldCap = q.project ? ctx.worldCaps?.[q.project] : undefined
  if (worldCap && worldCap > 0) {
    const terms = ctx.terminals ?? {}
    const busy = ctx.tasks.filter((t) => t.project === q.project && (t.state === 'spawning' ||
      (!!t.terminalId && !!terms[t.terminalId]?.alive && !['ready', 'merged', 'done', 'failed', 'cleaned'].includes(t.state)))).length
    if (busy >= worldCap) return [{ kind: 'cap', label: 'at unit cap', title: `${q.project}: ${busy}/${worldCap} units running`, tone: 'mute' }]
  }
  if (ctx.global && ctx.global.used >= ctx.global.cap) {
    return [{ kind: 'cap', label: 'at unit cap', title: `${ctx.global.used}/${ctx.global.cap} units running across all projects`, tone: 'mute' }]
  }
  return [{ kind: 'ready', label: 'ready', tone: 'neon' }]
}

// ------------------------------------------------------------------ priority editing

/** Priority bands the Queued column shows: only populated ones, or all four as drop targets while a ticket is dragged. */
export function visibleBands(queue: Pick<BacklogItem, 'priority'>[], dragging: boolean): Priority[] {
  return dragging ? PRIORITY_ORDER : PRIORITY_ORDER.filter((p) => queue.some((q) => q.priority === p))
}

export interface RankPatch { id: string; priority: Priority; rank: number }

/**
 * Drop `id` into the `priority` band of the queue, before `beforeId` (or at the
 * end). Returns the patches that persist the band's new manual order.
 */
export function reorderQueue(queue: BacklogItem[], id: string, priority: Priority, beforeId?: string): RankPatch[] {
  const moving = queue.find((q) => q.id === id)
  if (!moving) return []
  const band = queue.filter((q) => q.priority === priority && q.id !== id).sort(questOrder)
  const at = beforeId ? band.findIndex((q) => q.id === beforeId) : -1
  band.splice(at < 0 ? band.length : at, 0, moving)
  return band
    .map((q, i) => ({ q, patch: { id: q.id, priority, rank: i + 1 } }))
    .filter(({ q, patch }) => q.priority !== patch.priority || q.rank !== patch.rank)
    .map(({ patch }) => patch)
}

// ------------------------------------------------------------------ legacy migration

const labelOf = (program: BacklogItem): string =>
  program.tags.find(Boolean) ?? (program.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || program.id)

/**
 * Held is no longer a state: a held quest is a queued quest flagged "waiting for
 * you" (the hold and the player's words are kept). Programs are no longer quests:
 * each retires to the done archive and its quests carry its label as a tag.
 */
export function migrateLegacyQuests(items: BacklogItem[], now: string): { items: BacklogItem[]; retired: BacklogItem[]; changed: boolean } {
  let changed = false
  const programs = items.filter((i) => i.kind === 'program')
  const labels = new Map(programs.map((p) => [p.id, labelOf(p)]))
  const retired = programs.map((p) => ({
    ...p,
    state: p.state === 'done' ? ('done' as const) : ('dropped' as const),
    doneAt: p.doneAt ?? now,
    outcome: [p.outcome, `Program retired: its quests carry the label "${labels.get(p.id)}".`].filter(Boolean).join('\n')
  }))
  const kept = items.filter((i) => i.kind !== 'program').map((i) => {
    let next = i
    if (i.dependsOn.some((d) => labels.has(d))) {
      const tags = [...i.tags]
      for (const d of i.dependsOn) if (labels.has(d) && !tags.includes(labels.get(d)!)) tags.push(labels.get(d)!)
      next = { ...next, dependsOn: i.dependsOn.filter((d) => !labels.has(d)), tags }
    }
    if (next.state === 'held') {
      next = { ...next, state: 'queued', hold: next.hold ?? { reason: 'waiting on the player', since: next.updatedAt } }
    }
    if (next !== i) changed = true
    return next
  })
  return { items: kept, retired, changed: changed || programs.length > 0 }
}
