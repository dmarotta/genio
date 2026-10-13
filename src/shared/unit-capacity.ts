import type { Task, TerminalInfo } from './types'

/** Completed work releases its slot even when its terminal remains alive.
 * A respawn becomes working again; a PR from its previous run is only history. */
export const holdsCapacity = (task: Pick<Task, 'state'>, alive: boolean): boolean =>
  task.state === 'spawning' || (alive && !['ready', 'merged', 'done', 'failed', 'cleaned'].includes(task.state))

export function occupiedUnits(tasks: Task[], terminals: Record<string, Pick<TerminalInfo, 'alive'>>): number {
  return tasks.filter(task => holdsCapacity(task, !!task.terminalId && !!terminals[task.terminalId]?.alive)).length
}
