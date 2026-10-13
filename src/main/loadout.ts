/**
 * Loadout picker: decides which unit tool (harness), model and effort a unit
 * deploys with when the player didn't choose. Deterministic and explainable, so
 * the Deploy dialog can preview it and every deploy path (dialog, Genio, quest
 * auto-dispatch) lands on the same answer.
 *
 * Precedence per field: the player's explicit choice, then the best-fit
 * dispatch rule, then the configured default, then a built-in guess (effort
 * only; the harness falls back to Claude Code).
 */
import type { DispatchRule, HarnessAdapter, Loadout, LoadoutInput, Settings, TaskKind } from '@shared/types'
import type { SettingsService } from './services'

type Candidate = DispatchRule['candidates'][number]

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

export function pickLoadout(input: LoadoutInput, s: Settings, available: (h: HarnessAdapter) => boolean): Loadout {
  const reasons: string[] = []
  const enabled = s.harnesses.filter((h) => h.enabled)
  const byId = (id: string): HarnessAdapter | undefined => enabled.find((h) => h.id === id)
  const usable = (id: string): boolean => {
    const h = byId(id)
    return Boolean(h && available(h))
  }
  const nameOf = (id: string): string => byId(id)?.name ?? s.harnesses.find((h) => h.id === id)?.name ?? id

  let harness = input.harness?.trim() || ''
  let source: Loadout['source'] = 'player'
  let ruleId: string | undefined
  let cand: Candidate | undefined

  if (harness) {
    reasons.push(`${nameOf(harness)}: your pick`)
  } else {
    const ranked = s.dispatchRules
      .map((rule, i) => ({ rule, i, score: ruleScore(rule, input) }))
      .filter((r): r is { rule: DispatchRule; i: number; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
    for (const { rule } of ranked) {
      const options = rule.candidates
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => usable(c.harness))
        .sort((a, b) => (b.c.spendPriority ?? 0) - (a.c.spendPriority ?? 0) || a.i - b.i)
      const label = rule.match?.trim() ? `rule "${rule.match.trim()}"` : 'catch-all rule'
      if (!options.length) {
        reasons.push(`${label} matched, but none of its tools are installed and enabled`)
        continue
      }
      cand = options[0].c
      harness = cand.harness
      source = 'rule'
      ruleId = rule.id
      reasons.push(`${nameOf(harness)}: ${label}${rule.candidates.length > 1 ? ` (best of ${rule.candidates.length})` : ''}`)
      break
    }
    if (!harness) {
      harness = s.defaultHarness || 'claude'
      source = 'default'
      reasons.push(`${nameOf(harness)}: default unit tool${ranked.length || !s.dispatchRules.length ? '' : ' (no rule matched)'}`)
    }
  }

  const adapter = s.harnesses.find((h) => h.id === harness)
  const isDefaultTool = harness === (s.defaultHarness || 'claude')

  let model = input.model?.trim() || undefined
  if (model) reasons.push(`model ${model}: your pick`)
  else if (cand?.model) {
    model = cand.model
    reasons.push(`model ${model}: from the rule`)
  } else if (isDefaultTool && s.defaultWorkerModel) {
    model = s.defaultWorkerModel
    reasons.push(`model ${model}: default`)
  }

  let effort = input.effort?.trim() || undefined
  if (effort) reasons.push(`effort ${effort}: your pick`)
  else if (cand?.effort) {
    effort = cand.effort
    reasons.push(`effort ${effort}: from the rule`)
  } else if (s.defaultWorkerEffort) {
    effort = s.defaultWorkerEffort
    reasons.push(`effort ${effort}: default`)
  } else if (adapter?.effortArgs?.length) {
    const g = classifyEffort(input.kind, `${input.title}\n${input.intent}\n${input.spec ?? ''}`)
    effort = g.effort
    reasons.push(`effort ${effort}: ${g.why}`)
  }

  return { harness, model, effort, source, ruleId, reasons }
}

/** pickLoadout against what is actually installed, enabled and verified on this machine. */
export function resolveLoadout(input: LoadoutInput, settings: SettingsService): Loadout {
  const ready = new Set(settings.availableHarnesses().map((h) => h.id))
  return pickLoadout(input, settings.get(), (h) => ready.has(h.id))
}
