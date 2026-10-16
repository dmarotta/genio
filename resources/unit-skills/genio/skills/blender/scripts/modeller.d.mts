export const STEP_SCRIPT: string
export const SCHEMA: 'genio.modeller.v1'
export const KEEP_SNAPSHOTS: number
export const STEP_TIMEOUT: number

export interface PinnedBlender { path: string; version: string; size: number; mtimeMs: number }
export interface StepFiles { script: string; blend: string | null; glb: string | null; sheet: string | null; view: string | null; receipt: string }
export interface StepEntry {
  id: string; n: number; parent: string | null; branch: string; name: string; caption: string; t: string; ms: number
  triangles: number; vertices: number; objects: number; warnings: number; blend_sha256: string | null; files: StepFiles
  keep?: boolean; superseded_by?: string
}
export interface Manifest {
  schema: 'genio.modeller.v1'; model: string; created: string; updated: string; blender: PinnedBlender
  target: 'unity' | 'godot' | 'web' | null; checks: { budget: number | null; size: number[] | null }
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
  warnings: string[]; sheet: string | null; glb: string | null; blend: string | null; receipt: string; ms: number; pruned: string[]
}
export interface StepFailed {
  ok: false; kind: 'error' | 'crash' | 'hang' | 'replay'; model: string; id: string; name: string; branch: string; head: string | null
  error: string; trace: string[]; output: string; message: string; log: string; script: string
  recovered: { head: string | null; snapshot: string | null; intact?: boolean }
}
interface Common { dataDir?: string; model: string }

export function modellerDataDir(env?: Record<string, string | undefined>): string
export function stepName(script: string): string
export function line(m: Manifest, branch?: string): StepEntry[]
export function chooseBlender(choice?: string | { path: string; version: string }, env?: Record<string, string | undefined>): PinnedBlender
export function prune(m: Manifest, dir: string, keep?: number): string[]
export function init(o: Common & { blender?: string | { path: string; version: string }; target?: string; budget?: number | string; size?: string | number[]; repin?: boolean; cwd?: string; env?: Record<string, string | undefined> }): Promise<Summary & { existing: boolean }>
export function step(o: Common & { script: string; name?: string; amend?: boolean; timeout?: number; threads?: number; runner?: Runner }): Promise<StepDone | StepFailed>
export function materialize(o: Common & { step?: string; timeout?: number; threads?: number; runner?: Runner }): Promise<{ ok: true; id: string; blend: string; replayed: number }>
export function revert(o: Common & { to: string | number }): Promise<Summary & { reverted: string | null }>
export function branch(o: Common & { name: string; from?: string }): Promise<Summary>
export function switchBranch(o: Common & { name: string }): Promise<Summary>
export function keep(o: Common & { step: string; on?: boolean }): Promise<Summary>
export function status(o: Common): Promise<Summary>
