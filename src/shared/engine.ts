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