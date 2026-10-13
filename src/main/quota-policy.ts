import { QUOTA_EXPLORE_PERCENT, QUOTA_HOT_PERCENT } from '@shared/dispatch'
import type { UsageWindow } from '@shared/api'
import { freshWindow } from '@shared/quota-evidence'
export { freshWindow, expireWindow } from '@shared/quota-evidence'

export type QuotaWindow = UsageWindow

/** Historical percentages are diagnostic only; protection needs a current observation. */
export function blockedWindow(w: QuotaWindow, now = Date.now()): boolean {
  return freshWindow(w, now) && (w.status === 'rejected' || (w.usedPercent ?? 0) >= QUOTA_HOT_PERCENT)
}

export function explorationSafe(windows: QuotaWindow[] | undefined, now = Date.now()): boolean {
  return Boolean(windows?.length && windows.every((w) => freshWindow(w, now) && !blockedWindow(w, now) &&
    typeof w.usedPercent === 'number' && w.usedPercent < QUOTA_EXPLORE_PERCENT))
}
