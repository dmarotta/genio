/**
 * A plan's time and cost estimate from the squad's own history: each step's
 * unit run time from finished units of the same kind (and category, when there
 * are enough of them, preferring the plan's project), the elapsed time along
 * the plan's longest chain within max parallel, and the main chat's measured
 * cost per unit. Thin history falls back to Genio's measured defaults.
 */
import type { PlanEstimate, Task, TaskCategory, TaskKind } from './types'

export interface EstimateStep {
  key: string
  kind?: TaskKind
  category?: TaskCategory
  after?: string[]
}

/** Unit run minutes [typical, slow] without history (builds in this repo: median 19.8, p90 47.5). */
export const DEFAULT_STEP_MINUTES: Record<TaskKind, [number, number]> = { ship: [20, 45], scout: [15, 35] }
/** Main chat USD per unit, measured on hand-run chains (0.49-0.68). */
export const DEFAULT_CHAT_USD_PER_UNIT: [number, number] = [0.5, 0.7]
const MIN_SAMPLES = 3

/** Minutes from launch to first finish; discarded, unfinished and implausible runs give nothing. */
export function unitRunMinutes(t: Task): number | undefined {
  const end = t.finishedAt ?? t.readyAt
  if (!end || t.discarded) return undefined
  const m = (Date.parse(end) - Date.parse(t.createdAt)) / 60_000
  return Number.isFinite(m) && m >= 2 && m <= 8 * 60 ? m : undefined
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

/** [median, p75] run minutes for a step, and how many finished units that came from. */
export function stepMinutes(step: EstimateStep, history: Task[], world?: string): { minutes: [number, number]; samples: number } {
  const kind = step.kind ?? 'ship'
  const pools: ((t: Task) => boolean)[] = [
    ...(step.category ? [(t: Task) => t.kind === kind && t.category === step.category] : []),
    (t: Task) => t.kind === kind
  ]
  for (const fits of pools) {
    for (const scope of world ? [(t: Task) => t.project === world, () => true] : [() => true]) {
      const runs = history.filter((t) => fits(t) && scope(t)).map(unitRunMinutes).filter((m): m is number => m !== undefined).sort((a, b) => a - b)
      if (runs.length >= MIN_SAMPLES) return { minutes: [quantile(runs, 0.5), Math.max(quantile(runs, 0.75), quantile(runs, 0.5))], samples: runs.length }
    }
  }
  return { minutes: DEFAULT_STEP_MINUTES[kind], samples: 0 }
}

/**
 * The plan's estimate. chatUsdPerUnit is the main chat's measured average
 * (its spend over the units it ran); undefined uses the default range.
 */
export function estimatePlan(steps: EstimateStep[], history: Task[], opts: { world?: string; maxParallel?: number; chatUsdPerUnit?: number } = {}): PlanEstimate {
  const per = new Map(steps.map((s) => [s.key, stepMinutes(s, history, opts.world)]))
  const keys = new Set(steps.map((s) => s.key))
  const finish = (bound: 0 | 1): number => {
    const memo = new Map<string, number>()
    const end = (k: string, seen: Set<string>): number => {
      if (memo.has(k)) return memo.get(k)!
      if (seen.has(k)) return 0
      seen.add(k)
      const s = steps.find((x) => x.key === k)!
      const start = Math.max(0, ...(s.after ?? []).filter((a) => keys.has(a)).map((a) => end(a, seen)))
      const t = start + per.get(k)!.minutes[bound]
      memo.set(k, t)
      return t
    }
    return Math.max(0, ...steps.map((s) => end(s.key, new Set())))
  }
  const sum = (bound: 0 | 1): number => steps.reduce((n, s) => n + per.get(s.key)!.minutes[bound], 0)
  const parallel = Math.max(1, opts.maxParallel ?? 2)
  const elapsed = (bound: 0 | 1): number => Math.max(finish(bound), sum(bound) / parallel)
  const usd = opts.chatUsdPerUnit
  const chat: [number, number] = usd !== undefined && usd > 0 ? [usd * 0.85, usd * 1.15] : DEFAULT_CHAT_USD_PER_UNIT
  const cents = (n: number): number => Math.round(n * 100) / 100
  return {
    units: steps.length,
    unitMinutes: [Math.round(sum(0)), Math.round(sum(1))],
    elapsedMinutes: [Math.round(elapsed(0)), Math.round(elapsed(1))],
    mainChatUsd: [cents(chat[0] * steps.length), cents(chat[1] * steps.length)],
    samples: Math.max(0, ...[...per.values()].map((p) => p.samples))
  }
}

function minutesRange([lo, hi]: [number, number]): string {
  if (hi < 90) {
    const r = (n: number): number => Math.max(5, Math.round(n / 5) * 5)
    return r(lo) === r(hi) ? `${r(lo)} min` : `${r(lo)}-${r(hi)} min`
  }
  const h = (n: number): string => String(Math.max(0.5, Math.round(n / 30) / 2))
  return h(lo) === h(hi) ? `${h(lo)} h` : `${h(lo)}-${h(hi)} h`
}

/** "About 1-2.5 h, 3 units (~1.5 unit-hours), main chat ~$1.50-2.10" */
export function formatEstimate(e: PlanEstimate): string {
  const unitHours = Math.max(0.5, Math.round(((e.unitMinutes[0] + e.unitMinutes[1]) / 2) / 30) / 2)
  const usd = (n: number): string => n.toFixed(2)
  return `About ${minutesRange(e.elapsedMinutes)}, ${e.units} unit${e.units === 1 ? '' : 's'} (~${unitHours} unit-hour${unitHours === 1 ? '' : 's'}), main chat ~$${usd(e.mainChatUsd[0])}-${usd(e.mainChatUsd[1])}`
}
