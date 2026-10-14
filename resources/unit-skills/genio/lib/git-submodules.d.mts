export interface DeclaredSubmodule { name: string; path: string; url?: string }
export interface SubmoduleEntry {
  /** Forward-slash path from the checkout's top, nested submodules included. */
  path: string; name: string; commit: string
  action?: 'cloned' | 'updated' | 'reattached' | 'reset' | 'current' | 'failed' | 'skipped'
  reason?: string
  lfs?: { objects: number; copied: number }
}
export interface SubmoduleReport { submodules: SubmoduleEntry[]; problems: string[]; ok: boolean; elapsedMs: number }
export interface SubmoduleOptions {
  /** The checkout whose submodule git dirs hold the objects: the player's checkout or one of its worktrees. */
  source?: string
  /** Genio-owned slots only: reset changed or dirtied submodules. */
  force?: boolean
  hooksPath?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}
export function noHooksPath(dir: string): string
export function declaredSubmodules(top: string): DeclaredSubmodule[]
export function missingSubmodules(projectRoot: string): string[]
export function initSubmodules(dir: string, options?: SubmoduleOptions): Promise<SubmoduleReport>
