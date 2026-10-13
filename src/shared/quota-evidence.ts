import type { UsageWindow } from './api'
import { QUOTA_EVIDENCE_TTL } from './dispatch'

/** The observation clock, never the last scan or the last status-only event. */
export function freshWindow(w: UsageWindow, now = Date.now()): boolean {
  const observed = Date.parse(w.observedAt ?? '')
  const reset = Date.parse(w.resetsAt ?? '')
  return !w.stale && Number.isFinite(observed) && observed <= now && now - observed <= QUOTA_EVIDENCE_TTL && !(reset <= now)
}

export function expireWindow(w: UsageWindow, now = Date.now()): UsageWindow {
  const stale = !freshWindow(w, now)
  return { ...w, stale, usedPercent: stale ? undefined : w.usedPercent,
    status: stale ? undefined : w.status, lastKnownUsedPercent: w.usedPercent ?? w.lastKnownUsedPercent }
}
