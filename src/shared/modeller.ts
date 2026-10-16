/** The Modeller's live view: what main reads from a unit's step data for the canvas and its status line. */
export interface ModellerStep {
  id: string
  /** Place on the current branch, from 1: "step n of steps.length". The id's number also counts other branches and amends. */
  n: number
  /** The step script's docstring, first line: "Raising four timber legs on stone footings". */
  caption: string
  triangles: number
  /** Objects in the step's scene. */
  parts: number
  warnings: number
  ms: number
  /** When the step reached the live view (epoch ms), 0 when unknown. */
  at: number
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
  /** A step Blender is running now (in a batch, the next one to land); n is the place it will take. */
  running: { id: string; n: number; caption: string; startedAt: number } | null
  /** The last attempt on this branch failed; the model stays at its head. */
  failure: { id: string; n: number; caption: string; kind: string; error: string } | null
  /** The step script the unit is writing or about to run: its newest one under .genio/modeller/<model>/ in the worktree,
   * written after the head step landed and not running yet. `at` is its last write (epoch ms). */
  next: { caption: string; at: number } | null
  /** Changes whenever anything above does. */
  stamp: string
}

/** What the unit is doing, for the live view's text while no step runs: its latest status line and when it started. */
export interface ModellerActivity {
  status: string
  /** The unit's start (epoch ms): the clock before the first step. */
  since: number
}

/** "42 s", "6 min 38 s", "1 h 5 min": the live view's clocks. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min`
}

/**
 * The live view's caption: the running step, a failed attempt, or the head step; with the unit's
 * activity while it works and no step runs. Before the first step that is its latest status line (or
 * the next step's caption once its script exists) and the time since it started; between steps,
 * "working on the next step" (or the next caption) and the time since the head landed.
 */
export function modellerCaption(live: ModellerLive | null, activity: ModellerActivity | null | undefined, now: number):
  { text: string; side: string; clock: string; tone: 'run' | 'warn' | 'idle' } | null {
  const run = live?.running, failed = live?.failure, head = live?.steps.at(-1), next = live?.next
  if (run) return { text: `Step ${run.n} · ${run.caption}…`, side: '', clock: elapsed(now - run.startedAt), tone: 'run' }
  if (failed) return { text: `Step ${failed.n} failed · ${failed.caption}`, side: '', clock: '', tone: 'warn' }
  if (head) {
    const text = `Step ${head.n} · ${head.caption}`
    if (!activity) return { text, side: '', clock: '', tone: 'idle' }
    return { text, side: next ? `next: ${next.caption}` : 'working on the next step', clock: head.at ? elapsed(now - head.at) : '', tone: 'idle' }
  }
  if (!activity) return null
  return { text: next ? `Next: ${next.caption}` : activity.status || 'Working', side: '', clock: elapsed(now - activity.since), tone: 'idle' }
}

/** What the player does to a model from the unit page; main runs it through the kernel and tells the unit. */
export type ModellerAct =
  | { op: 'revert'; model: string; step: string }
  | { op: 'branch'; model: string; step: string }
  | { op: 'switch'; model: string; branch: string }

/** Where a Modeller commits a model's build scripts and manifest: also the path it claims for that model. */
export const modelScriptsDir = (model: string): string => `.genio/modeller/${model}/`

/** A claimed project path, compared case-insensitively with forward slashes; a trailing slash claims a folder. */
export function normalizeClaim(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').toLowerCase()
}

/** Two claims meet when they name the same file or one is a folder holding the other. */
export function claimsMeet(a: string, b: string): boolean {
  const x = normalizeClaim(a), y = normalizeClaim(b)
  if (!x || !y) return false
  const dir = (s: string): string => (s.endsWith('/') ? s : `${s}/`)
  return x === y || dir(x) === dir(y) || x.startsWith(dir(y)) || y.startsWith(dir(x))
}

/** A Modeller or a Generator holds its claims until it lands or is despawned. */
export const holdsClaims = (t: { kind: string; modeller?: boolean; generator?: boolean; state: string }): boolean =>
  t.kind === 'ship' && (!!t.modeller || !!t.generator) && t.state !== 'merged' && t.state !== 'cleaned'

/** Who holds a claim, in words: "Modeller" or "Generator". */
export const claimHolderKind = (t: { modeller?: boolean; generator?: boolean }): string => (t.generator && !t.modeller ? 'Generator' : 'Modeller')

/** A Modeller still at its model shows the 3D view from its start: an empty scene until the first step lands. */
export const modellerCanvas = (t: { kind: string; modeller?: boolean; state: string; landedAt?: string; pr?: { state?: string } }): boolean =>
  !!t.modeller && holdsClaims(t) && !t.landedAt && t.pr?.state !== 'MERGED'

/** The first path in `claims` another Modeller or Generator of the same project already holds, with its holder. */
export function claimConflict<T extends { id: string; project: string; kind: string; modeller?: boolean; generator?: boolean; state: string; claims?: string[] }>(
  claims: string[], project: string, others: T[], self?: string
): { path: string; holder: T } | undefined {
  for (const o of others) {
    if (o.id === self || o.project !== project || !holdsClaims(o)) continue
    for (const c of claims) if ((o.claims ?? []).some(h => claimsMeet(c, h))) return { path: c, holder: o }
  }
  return undefined
}

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
