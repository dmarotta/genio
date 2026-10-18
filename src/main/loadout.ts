/**
 * Loadout picker: decides which unit tool (harness), model and effort a unit
 * deploys with. Deterministic and explainable, so the Deploy dialog can
 * preview it and every deploy path (dialog, Genio, quest auto-dispatch) lands
 * on the same answer.
 *
 * Whatever the player set is used as written: the explicit per-task pick
 * (player or Genio), a follow-up's sticky loadout, the best-fit dispatch rule,
 * the player's row for the category, the player's default unit tool, model and
 * effort. Where nothing is set, the default: Claude Sonnet 5.5, or Codex Sol
 * 6.1 when Claude is not signed in and Codex is; effort medium (high for a
 * Recon). Within a player's own list, candidates whose tool is not installed,
 * enabled or logged in are skipped and cheap third-party models need the world
 * not opted out and a paid-spend allowance. Quota protection never changes the
 * pick: a plan it holds makes the launch wait.
 */
import type { CategoryPool, DispatchRule, HarnessAdapter, Loadout, LoadoutInput, PoolCandidate, Settings, TaskCategory, TaskKind } from '@shared/types'
import { categoryLabel, isCategory } from '@shared/dispatch'
import { isPlan, planStatuses, protectionCause } from '@shared/usage-mode'
import type { SettingsService } from './services'
import { blockedWindow, type QuotaWindow } from './quota-policy'
import { QuotaDeferredError } from './quota-deferred'
import { approvalModel, defaultProvider, defaultUnitEffort, unitModel } from '@shared/unit-model-policy'
import { settingsPath } from '@shared/settings-pages'
export type { QuotaWindow } from './quota-policy'

type RuleCandidate = DispatchRule['candidates'][number]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Comma or pipe separated terms; `/regex/` terms are honoured; whole-word, case-insensitive. */
export function matchTerms(match: string): RegExp[] {
  const out: RegExp[] = []
  for (const raw of match.split(/[,|\n]/)) {
    const term = raw.trim()
    if (!term) continue
    const re = /^\/(.+)\/$/.exec(term)
    try {
      out.push(re ? new RegExp(re[1], 'i') : new RegExp(`(^|\\W)${escapeRe(term)}(?=\\W|$)`, 'i'))
    } catch {
      out.push(new RegExp(escapeRe(term), 'i'))
    }
  }
  return out
}

/** null = rule doesn't apply; higher = more specific fit. */
export function ruleScore(rule: DispatchRule, input: LoadoutInput): number | null {
  if (rule.kind && rule.kind !== 'any' && rule.kind !== input.kind) return null
  if (rule.project && rule.project.toLowerCase() !== input.project.toLowerCase()) return null
  const terms = matchTerms(rule.match ?? '')
  let hits = 0
  if (terms.length) {
    const text = `${input.title}\n${input.intent}\n${input.spec ?? ''}`
    hits = terms.filter((re) => re.test(text)).length
    if (!hits) return null
  }
  return (rule.project ? 100 : 0) + (rule.kind && rule.kind !== 'any' ? 10 : 0) + hits
}

/** Keyword table for the fallback classifier, most specific first (ties go to the earlier row). */
const CATEGORY_TERMS: [TaskCategory, RegExp][] = [
  ['large-context', /\b(whole|entire) (codebase|repo|repository|project)\b|\ball (the )?files\b|\bacross the (codebase|repo)\b|\bmap (out )?the codebase\b|\bsummari[sz]e the (codebase|repo|project)\b|\blarge context\b/gi],
  ['art', /\b(sprites?|textures?|tilesets?|portraits?|concept art|artwork|icons?|sound effects?|sfx|music|soundtrack|voice ?over|3d models?|assets?|generate (an? )?(image|sprite|sound|model)s?)\b/gi],
  ['graphics', /\b(shaders?|hlsl|glsl|wgsl|render\w*|lighting|post[- ]?process\w*|vfx|particles?|fps|frame ?(rate|time)|gpu|draw calls?|stutter\w*|perf|performance|optimi[sz]\w*|profil\w*)\b/gi],
  ['review', /\b(review|audit|critique|second opinion|look over)\b/gi],
  ['tests', /\b(tests?|testing|unit tests?|coverage|e2e|test suite|flaky)\b/gi],
  ['build-ci', /\b(ci|pipelines?|github actions?|workflows?|build scripts?|export presets?|packag\w*|release scripts?|tooling|scripts?|makefile|docker\w*|lint\w*|cli tool)\b/gi],
  ['docs', /\b(docs?|documentation|readme|changelog|tutorial|guide|wiki|docstrings?)\b/gi],
  ['ui', /\b(ui|ux|hud|menus?|buttons?|dialogs?|screens?|layouts?|fonts?|tooltips?|widgets?)\b/gi],
  ['refactor', /\b(refactor\w*|migrat\w*|port|porting|upgrade|rewrite|restructur\w*|modernize|clean ?up)\b/gi],
  ['bugfix', /\b(bugs?|broken|crash\w*|errors?|exceptions?|regressions?|glitch\w*|debug\w*|desync\w*|not working|doesn'?t work|fix(es|ing)?)\b/gi],
  ['chore', /\b(typos?|rename|bump|tweak|chore|constant|one[- ]liner|version)\b/gi],
  ['recon-design', /\b(design|architect\w*|plan|proposal|investigat\w*|research|explore|evaluate|compare|spike)\b/gi],
  ['feature', /\b(add|implement|feature|system|mechanic|new|support|create)\b/gi]
]

const RECON_KEEP: TaskCategory[] = ['review', 'large-context', 'recon-design']

/** Lightweight keyword fallback when nobody passed a category. Title hits count double. */
export function classifyCategory(kind: TaskKind, title: string, body: string): { category: TaskCategory; why: string } {
  let best: { category: TaskCategory; score: number; terms: string[] } | undefined
  for (const [category, re] of CATEGORY_TERMS) {
    const inTitle = title.match(re) ?? []
    const inBody = body.match(re) ?? []
    const score = inTitle.length * 2 + inBody.length
    if (score && (!best || score > best.score)) best = { category, score, terms: [...new Set([...inTitle, ...inBody].map((t) => t.toLowerCase()))] }
  }
  if (kind === 'scout' && (!best || !RECON_KEEP.includes(best.category))) {
    return { category: 'recon-design', why: best ? `Recon mission (mentions "${best.terms[0]}")` : 'Recon mission' }
  }
  if (!best) return { category: kind === 'scout' ? 'recon-design' : 'feature', why: 'no keyword matched' }
  return { category: best.category, why: `keywords ${best.terms.slice(0, 3).map((t) => `"${t}"`).join(', ')}` }
}

/** What the picker knows about this machine and world beyond the settings. */
export interface PickEnv {
  /** installed, enabled and verified on this machine */
  available: (h: HarnessAdapter) => boolean
  /** tool ids whose login check says logged out */
  loggedOut?: (id: string) => boolean
  /** current plan windows per tool id */
  quota?: Record<string, QuotaWindow[]>
  /** quota protection holds this tool now (one unit at a time at 70%+, a chat rejection) */
  unavailable?: (id: string) => boolean
  /** cheap third-party models: OpenRouter key + OpenCode installed + the world not opted out */
  cheap?: { allowed: boolean; why: string }
}

type Option = { c: PoolCandidate & { spendPriority?: number }; i: number }

/** Plan windows of a tool at or above the quota threshold, worst first. */
export function hotWindows(quota: PickEnv['quota'], harness: string): QuotaWindow[] {
  return (quota?.[harness] ?? []).filter((w) => blockedWindow(w)).sort((a, b) => (b.usedPercent ?? b.lastKnownUsedPercent ?? 100) - (a.usedPercent ?? a.lastKnownUsedPercent ?? 100))
}

/** The player's row for a category; none means the default model. */
export function poolFor(s: Pick<Settings, 'categoryPools'>, category: TaskCategory): CategoryPool | undefined {
  return (Array.isArray(s.categoryPools) ? s.categoryPools : []).find((p) => p.category === category && p.candidates.length > 0)
}

export function pickLoadout(input: LoadoutInput, s: Settings, envOrAvailable: PickEnv | ((h: HarnessAdapter) => boolean)): Loadout {
  const supplied: PickEnv = typeof envOrAvailable === 'function' ? { available: envOrAvailable } : envOrAvailable
  const protection = s.quotaProtection !== false
  const env = protection ? supplied : { ...supplied, quota: undefined, unavailable: undefined }
  const reasons: string[] = []
  const enabled = s.harnesses.filter((h) => h.enabled)
  const byId = (id: string): HarnessAdapter | undefined => enabled.find((h) => h.id === id)
  const installed = (id: string): boolean => {
    const h = byId(id)
    return Boolean(h && env.available(h))
  }
  const signedIn = (id: string): boolean => installed(id) && !env.loggedOut?.(id)
  const quotaBlocked = (id: string): boolean => !!hotWindows(env.quota, id).length || !!env.unavailable?.(id)
  const nameOf = (id: string): string => byId(id)?.name ?? s.harnesses.find((h) => h.id === id)?.name ?? id
  const plans = planStatuses(env.quota)
  /** Protection limits how many units run; it never swaps the tool or model: the launch waits. */
  const hold = (id: string, name = nameOf(id)): never => {
    const w = hotWindows(env.quota, id)[0]
    const why = w ? `${w.label} window at ${Math.round(w.usedPercent ?? w.lastKnownUsedPercent ?? 100)}%` : isPlan(id) && plans[id].level !== 'ok' ? protectionCause(plans[id]) : 'one unit at a time or a launch already reserved'
    throw new QuotaDeferredError(`deferred: ${name} is held by quota protection (${why}). The launch waits and keeps its tool and model.`)
  }
  const explicitHarness = input.harness?.trim() || ''
  const explicitModel = input.model?.trim() || ''
  const explicitEffort = input.effort?.trim() || ''

  // ---- category
  let category: TaskCategory
  if (isCategory(input.category)) {
    category = input.category
    reasons.push(`category ${categoryLabel(category)}: given at deploy`)
  } else if (input.sticky?.category && !explicitHarness) {
    category = input.sticky.category
    reasons.push(`category ${categoryLabel(category)}: kept from ${input.sticky.from}`)
  } else {
    const c = classifyCategory(input.kind, input.title, `${input.intent}\n${input.spec ?? ''}`)
    category = c.category
    reasons.push(`category ${categoryLabel(category)}: ${c.why}`)
  }

  // ---- sticky follow-up: same quest, same loadout (an explicit pick still wins)
  const st = input.sticky
  if (st && !explicitHarness && !explicitModel && !explicitEffort) {
    if (signedIn(st.harness)) {
      if (quotaBlocked(st.harness)) hold(st.harness)
      reasons.push(`${nameOf(st.harness)}: keeps the loadout of ${st.from} (follow-up on the same quest)`)
      if (st.model) reasons.push(`model ${st.model}: kept`)
      if (st.effort) reasons.push(`effort ${st.effort}: kept`)
      const model = unitModel(st.harness, st.model)
      if (approvalModel(model)) reasons.push('Explicit approval required for this launch; previous approval does not carry over.')
      return { harness: st.harness, model, effort: st.effort, source: 'sticky', category, reasons }
    }
    reasons.push(`${nameOf(st.harness)} from ${st.from} is not available now: picking again`)
  }

  for (const id of ['claude', 'codex'] as const) {
    if (protection && installed(id) && !plans[id].known) reasons.push(`warning: ${nameOf(id)} quota unverified (missing or expired report); ordinary dispatch allowed`)
  }

  /** Walk the player's ordered list: the first installed, signed-in candidate wins; say why earlier ones were passed over. */
  const walk = (ordered: Option[], label: string): Option | undefined => {
    for (const o of ordered) {
      const id = o.c.harness
      const name = `${nameOf(id)}${o.c.model ? ` / ${o.c.model}` : ''}`
      if (!installed(id)) {
        reasons.push(`${name} skipped: not installed or enabled`)
        continue
      }
      if (env.loggedOut?.(id)) {
        reasons.push(`${name} skipped: not logged in${id === 'codex' ? " (Genio's own Codex sign-in; picking another tool)" : ''}`)
        continue
      }
      if (o.c.cheap && !env.cheap?.allowed) {
        reasons.push(`${name} skipped: ${env.cheap?.why ?? 'cheap third-party models are off'}`)
        continue
      }
      if (quotaBlocked(id)) hold(id, name)
      return o
    }
    reasons.push(`${label}: none of its tools are installed, enabled and logged in`)
    return undefined
  }

  let harness = explicitHarness
  let source: Loadout['source'] = 'player'
  let ruleId: string | undefined
  let cand: Option['c'] | undefined

  if (harness) {
    if (harness === 'codex' && env.loggedOut?.(harness)) throw new Error(`${nameOf(harness)} is not signed in: sign in Genio's Codex in ${settingsPath('accounts')}, or pick another tool.`)
    if (quotaBlocked(harness)) hold(harness)
    reasons.push(`${nameOf(harness)}: your pick`)
  } else {
    // ---- the player's dispatch rules
    const ranked = s.dispatchRules
      .map((rule, i) => ({ rule, i, score: ruleScore(rule, input) }))
      .filter((r): r is { rule: DispatchRule; i: number; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
    for (const { rule } of ranked) {
      const label = rule.match?.trim() ? `rule "${rule.match.trim()}"` : 'catch-all rule'
      const ordered = rule.candidates
        .map((c: RuleCandidate, i) => ({ c, i }))
        .sort((a, b) => (b.c.spendPriority ?? 0) - (a.c.spendPriority ?? 0) || a.i - b.i)
      const pick = walk(ordered, label)
      if (!pick) continue
      cand = pick.c
      harness = cand.harness
      source = 'rule'
      ruleId = rule.id
      reasons.push(`${nameOf(harness)}: ${label}${rule.candidates.length > 1 ? ` (best of ${rule.candidates.length})` : ''}`)
      break
    }

    // ---- the player's row for this category
    const pool = harness ? undefined : poolFor(s, category)
    if (pool) {
      const label = `your ${categoryLabel(category)} row`
      const pick = walk(pool.candidates.map((c, i) => ({ c, i })), label)
      if (pick) {
        cand = pick.c
        harness = cand.harness
        source = 'table'
        reasons.push(`${nameOf(harness)}${cand.model ? ` / ${cand.model}` : ''}: ${label}${pick.i > 0 ? ` (#${pick.i + 1} of ${pool.candidates.length})` : ''}`)
      }
    }

    // ---- the player's default unit tool, else the default: Claude, or Codex when only Codex is signed in
    if (!harness) {
      const own = s.defaultHarness?.trim()
      harness = own || defaultProvider({ claude: signedIn('claude'), codex: signedIn('codex') })
      if (!signedIn(harness)) throw new Error(`deferred: ${nameOf(harness)} is not ${installed(harness) ? 'signed in' : 'installed or enabled'}, so no unit can start; the quest stays queued.`)
      if (quotaBlocked(harness)) hold(harness)
      source = 'default'
      reasons.push(own ? `${nameOf(harness)}: your default unit tool` : `${nameOf(harness)}: default (Claude while signed in, else Codex)`)
    }
  }

  const adapter = s.harnesses.find((h) => h.id === harness)
  const ownDefaultTool = Boolean(s.defaultHarness?.trim()) && harness === s.defaultHarness.trim()

  // ---- model: the pick, the rule or row, the player's default unit model, else the tool's default
  let model = explicitModel || undefined
  if (model) reasons.push(`model ${model}: your pick`)
  else if (cand?.model) {
    model = cand.model
    reasons.push(`model ${model}: ${cand.cheap ? 'cheap OpenRouter model' : source === 'table' ? 'your category row' : 'from the rule'}`)
  } else if (ownDefaultTool && s.defaultWorkerModel?.trim()) {
    model = s.defaultWorkerModel.trim()
    reasons.push(`model ${model}: your default unit model`)
  }
  const chosen = model
  model = unitModel(harness, model)
  if (model && !chosen) reasons.push(`model ${model}: default`)

  // ---- effort: the same order, else medium (high for a Recon)
  let effort = explicitEffort || undefined
  if (effort) reasons.push(`effort ${effort}: your pick`)
  else if (cand?.effort) {
    effort = cand.effort
    reasons.push(`effort ${effort}: ${source === 'table' ? 'your category row' : 'from the rule'}`)
  } else if (s.defaultWorkerEffort?.trim() && !cand?.cheap) {
    effort = s.defaultWorkerEffort.trim()
    reasons.push(`effort ${effort}: your default unit effort`)
  } else if (adapter?.effortArgs?.length) {
    effort = defaultUnitEffort(input.kind)
    reasons.push(`effort ${effort}: default`)
  }

  if (approvalModel(model)) reasons.push('Explicit approval required for this launch. Astra is normally reserved for heavy visual work.')
  return { harness, model, effort, source, ruleId, category, reasons }
}

/**
 * Cheap third-party models (OpenRouter through OpenCode) need all three: the
 * world not opted out (on by default), an OpenRouter key and OpenCode installed.
 * A world that opts out never sends code to a third-party provider.
 */
export function cheapGate(g: { worldAllows: boolean; keySet: boolean; opencodeReady: boolean }): { allowed: boolean; why: string } {
  if (!g.worldAllows) return { allowed: false, why: 'cheap third-party models are off for this project' }
  if (!g.keySet) return { allowed: false, why: `no OpenRouter key in ${settingsPath('accounts')}` }
  if (!g.opencodeReady) return { allowed: false, why: 'OpenCode is not installed' }
  return { allowed: true, why: 'allowed for this project' }
}

/** pickLoadout against what is actually installed, enabled and verified on this machine, plus live dispatch signals. */
export function resolveLoadout(input: LoadoutInput, settings: SettingsService, signals: Omit<PickEnv, 'available'> = {}): Loadout {
  const ready = new Set(settings.availableHarnesses().map((h) => h.id))
  return pickLoadout(input, settings.get(), { ...signals, available: (h) => ready.has(h.id) })
}

