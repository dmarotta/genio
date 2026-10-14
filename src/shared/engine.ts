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
