import type { Task } from './types'

/** One-line consequence of each unit control, shown wherever the control is offered (game words: docs/VOCABULARY.md). */
export const UNIT_ACTION_HINT = {
  interrupt: 'Stops the current turn; the agent idles until a ping, or until Genio finds it lagging.',
  recall: 'Stops the agent and keeps its copy; reopening the project respawns it automatically.',
  respawn: 'Restarts the agent in the same copy, resuming its conversation; it takes a squad slot.',
  despawn: "Deletes the unit's copy and branch, and closes its shells; refused while work is not landed.",
  shell: "Opens a shell in the unit's copy: edits land on its branch, and Despawn closes it.",
  folder: "Opens the unit's copy in Explorer; nothing changes.",
  archive: "Removes the Recon's copy; its report and record stay.",
  build: "Turns this Recon into a Build in the same copy, with the report as its context."
} as const

/**
 * Respawn resumes unfinished work only. A despawned, landed, ready or finished
 * unit would take a squad slot and re-run its brief; a validating one would
 * restart under a running Gauntlet.
 */
export function canRespawn(t: Pick<Task, 'state'>): boolean {
  return !['cleaned', 'merged', 'ready', 'done', 'validating'].includes(t.state)
}

/** A Build whose PR is still open: despawning it stops Genio watching the PR and removes Merge. */
export function hasOpenPr(t: Pick<Task, 'kind' | 'pr'>): boolean {
  return t.kind === 'ship' && !!t.pr?.url && t.pr.state !== 'MERGED' && t.pr.state !== 'CLOSED'
}
