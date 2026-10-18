import type { Task, TerminalInfo } from './types'
import { resumedAfterReady } from './unit-activity'

/** States in which a unit with a live process is doing work or can still lose it. */
const ACTIVE = new Set<Task['state']>(['working', 'validating', 'paused', 'blocked', 'needs-decision', 'stale'])

type CapacityFields = Pick<Task, 'state'> & Partial<Pick<Task, 'readyAt' | 'lastStatusAt' | 'updatedAt' | 'resumedAt' | 'harness'>>
type CapacityTerminal = Pick<TerminalInfo, 'alive'> & Partial<Pick<TerminalInfo, 'processSpawnedAt' | 'workOutputAt'>>

/** The one definition of a unit in play, shared by the Squad count, the unit cap and the quit warning.
 * Completed work (ready, merged, done, failed, exited, cleaned) releases its slot even when its
 * terminal remains alive; a respawn becomes working again, and so does a ready unit with positive
 * evidence of resumed work (the Squad's WORKING), never its idle CLI chrome. */
export const holdsCapacity = (task: CapacityFields, alive: boolean, terminal?: CapacityTerminal): boolean =>
  task.state === 'spawning' || (alive && (ACTIVE.has(task.state) ||
    (task.state === 'ready' && resumedAfterReady(task, terminal))))

export function occupiedUnits(tasks: Task[], terminals: Record<string, CapacityTerminal>): number {
  return tasks.filter(task => {
    const terminal = task.terminalId ? terminals[task.terminalId] : undefined
    return holdsCapacity(task, !!terminal?.alive, terminal)
  }).length
}

/** Independent global concurrency setting; the old Balanced limit is the new-install default. */
export const DEFAULT_UNITS_AT_ONCE = 8
export const MAX_UNITS_AT_ONCE = 32

export function normalizeUnitsAtOnce(value: unknown, fallback = DEFAULT_UNITS_AT_ONCE): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_UNITS_AT_ONCE, Math.round(value))) : fallback
}

/** Only an explicit project capacity can lower the global setting; equal limits need no extra display. */
export function unitCaps(unitsAtOnce: number, project?: { capacity?: number }): { global: number; world?: number } {
  const global = normalizeUnitsAtOnce(unitsAtOnce)
  const own = project?.capacity
  return { global, world: own !== undefined && own > 0 && own < global ? own : undefined }
}
