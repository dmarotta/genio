import type { Task } from './types'

/** One-line consequence of each unit control, shown wherever the control is offered (game words: docs/VOCABULARY.md). */
export const UNIT_ACTION_HINT = {
  interrupt: 'Stops the current turn; the agent idles until a ping, or until Genio finds it lagging.',
  recall: 'Stops the agent and keeps its copy; reopening the project respawns it automatically.',
  respawn: 'Restarts the agent in the same copy, resuming its conversation; it takes a squad slot.',
  despawn: "Deletes the unit's copy and branch, and closes a terminal open in it; work not merged is lost.",
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

/**
 * The Despawn confirm: one line and one button besides Cancel. Discard when the
 * unit may hold work that is not merged (the click discards it), Despawn when
 * nothing is lost.
 */
export function despawnConfirm(t: Pick<Task, 'kind' | 'state' | 'pr' | 'landedAt' | 'reportPath'>): { line: string; button: 'Despawn' | 'Discard' } {
  if (t.kind === 'scout') return t.reportPath ? { line: 'Despawn this Recon?', button: 'Despawn' } : { line: 'Discard this Recon and its unfinished report?', button: 'Discard' }
  if (t.state === 'merged' || t.pr?.state === 'MERGED' || t.landedAt) return { line: 'Despawn this unit?', button: 'Despawn' }
  if (hasOpenPr(t)) return { line: `Despawn this unit? Its PR${t.pr!.number ? ` #${t.pr!.number}` : ''} stays open but can no longer be merged here.`, button: 'Despawn' }
  return { line: 'Discard this unit and its unmerged work?', button: 'Discard' }
}
