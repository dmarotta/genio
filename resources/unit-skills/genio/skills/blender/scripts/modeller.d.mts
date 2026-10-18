export const STEP_SCRIPT: string
export const WARM_SCRIPT: string
export const SCHEMA: 'genio.modeller.v1'
export const KEEP_SNAPSHOTS: number
export const STEP_TIMEOUT: number
export const PUBLISH_GAP_MS: number
/** An agent_ms past this is a gap (a respawn, a wait for the player), left out of the report's sums. */
export const AGENT_GAP_MS: number
/** The folder of lib templates per model kind (`<kind>.py`). */
export const TEMPLATES: string
export type ModelKind = 'vehicle' | 'building' | 'prop' | 'weapon' | 'character'
/** The model kinds `init --kind` knows, each with its default symmetry axis. */
export const KINDS: Record<ModelKind, { symmetry?: 'x' | 'y' }>

export interface PinnedBlender { path: string; version: string; size: number; mtimeMs: number }
/** A run's measures, in its receipt (and a failure's manifest entry). */
export interface RunMeasures {
  /** The agent's time since the kernel returned the run before (or init); 0 for a batch's later steps, null without a mark. */
  agent_ms: number | null; agent_gap?: boolean
  script_bytes: number; lib_bytes: number; lib_changed: boolean; amend: boolean
  /** The run before had the same step name: its id, and its failure kind when it failed. */
  rerun_of: { id: string; failed?: string } | null
}
export interface StepFiles { script: string; lib?: string | null; blend: string | null; glb: string | null; sheet: string | null; view: string | null; receipt: string }
export interface StepEntry {
  id: string; n: number; parent: string | null; branch: string; name: string; caption: string; t: string; ms: number
  triangles: number; vertices: number; objects: number; warnings: number; blend_sha256: string | null; files: StepFiles
  keep?: boolean; superseded_by?: string
}
export interface Manifest {
  schema: 'genio.modeller.v1'; model: string; created: string; updated: string; blender: PinnedBlender
  target: 'unity' | 'godot' | 'web' | null; checks: { budget: number | null; size: number[] | null; symmetry?: 'x' | 'y' | null }
  branch: string; branches: Record<string, { head: string | null; from: string | null }>; next: number
  steps: StepEntry[]; failures: ({ id: string; name: string; kind: string; parent: string | null; branch: string; t: string; ms?: number; error: string; dir: string } & Partial<RunMeasures>)[]
  history: Record<string, unknown>[]
  /** When the kernel last returned a run (or init): the next run's agent_ms starts here. */
  returned_at?: string
  last_run?: { id: string; name: string; failed?: string }
}
interface Spread { n: number; median: number | null; p90: number | null; sum: number }
/** `report <model>`: a model's run summed up, for recons and benchmarks. */
export interface Report {
  ok: true; model: string; blender: string; branch: string; head: string | null
  wall_s: number | null; first_step_s: number | null; steps: number; runs: number; amends: number; reruns: number
  failures: Record<string, number>; killed: number
  agent_ms: Spread; agent_gaps: number; blender_ms: Spread
  blender_phases_ms: Record<string, number>; checks_ms: Record<string, number>
  script_kb: number; lib_kb: number; lib_changes: number; triangles: number; budget: number | null
  review: { new: Record<string, number>; known: Record<string, number> }; open_review: string[]
  timeline: { id: string; name: string; outcome: string; agent_ms: number | null; ms: number | null; script_bytes: number; triangles: number | null }[]
}
export interface Summary {
  ok: true; model: string; dir: string; blender: string; target: string | null; checks: Manifest['checks']
  branch: string; head: string | null
  steps: { id: string; name: string; caption: string; triangles: number; warnings: number; snapshot: boolean }[]
  branches: Record<string, { head: string | null; from: string | null }>
  failures: { id: string; kind: string; error: string }[]
}
export interface Runner { prefix?: string[] }
export interface StepDone {
  ok: true; model: string; id: string; n: number; name: string; caption: string; branch: string; parent: string | null
  triangles: number; vertices: number; objects: number; bounds: { min: number[]; max: number[]; dimensions: number[] } | null
  /**
   * The text review, a few short lines: what changed since the parent step, then only the lines that
   * have something to say (Plan, Floating, Deep overlap, Z-fighting, Symmetry, Size, Triangles, Materials,
   * Bake). An item the parent step printed is a count (`2 known`) while it stands; the receipt's
   * `review_full` names every item.
   */
  review: string[]
  /** Warnings new since the parent step; `known_warnings` counts the unchanged rest, all in the receipt. */
  warnings: string[]; known_warnings: number
  sheet: string | null; glb: string | null; blend: string | null; receipt: string; ms: number; pruned: string[]
  /** The lib.py this step ran first (a copy of the one next to its script), or null. */
  lib: string | null
  /** What p.bake_maps did in this step, when it baked. */
  bakes?: Bake[]
  /** With the player's references (GENIO_REFERENCES): their image files; the review's last line names every reference. */
  references?: string[]
}
export interface Bake {
  parts: number; materials: number; size: number; samples: number; device: string; threads: number; bakes: number
  bake_s: Record<string, number>; total_s: number; files: Record<string, string>; material: string | null
}
export interface StepFailed {
  ok: false; kind: 'error' | 'crash' | 'hang' | 'replay'; model: string; id: string; name: string; branch: string; head: string | null
  error: string; trace: string[]; output: string; message: string; log: string; script: string
  recovered: { head: string | null; snapshot: string | null; intact?: boolean }
}
export interface BatchScript { script: string; name?: string }
export interface BatchDone {
  ok: boolean; model: string; branch: string; head: string | null
  steps: { id: string; n: number; name: string; caption: string; triangles: number; objects: number; review: string[]; warnings: string[]; known_warnings: number; glb: string | null; sheet: string | null; ms: number }[]
  sheet: string | null; receipt: string | null; warnings: string[]; known_warnings: number
  failure: StepFailed | null; not_run: { name: string; script: string }[]; message: string
  /** With the player's references: their image files (each step's review names them). */
  references?: string[]
}
interface Common { dataDir?: string; model: string }

export function modellerDataDir(env?: Record<string, string | undefined>): string
export function stepName(script: string): string
export function line(m: Manifest, branch?: string): StepEntry[]
export function chooseBlender(choice?: string | { path: string; version: string }, env?: Record<string, string | undefined>, fresh?: boolean): PinnedBlender
/** The bytecode cache's marker for this exact binary, or null when the cache is off for it or it is not Blender. */
export function warmMarker(pin: { path: string; size: number; mtimeMs: number }): string | null
/** Fill the bytecode cache for the model's pinned Blender (init starts this in the background). */
export function warm(o: Common & { timeout?: number; runner?: Runner; marker?: string }): Promise<{ ok: boolean; model: string; blender: string; warmed: boolean; ms?: number; log?: string }>
export function prune(m: Manifest, dir: string, keep?: number): string[]
export function planThreads(plan: { replay: (string | { script: string; lib?: string | null })[]; steps: { script: string | null; lib?: string | null }[] }, threads?: number): number | undefined
/**
 * Start (or update) a model. With `kind`, the kind's template becomes `<cwd>/.genio/modeller/<model>/lib.py` unless a lib is
 * there already (`template.written`), and a new model takes the kind's symmetry when `symmetry` is not given.
 */
export function init(o: Common & { blender?: string | { path: string; version: string }; target?: string; budget?: number | string; size?: string | number[]; symmetry?: 'x' | 'y' | 'none'; kind?: ModelKind; repin?: boolean; cwd?: string; env?: Record<string, string | undefined> }): Promise<Summary & { existing: boolean; template?: { kind: ModelKind; lib: string; written: boolean } }>
/** The player's references folder (default GENIO_REFERENCES): a review line naming them and their image files, or null without any. */
export function referenceReview(refDir?: string): { line: string; images: string[] } | null
export function step(o: Common & { script: string; name?: string; amend?: boolean; timeout?: number; threads?: number; runner?: Runner; references?: string }): Promise<StepDone | StepFailed>
export function batchScripts(args: string | string[]): BatchScript[]
export function batch(o: Common & { scripts: string | (string | BatchScript)[]; everySheet?: boolean; timeout?: number; threads?: number; runner?: Runner; gapMs?: number; references?: string }): Promise<BatchDone>
/**
 * The step's .blend, rebuilt by replay when pruned. `review` and `warnings`: the step's check of every pair (run here once
 * when its own checks were incremental); absent for a receipt without pair results.
 */
export function materialize(o: Common & { step?: string; timeout?: number; threads?: number; runner?: Runner }): Promise<{ ok: true; id: string; blend: string; replayed: number; review?: string[]; warnings?: string[] }>
export function revert(o: Common & { to: string | number }): Promise<Summary & { reverted: string | null }>
export function branch(o: Common & { name: string; from?: string }): Promise<Summary>
export function switchBranch(o: Common & { name: string }): Promise<Summary>
export function keep(o: Common & { step: string; on?: boolean }): Promise<Summary>
export function status(o: Common): Promise<Summary>
export function report(o: Common): Promise<Report>
