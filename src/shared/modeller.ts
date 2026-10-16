/** The Modeller's live view: what main reads from a unit's step data for the canvas and its status line. */
export interface ModellerStep {
  id: string
  n: number
  /** The step script's docstring, first line: "Raising four timber legs on stone footings". */
  caption: string
  triangles: number
  warnings: number
  ms: number
  /** The step's GLB through the unit's viewer grant, or null when it has none. */
  glb: string | null
}
export interface ModellerLive {
  model: string
  branch: string
  /** The current branch from its first step to its head. */
  steps: ModellerStep[]
  /** A step Blender is running now. */
  running: { id: string; n: number; caption: string; startedAt: number } | null
  /** The last attempt on this branch failed; the model stays at its head. */
  failure: { id: string; n: number; caption: string; kind: string; error: string } | null
  /** Changes whenever anything above does. */
  stamp: string
}
