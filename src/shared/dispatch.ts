/**
 * Dispatch data shared by main and renderer: the fixed category list, the
 * player's category rows (Settings → Advanced → Model routing (Dispatch)),
 * the cheap OpenRouter models and the scorecard shapes. The scorecard is
 * history and proposals only: it never picks a model.
 */
import type { CategoryPool, PoolCandidate, TaskCategory, Verdict } from './types'

export const QUOTA_EVIDENCE_TTL = 10 * 60_000

export const CATEGORIES: { id: TaskCategory; label: string; hint: string }[] = [
  { id: 'recon-design', label: 'Recon / design', hint: 'investigate, plan, architect' },
  { id: 'feature', label: 'Feature (multi-file)', hint: 'new mechanics and systems' },
  { id: 'bugfix', label: 'Bugfix / debug', hint: 'broken behaviour, crashes, desyncs' },
  { id: 'refactor', label: 'Refactor / migration', hint: 'restructure, port, upgrade' },
  { id: 'graphics', label: 'Shaders / graphics / perf', hint: 'rendering, VFX, frame time' },
  { id: 'ui', label: 'UI', hint: 'menus, HUD, layouts' },
  { id: 'review', label: 'Review', hint: 'code review, audits' },
  { id: 'tests', label: 'Tests', hint: 'unit, integration and e2e tests' },
  { id: 'chore', label: 'Small fix / chore', hint: 'typos, renames, bumps, tweaks' },
  { id: 'build-ci', label: 'Build / CI / scripts / tools', hint: 'pipelines, export, tooling' },
  { id: 'docs', label: 'Docs', hint: 'READMEs, guides, comments' },
  { id: 'art', label: 'Art / asset generation', hint: 'sprites, textures, audio, models' },
  { id: 'large-context', label: 'Large-context read', hint: 'whole-codebase reading and summaries' }
]

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as [TaskCategory, ...TaskCategory[]]

export const categoryLabel = (id?: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id ?? 'uncategorised'

export const isCategory = (v: unknown): v is TaskCategory => typeof v === 'string' && CATEGORIES.some((c) => c.id === v)

/** Low-stakes categories where cheap third-party models may be candidates. */
export const LOW_STAKES: TaskCategory[] = ['tests', 'chore', 'docs', 'build-ci']

/**
 * Cheap coding models on OpenRouter, run through OpenCode (`openrouter/<id>`).
 * Ids checked against https://openrouter.ai/api/v1/models on 2026-10-13.
 */
export const CHEAP_MODELS: { model: string; label: string }[] = [
  { model: 'openrouter/deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
  { model: 'openrouter/qwen/qwen3.8-flash', label: 'Qwen 3.8 Flash' },
  { model: 'openrouter/z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' }
]

/**
 * The player's category rows, one per category at most, each with at least
 * one candidate. A category without a row uses the default model. Rows saved
 * before the default existed migrate in settings.ts (only the locked ones were
 * the player's own choice).
 */
export function normalizeCategoryPools(saved: unknown): CategoryPool[] {
  if (!Array.isArray(saved)) return []
  const out: CategoryPool[] = []
  for (const p of saved as Partial<CategoryPool>[]) {
    if (!p || !isCategory(p.category) || !Array.isArray(p.candidates) || !p.candidates.length || out.some((x) => x.category === p.category)) continue
    out.push({ category: p.category, candidates: p.candidates.filter((c): c is PoolCandidate => Boolean(c?.harness)) })
  }
  return out.filter((p) => p.candidates.length)
}

/** Plan usage at or above this share of a 5-hour or weekly window holds new units on that plan. */
export const QUOTA_HOT_PERCENT = 85

/** Scorecard thresholds (documented in Settings → Advanced → Model routing (Dispatch)). */
export const LEARNING = {
  /** recency half-life of an outcome, in days */
  halfLifeDays: 30,
  /** a candidate needs this many outcomes before it counts as proven */
  minSamples: 5,
  /** a candidate this bad over this many outcomes is proposed for removal */
  removeBelow: 0.35,
  removeMinSamples: 8,
  /** an outside tool beating a pool's first candidate by this much is proposed for the pool */
  addMargin: 0.2
}

/** One outcome on the scorecard (data/dispatch/scorecard.json). */
export interface OutcomeRecord {
  v: 1
  taskId: string
  title: string
  kind: 'ship' | 'scout'
  category: TaskCategory
  /** the task had no category: `category` is the kind's default, not evidence of the work */
  categoryGuessed?: boolean
  world: string
  harness: string
  model?: string
  effort?: string
  source?: string
  ruleId?: string
  /** history: an older version picked this tool by exploration */
  explored?: boolean
  outcome: 'landed' | 'despawned' | 'failed'
  landed: boolean
  pings: number
  relaunches: number
  lagging: number
  stopped: number
  /** Gauntlet fix rounds (Hardcore Builds only) */
  fixRounds?: number
  wallMinutes: number
  /** the unit tool's plan window usage at deploy and at the end (percent), when the tool reports it */
  planUsage?: { start?: number; end?: number }
  costUsd?: number
  verdict?: Verdict
  note?: string
  /** liked Genio messages that covered this unit: a small positive, below a verdict */
  likes?: number
  endedAt: string
}

/** Recency-weighted score for one (scope, harness, model); scope is a category or `rule:<id>`. */
export interface ScoreRow {
  scope: string
  harness: string
  model?: string
  /** 0-1 */
  score: number
  samples: number
  landed: number
  /** sum of recency weights */
  weight: number
}

export interface LearningEvent {
  ts: string
  kind: 'reorder' | 'proposal' | 'applied'
  text: string
}

/** Settings → Advanced → Model routing (Dispatch): scores, recent outcomes and what the learning loop did. */
export interface DispatchScoresView {
  rows: ScoreRow[]
  recent: OutcomeRecord[]
  log: LearningEvent[]
}

export const candidateKey = (c: { harness: string; model?: string }): string => `${c.harness}/${c.model || 'default'}`

/** Cheap third-party models are on in every world unless it opts out (allowCheapModels: false). */
export function cheapModelsAllowed(p: { allowCheapModels?: boolean } | undefined): boolean {
  return p?.allowCheapModels !== false
}
