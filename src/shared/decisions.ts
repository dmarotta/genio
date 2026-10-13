import type { Decision } from './types'

/** A project is authoritative; unassigned choices belong to their base. */
export function ownsDecision(d: Decision, binding: { project: string; wksp: string }): boolean {
  return d.project ? d.project === binding.project : d.wksp === binding.wksp
}

export function pendingDecision(d: Decision, now = Date.now()): boolean {
  return !d.resolvedAt && (!d.until || Date.parse(d.until) <= now)
}
