import type { Task, TaskOutcome, TaskState, TerminalInfo } from './types'

export type SquadState = 'WORKING' | 'READY TO MERGE' | 'DONE'
export type SquadTone = 'blue' | 'violet' | 'volt' | 'alert' | 'amber'
export type SquadOutcome = TaskOutcome

/** Internal states the Squad shows as DONE. */
export const DONE_STATES: TaskState[] = ['merged', 'done', 'failed', 'exited', 'cleaned']
/** The Squad keeps this many finished units below the active ones; the Quest log keeps the full record. */
export const DONE_HISTORY = 25

/** Display only: lifecycle and capacity policies deliberately stay unchanged. */
export function squadState(task: Task, terminal?: TerminalInfo): SquadState {
  if (DONE_STATES.includes(task.state)) return 'DONE'
  if (task.state !== 'ready' || task.validation?.state === 'running') return 'WORKING'
  // A surviving idle CLI is allowed. Output after the final status means work
  // has resumed; never let its old PR/ready label override that evidence.
  const output = Math.max(Date.parse(task.lastOutputAt ?? '') || 0, Date.parse(terminal?.lastOutputAt ?? '') || 0)
  const ready = Date.parse(task.readyAt ?? task.lastStatusAt ?? task.updatedAt) || 0
  if (terminal?.alive && (!ready || output > ready)) return 'WORKING'
  return 'READY TO MERGE'
}

/**
 * The unit's color everywhere it appears (Squad rail, Squad page, Quest log):
 * red for errors, green for ready or done, otherwise its kind at work, purple
 * Recon or blue Build. Needing the player never repaints the unit; it is the
 * separate yellow indicator from `squadAttention`.
 */
export function squadTone(task: Task, terminal?: TerminalInfo): SquadTone {
  const abnormalExit = task.state === 'exited' && (terminal?.exitCode !== undefined
    ? terminal.exitCode !== 0 : !/\bcode 0\b/.test(task.stateReason ?? ''))
  if (task.state === 'failed' || abnormalExit ||
      (terminal?.alive === false && terminal.exitCode !== undefined && terminal.exitCode !== 0)) return 'alert'
  if (squadState(task, terminal) !== 'WORKING') return 'volt'
  return task.kind === 'scout' ? 'violet' : 'blue'
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

/** Finish time from the persisted record; legacy records fall back to their landing, despawn or last update. */
export function finishedAt(task: Task): string {
  return task.finishedAt ?? task.landedAt ?? task.cleanedAt ?? task.updatedAt
}

/**
 * Squad list: active units in their given order, then the newest finished
 * units (newest first), capped so older ones drop off the list.
 */
export function squadSections<T extends Task>(tasks: T[], terminalOf: (t: T) => TerminalInfo | undefined = () => undefined,
  limit = DONE_HISTORY): { active: T[]; done: T[] } {
  const active: T[] = [], done: T[] = []
  for (const t of tasks) (squadState(t, terminalOf(t)) === 'DONE' ? done : active).push(t)
  const at = (t: T): number => Date.parse(finishedAt(t)) || 0
  done.sort((a, b) => at(b) - at(a) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return { active, done: done.slice(0, limit) }
}
