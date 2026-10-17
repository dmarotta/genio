export interface PoolLease { id: number; token: string; root: string }
export interface PoolProcess { pid: number; ppid: number; created: string; command: string }
export interface PoolSystem { list(): Promise<PoolProcess[]>; terminate(pid: number): Promise<void>; kill(pid: number): Promise<void> }
export interface PoolOptions { graceMs?: number; forceMs?: number; system?: Partial<PoolSystem>; clone?: import('./clone.mjs').CloneOptions; desktop?: import('../../../lib/hidden-desktop.mjs').DesktopApi; spawnVisible?: import('../../../lib/hidden-desktop.mjs').SpawnVisible; quiet?: () => Promise<import('../../../lib/quiet-start.mjs').QuietWait>; platform?: string }
/** closed: the editor and its children are gone. kept: release left it running. Otherwise the slot is stuck. */
export interface CloseResult { closed: boolean; kept?: boolean; forced?: boolean; pids: number[]; reason?: string }
/** inUse counts slots within the cap; draining lists slots above it that are still in use. */
export interface PoolWait { position: number; length: number; estimateMs: number | null; cap: number; inUse: number; draining: number[]; holders: { slot: number; owner: string }[]; stuck: { slot: number; reason: string; pids: number[] }[] }
export class PlayPool {
  constructor(data: string, world: string, engineRoot?: string, options?: PoolOptions)
  dir: string
  root(id: number): string
  slots(): string
  slotDir(id: number): string
  place(): Promise<string>
  relocate(): Promise<string>
  state(): Promise<import('../../../../../../src/shared/play').PlayPoolState>
  configure(cap: number): Promise<{ cap: number; draining: number[] }>
  acquire(owner: string, pid?: number, preferred?: number, takeover?: boolean): Promise<PoolLease | null>
  waitInfo(owner: string, pid?: number): Promise<PoolWait>
  check(id: number, token: string): Promise<string>
  recordEditor(id: number, token: string, pid: number, launch?: Partial<import('../../../lib/hidden-desktop.mjs').EditorLaunch>): Promise<void>
  /** Starts the slot editor (hidden desktop unless configured visible or unavailable) and records it. */
  launchEditor(id: number, token: string, executable: string, options?: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<import('../../../lib/hidden-desktop.mjs').EditorLaunch>
  /** Dialog watcher pass for the lease holder; throws (and ends the lease) when a dialog blocks the editor. */
  watchEditor(id: number, token: string, options?: { now?: number; graceMs?: number }): Promise<import('../../../lib/hidden-desktop.mjs').InspectResult & { error?: string }>
  /** Resolves once the slot editor's own Pipeline endpoint answers /api/status "ready"; throws naming the cause after timeoutMs. */
  waitReady(id: number, token: string, options?: { timeoutMs?: number; intervalMs?: number; reportMs?: number; onProgress?: (p: { elapsedSeconds: number; message: string }) => void }): Promise<{ port: number; pid: number; waitedMs: number }>
  probePipeline(root: string, known?: number[]): Promise<{ ready?: boolean; port?: number; pid?: number; cause?: string }>
  configureLaunch(visible: boolean): Promise<{ launch: 'hidden' | 'visible' }>
  release(id: number, token: string, options?: { keepEditor?: boolean }): Promise<CloseResult | undefined>
  closeSlot(id: number, options?: { force?: boolean }): Promise<CloseResult>
  closeOwned(owner: string): Promise<(CloseResult & { slot: number })[]>
  settle(): Promise<void>
  editorAlive(id: number): boolean
  cancel(owner: string, pid?: number): Promise<void>
  mainControl(): Promise<void>
  releaseMain(): Promise<void>
  prepare(id: number, token: string, source?: string): Promise<string>
  estimate(): Promise<number>
  disk(): Promise<Record<number, number>>
  validateCopy(id: number): Promise<void>
}
export const READY_MS: number
export function poolDirectory(data: string, world: string): string
export function stuckMessage(id: number, result: { reason?: string; pids?: number[] }): string
export function mentionsRoot(command: string, root: string): boolean
export function listProcesses(): Promise<PoolProcess[]>
