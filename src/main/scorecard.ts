/**
 * Dispatch scorecard and the learning loop around it.
 *
 * When a unit ends (landed, despawned or failed) one outcome record per task
 * is upserted into data/dispatch/scorecard.json. Each record scores 0-1 (did
 * it land, how much rework it needed, the player's verdict) and the scores
 * are recency-weighted per (category, tool, model), and per (rule, tool, model)
 * for picks a rule made.
 *
 * Guardrails (thresholds in LEARNING, src/shared/dispatch.ts):
 *   - automatic: swap two neighbouring candidates of a category row or a rule
 *     (same spend priority) when both have at least `minSamples` outcomes and
 *     the lower one scores at least `reorderMargin` higher;
 *   - needs the player's OK: adding or removing a candidate is proposed as a
 *     choice under Your Move, with the evidence; accepting it applies it;
 *   - locked rows and rules are never touched.
 */
import path from 'node:path'
import type { CategoryPool, Decision, DispatchProposal, DispatchRule, PoolCandidate, Settings, Task, Verdict } from '@shared/types'
import { LEARNING, candidateKey, categoryLabel, isCategory, type LearningEvent, type OutcomeRecord, type ScoreRow } from '@shared/dispatch'
import type { DecisionService } from './services'
import { appendLine, nowIso, readJson, readJsonl, writeJson } from './util'

const KEEP = 2000
const DAY = 86_400_000

// ---------------------------------------------------------------- outcomes

/** How a task ended, or undefined while it is still in play. */
export function outcomeOf(t: Task): OutcomeRecord['outcome'] | undefined {
  if (t.state === 'merged') return 'landed'
  if (t.state === 'done' && t.kind === 'scout') return 'landed'
  if (t.state === 'failed') return 'failed'
  if (t.state === 'cleaned') return t.landedAt || /\blanded\b/.test(t.stateReason ?? '') ? 'landed' : 'despawned'
  return undefined
}

export function buildOutcome(t: Task, outcome: OutcomeRecord['outcome'], now = Date.now(), usageEnd?: number): OutcomeRecord {
  const c = t.counters ?? { pings: 0, lagging: 0, stopped: 0, fixRounds: 0 }
  const created = Date.parse(t.createdAt)
  return {
    v: 1,
    taskId: t.id,
    title: t.title,
    kind: t.kind,
    category: isCategory(t.category) ? t.category : t.kind === 'scout' ? 'recon-design' : 'feature',
    world: t.project,
    harness: t.harness,
    model: t.model,
    effort: t.effort,
    source: t.loadoutSource,
    ruleId: t.ruleId,
    explored: t.explored || undefined,
    outcome,
    landed: outcome === 'landed',
    // Gauntlet findings reach the unit as pings: those count as fix rounds, not steering
    pings: Math.max(0, c.pings - c.fixRounds),
    relaunches: t.relaunches ?? 0,
    lagging: c.lagging,
    stopped: c.stopped,
    fixRounds: t.mode === 'no-mistakes' || c.fixRounds ? c.fixRounds : undefined,
    wallMinutes: Number.isFinite(created) ? Math.max(0, Math.round((now - created) / 60_000)) : 0,
    planUsage: t.usageAtStart !== undefined || usageEnd !== undefined ? { start: t.usageAtStart, end: usageEnd } : undefined,
    verdict: t.verdict,
    note: t.verdictNote,
    endedAt: new Date(now).toISOString()
  }
}

export interface Scorecard {
  list(): OutcomeRecord[]
  /** one record per task: a later end replaces an earlier one (a landed task stays landed) */
  upsert(r: OutcomeRecord): OutcomeRecord
  /** record the player's verdict; false when the task has no outcome yet */
  rate(taskId: string, verdict: Verdict, note?: string): boolean
}

export function createScorecard(file: string): Scorecard {
  let rows: OutcomeRecord[] | undefined
  const load = (): OutcomeRecord[] => {
    if (!rows) {
      const raw = readJson<OutcomeRecord[]>(file, [])
      rows = Array.isArray(raw) ? raw.filter((r) => r && typeof r.taskId === 'string') : []
    }
    return rows
  }
  const save = (): void => {
    const all = load()
    if (all.length > KEEP) rows = all.slice(all.length - KEEP)
    writeJson(file, rows)
  }
  return {
    list: () => load().slice(),
    upsert(r) {
      const all = load()
      const i = all.findIndex((x) => x.taskId === r.taskId)
      let next = r
      if (i >= 0) {
        const prev = all[i]
        next = { ...r, verdict: r.verdict ?? prev.verdict, note: r.note ?? prev.note }
        if (prev.landed && !r.landed && r.outcome === 'despawned') next = { ...next, outcome: 'landed', landed: true }
        all.splice(i, 1)
      }
      all.push(next)
      save()
      return next
    },
    rate(taskId, verdict, note) {
      const r = load().find((x) => x.taskId === taskId)
      if (!r) return false
      r.verdict = verdict
      if (note !== undefined) r.note = note || undefined
      save()
      return true
    }
  }
}

export const scorecardFile = (dataDir: string): string => path.join(dataDir, 'dispatch', 'scorecard.json')
export const learningLogFile = (dataDir: string): string => path.join(dataDir, 'dispatch', 'learning.jsonl')

export function appendLearning(dataDir: string, kind: LearningEvent['kind'], text: string): void {
  try {
    appendLine(learningLogFile(dataDir), JSON.stringify({ ts: nowIso(), kind, text } satisfies LearningEvent))
  } catch {
    /* the log is a convenience */
  }
}

export function readLearning(dataDir: string, n = 30): LearningEvent[] {
  return readJsonl<LearningEvent>(learningLogFile(dataDir)).slice(-n).reverse()
}

// ---------------------------------------------------------------- scoring

/** 0-1: landed work scores high, rework pulls it down, the player's verdict weighs most. */
export function scoreOutcome(r: OutcomeRecord): number {
  let s = r.landed ? 1 : r.outcome === 'despawned' ? 0.1 : 0
  if (r.landed) {
    s -= Math.min(0.25, r.pings * 0.05)
    s -= Math.min(0.3, r.relaunches * 0.1)
    s -= Math.min(0.3, (r.fixRounds ?? 0) * 0.1)
    s -= Math.min(0.15, (r.lagging + r.stopped) * 0.03)
  }
  if (r.verdict === 'up') s = Math.max(0.6, s + 0.25)
  if (r.verdict === 'down') s = Math.min(0.3, s) - 0.1
  return Math.max(0, Math.min(1, s))
}

export const recencyWeight = (endedAt: string, now: number): number => {
  const t = Date.parse(endedAt)
  const age = Number.isFinite(t) ? Math.max(0, now - t) / DAY : 0
  return Math.pow(0.5, age / LEARNING.halfLifeDays)
}

/** Recency-weighted scores per (category, tool, model) and per (rule:<id>, tool, model). */
export function scoreTable(records: OutcomeRecord[], now = Date.now()): ScoreRow[] {
  const acc = new Map<string, { row: ScoreRow; sum: number }>()
  const add = (scope: string, r: OutcomeRecord): void => {
    const key = `${scope}|${r.harness}|${r.model ?? ''}`
    const w = recencyWeight(r.endedAt, now)
    const cur = acc.get(key) ?? { row: { scope, harness: r.harness, model: r.model || undefined, score: 0, samples: 0, landed: 0, weight: 0 }, sum: 0 }
    cur.row.samples++
    if (r.landed) cur.row.landed++
    cur.row.weight += w
    cur.sum += w * scoreOutcome(r)
    acc.set(key, cur)
  }
  for (const r of records) {
    add(r.category, r)
    if (r.ruleId && r.source === 'rule') add(`rule:${r.ruleId}`, r)
  }
  return [...acc.values()]
    .map(({ row, sum }) => ({ ...row, score: row.weight ? Math.round((sum / row.weight) * 1000) / 1000 : 0 }))
    .sort((a, b) => a.scope.localeCompare(b.scope) || b.score - a.score)
}

const rowFor = (rows: ScoreRow[], scope: string, c: { harness: string; model?: string }): ScoreRow | undefined =>
  rows.find((r) => r.scope === scope && r.harness === c.harness && (r.model ?? '') === (c.model ?? ''))

const proven = (r: ScoreRow | undefined, min = LEARNING.minSamples): r is ScoreRow => Boolean(r && r.samples >= min)

const who = (c: { harness: string; model?: string }): string => (c.model ? `${c.harness} / ${c.model}` : c.harness)
const ev = (c: { harness: string; model?: string }, r: ScoreRow): string => `${who(c)} landed ${r.landed}/${r.samples} (score ${r.score.toFixed(2)})`

// ---------------------------------------------------------------- automatic reordering

/** Neighbour swaps the evidence clearly supports; `scopeOf(i)` names the scorecard scope. */
function reorder<T extends { harness: string; model?: string }>(list: T[], scope: string, rows: ScoreRow[], sameTier: (a: T, b: T) => boolean): { list: T[]; swaps: string[] } {
  const out = list.slice()
  const swaps: string[] = []
  for (let pass = 0; pass < out.length; pass++) {
    let changed = false
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i]
      const b = out[i + 1]
      if (!sameTier(a, b)) continue
      const ra = rowFor(rows, scope, a)
      const rb = rowFor(rows, scope, b)
      if (!proven(ra) || !proven(rb)) continue
      if (rb.score - ra.score < LEARNING.reorderMargin) continue
      out[i] = b
      out[i + 1] = a
      swaps.push(`${ev(b, rb)} now ahead of ${ev(a, ra)}`)
      changed = true
    }
    if (!changed) break
  }
  return { list: out, swaps }
}

export interface ReorderResult {
  categoryPools: CategoryPool[]
  dispatchRules: DispatchRule[]
  changes: string[]
}

/** Reorders candidates within unlocked category rows and rules; undefined when nothing moves. */
export function planReorder(s: Pick<Settings, 'categoryPools' | 'dispatchRules'>, rows: ScoreRow[]): ReorderResult | undefined {
  const changes: string[] = []
  const categoryPools = s.categoryPools.map((p) => {
    if (p.locked) return p
    const r = reorder(p.candidates, p.category, rows, () => true)
    if (!r.swaps.length) return p
    changes.push(...r.swaps.map((x) => `${categoryLabel(p.category)}: ${x}`))
    return { ...p, candidates: r.list }
  })
  const dispatchRules = s.dispatchRules.map((rule) => {
    if (rule.locked) return rule
    const r = reorder(rule.candidates, `rule:${rule.id}`, rows, (a, b) => (a.spendPriority ?? 0) === (b.spendPriority ?? 0))
    if (!r.swaps.length) return rule
    changes.push(...r.swaps.map((x) => `rule "${rule.match || 'catch-all'}": ${x}`))
    return { ...rule, candidates: r.list }
  })
  return changes.length ? { categoryPools, dispatchRules, changes } : undefined
}

// ---------------------------------------------------------------- proposals (need the player's OK)

export function planProposals(s: Pick<Settings, 'categoryPools' | 'dispatchRules'>, rows: ScoreRow[]): DispatchProposal[] {
  const out: DispatchProposal[] = []
  for (const p of s.categoryPools) {
    if (p.locked) continue
    const label = categoryLabel(p.category)
    for (const c of p.candidates) {
      const r = rowFor(rows, p.category, c)
      if (p.candidates.length > 1 && proven(r, LEARNING.removeMinSamples) && r.score < LEARNING.removeBelow) {
        out.push({ op: 'pool-remove', category: p.category, candidate: c, evidence: `${ev(c, r)} on ${label} jobs` })
      }
    }
    const first = p.candidates.find((c) => proven(rowFor(rows, p.category, c)))
    const firstRow = first ? rowFor(rows, p.category, first) : undefined
    if (!first || !firstRow) continue
    const inPool = new Set(p.candidates.map(candidateKey))
    for (const r of rows) {
      if (r.scope !== p.category || inPool.has(candidateKey(r)) || !proven(r)) continue
      if (r.score - firstRow.score < LEARNING.addMargin) continue
      const cand: PoolCandidate = { harness: r.harness, ...(r.model ? { model: r.model } : {}) }
      out.push({ op: 'pool-add', category: p.category, candidate: cand, evidence: `${ev(cand, r)} on ${label} jobs vs ${ev(first, firstRow)}` })
    }
  }
  for (const rule of s.dispatchRules) {
    if (rule.locked || rule.candidates.length < 2) continue
    for (const c of rule.candidates) {
      const r = rowFor(rows, `rule:${rule.id}`, c)
      if (proven(r, LEARNING.removeMinSamples) && r.score < LEARNING.removeBelow) {
        out.push({ op: 'rule-drop-candidate', ruleId: rule.id, candidate: { harness: c.harness, model: c.model }, evidence: `${ev(c, r)} under rule "${rule.match || 'catch-all'}"` })
      }
    }
  }
  return out
}

export const proposalKey = (p: DispatchProposal): string => `dispatch:${p.op}:${p.op === 'rule-drop-candidate' ? p.ruleId : p.category}:${candidateKey(p.candidate)}`

export function proposalQuestion(p: DispatchProposal, s: Pick<Settings, 'dispatchRules'>): string {
  const c = who(p.candidate)
  if (p.op === 'pool-add') return `Add ${c} at the top of the ${categoryLabel(p.category)} dispatch table?`
  if (p.op === 'pool-remove') return `Remove ${c} from the ${categoryLabel(p.category)} dispatch table?`
  const rule = s.dispatchRules.find((r) => r.id === p.ruleId)
  return `Drop ${c} from the dispatch rule "${rule?.match || 'catch-all'}"?`
}

export const PROPOSAL_OPTIONS = ['Apply the change', 'Keep things as they are']
/** a declined proposal is not asked again for this long */
const DECLINED_QUIET_MS = 30 * DAY

/** Open one Your Move choice per new proposal (idempotent per key). Returns the opened choices. */
export function openProposals(decisions: DecisionService, proposals: DispatchProposal[], s: Pick<Settings, 'dispatchRules'>, now = Date.now()): Decision[] {
  const all = decisions.list(true)
  const opened: Decision[] = []
  for (const p of proposals) {
    const key = proposalKey(p)
    const prior = all.filter((d) => d.key === key)
    if (prior.some((d) => !d.resolvedAt)) continue
    if (prior.some((d) => d.resolvedAt && now - Date.parse(d.resolvedAt) < DECLINED_QUIET_MS)) continue
    opened.push(
      decisions.open({
        key,
        question: proposalQuestion(p, s),
        context: `Dispatch learning: ${p.evidence}.\n\nAccepting changes the dispatch table in Systems → Dispatch; locked rows and rules are never touched.`,
        options: PROPOSAL_OPTIONS,
        recommendation: PROPOSAL_OPTIONS[0],
        source: 'system',
        action: { kind: 'dispatch-proposal', proposal: p }
      })
    )
  }
  return opened
}

export const acceptsProposal = (d: Pick<Decision, 'options'>, answer: string): boolean =>
  answer.trim() === (d.options[0] ?? PROPOSAL_OPTIONS[0]) || /^(apply|yes|ok|okay|accept|do it|sure|approved?)\b/i.test(answer.trim())

/** The settings patch a proposal makes; undefined when its target is gone or locked. */
export function applyProposal(s: Pick<Settings, 'categoryPools' | 'dispatchRules'>, p: DispatchProposal): Partial<Settings> | undefined {
  const same = (c: { harness: string; model?: string }): boolean => candidateKey(c) === candidateKey(p.candidate)
  if (p.op === 'rule-drop-candidate') {
    const rule = s.dispatchRules.find((r) => r.id === p.ruleId)
    if (!rule || rule.locked || !rule.candidates.some(same) || rule.candidates.length < 2) return undefined
    return { dispatchRules: s.dispatchRules.map((r) => (r.id === rule.id ? { ...r, candidates: r.candidates.filter((c) => !same(c)) } : r)) }
  }
  const pool = s.categoryPools.find((x) => x.category === p.category)
  if (!pool || pool.locked) return undefined
  if (p.op === 'pool-add') {
    if (pool.candidates.some(same)) return undefined
    return { categoryPools: s.categoryPools.map((x) => (x === pool ? { ...x, candidates: [p.candidate, ...x.candidates] } : x)) }
  }
  if (!pool.candidates.some(same) || pool.candidates.length < 2) return undefined
  return { categoryPools: s.categoryPools.map((x) => (x === pool ? { ...x, candidates: x.candidates.filter((c) => !same(c)) } : x)) }
}

