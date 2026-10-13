/**
 * Usage mode in the main process: settings migration, the per-world mode,
 * the chat's effective model/effort, the global unit count, routine wake
 * batching and the durable policy-transition notices. The mode table, the
 * protection levels and the meter live in @shared/usage-mode.
 */
import path from 'node:path'
import type { Project, Settings, Task, Wake } from '@shared/types'
import {
  DEFAULT_USAGE_MODE, DIAL_MODE, MODE_PRESETS, SONNET, isUsageMode, pctText, planLabel, planStatus, resolveChat,
  type PlanId, type PlanLevel, type PlanStatus, type PolicyNotice, type UsageMode, type WorldUsage
} from '@shared/usage-mode'
import { claudeLimits, claudeLimitsFile, type ClaudeLimitsFile } from './usage'
import { readJson, writeJsonAtomic } from './util'
import { holdsCapacity } from '@shared/unit-capacity'
export { holdsCapacity } from '@shared/unit-capacity'

/**
 * Pre-mode settings: the cost dial becomes the mode, and the old shipped chat
 * effort default ('high' with no model picked) becomes Auto. Every explicit
 * model/effort the player picked stays as written and shows as Pinned.
 */
export function migrateUsageSettings(saved: Partial<Settings>): Partial<Settings> {
  if (isUsageMode(saved.usageMode)) return saved
  const next: Partial<Settings> = { ...saved, usageMode: saved.costDial ? DIAL_MODE[saved.costDial] ?? DEFAULT_USAGE_MODE : DEFAULT_USAGE_MODE }
  if (!saved.wkspModel?.trim() && saved.wkspEffort === 'high') next.wkspEffort = ''
  return next
}

/** A world's own mode, else its legacy dial, else the global mode. */
export function worldUsage(s: Pick<Settings, 'usageMode'>, p?: Pick<Project, 'name' | 'usageMode' | 'costDial' | 'capacity'>): WorldUsage {
  const global = isUsageMode(s.usageMode) ? s.usageMode : DEFAULT_USAGE_MODE
  if (p && isUsageMode(p.usageMode)) return { name: p.name, mode: p.usageMode, source: 'world' }
  if (p?.costDial) return { name: p.name, mode: DIAL_MODE[p.costDial] ?? global, source: 'legacy-dial' }
  return { name: p?.name ?? '', mode: global, source: 'global' }
}

export const globalMode = (s: Pick<Settings, 'usageMode'>): UsageMode => (isUsageMode(s.usageMode) ? s.usageMode : DEFAULT_USAGE_MODE)

export function claudeStatus(dataDir: string, now = Date.now()): PlanStatus {
  return planStatus('claude', claudeLimits(readJson<ClaudeLimitsFile | undefined>(claudeLimitsFile(dataDir), undefined), now)?.windows)
}

/** The settings the chat sessions read, with Auto values resolved by the mode and Claude protection. */
export function chatSettings(s: Settings, dataDir: string): Settings {
  const claude = claudeStatus(dataDir)
  const chat = resolveChat(globalMode(s), { model: s.wkspModel, effort: s.wkspEffort }, claude)
  // The Bot runs Sonnet / low unless pinned.
  return { ...s, wkspModel: chat.model, wkspEffort: chat.effort, botModel: s.botModel?.trim() || SONNET }
}

export function liveUnits(homes: Iterable<{ crew: { list(): Task[] } }>, alive: (t: Task) => boolean, project?: string): number {
  let n = 0
  for (const h of homes) n += h.crew.list().filter((t) => holdsCapacity(t, alive(t)) && (!project || t.project === project)).length
  return n
}

export function heartbeatFor(s: Pick<Settings, 'usageMode'>): { baseMs: number; maxMs: number } {
  const h = MODE_PRESETS[globalMode(s)].heartbeat
  return { baseMs: h.baseMinutes * 60_000, maxMs: h.maxMinutes * 60_000 }
}

export const wakeBatchMs = (s: Pick<Settings, 'usageMode'>): number => MODE_PRESETS[globalMode(s)].wakeBatchMinutes * 60_000

/** Milliseconds a routine-only batch still waits; 0 = deliver now. Anything urgent goes immediately. */
export function routineDelay(pending: Pick<Wake, 'routine' | 'ts'>[], batchMs: number, now = Date.now()): number {
  if (!pending.length || pending.some((w) => !w.routine)) return 0
  const oldest = Math.min(...pending.map((w) => Date.parse(w.ts)).filter(Number.isFinite))
  return Number.isFinite(oldest) ? Math.max(0, oldest + batchMs - now) : 0
}

// ------------------------------------------------------------- notices

function ageText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'age unknown'
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'under a minute old' : m < 120 ? `${m} min old` : `${Math.round(m / 60)} h old`
}

const at = (iso?: string): string =>
  iso && Date.parse(iso) > Date.now() ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'fresh evidence'

export function noticeFor(p: PlanStatus, from: PlanLevel, other: PlanId, lowWaiting: number, now = Date.now()): Pick<PolicyNotice, 'text' | 'details'> {
  const name = planLabel(p.plan)
  const alt = planLabel(other)
  let text: string
  if (p.level === 'out') {
    const waits = lowWaiting ? `; ${lowWaiting} low-priority quest${lowWaiting === 1 ? '' : 's'} wait until ${at(p.resetsAt)}` : ''
    text = p.plan === 'claude'
      ? `${name} reached its limit: no new automatic ${name} work until ${at(p.resetsAt)}; chat is saved${waits}.`
      : `${name} reached its limit: automatic units use ${alt}${waits}.`
  } else if (p.level === 'hot') {
    text = `${name} has ${p.percent !== undefined ? `${Math.max(0, Math.round(100 - p.percent))}%` : 'little'} left: automatic units use ${alt}${p.plan === 'claude' ? '; Auto chat drops to Sonnet / low next turn' : ''}.`
  } else if (p.level === 'warm') {
    text = `${name} at ${pctText(p)}: exploration off, one ${name} unit at a time, Auto effort one step lower.`
  } else {
    text = `${name} is back under 70%: the Usage mode applies again.`
  }
  const cause = p.level === 'ok' ? `was ${from}` : `${p.window ?? 'plan'} window ${pctText(p)}${p.rejected ? ' (rejected)' : ''}`
  const age = p.observedAt ? ageText(now - Date.parse(p.observedAt)) : 'age unknown'
  return { text, details: `cause: ${name} ${cause} · evidence ${age}${p.resetsAt ? ` · resets ${p.resetsAt}` : ''}` }
}

interface NoticeState {
  levels: Partial<Record<PlanId, PlanLevel>>
  notices: PolicyNotice[]
}

/** One notice per policy transition, persisted so a restart never repeats one. */
export class PolicyNotices {
  private readonly file: string
  constructor(dataDir: string) { this.file = path.join(dataDir, 'usage', 'policy-state.json') }

  private read(): NoticeState {
    const s = readJson<NoticeState>(this.file, { levels: {}, notices: [] })
    return { levels: s.levels ?? {}, notices: Array.isArray(s.notices) ? s.notices : [] }
  }

  list(): PolicyNotice[] { return this.read().notices.slice().reverse() }

  /** Record current levels; returns only the notices for levels that changed. Unknown headroom is not a transition. */
  observe(plans: PlanStatus[], lowWaiting = 0, now = Date.now()): PolicyNotice[] {
    const state = this.read()
    const out: PolicyNotice[] = []
    for (const p of plans) {
      if (!p.known && p.level === 'ok') continue
      const from = state.levels[p.plan] ?? 'ok'
      if (from === p.level) continue
      state.levels[p.plan] = p.level
      const other: PlanId = p.plan === 'claude' ? 'codex' : 'claude'
      out.push({ ts: new Date(now).toISOString(), plan: p.plan, from, to: p.level, ...noticeFor(p, from, other, lowWaiting, now) })
    }
    if (!out.length) return out
    state.notices = [...state.notices, ...out].slice(-30)
    writeJsonAtomic(this.file, state)
    return out
  }
}
