import type { Task, TerminalInfo } from './types'

/** States in which a unit with a live process is doing work or can still lose it. */
const ACTIVE = new Set<Task['state']>(['working', 'validating', 'paused', 'blocked', 'needs-decision', 'stale'])

/** The one definition of a unit in play, shared by the Squad count, the unit cap and the quit warning.
 * Completed work (ready, merged, done, failed, exited, cleaned) releases its slot even when its
 * terminal remains alive; a respawn becomes working again. */
export const holdsCapacity = (task: Pick<Task, 'state'>, alive: boolean): boolean =>
  task.state === 'spawning' || (alive && ACTIVE.has(task.state))

export function occupiedUnits(tasks: Task[], terminals: Record<string, Pick<TerminalInfo, 'alive'>>): number {
  return tasks.filter(task => holdsCapacity(task, !!task.terminalId && !!terminals[task.terminalId]?.alive)).length
}
