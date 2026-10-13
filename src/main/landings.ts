/**
 * Daily landing counts for the Character Sheet heatmap, kept in stats.json.
 *
 * Recorded going forward only: one per merged build and one per delivered
 * recon report, deduplicated by mission (a quest-linked mission counts once,
 * never again through its quest or a re-delivered event). Days are local
 * calendar days. A day before recording began, or one Genio never saw, is
 * unknown rather than zero.
 */
import type { LandingDay } from '@shared/types'
import { todayStamp } from './util'

export interface LandingLog {
  /** first day of recording */
  since: string
  days: Record<string, { builds: number; recons: number }>
  /** dedupe keys -> day recorded */
  seen: Record<string, string>
  /** days Genio was running and recording */
  observed: string[]
}

export type LandingKind = 'build' | 'recon'

/** history kept on disk; the sheet shows 8 weeks */
const KEEP_DAYS = 400
/** a re-delivered event is never this late */
const SEEN_DAYS = 120

export function freshLandingLog(today = new Date()): LandingLog {
  return { since: todayStamp(today), days: {}, seen: {}, observed: [todayStamp(today)] }
}

/** Accept whatever stats.json holds; anything malformed starts recording today. */
export function loadLandingLog(raw: unknown, today = new Date()): LandingLog {
  const r = raw as Partial<LandingLog> | undefined
  if (!r || typeof r.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.since)) return freshLandingLog(today)
  return {
    since: r.since,
    days: r.days && typeof r.days === 'object' ? r.days : {},
    seen: r.seen && typeof r.seen === 'object' ? r.seen : {},
    observed: Array.isArray(r.observed) ? r.observed.filter((d) => typeof d === 'string') : []
  }
}

const shift = (d: Date, days: number): Date => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() + days)
  return x
}

function prune(log: LandingLog, today: Date): void {
  const keepFrom = todayStamp(shift(today, -KEEP_DAYS))
  const seenFrom = todayStamp(shift(today, -SEEN_DAYS))
  for (const d of Object.keys(log.days)) if (d < keepFrom) delete log.days[d]
  for (const [k, d] of Object.entries(log.seen)) if (d < seenFrom) delete log.seen[k]
  log.observed = log.observed.filter((d) => d >= keepFrom)
}

/** Mark today as recorded; true when that changed the log. */
export function observeDay(log: LandingLog, today = new Date()): boolean {
  const day = todayStamp(today)
  if (log.observed.includes(day)) return false
  log.observed.push(day)
  prune(log, today)
  return true
}

/** Count one landing for a mission; false when that mission (or its quest) already counted for this kind. */
export function recordLanding(log: LandingLog, kind: LandingKind, mission: { taskId?: string; questId?: string }, now = new Date()): boolean {
  const keys = [mission.taskId && `${kind}:task:${mission.taskId}`, mission.questId && `${kind}:quest:${mission.questId}`].filter(Boolean) as string[]
  if (keys.some((k) => log.seen[k])) return false
  const day = todayStamp(now)
  for (const k of keys) log.seen[k] = day
  const cur = log.days[day] ?? { builds: 0, recons: 0 }
  log.days[day] = kind === 'build' ? { ...cur, builds: cur.builds + 1 } : { ...cur, recons: cur.recons + 1 }
  observeDay(log, now)
  return true
}

/** The heatmap: `weeks` Monday-first weeks ending with the current one. */
export function landingWindow(log: LandingLog, today = new Date(), weeks = 8): LandingDay[] {
  const todayKey = todayStamp(today)
  const monday = shift(today, -((today.getDay() + 6) % 7))
  const start = shift(monday, -7 * (weeks - 1))
  const observed = new Set(log.observed)
  const out: LandingDay[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const day = todayStamp(shift(start, i))
    const counts = log.days[day]
    const state: LandingDay['state'] = day > todayKey ? 'future' : counts || (day >= log.since && observed.has(day)) ? 'recorded' : 'unknown'
    out.push({ day, builds: counts?.builds ?? 0, recons: counts?.recons ?? 0, state })
  }
  return out
}

/** How many of the last seven days (today included) had a landing. */
export function landedDaysInWeek(log: LandingLog, today = new Date()): number {
  let n = 0
  for (let i = 0; i < 7; i++) {
    const c = log.days[todayStamp(shift(today, -i))]
    if (c && c.builds + c.recons > 0) n++
  }
  return n
}
