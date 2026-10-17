export const STEP_SCRIPT: string
export const SCHEMA: 'genio.modeller.v1'
export const KEEP_SNAPSHOTS: number
export const STEP_TIMEOUT: number
export const PUBLISH_GAP_MS: number

export interface PinnedBlender { path: string; version: string; size: number; mtimeMs: number }
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
  steps: StepEntry[]; failures: { id: string; name: string; kind: string; parent: string | null; branch: string; t: string; error: string; dir: string }[]
  history: Record<string, unknown>[]
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
   * The text review, a few short lines: what changed since the parent step, then only the defect
   * lines that have something to say (Floating, Deep overlap, Z-fighting, Symmetry).
   */
  review: string[]
  /** Warnings new since the parent step; `known_warnings` counts the unchanged rest, all in the receipt. */
  warnings: string[]; known_warnings: number
  sheet: string | null; glb: string | null; blend: string | null; receipt: string; ms: number; pruned: string[]
  /** The lib.py this step ran first (a copy of the one next to its script), or null. */
  lib: string | null
  /** What p.bake_maps did in this step, when it baked. */
  bakes?: Bake[]
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
}
interface Common { dataDir?: string; model: string }

export function modellerDataDir(env?: Record<string, string | undefined>): string
export function stepName(script: string): string
export function line(m: Manifest, branch?: string): StepEntry[]
export function chooseBlender(choice?: string | { path: string; version: string }, env?: Record<string, string | undefined>): PinnedBlender
export function prune(m: Manifest, dir: string, keep?: number): string[]
export function planThreads(plan: { replay: (string | { script: string; lib?: string | null })[]; steps: { script: string | null; lib?: string | null }[] }, threads?: number): number | undefined
export function init(o: Common & { blender?: string | { path: string; version: string }; target?: string; budget?: number | string; size?: string | number[]; symmetry?: 'x' | 'y' | 'none'; repin?: boolean; cwd?: string; env?: Record<string, string | undefined> }): Promise<Summary & { existing: boolean }>
export function step(o: Common & { script: string; name?: string; amend?: boolean; timeout?: number; threads?: number; runner?: Runner }): Promise<StepDone | StepFailed>
export function batchScripts(args: string | string[]): BatchScript[]
export function batch(o: Common & { scripts: string | (string | BatchScript)[]; everySheet?: boolean; timeout?: number; threads?: number; runner?: Runner; gapMs?: number }): Promise<BatchDone>
export function materialize(o: Common & { step?: string; timeout?: number; threads?: number; runner?: Runner }): Promise<{ ok: true; id: string; blend: string; replayed: number }>
export function revert(o: Common & { to: string | number }): Promise<Summary & { reverted: string | null }>
export function branch(o: Common & { name: string; from?: string }): Promise<Summary>
export function switchBranch(o: Common & { name: string }): Promise<Summary>
export function keep(o: Common & { step: string; on?: boolean }): Promise<Summary>
export function status(o: Common): Promise<Summary>
