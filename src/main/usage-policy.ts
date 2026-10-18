/**
 * Usage mode in the main process: settings migration, the per-world mode,
 * the chat's model/effort (the player's, else the default), unit-capacity
 * migration and counts, routine wake batching and the durable
 * policy-transition notices. The mode table, the protection levels and the
 * meter live in @shared/usage-mode.
 */
import path from 'node:path'
import type { Project, Settings, Task, Wake } from '@shared/types'
import {
  DEFAULT_USAGE_MODE, DIAL_MODE, MODE_PRESETS, isUsageMode, pctText, planLabel, planStatus,
  type PlanId, type PlanLevel, type PlanStatus, type PolicyNotice, type UsageMode, type WorldUsage
} from '@shared/usage-mode'
import { CLAUDE_UNIT_MODEL, DEFAULT_EFFORT, defaultChatModel, type SignIns } from '@shared/unit-model-policy'
import { normalizeCategoryPools } from '@shared/dispatch'
import { claudeLimits, readClaudeLimits } from './usage'
import { readJson, writeJsonAtomic } from './util'
import { holdsCapacity, normalizeUnitsAtOnce } from '@shared/unit-capacity'
export { holdsCapacity } from '@shared/unit-capacity'

/**
 * Seed independent concurrency from the old mode limit once. For pre-mode settings,
 * the cost dial becomes the mode, and the old shipped chat
 * effort default ('high' with no model picked) becomes unset. Every explicit
 * model/effort the player picked stays as written.
 */
export function migrateUsageSettings(saved: Partial<Settings>): Partial<Settings> {
  saved = migrateModelDefaults(saved)
  if (typeof saved.quotaProtection !== 'boolean') saved = { ...saved, quotaProtection: true }
  const hadMode = isUsageMode(saved.usageMode)
  const mode = hadMode ? saved.usageMode! : saved.costDial ? DIAL_MODE[saved.costDial] ?? DEFAULT_USAGE_MODE : DEFAULT_USAGE_MODE
  // These are migration values only: changing a mode never changes concurrency again.
  const legacyCaps = { save: 4, balanced: 8, max: 16 }
  const unitsAtOnce = normalizeUnitsAtOnce(saved.unitsAtOnce, legacyCaps[mode])
  if (hadMode && saved.unitsAtOnce === unitsAtOnce) return saved
  const next: Partial<Settings> = { ...saved, usageMode: mode, unitsAtOnce }
  if (!hadMode && !saved.wkspModel?.trim() && saved.wkspEffort === 'high') next.wkspEffort = ''
  return next
}

type LegacyRow = { category?: unknown; candidates?: unknown; locked?: boolean }

/**
 * Once: explicit picks stay as they are, the old shipped defaults become unset
 * and so use the default model. Only locked category rows were the player's
 * choice (unlocked rows followed the Usage mode and were never used as
 * written), rules lose their lock (they were always used as written), and the
 * shipped default unit tool 'claude' becomes unset unless a default unit
 * model or effort was set for it.
 */
export function migrateModelDefaults(saved: Partial<Settings>): Partial<Settings> {
  if (saved.plainModelDefaults) return saved
  const fresh = !Object.keys(saved).length
  const rows = Array.isArray(saved.categoryPools) ? (saved.categoryPools as LegacyRow[]).filter((p) => p?.locked === true) : []
  const next: Partial<Settings> & { autoReorder?: unknown } = {
    ...saved,
    plainModelDefaults: true,
    categoryPools: normalizeCategoryPools(rows),
    ...(Array.isArray(saved.dispatchRules) ? { dispatchRules: saved.dispatchRules.map(({ locked: _l, ...r }: Settings['dispatchRules'][number] & { locked?: boolean }) => r) } : {})
  }
  delete next.autoReorder
  if (!fresh && saved.defaultHarness === 'claude' && !saved.defaultWorkerModel?.trim() && !saved.defaultWorkerEffort?.trim()) next.defaultHarness = ''
  return next
}

/** The chat's settings with the default filled in where the player set nothing (main chat, allies without their own pick, Bot, Lore chats). */
export function chatSettings(s: Settings, signIns: SignIns = {}): Settings {
  return {
    ...s,
    wkspModel: s.wkspModel?.trim() || defaultChatModel(signIns),
    wkspEffort: s.wkspEffort?.trim() || DEFAULT_EFFORT,
    botModel: s.botModel?.trim() || CLAUDE_UNIT_MODEL
  }
}

/** A world's own mode, else its legacy dial, else the global mode. */
export function worldUsage(s: Pick<Settings, 'usageMode'>, p?: Pick<Project, 'name' | 'usageMode' | 'costDial' | 'capacity'>): WorldUsage {
  const global = isUsageMode(s.usageMode) ? s.usageMode : DEFAULT_USAGE_MODE
  if (p && isUsageMode(p.usageMode)) return { name: p.name, mode: p.usageMode, source: 'world' }
  if (p?.costDial) return { name: p.name, mode: DIAL_MODE[p.costDial] ?? global, source: 'legacy-dial' }
  return { name: p?.name ?? '', mode: global, source: 'global' }
}

export const globalMode = (s: Pick<Settings, 'usageMode'>): UsageMode => (isUsageMode(s.usageMode) ? s.usageMode : DEFAULT_USAGE_MODE)

export function claudeStatus(dataDir: string, now = Date.now(), protection = true): PlanStatus {
  if (!protection) return planStatus('claude', undefined, now)
  try { return planStatus('claude', claudeLimits(readClaudeLimits(dataDir), now)?.windows, now) }
  catch { return planStatus('claude', undefined, now) } // The meter exposes the read failure; chat must remain usable.
}

/** Units in play (the cap's definition), in one project or across every base. */
export function unitsInPlay(homes: Iterable<{ crew: { list(): Task[] } }>, alive: (t: Task) => boolean, project?: string): Task[] {
  const out: Task[] = []
  for (const h of homes) out.push(...h.crew.list().filter((t) => holdsCapacity(t, alive(t)) && (!project || t.project === project)))
  return out
}

export function liveUnits(homes: Iterable<{ crew: { list(): Task[] } }>, alive: (t: Task) => boolean, project?: string): number {
  return unitsInPlay(homes, alive, project).length
}

/** The quit/close warning for units still in play, naming them so the player sees what runs. */
export function stopUnitsDialog(units: Pick<Task, 'title' | 'state'>[], action: 'close' | 'exit'): { buttons: string[]; message: string; detail: string } {
  const shown = units.slice(0, 8).map((t) => `• ${t.title} (${t.state})`)
  if (units.length > shown.length) shown.push(`• and ${units.length - shown.length} more`)
  return {
    buttons: [`Stop units and ${action}`, 'Cancel'],
    message: `${units.length} unit${units.length === 1 ? ' is' : 's are'} still running.`,
    detail: `${shown.join('\n')}\n\n${action === 'exit' ? 'Exiting Genio' : 'Closing'} stops their terminals; worktrees are kept for respawn.`
  }
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

export function noticeFor(p: PlanStatus, from: PlanLevel, _other: PlanId, lowWaiting: number, now = Date.now()): Pick<PolicyNotice, 'text' | 'details'> {
  const name = planLabel(p.plan)
  let text: string
  if (p.level === 'out') {
    const waits = lowWaiting ? `; ${lowWaiting} low-priority quest${lowWaiting === 1 ? '' : 's'} wait until ${at(p.resetsAt)}` : ''
    text = `${name} reached its limit: new ${name} units wait until ${at(p.resetsAt)}${p.plan === 'claude' ? '; optional chat work waits' : ''}${waits}.`
  } else if (p.level === 'hot') {
    text = `${name} has ${p.percent !== undefined ? `${Math.max(0, Math.round(100 - p.percent))}%` : 'little'} left: new ${name} units wait.`
  } else if (p.level === 'warm') {
    text = `${name} at ${pctText(p)}: one ${name} unit at a time.`
  } else {
    text = p.known ? `${name} is back under 70%: no limit on ${name} units.` : `${name} usage is unknown: the old quota hold expired; ordinary dispatch is allowed with quota unverified.`
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

  /** Record current levels, including expiry of a persisted hold to unknown. */
  observe(plans: PlanStatus[], lowWaiting = 0, now = Date.now()): PolicyNotice[] {
    const state = this.read()
    const out: PolicyNotice[] = []
    for (const p of plans) {
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
