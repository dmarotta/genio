/** The Modeller's live view: what main reads from a unit's step data for the canvas and its status line. */
export interface ModellerStep {
  id: string
  n: number
  /** The step script's docstring, first line: "Raising four timber legs on stone footings". */
  caption: string
  triangles: number
  /** Objects in the step's scene. */
  parts: number
  warnings: number
  ms: number
  /** The step's GLB through the unit's viewer grant, or null when it has none. */
  glb: string | null
  /** The step's 3/4 review render (512 px PNG) through the same grant, or null. */
  view: string | null
}
export interface ModellerLive {
  model: string
  branch: string
  /** Every branch of the model, the current one included. */
  branches: string[]
  /** The current branch from its first step to its head. */
  steps: ModellerStep[]
  /** The head step's advisory checks (budget, ground, piercing parts…): information, never a gate. */
  checks: string[]
  /** A step Blender is running now. */
  running: { id: string; n: number; caption: string; startedAt: number } | null
  /** The last attempt on this branch failed; the model stays at its head. */
  failure: { id: string; n: number; caption: string; kind: string; error: string } | null
  /** Changes whenever anything above does. */
  stamp: string
}

/** What the player does to a model from the unit page; main runs it through the kernel and tells the unit. */
export type ModellerAct =
  | { op: 'revert'; model: string; step: string }
  | { op: 'branch'; model: string; step: string }
  | { op: 'switch'; model: string; branch: string }
  | { op: 'accept'; model: string; step: string }

/** Before and after of one binary file a unit changed (Changes tab). */
export interface UnitFilePreview {
  kind: 'image' | 'model' | 'other'
  /** Image URLs (data: or genio-media:); absent when there is no such side or it cannot be shown. */
  before?: string
  after?: string
  /** Bytes at the base and in the worktree; absent when the file is new or was removed. */
  beforeBytes?: number
  afterBytes?: number
  /** A model's triangles and parts after, from the Modeller's head step. */
  triangles?: number
  parts?: number
}
