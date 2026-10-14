import type { Engine, Project } from './types'

/** The engine Genio works with and where it lives, as a repository-relative POSIX path ('' = the repository root). */
export interface EffectiveEngine { engine: Engine; root: string }

/**
 * The single source of truth for a project's engine. Detection writes `engine`/`engineRoot`
 * (register, window open, startup, Sync); Play, the renderer Play gate, units, the test gate,
 * asset placement and Inventory read them through this and never re-detect on their own.
 */
export function effectiveEngine(p: Pick<Project, 'engine' | 'engineRoot'>): EffectiveEngine {
  return { engine: p.engine ?? 'other', root: engineRootOf(p.engineRoot) }
}

/** `Game\`, `./Game/` and `Game` are one root. A root that escapes the project (hand-edited registry) reads as the repository root. */
function engineRootOf(stored: string | undefined): string {
  const root = (stored ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (root === '.' || root.startsWith('/') || /^[A-Za-z]:/.test(root) || /[\x00-\x1f]/.test(root) || root.split('/').includes('..')) return ''
  return root
}


export const ENGINE_LABEL: Record<Engine, string> = {
  godot: 'Godot',
  unity: 'Unity',
  unreal: 'Unreal',
  bevy: 'Bevy',
  web: 'Web',
  love2d: 'LÖVE',
  gamemaker: 'GameMaker',
  defold: 'Defold',
  monogame: 'MonoGame',
  other: 'Other'
}

/** One line for toasts, notices and briefs: `Unity 6000.0.23f1 at ./FoundersOfAvalonUnity`, `Godot at the repository root`, `no game engine`. */
export function engineSummary(engine: Engine, root = '', version?: string): string {
  if (engine === 'other') return 'no game engine'
  return `${ENGINE_LABEL[engine]}${version ? ` ${version}` : ''} at ${root ? `./${root}` : 'the repository root'}`
}

/** What the player sees of detection: the engine Genio uses, where it came from and what else the scan found. */
export interface DetectedView {
  engine: Engine
  /** `Unity 6000.0.23f1 at ./FoundersOfAvalonUnity`; `no game engine` without one. */
  summary: string
  /** The root comes from the repository's `.genio/project.json`. */
  declared: boolean
  /** The top two candidates tied, so the alphabetical order picked. */
  ambiguous: boolean
  /** Every other candidate, named: `Unity at ./tools/LevelEditor`. */
  others: string[]
  /** Why the repository's declaration was ignored. */
  warning?: string
  scannedAt?: string
}

export function detectedView(p: Pick<Project, 'engine' | 'engineRoot' | 'detected'>): DetectedView {
  const { engine, root } = effectiveEngine(p)
  const d = p.detected
  const others = [...new Set((d?.candidates ?? []).filter((c) => c.engine !== engine || c.root !== root).map((c) => engineSummary(c.engine, c.root)))]
  return {
    engine,
    summary: engineSummary(engine, root, engine === 'other' ? undefined : d?.version),
    declared: !!d?.declared,
    ambiguous: !!d?.ambiguous,
    others,
    ...(d?.warning ? { warning: d.warning } : {}),
    ...(d?.scannedAt ? { scannedAt: d.scannedAt } : {})
  }
}

/** The proposal left by retiring a manual engine: what the player had set, what Genio uses now, and how to keep theirs. */
export function proposalLine(p: Pick<Project, 'engine' | 'engineRoot' | 'detected' | 'engineProposal'>): string | undefined {
  const x = p.engineProposal
  if (!x) return undefined
  const keep = x.declarable ? ` To keep yours, ask Genio to pin it in .genio/project.json { "engineRoot": "${x.engineRoot}" }; Genio never writes it into the repository on its own.` : ''
  return `You had set ${engineSummary(x.engine, x.engineRoot)} by hand; Genio now infers the engine and uses ${detectedView(p).summary}.${keep}`
}

/** The one-liner for the registration notice and the Hub. */
export function detectedLine(v: DetectedView): string {
  if (v.engine === 'other') return 'No game engine detected; Genio treats this as a code project'
  return `${v.summary}${v.declared ? ' (set in .genio/project.json)' : ''}`
}