/**
 * Usage mode (Save / Balanced / Max): one control that sets chat and unit
 * model/effort, the shared concurrent-unit cap, exploration, cheap-model use,
 * routine wake batching and answer/report ceilings; plus the automatic plan
 * protection levels and the shared plan meter. Pure, so the Systems preview
 * shows exactly what the dispatcher and the chat apply.
 *
 * Pins: a non-empty raw model/effort (Settings.wkspModel/wkspEffort/botModel/
 * defaultWorkerModel/defaultWorkerEffort, an ally's model/effort, a locked
 * category row, a dispatch rule, an explicit deploy pick) is Pinned and never
 * changed by the mode or by protection. Empty means Auto.
 */
import type { CostDial, PoolCandidate, Priority, TaskCategory } from './types'
import type { UsageReport, UsageWindow } from './api'
import { CHEAP_MODELS, EFFORT_LADDER, LOW_STAKES } from './dispatch'
import { CODEX_UNIT_MODEL } from './unit-model-policy'
import { expireWindow, freshWindow } from './quota-evidence'

export type UsageMode = 'save' | 'balanced' | 'max'
export const USAGE_MODES: UsageMode[] = ['save', 'balanced', 'max']
export const DEFAULT_USAGE_MODE: UsageMode = 'balanced'
export const USAGE_MODE_LABEL: Record<UsageMode, string> = { save: 'Save', balanced: 'Balanced', max: 'Max' }
export const isUsageMode = (v: unknown): v is UsageMode => v === 'save' || v === 'balanced' || v === 'max'

/** The retired cost dial maps one to one onto a mode. */
export const DIAL_MODE: Record<CostDial, UsageMode> = { cost: 'save', balanced: 'balanced', quality: 'max' }

export const SONNET = 'claude-sonnet-5-5'
export const OPUS = 'claude-opus-5-5'

/** S = Claude Sonnet, O = Claude Opus, C = Codex Sol (explicit, conservative default). */
export type Slot = 'S' | 'O' | 'C'
export const SLOT: Record<Slot, { harness: 'claude' | 'codex'; model?: string; label: string }> = {
  S: { harness: 'claude', model: SONNET, label: 'Sonnet' },
  O: { harness: 'claude', model: OPUS, label: 'Opus' },
  C: { harness: 'codex', model: CODEX_UNIT_MODEL, label: 'Codex Sol' }
}
/** Same-effort fallback: Codex and Sonnet back each other up; Opus falls back to Codex. */
export const FALLBACK: Record<Slot, Slot> = { S: 'C', C: 'S', O: 'C' }

export type UnitGroup = 'light' | 'build' | 'deep' | 'review' | 'art'
export const UNIT_GROUPS: { id: UnitGroup; label: string; categories: TaskCategory[] }[] = [
  { id: 'light', label: 'Chore, docs, tests, build/CI', categories: ['chore', 'docs', 'tests', 'build-ci'] },
  { id: 'build', label: 'Feature, bugfix, UI', categories: ['feature', 'bugfix', 'ui'] },
  { id: 'deep', label: 'Recon/design, refactor, graphics', categories: ['recon-design', 'refactor', 'graphics'] },
  { id: 'review', label: 'Review, large-context', categories: ['review', 'large-context'] },
  { id: 'art', label: 'Art (agent work, not generation fees)', categories: ['art'] }
]
export const groupOf = (c: TaskCategory): UnitGroup => UNIT_GROUPS.find((g) => g.categories.includes(c))?.id ?? 'build'

export type Cell = readonly [Slot, string]

export interface ModePreset {
  /** main chat and allies without their own pick */
  chat: Cell
  units: Record<UnitGroup, Cell>
  /** what a locked (pinned) category row and the legacy dial see */
  dial: CostDial
  /** concurrent units across every world and base */
  unitCap: number
  /** share of automatic picks that try the fallback, subject to fresh evidence below 70% on both plans */
  exploration: number
  /** cheap third-party candidates for low-stakes categories */
  cheap: 'first' | 'fallback' | 'off'
  /** routine (non-urgent) AI wakes wait this long to batch */
  wakeBatchMinutes: number
  heartbeat: { baseMinutes: number; maxMinutes: number }
  answerWords: number
  reconWords: number
}

export const MODE_PRESETS: Record<UsageMode, ModePreset> = {
  save: {
    chat: ['S', 'low'],
    units: { light: ['C', 'low'], build: ['S', 'medium'], deep: ['C', 'medium'], review: ['C', 'medium'], art: ['C', 'low'] },
    dial: 'cost', unitCap: 4, exploration: 0, cheap: 'first',
    wakeBatchMinutes: 10, heartbeat: { baseMinutes: 30, maxMinutes: 120 }, answerWords: 150, reconWords: 400
  },
  balanced: {
    chat: ['S', 'medium'],
    units: { light: ['C', 'medium'], build: ['C', 'medium'], deep: ['C', 'high'], review: ['C', 'high'], art: ['C', 'medium'] },
    dial: 'balanced', unitCap: 8, exploration: 0, cheap: 'fallback',
    wakeBatchMinutes: 5, heartbeat: { baseMinutes: 15, maxMinutes: 120 }, answerWords: 250, reconWords: 800
  },
  max: {
    chat: ['O', 'high'],
    units: { light: ['C', 'high'], build: ['O', 'high'], deep: ['O', 'xhigh'], review: ['C', 'xhigh'], art: ['C', 'high'] },
    dial: 'quality', unitCap: 16, exploration: 0.05, cheap: 'off',
    wakeBatchMinutes: 1, heartbeat: { baseMinutes: 10, maxMinutes: 120 }, answerWords: 400, reconWords: 1500
  }
}

export const cellLabel = ([slot, effort]: Cell): string => `${SLOT[slot].label} / ${effort}`

/** One supported step lower, never below low. */
export function stepDown(effort: string): string {
  const i = EFFORT_LADDER.indexOf(effort)
  return i > 0 ? EFFORT_LADDER[i - 1] : effort
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

export interface ChatPins {
  model?: string
  effort?: string
}

export interface ChatChoice {
  model: string
  effort: string
  pinnedModel: boolean
  pinnedEffort: boolean
  /** set when protection moved an Auto value off the mode's preset */
  protectedBy?: string
}

/**
 * The chat's model/effort. Pinned values are kept as they are. Auto values
 * follow the mode; Claude at 70-84% lowers Auto effort one step, at 85%+ the
 * Auto chat drops to Sonnet / low (applied at the next turn boundary).
 */
export function resolveChat(mode: UsageMode, pins: ChatPins, claude?: PlanStatus): ChatChoice {
  const [slot, presetEffort] = MODE_PRESETS[mode].chat
  const pinnedModel = Boolean(pins.model?.trim())
  const pinnedEffort = Boolean(pins.effort?.trim())
  let model = pinnedModel ? pins.model!.trim() : SLOT[slot].model!
  let effort = pinnedEffort ? pins.effort!.trim() : presetEffort
  let protectedBy: string | undefined
  const level = claude?.level ?? 'ok'
  if (level === 'hot' || level === 'out') {
    if (!pinnedModel && model !== SONNET) { model = SONNET; protectedBy = protectionCause(claude!) }
    if (!pinnedEffort && effort !== 'low') { effort = 'low'; protectedBy = protectionCause(claude!) }
  } else if (level === 'warm' && !pinnedEffort) {
    const lower = stepDown(effort)
    if (lower !== effort) { effort = lower; protectedBy = protectionCause(claude!) }
  }
  return { model, effort, pinnedModel, pinnedEffort, protectedBy }
}

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

// ------------------------------------------------------------- units

export interface ModeCandidates {
  candidates: PoolCandidate[]
  notes: string[]
}

/**
 * The automatic candidates for a category under a mode: the preset cell, its
 * same-effort fallback, and cheap third-party models for low-stakes work
 * (Save first, Balanced after the plans, Max never). A plan at 70-84% moves
 * behind the other plan; plans at 85%+ are excluded later by the picker.
 */
export function modeCandidates(mode: UsageMode, category: TaskCategory, plans?: Partial<Record<PlanId, PlanStatus>>): ModeCandidates {
  const p = MODE_PRESETS[mode]
  const [slot, effort] = p.units[groupOf(category)]
  const toCand = (s: Slot): PoolCandidate => ({ harness: SLOT[s].harness, ...(SLOT[s].model ? { model: SLOT[s].model } : {}), effort })
  const notes: string[] = []
  let planned = [toCand(slot), toCand(FALLBACK[slot])]
  const warm = (c: PoolCandidate): boolean => plans?.[c.harness as PlanId]?.level === 'warm'
  if (warm(planned[0]) && !warm(planned[1])) {
    notes.push(`${planLabel(planned[0].harness)} at ${pctText(plans![planned[0].harness as PlanId]!)}: preferring ${planLabel(planned[1].harness)}`)
    planned = [planned[1], planned[0]]
  }
  const cheap = LOW_STAKES.includes(category) && p.cheap !== 'off' ? CHEAP_MODELS.map((m): PoolCandidate => ({ harness: 'opencode', model: m.model, cheap: true })) : []
  return { candidates: p.cheap === 'first' ? [...cheap, ...planned] : [...planned, ...cheap], notes }
}

/** Global cap from the global mode; a world's own mode or capacity can only lower it. */
export function unitCaps(globalMode: UsageMode, world?: { mode?: UsageMode; capacity?: number }): { global: number; world?: number } {
  const global = MODE_PRESETS[globalMode].unitCap
  const limits = [world?.mode ? MODE_PRESETS[world.mode].unitCap : undefined, world?.capacity && world.capacity > 0 ? world.capacity : undefined]
    .filter((n): n is number => typeof n === 'number')
  const own = limits.length ? Math.min(...limits) : undefined
  return { global, world: own !== undefined && own < global ? own : undefined }
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
  /** the stable one-line shape for compact meters and hover popups */
  summary: PlanUsageSummary
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

/** Systems → Usage, the plan meter and the quest list. Built from cached local evidence only. */
export interface UsagePolicyView {
  generatedAt: string
  mode: UsageMode
  chat: ChatChoice
  bot: { model: string; pinned: boolean }
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

/** "Auto: Sonnet / medium · up to 8 units" */
export function modeSummary(mode: UsageMode, chat?: ChatChoice): string {
  const p = MODE_PRESETS[mode]
  const chatText = chat ? `${chat.model.replace(/^claude-/, '').replace(/-\d.*$/, '').replace(/^./, (c) => c.toUpperCase())} / ${chat.effort}` : cellLabel(p.chat)
  return `${chat && (chat.pinnedModel || chat.pinnedEffort) ? 'Chat' : 'Auto'}: ${chatText} · up to ${p.unitCap} unit${p.unitCap === 1 ? '' : 's'}`
}

/** What a mode sets, as label/value rows for the preview table. */
export function presetRows(mode: UsageMode): { label: string; value: string }[] {
  const p = MODE_PRESETS[mode]
  return [
    { label: 'Chat, including allies', value: cellLabel(p.chat) },
    ...UNIT_GROUPS.map((g) => ({ label: `Units: ${g.label}`, value: cellLabel(p.units[g.id]) })),
    { label: 'Concurrent units (all projects)', value: String(p.unitCap) },
    { label: 'Exploration', value: p.exploration ? `${Math.round(p.exploration * 100)}%, only with fresh evidence below 70% on both plans` : 'off' },
    { label: 'Cheap third-party models', value: p.cheap === 'first' ? 'first for low-stakes work' : p.cheap === 'fallback' ? 'fallback after the plans' : 'off' },
    { label: 'Routine wake batching', value: `${p.wakeBatchMinutes} min; heartbeat ${p.heartbeat.baseMinutes}/${p.heartbeat.maxMinutes} min` },
    { label: 'Answer / Recon summary target', value: `${p.answerWords} / ${p.reconWords.toLocaleString('en-US')} words` }
  ]
}
