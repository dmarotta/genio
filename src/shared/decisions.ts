import type { Decision } from './types'

/** A project is authoritative; unassigned choices belong to their base. */
export function ownsDecision(d: Decision, binding: { project: string; workspace: string }): boolean {
  return d.project ? d.project === binding.project : d.workspace === binding.workspace
}

export function pendingDecision(d: Decision, now = Date.now()): boolean {
  return !d.resolvedAt && (!d.until || Date.parse(d.until) <= now)
}

/** Pending and asking now: a choice set aside with Later or Ask Genio waits quietly, off the popup. */
export function askingDecision(d: Decision, now = Date.now()): boolean {
  return pendingDecision(d, now) && !d.held
}
