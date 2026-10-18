import type { Task, TaskOutcome, TaskState, TerminalInfo } from './types'
import { resumedAfterReady } from './unit-activity'
import { formatDuration } from './duration'

export type SquadState = 'WORKING' | 'READY TO MERGE' | 'DONE'
export type SquadTone = 'blue' | 'violet' | 'orange' | 'magenta' | 'volt' | 'alert' | 'amber'
export type SquadOutcome = TaskOutcome

/** Internal states the Squad shows as DONE. */
export const DONE_STATES: TaskState[] = ['merged', 'done', 'failed', 'exited', 'cleaned']
/** The rail keeps this many finished units; the Quest log keeps the full history. */
export const DONE_HISTORY = 25

/** Display only: lifecycle and capacity policies deliberately stay unchanged. */
export function squadState(task: Task, terminal?: TerminalInfo): SquadState {
  if (DONE_STATES.includes(task.state)) return 'DONE'
  if (task.state !== 'ready' || task.validation?.state === 'running') return 'WORKING'
  // A surviving idle CLI is allowed and its own chrome is not work. Positive
  // evidence of resumed work wins over an old PR/ready label.
  if (terminal?.alive && resumedAfterReady(task, terminal)) return 'WORKING'
  return 'READY TO MERGE'
}

/**
 * The unit's color everywhere it appears (Squad rail, Squad page, Quest log):
 * red for errors, green for ready or done, otherwise its kind at work, purple
 * Recon, orange Modeller, magenta Generator or blue Build. Needing the player
 * never repaints the unit; it is the separate yellow indicator from `squadAttention`.
 */
export function squadTone(task: Task, terminal?: TerminalInfo): SquadTone {
  const abnormalExit = task.state === 'exited' && (terminal?.exitCode !== undefined
    ? terminal.exitCode !== 0 : !/\bcode 0\b/.test(task.stateReason ?? ''))
  if (task.state === 'failed' || abnormalExit ||
      (terminal?.alive === false && terminal.exitCode !== undefined && terminal.exitCode !== 0)) return 'alert'
  if (squadState(task, terminal) !== 'WORKING') return 'volt'
  return unitKindTone(task)
}

/** A unit's kind color, whatever its state: its kind chip and icon on the Squad, unit page and Quest log. */
export function unitKindTone(task: Pick<Task, 'kind' | 'modeller' | 'generator'>): 'blue' | 'violet' | 'orange' | 'magenta' {
  if (task.kind === 'scout') return 'violet'
  return task.modeller ? 'orange' : task.generator ? 'magenta' : 'blue'
}

/** Yellow indicator: an active unit waits on the player (an open question, blocked, or a pending decision). */
export function squadAttention(task: Task, terminal?: TerminalInfo, pending = false): boolean {
  if (squadState(task, terminal) === 'DONE' || squadTone(task, terminal) === 'alert') return false
  return pending || task.state === 'needs-decision' || task.state === 'blocked'
}

/** How a finished unit ended. The outcome recorded at finish time survives a later despawn. */
export function squadOutcome(task: Task, terminal?: TerminalInfo): SquadOutcome {
  if (task.state === 'merged' || task.landedAt || task.pr?.state === 'MERGED') return 'merged'
  if (task.outcome) return task.outcome
  if (task.state === 'failed') return 'failed'
  if (task.state === 'exited' && squadTone(task, terminal) === 'alert') return 'exited abnormally'
  return 'done'
}

export const outcomeTone = (o: SquadOutcome): SquadTone => (o === 'failed' || o === 'exited abnormally' ? 'alert' : 'volt')

/** A unit's badge: WORKING or READY TO MERGE while active, then how it ended (FAILED, MERGED…), never a red DONE. */
export function squadBadge(task: Task, terminal?: TerminalInfo): { label: string; tone: SquadTone } {
  const state = squadState(task, terminal)
  if (state !== 'DONE') return { label: state, tone: squadTone(task, terminal) }
  const outcome = squadOutcome(task, terminal)
  return { label: outcome.toUpperCase(), tone: outcomeTone(outcome) }
}

/** Finish time from the persisted record; legacy records fall back to their landing, despawn or last update. */
export function finishedAt(task: Task): string {
  return task.finishedAt ?? task.landedAt ?? task.cleanedAt ?? task.updatedAt
}

/** How long the unit has run: live while WORKING, stopped once it is ready or finished. */
function unitRunMs(task: Task, terminal: TerminalInfo | undefined, now: number): { ms: number; working: boolean } {
  const start = Date.parse(task.createdAt) || now
  const state = squadState(task, terminal)
  if (state === 'WORKING') return { ms: now - start, working: true }
  const end = Date.parse(state === 'DONE' ? finishedAt(task) : task.readyAt ?? task.lastStatusAt ?? task.updatedAt) || now
  return { ms: end - start, working: false }
}

/** "working 23m 4s" while active; "took 54m 10s" once ready or finished. */
export function unitClock(task: Task, terminal?: TerminalInfo, now = Date.now()): string {
  const run = unitRunMs(task, terminal, now)
  return `${run.working ? 'working' : 'took'} ${formatDuration(run.ms)}`
}

/** The Squad rail's clock, without the unit page's working/took prefix. */
export function unitClockShort(task: Task, terminal?: TerminalInfo, now = Date.now()): string {
  return formatDuration(unitRunMs(task, terminal, now).ms)
}

/** Squad page: the active units in their given order. */
export function squadActive<T extends Task>(tasks: T[], terminalOf: (t: T) => TerminalInfo | undefined = () => undefined): T[] {
  return tasks.filter((t) => squadState(t, terminalOf(t)) !== 'DONE')
}

/** Rail: active units first, then the newest finished units, capped. Despawned units never return. */
export function squadSections<T extends Task>(tasks: T[], terminalOf: (t: T) => TerminalInfo | undefined = () => undefined,
  limit = DONE_HISTORY): { active: T[]; done: T[] } {
  const active: T[] = [], done: T[] = []
  for (const t of tasks) {
    if (t.state === 'cleaned') continue
    const section = squadState(t, terminalOf(t)) === 'DONE' ? done : active
    section.push(t)
  }
  const at = (t: T): number => Date.parse(finishedAt(t)) || 0
  done.sort((a, b) => at(b) - at(a) || b.createdAt.localeCompare(a.createdAt))
  return { active, done: done.slice(0, limit) }
}
