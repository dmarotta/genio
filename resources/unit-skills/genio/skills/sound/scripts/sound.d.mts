import type { Metrics } from './dsp.mjs'

export const FAL_SCRIPT: string
export const SCHEMA: 'genio.sound.v1'
export const STEP_SCHEMA: 'genio.sound-step.v1'
export const PUBLISH_GAP_MS: number
export const KINDS: string[]
export const DEFAULT_ENDPOINT: string
export const ENDPOINTS: Record<string, { label: string; usd_per_s: number; prompt: string; seconds: string; min: number; max: number }>

export class BudgetStop extends Error {
  code: 'BUDGET'
  gate: Record<string, unknown>
}

type Env = Record<string, string | undefined>
export interface SetTake { file: string; sheet: string; duration_s: number; peak_dbfs: number | null; lufs: number | null; loop: boolean; warnings: number; step: string }
export interface StepEntry {
  id: string; n: number; parent: string | null; branch: string; name: string; caption: string; t: string; ms: number
  takes: Record<string, Omit<SetTake, 'step'>>; dropped: string[]; warnings: number; est_usd: number
  files: { recipe: string; receipt: string }; superseded_by?: string
}
export interface Manifest {
  schema: 'genio.sound.v1'; set: string; created: string; updated: string; kind: string; target: string | null
  budget_usd: number | null; spent_usd: number; branch: string; branches: Record<string, { head: string | null; from: string | null }>; next: number
  steps: StepEntry[]; failures: { id: string; name: string; kind: string; parent: string | null; branch: string; t: string; error: string; dir: string | null; paid?: { take: string; request_id: string; est_usd: number }[] }[]
  history: Record<string, unknown>[]
}
export interface Summary {
  ok: true; set: string; dir: string; kind: string; target: string | null; budget_usd: number | null; spent_usd: number
  branch: string; head: string | null
  steps: { id: string; name: string; caption: string; takes: string[]; dropped: string[]; warnings: number; est_usd: number }[]
  takes: Record<string, SetTake>
  branches: Record<string, { head: string | null; from: string | null }>
  failures: { id: string; kind: string; error: string }[]
}
export interface Lineage { fal: { endpoint: string; request_id: string | null; est_usd: number; units: number; input: Record<string, unknown>; resumed: boolean }[]; files: string[]; takes: string[] }
export interface StepDone {
  ok: true; set: string; id: string; n: number; name: string; caption: string; branch: string; parent: string | null; est_usd: number
  takes: { name: string; file: string; sheet: string; duration_s: number; peak_dbfs: number | null; lufs: number | null; warnings: string[] }[]
  warnings: string[]; receipt: string
}
export interface StepFailed {
  ok: false; kind: 'budget' | 'fal' | 'error'; set: string; id: string; name: string; branch: string; head: string | null
  error: string; message: string; recipe: string; paid: { take: string; request_id: string; est_usd: number }[]
}
export interface Recipe {
  caption?: string; name?: string; drop?: string[]
  takes?: { name: string; source: { fal: { endpoint?: string; input: Record<string, unknown> } } | { take: string } | { file: string }; ops?: Record<string, Record<string, unknown>>[]; loop?: boolean; expect_s?: number }[]
}
export interface Receipt {
  schema: 'genio.sound-step.v1'; ok: true; set: string; id: string; caption: string; est_usd: number; warnings: string[]
  takes: { name: string; file: string; sheet: string; metrics: Metrics; warnings: string[]; notes: string[]; lineage: Lineage; source: 'fal' | 'take' | 'file' }[]
}
export interface BatchDone {
  ok: boolean; set: string; branch: string; head: string | null; steps: StepDone[]; failure: StepFailed | null
  not_run: { name: string; recipe: string | null }[]; est_usd: number; message: string
}
export interface Exported {
  take: string; step: string; path: string; file: string; provenance: string; recipe: string; est_usd: number
  spend: Record<string, unknown>[]; metrics: Metrics; warnings: string[]; sha256: string
}
interface Common { dataDir?: string; set: string }

export function soundDataDir(env?: Env): string
export function stepName(file: string): string
export function line(m: Manifest, branch?: string): StepEntry[]
export function setAt(m: Manifest, id: string): Record<string, SetTake>
export function checkRecipe(raw: unknown, where?: string): { caption: string | null; takes: unknown[]; drop: string[]; name?: string }
export function batchRecipes(args: string | string[]): { file: string; raw: Recipe }[]
export function init(o: Common & { kind?: string; target?: string; budget?: number | string; cwd?: string; world?: string }): Promise<Summary & { existing: boolean }>
export function step(o: Common & { recipe: string | Recipe; name?: string; amend?: boolean; world?: string; budget?: number | string; env?: Env }): Promise<StepDone | StepFailed>
export function batch(o: Common & { recipes: string | string[] | Recipe[]; world?: string; budget?: number | string; env?: Env; gapMs?: number }): Promise<BatchDone>
export function revert(o: Common & { to: string | number }): Promise<Summary & { reverted: string | null }>
export function branch(o: Common & { name: string; from?: string }): Promise<Summary>
export function switchBranch(o: Common & { name: string }): Promise<Summary>
export function status(o: Common): Promise<Summary>
export function budgetInfo(o: Common & { world?: string; budget?: number | string; env?: Env }): Promise<{ ok: true; set: string; grant_usd: number; approval: string; budget_usd: number | null; spent_usd: number; remaining_usd: number; set_spent_usd: number; by: string }>
export function exportSet(o: Common & { world?: string; step?: string; takes?: string[]; to: string | Record<string, string>; bits?: 16 | 24; overwrite?: boolean; env?: Env }): Promise<{ ok: true; set: string; step: string; exported: Exported[]; recipes: string; est_usd: number; message: string }>
