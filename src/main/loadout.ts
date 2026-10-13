/**
 * Loadout picker: decides which unit tool (harness), model and effort a unit
 * deploys with when the player didn't choose. Deterministic and explainable
 * (exploration rolls only through an injected `rand`), so the Deploy dialog
 * can preview it and every deploy path (dialog, Genio, quest auto-dispatch)
 * lands on the same answer.
 *
 * Precedence for the unit tool: the explicit per-task pick (player or Genio),
 * then a follow-up's sticky loadout, then the best-fit dispatch rule, then the
 * category table (category from Genio or the keyword heuristic), then the
 * configured default. Inside a rule or the table, candidates whose tool is not
 * installed, enabled or logged in are skipped, cheap third-party models need
 * the world not opted out, the cost dial reorders, and a tool above ~85% of a plan
 * window is excluded. Exploration only ever happens inside the table.
 */
import type {
  CategoryPool, CostDial, DispatchRule, HarnessAdapter, Loadout, LoadoutInput, PoolCandidate, Settings, TaskCategory, TaskKind
} from '@shared/types'
import {
  COST_MODEL, DIAL_LABEL, QUALITY_MODEL, categoryLabel, defaultCategoryPools, isCategory, shiftEffort, type ScoreRow
} from '@shared/dispatch'
import type { SettingsService } from './services'
import { blockedWindow, explorationSafe, type QuotaWindow } from './quota-policy'
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

const DEEP =
  /\b(design|architect\w*|rework|overhaul|refactor\w*|investigat\w*|figure out|root cause|not sure|unclear|why|somehow|netcode|multiplayer|procedural|optimi[sz]\w*|performance|perf|profil\w*|migrat\w*|rewrite)\b/i
const SMALL = /\b(fix|rename|typo|bump|tweak|adjust|change|swap|update|add|remove|move|hide|show|colou?r|text|label|string|constant|value)\b/i

/** Built-in effort guess from the mission type and how open-ended the ask reads. */
export function classifyEffort(kind: TaskKind, text: string): { effort: string; why: string } {
  const words = (text.match(/\S+/g) ?? []).length
  const deep = DEEP.exec(text)
  if (kind === 'scout')
    return deep
      ? {
          effort: 'xhigh',
          why: `open-ended Recon ("${deep[0].toLowerCase()}")`
        }
      : { effort: 'high', why: 'Recon mission' }
  if (deep)
    return {
      effort: 'high',
      why: `open-ended Build ("${deep[0].toLowerCase()}")`
    }
  if (words <= 40 && SMALL.test(text)) return { effort: 'low', why: 'small, explicit Build' }
  return { effort: 'medium', why: 'Build of ordinary scope' }
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
  unavailable?: (id: string) => boolean
  /** cheap third-party models: OpenRouter key + OpenCode installed + the world not opted out */
  cheap?: { allowed: boolean; why: string }
  /** the world's dial override, else Settings.costDial */
  dial?: CostDial
  dialFromWorld?: boolean
  /** scorecard rows (learning) */
  stats?: ScoreRow[]
  /** exploration roll in [0,1); omitted = never explore */
  rand?: () => number
  /** the Deploy preview: say that exploration may happen instead of rolling */
  preview?: boolean
}

type Option = { c: PoolCandidate & { spendPriority?: number }; i: number }

/** Plan windows of a tool at or above the quota threshold, worst first. */
export function hotWindows(quota: PickEnv['quota'], harness: string): QuotaWindow[] {
  return (quota?.[harness] ?? []).filter((w) => blockedWindow(w)).sort((a, b) => (b.usedPercent ?? b.lastKnownUsedPercent ?? 100) - (a.usedPercent ?? a.lastKnownUsedPercent ?? 100))
}

/** The category table's order after the cost dial. */
export function dialOrder(list: Option[], dial: CostDial): Option[] {
  if (dial === 'quality') return [...list.filter((o) => !o.c.cheap), ...list.filter((o) => o.c.cheap)]
  if (dial === 'cost') return [...list.filter((o) => o.c.cheap), ...list.filter((o) => !o.c.cheap)]
  return list
}

const DEEP_CATEGORIES: TaskCategory[] = ['recon-design', 'feature', 'bugfix', 'refactor', 'graphics', 'large-context']

export function poolFor(s: Settings, category: TaskCategory): CategoryPool | undefined {
  const pools = Array.isArray(s.categoryPools) ? s.categoryPools : defaultCategoryPools()
  return pools.find((p) => p.category === category)
}

const statFor = (stats: ScoreRow[] | undefined, scope: string, c: { harness: string; model?: string }): ScoreRow | undefined =>
  stats?.find((r) => r.scope === scope && r.harness === c.harness && (r.model ?? '') === (c.model ?? ''))

export function pickLoadout(input: LoadoutInput, s: Settings, envOrAvailable: PickEnv | ((h: HarnessAdapter) => boolean)): Loadout {
  const env: PickEnv = typeof envOrAvailable === 'function' ? { available: envOrAvailable } : envOrAvailable
  const reasons: string[] = []
  const enabled = s.harnesses.filter((h) => h.enabled)
  const byId = (id: string): HarnessAdapter | undefined => enabled.find((h) => h.id === id)
  const installed = (id: string): boolean => {
    const h = byId(id)
    return Boolean(h && env.available(h))
  }
  const quotaBlocked = (id: string): boolean => !!hotWindows(env.quota, id).length || !!env.unavailable?.(id)
  const usable = (id: string): boolean => installed(id) && !env.loggedOut?.(id) && !quotaBlocked(id)
  const nameOf = (id: string): string => byId(id)?.name ?? s.harnesses.find((h) => h.id === id)?.name ?? id
  const dial: CostDial = env.dial ?? s.costDial ?? 'balanced'
  const text = `${input.title}\n${input.intent}\n${input.spec ?? ''}`
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
    if (usable(st.harness)) {
      reasons.push(`${nameOf(st.harness)}: keeps the loadout of ${st.from} (follow-up on the same quest)`)
      if (st.model) reasons.push(`model ${st.model}: kept`)
      if (st.effort) reasons.push(`effort ${st.effort}: kept`)
      return { harness: st.harness, model: st.model, effort: st.effort, source: 'sticky', category, reasons }
    }
    reasons.push(`${nameOf(st.harness)} from ${st.from} is not available now: picking again`)
  }

  if (dial !== 'balanced') reasons.push(`dial ${DIAL_LABEL[dial]}${env.dialFromWorld ? ' (this world)' : ''}`)

  /** Walk an ordered list: the first usable candidate wins; say why earlier ones were passed over. */
  const walk = (ordered: Option[], label: string): Option | undefined => {
    for (const o of ordered) {
      const id = o.c.harness
      const name = `${nameOf(id)}${o.c.model ? ` / ${o.c.model}` : ''}`
      if (!installed(id)) {
        reasons.push(`${name} skipped: not installed or enabled`)
        continue
      }
      if (env.loggedOut?.(id)) {
        reasons.push(`${name} skipped: not logged in`)
        continue
      }
      if (quotaBlocked(id)) {
        const w = hotWindows(env.quota, id)[0]
        reasons.push(w ? `${name} excluded: ${w.label} window at ${Math.round(w.usedPercent ?? w.lastKnownUsedPercent ?? 100)}%` : `${name} excluded: quota protection or launch already reserved`)
        continue
      }
      if (o.c.cheap && !env.cheap?.allowed) {
        reasons.push(`${name} skipped: ${env.cheap?.why ?? 'cheap third-party models are off'}`)
        continue
      }
      return o
    }
    reasons.push(`${label}: none of its tools are installed, enabled and logged in`)
    return undefined
  }

  let harness = explicitHarness
  let source: Loadout['source'] = 'player'
  let ruleId: string | undefined
  let cand: Option['c'] | undefined
  let fromTable = false
  let explored = false

  if (harness) {
    if (quotaBlocked(harness)) throw new Error(`deferred: ${nameOf(harness)} is held by quota protection. Wait for fresh evidence before resuming this pinned task.`)
    reasons.push(`${nameOf(harness)}: your pick`)
  } else {
    // ---- explicit dispatch rules
    const ranked = s.dispatchRules
      .map((rule, i) => ({ rule, i, score: ruleScore(rule, input) }))
      .filter((r): r is { rule: DispatchRule; i: number; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
    for (const { rule } of ranked) {
      const label = rule.match?.trim() ? `rule "${rule.match.trim()}"` : 'catch-all rule'
      const byPriority = rule.candidates
        .map((c: RuleCandidate, i) => ({ c, i }))
        .sort((a, b) => (b.c.spendPriority ?? 0) - (a.c.spendPriority ?? 0) || a.i - b.i)
      const ordered = byPriority
      const pick = walk(ordered, label)
      if (!pick) continue
      cand = pick.c
      harness = cand.harness
      source = 'rule'
      ruleId = rule.id
      reasons.push(`${nameOf(harness)}: ${label}${rule.candidates.length > 1 ? ` (best of ${rule.candidates.length})` : ''}`)
      const row = statFor(env.stats, `rule:${rule.id}`, cand)
      if (row) reasons.push(`learning: ${row.samples} outcome${row.samples === 1 ? '' : 's'} under this rule, score ${row.score.toFixed(2)}`)
      break
    }

    // ---- category table
    const pool = harness ? undefined : poolFor(s, category)
    if (!harness && pool?.candidates.length) {
      const label = `${categoryLabel(category)} table`
      const ordered = dialOrder(pool.candidates.map((c, i) => ({ c, i })), dial)
      const before = reasons.length
      const pick = walk(ordered, label)
      if (pick) {
        let chosen = pick
        const eligible = ordered.filter((o) => usable(o.c.harness) && explorationSafe(env.quota?.[o.c.harness]) && (!o.c.cheap || env.cheap?.allowed))
        const rate = Math.max(0, Math.min(1, s.explorationRate ?? 0))
        const canExplore = rate > 0 && eligible.includes(pick) && eligible.length >= 2 && !explicitModel && !explicitEffort && input.priority !== 'critical'
        if (canExplore && env.preview) {
          reasons.push(`exploration: ${Math.round(rate * 100)}% of deploys try a less-proven candidate`)
        } else if (canExplore && env.rand && env.rand() < rate) {
          const samples = (o: Option): number => statFor(env.stats, category, o.c)?.samples ?? 0
          const alt = eligible.filter((o) => o !== pick).sort((a, b) => samples(a) - samples(b) || ordered.indexOf(a) - ordered.indexOf(b))[0]
          if (alt) {
            chosen = alt
            explored = true
            // the skip notes explained a pick that exploration replaced
            reasons.splice(before)
            reasons.push(
              `exploration (${Math.round(rate * 100)}%): trying ${nameOf(alt.c.harness)}${alt.c.model ? ` / ${alt.c.model}` : ''}, less proven for ${categoryLabel(category)} (${samples(alt)} vs ${samples(pick)} outcomes)`
            )
          }
        }
        cand = chosen.c
        harness = cand.harness
        source = 'table'
        fromTable = true
        if (!explored) {
          const pos = pool.candidates.indexOf(chosen.c)
          reasons.push(`${nameOf(harness)}${cand.model ? ` / ${cand.model}` : ''}: ${label}${pos > 0 ? ` (#${pos + 1} of ${pool.candidates.length})` : ''}`)
        }
        const row = statFor(env.stats, category, cand)
        if (row) reasons.push(`learning: score ${row.score.toFixed(2)} for ${categoryLabel(category)} over ${row.samples} outcome${row.samples === 1 ? '' : 's'}`)
      }
    }

    if (!harness) {
      harness = s.defaultHarness || 'claude'
      if (!usable(harness)) throw new Error('deferred: no eligible unit plan is available; the quest stays queued.')
      source = 'default'
      reasons.push(`${nameOf(harness)}: default unit tool${ranked.length || !s.dispatchRules.length ? '' : ' (no rule matched)'}`)
    }
  }

  const adapter = s.harnesses.find((h) => h.id === harness)
  const isDefaultTool = harness === (s.defaultHarness || 'claude')

  // ---- model
  let model = explicitModel || undefined
  if (model) reasons.push(`model ${model}: your pick`)
  else if (cand?.model) {
    model = cand.model
    reasons.push(`model ${model}: ${cand.cheap ? 'cheap OpenRouter model' : fromTable ? 'from the table' : 'from the rule'}`)
  } else if (isDefaultTool && s.defaultWorkerModel) {
    model = s.defaultWorkerModel
    reasons.push(`model ${model}: default`)
  } else if (!explicitHarness && dial === 'quality' && QUALITY_MODEL[harness] && DEEP_CATEGORIES.includes(category)) {
    model = QUALITY_MODEL[harness]
    reasons.push(`model ${model}: Quality dial`)
  } else if (!explicitHarness && dial === 'cost' && COST_MODEL[harness]) {
    model = COST_MODEL[harness]
    reasons.push(`model ${model}: Cost dial`)
  }

  // ---- effort (the dial shifts everything except an explicit or rule effort)
  const shift = dial === 'quality' ? 1 : dial === 'cost' ? -1 : 0
  const dialled = (e: string, why: string): { effort: string; why: string } => {
    if (!shift || !adapter?.effortArgs?.length) return { effort: e, why }
    const next = shiftEffort(e, shift)
    return next === e ? { effort: e, why } : { effort: next, why: `${why}, ${shift > 0 ? 'raised' : 'lowered'} from ${e} by the ${DIAL_LABEL[dial]} dial` }
  }
  let effort = explicitEffort || undefined
  if (effort) reasons.push(`effort ${effort}: your pick`)
  else if (cand?.effort && !fromTable) {
    effort = cand.effort
    reasons.push(`effort ${effort}: from the rule`)
  } else {
    let base: { effort: string; why: string } | undefined
    if (cand?.effort) base = { effort: cand.effort, why: 'from the table' }
    else if (s.defaultWorkerEffort) base = { effort: s.defaultWorkerEffort, why: 'default' }
    else if (adapter?.effortArgs?.length) base = classifyEffort(input.kind, text)
    if (base) {
      const d = dialled(base.effort, base.why)
      effort = d.effort
      reasons.push(`effort ${effort}: ${d.why}`)
    }
  }

  return { harness, model, effort, source, ruleId, category, explored: explored || undefined, reasons }
}

/**
 * Cheap third-party models (OpenRouter through OpenCode) need all three: the
 * world not opted out (on by default), an OpenRouter key and OpenCode installed.
 * A world that opts out never sends code to a third-party provider.
 */
export function cheapGate(g: { worldAllows: boolean; keySet: boolean; opencodeReady: boolean }): { allowed: boolean; why: string } {
  if (!g.worldAllows) return { allowed: false, why: 'cheap third-party models are off for this world' }
  if (!g.keySet) return { allowed: false, why: 'no OpenRouter key in Systems → Accounts' }
  if (!g.opencodeReady) return { allowed: false, why: 'OpenCode is not installed' }
  return { allowed: true, why: 'allowed for this world' }
}

/** pickLoadout against what is actually installed, enabled and verified on this machine, plus live dispatch signals. */
export function resolveLoadout(input: LoadoutInput, settings: SettingsService, signals: Omit<PickEnv, 'available'> = {}): Loadout {
  const ready = new Set(settings.availableHarnesses().map((h) => h.id))
  return pickLoadout(input, settings.get(), { ...signals, available: (h) => ready.has(h.id) })
}
