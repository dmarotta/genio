import type { CloneSystem } from '../skills/play/scripts/clone.mjs'
import type { QuietWait } from './quiet-start.mjs'
export const DEPS_RULE: string
export const LOCKFILES: string[]
export const PACKAGE_MANAGERS: string[]
export interface DepsContext { worktree?: string; main?: string; state?: string }
export interface LinkFinding { path: string; target?: string; reason: string }
export interface LinkRemoval { removed: boolean; path: string; reason?: string; target?: string; targetIntact?: boolean }
export interface InstallCheck { ok: boolean; root: string; missing: string[]; skipped?: string; linked?: string }
export interface WorktreeLink { worktree: string; project: string; unit: string; path: string; target?: string }
export type DepsState = 'installing' | 'ready' | 'failed' | 'skipped'
export interface DepsReport { state: DepsState; method?: string; reason?: string; from?: string; repaired?: string; copyFailure?: string; elapsedMs: number; deferredMs?: number }
export interface SetupOptions {
  platform?: string
  run?: (file: string, args: string[], options: { windowsHide: boolean; maxBuffer: number }) => Promise<unknown>
  data?: string
  system?: Partial<CloneSystem>
  copy?: (source: string, dest: string, options: SetupOptions) => Promise<{ method: string }>
  install?: (dir: string, options?: { data?: string }) => Promise<{ code: number; output?: string }>
  progress?: (r: { state: 'installing'; method: string; waiting?: string }) => void
  /** Quiet start: waited on before the copy or npm ci; onWait runs when a Play start makes it wait. */
  quiet?: (onWait?: () => void) => Promise<QuietWait>
}
export function within(p: string, root: string): boolean
export function isLink(p: string): boolean
export function linkTarget(p: string): string | undefined
export function removeLinkSafely(p: string): LinkRemoval
export function linkedNodeModules(cwd: string, context?: { worktree?: string; main?: string }): LinkFinding | undefined
export function packageCommand(tool: string, args: string[], cwd?: string): { tool: string; sub?: string; dir: string; mutating: boolean }
export function npmGuardReason(tool: string, args: string[], context?: DepsContext & { cwd?: string }): string | undefined
export function depsToolReason(input: unknown, context?: DepsContext): string | undefined
export function lockHash(root: string): { file: string; hash: string } | undefined
export function checkInstall(root: string, options?: { packages?: string[]; dev?: boolean; bin?: boolean; electron?: boolean }): InstallCheck
export function worktreeLinks(roots: string[]): WorktreeLink[]
export const GENIO_CRITICAL: string[]
export interface GenioInstallReport extends InstallCheck { linked: WorktreeLink[]; command: string; message: string }
export function genioWorktreeRoots(homeRoot: string): string[]
export function genioInstallReport(appRoot: string, homeRoot?: string): GenioInstallReport
export function copyNodeModules(source: string, dest: string, options?: SetupOptions): Promise<{ method: string; reason?: string }>
export function npmCi(dir: string, options?: { timeoutMs?: number; data?: string }): Promise<{ code: number; output: string }>
export function setupNodeModules(worktree: string, main: string, options?: SetupOptions): Promise<DepsReport>
