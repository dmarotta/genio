/**
 * Usage mode (Save / Balanced / Max): routine wake batching and answer/report
 * ceilings, never a model or effort; plus the plan protection levels and the
 * shared plan meter. Models are what the player set, else the one default
 * (unit-model-policy.ts). Pure, so Settings shows exactly what the dispatcher
 * and the chat apply.
 */
import type { CostDial, Priority } from './types'
import type { UsageReport, UsageWindow } from './api'
import { expireWindow, freshWindow } from './quota-evidence'

export type UsageMode = 'save' | 'balanced' | 'max'
export const USAGE_MODES: UsageMode[] = ['save', 'balanced', 'max']
export const DEFAULT_USAGE_MODE: UsageMode = 'balanced'
export const USAGE_MODE_LABEL: Record<UsageMode, string> = { save: 'Save', balanced: 'Balanced', max: 'Max' }
export const isUsageMode = (v: unknown): v is UsageMode => v === 'save' || v === 'balanced' || v === 'max'

/** The retired cost dial maps one to one onto a mode. */
export const DIAL_MODE: Record<CostDial, UsageMode> = { cost: 'save', balanced: 'balanced', quality: 'max' }

export interface ModePreset {
  /** routine (non-urgent) AI wakes wait this long to batch */
  wakeBatchMinutes: number
  heartbeat: { baseMinutes: number; maxMinutes: number }
  answerWords: number
  reconWords: number
}

export const MODE_PRESETS: Record<UsageMode, ModePreset> = {
  save: { wakeBatchMinutes: 10, heartbeat: { baseMinutes: 30, maxMinutes: 120 }, answerWords: 150, reconWords: 400 },
  balanced: { wakeBatchMinutes: 5, heartbeat: { baseMinutes: 15, maxMinutes: 120 }, answerWords: 250, reconWords: 800 },
  max: { wakeBatchMinutes: 1, heartbeat: { baseMinutes: 10, maxMinutes: 120 }, answerWords: 400, reconWords: 1500 }
}

// ------------------------------------------------------------- protection

export type PlanId = 'claude' | 'codex'
export const PLANS: { id: PlanId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' }
]
export const planLabel = (id: string): string => PLANS.find((p) => p.id === id)?.label ?? id
export const isPlan = (id: string): id is PlanId => id === 'claude' || id === 'codex'

/** below 70: the mode; 70-84 warm; 85-94 hot; 95+ or rejected: out */
export type PlanLevel = 'ok' | 'warm' | 'hot' | 'out'
export const PROTECT = { warm: 70, hot: 85, out: 95 } as const
export const LEVEL_RANK: Record<PlanLevel, number> = { ok: 0, warm: 1, hot: 2, out: 3 }

export interface PlanStatus {
  plan: PlanId
  level: PlanLevel
  /** false: no current percentage (never reported, or the observation expired) */
  known: boolean
  percent?: number
  window?: string
  rejected?: boolean
  resetsAt?: string
  observedAt?: string
}

/**
 * The worst current window. Old readings are unknown and cannot hold dispatch.
 */
export function planStatus(plan: PlanId, windows: UsageWindow[] | undefined, now = Date.now()): PlanStatus {
  let worst: { pct: number; w: UsageWindow } | undefined
  for (const w of windows ?? []) {
    if (!freshWindow(w, now)) continue
    const pct = w.status === 'rejected' ? 100 : w.usedPercent
    if (pct === undefined) continue
    if (!worst || pct > worst.pct) worst = { pct, w }
  }
  if (!worst) return { plan, level: 'ok', known: false }
  const { pct, w } = worst
  const rejected = w.status === 'rejected'
  const level: PlanLevel = rejected || pct >= PROTECT.out ? 'out' : pct >= PROTECT.hot ? 'hot' : pct >= PROTECT.warm ? 'warm' : 'ok'
  const current = rejected || (w.usedPercent !== undefined && !w.stale)
  if (level === 'ok' && !current) return { plan, level, known: false }
  return { plan, level, known: current, percent: rejected ? undefined : pct, window: w.label, rejected: rejected || undefined, resetsAt: w.resetsAt, observedAt: w.observedAt }
}

export function planStatuses(quota: Record<string, UsageWindow[] | undefined> | undefined): Record<PlanId, PlanStatus> {
  return { claude: planStatus('claude', quota?.claude), codex: planStatus('codex', quota?.codex) }
}

// ------------------------------------------------------------- chat

/** Words the chat aims for: Save's ceiling while Claude is at 70%+. */
export function answerWords(mode: UsageMode, claude?: PlanStatus): number {
  return LEVEL_RANK[claude?.level ?? 'ok'] >= LEVEL_RANK.warm ? MODE_PRESETS.save.answerWords : MODE_PRESETS[mode].answerWords
}

/** Recon summary target: Save's ceiling when the unit's plan is at 70%+. */
export function reconWords(mode: UsageMode, plan?: PlanStatus): number {
  return LEVEL_RANK[plan?.level ?? 'ok'] >= LEVEL_RANK.warm ? MODE_PRESETS.save.reconWords : MODE_PRESETS[mode].reconWords
}

export function chatUsageLine(mode: UsageMode, claude?: PlanStatus): string {
  return `Usage mode: ${USAGE_MODE_LABEL[mode]}. Keep ordinary replies under about ${answerWords(mode, claude)} words; give more when the player asks for detail.`
}

// ------------------------------------------------------------- queue

export interface QuotaWait {
  plan?: PlanId
  until?: string
  reason: string
}

/**
 * Whether a queued quest waits for a plan reset instead of being offered for
 * automatic dispatch. Nothing is dropped: the quest stays queued and a player
 * dispatch still goes through the picker's own protection.
 */
export function quotaWait(priority: Priority, plans: PlanStatus[]): QuotaWait | undefined {
  if (!plans.length) return undefined
  const usable = plans.filter((p) => LEVEL_RANK[p.level] < LEVEL_RANK.hot)
  const out = plans.filter((p) => p.level === 'out').sort((a, b) => (a.resetsAt ?? '~').localeCompare(b.resetsAt ?? '~'))
  if (!usable.length) {
    const first = [...plans].sort((a, b) => (a.resetsAt ?? '~').localeCompare(b.resetsAt ?? '~'))[0]
    return { plan: first.plan, until: futureReset(first), reason: `no plan has headroom (${plans.map((p) => `${planLabel(p.plan)} ${pctText(p)}`).join(', ')})` }
  }
  if (priority === 'low' && out.length) {
    return { plan: out[0].plan, until: futureReset(out[0]), reason: `low priority waits for the ${planLabel(out[0].plan)} reset` }
  }
  return undefined
}

const futureReset = (p: PlanStatus): string | undefined => (p.resetsAt && Date.parse(p.resetsAt) > Date.now() ? p.resetsAt : undefined)

export function pctText(p: PlanStatus): string {
  if (p.rejected) return 'its limit'
  return p.percent !== undefined ? `${Math.round(p.percent)}%` : 'unknown'
}

export function protectionCause(p: PlanStatus): string {
  return `${planLabel(p.plan)} ${p.window ?? 'plan'} at ${pctText(p)}`
}

// ------------------------------------------------------------- meter

export interface MeterWindow {
  label: string
  state: 'known' | 'unknown' | 'limit'
  /** only when the current percentage is known; never assumed */
  leftPercent?: number
  usedPercent?: number
  resetsAt?: string
  observedAt?: string
}

export interface MeterRow {
  plan: PlanId
  label: string
  source?: string
  planName?: string
  level: PlanLevel
  headline?: MeterWindow
  windows: MeterWindow[]
  /** standard windows the tool has not reported (never invented) */
  missing: string[]
  note?: string
  error?: string
  /** the stable one-line shape for compact meters and hover popups; meterRows always sets it */
  summary?: PlanUsageSummary
}

/**
 * One plan at a glance, in a shape any meter UI can rely on. `usedPercent` is
 * set only for a fresh report; `error` explains a failed read (shown with the
 * last report when one is still fresh); `note` explains any other unknown.
 */
export interface PlanUsageSummary {
  provider: PlanId
  label: string
  state: 'known' | 'limit' | 'unknown' | 'error'
  usedPercent?: number
  leftPercent?: number
  /** e.g. "5-hour", "weekly" */
  windowLabel?: string
  resetsAt?: string
  /** when the provider reported the headline window */
  fetchedAt?: string
  source?: string
  error?: string
  note?: string
}

export function usageSummary(r: Omit<MeterRow, 'summary'>): PlanUsageSummary {
  const h = r.headline
  const known = h && h.state !== 'unknown'
  const note = known ? undefined : h ? `last ${h.label} report ${h.observedAt ? 'expired' : 'has no report time'}; current usage unknown` : r.note ?? 'no plan report yet'
  return {
    provider: r.plan, label: r.label, state: known ? h.state : r.error ? 'error' : 'unknown',
    usedPercent: known ? (h.state === 'limit' ? 100 : h.usedPercent) : undefined, leftPercent: known ? h.leftPercent : undefined,
    windowLabel: h?.label, resetsAt: h?.resetsAt, fetchedAt: h?.observedAt, source: r.source, error: r.error, note
  }
}

export function meterWindow(raw: UsageWindow): MeterWindow {
  const w = expireWindow(raw)
  const base = { label: w.label, resetsAt: w.resetsAt, observedAt: w.observedAt }
  if (w.status === 'rejected') return { ...base, state: 'limit', leftPercent: 0 }
  if (!w.stale && typeof w.usedPercent === 'number') return { ...base, state: 'known', usedPercent: w.usedPercent, leftPercent: Math.max(0, Math.round(100 - w.usedPercent)) }
  return { ...base, state: 'unknown' }
}

/** One row per plan (never summed): every reported window, worst first as the headline. */
export function meterRows(report: Pick<UsageReport, 'tools'> | undefined): MeterRow[] {
  return PLANS.map(({ id, label }) => {
    const tool = report?.tools.find((t) => t.tool === id)
    const raw = (tool?.limits ?? []).flatMap((l) => l.windows.map((w) => ({ ...w, label: l.name ? `${l.name}: ${w.label}` : w.label })))
    const windows = raw.map(meterWindow)
    const known = windows.filter((w) => w.state !== 'unknown').sort((a, b) => (a.leftPercent ?? 0) - (b.leftPercent ?? 0))
    const top = new Set(raw.map((w) => w.label))
    const row: Omit<MeterRow, 'summary'> = {
      plan: id,
      label,
      source: tool?.limits[0]?.source,
      planName: tool?.limits.find((l) => l.plan)?.plan,
      level: planStatus(id, raw).level,
      headline: known[0] ?? windows[0],
      windows,
      missing: ['5-hour', 'weekly'].filter((l) => !top.has(l)),
      note: tool?.note,
      error: tool?.error
    }
    return { ...row, summary: usageSummary(row) }
  })
}

export function leftText(w: MeterWindow | undefined): string {
  if (!w) return 'unknown'
  if (w.state === 'limit') return 'limit reached'
  if (w.state === 'unknown') return 'unknown'
  return `${w.leftPercent}% left`
}

// ------------------------------------------------------------- view

export interface PolicyNotice {
  ts: string
  plan: PlanId
  from: PlanLevel
  to: PlanLevel
  /** the one-line notice */
  text: string
  /** cause and evidence age */
  details: string
}

export interface WorldUsage {
  name: string
  mode: UsageMode
  source: 'global' | 'world' | 'legacy-dial'
  /** this world's own concurrent-unit limit, when below the global cap */
  cap?: number
}

/** Settings → Usage & limits, the plan meter and the quest list. Built from cached local evidence only. */
export interface UsagePolicyView {
  generatedAt: string
  mode: UsageMode
  quotaProtection: boolean
  heldLaunches: { project: string; title: string; plan: PlanId }[]
  /** what the chat runs now: the player's choice, else the default */
  chat: { model: string; effort: string }
  /** the player's unit default ('' harness: Claude, else Codex when only Codex is signed in) */
  units: { defaultHarness: string; model?: string; effort?: string }
  unitCap: number
  liveUnits: number
  worlds: WorldUsage[]
  plans: PlanStatus[]
  meter: MeterRow[]
  notices: PolicyNotice[]
  /** queued quests held until a plan resets */
  waiting: { id: string; title: string; wait: QuotaWait }[]
  cheap: { allowed: boolean; why: string }
}

/** What a mode sets, in one line: "Replies under about 250 words; routine updates batched up to 5 min." */
export function modeSummary(mode: UsageMode): string {
  const p = MODE_PRESETS[mode]
  return `Replies under about ${p.answerWords} words; routine updates batched up to ${p.wakeBatchMinutes} min.`
}
