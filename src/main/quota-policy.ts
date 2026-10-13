import { QUOTA_EVIDENCE_TTL, QUOTA_EXPLORE_PERCENT, QUOTA_HOT_PERCENT } from '@shared/dispatch'
import type { UsageWindow } from '@shared/api'

export type QuotaWindow = UsageWindow

export function freshWindow(w: QuotaWindow, now = Date.now()): boolean {
  const observed = Date.parse(w.observedAt ?? '')
  const reset = Date.parse(w.resetsAt ?? '')
  return !w.stale && Number.isFinite(observed) && observed <= now && now - observed <= QUOTA_EVIDENCE_TTL && !(reset <= now)
}

/** Old hot evidence stays protective until a new provider observation confirms recovery. */
export function blockedWindow(w: QuotaWindow): boolean {
  return w.status === 'rejected' || (w.usedPercent ?? w.lastKnownUsedPercent ?? 0) >= QUOTA_HOT_PERCENT
}

export function explorationSafe(windows: QuotaWindow[] | undefined, now = Date.now()): boolean {
  return Boolean(windows?.length && windows.every((w) => freshWindow(w, now) && !blockedWindow(w) &&
    typeof w.usedPercent === 'number' && w.usedPercent < QUOTA_EXPLORE_PERCENT))
}

export function expireWindow(w: UsageWindow, now = Date.now()): UsageWindow {
  const stale = !freshWindow(w, now)
  return { ...w, stale, usedPercent: stale ? undefined : w.usedPercent,
    lastKnownUsedPercent: w.usedPercent ?? w.lastKnownUsedPercent }
}
