export interface PoolLease { id: number; token: string; root: string }
export interface PoolProcess { pid: number; ppid: number; created: string; command: string }
export interface PoolSystem { list(): Promise<PoolProcess[]>; terminate(pid: number): Promise<void>; kill(pid: number): Promise<void> }
export interface PoolOptions { graceMs?: number; forceMs?: number; system?: Partial<PoolSystem> }
/** closed: the editor and its children are gone. kept: release left it running. Otherwise the slot is stuck. */
export interface CloseResult { closed: boolean; kept?: boolean; forced?: boolean; pids: number[]; reason?: string }
/** inUse counts slots within the cap; draining lists slots above it that are still in use. */
export interface PoolWait { position: number; length: number; estimateMs: number | null; cap: number; inUse: number; draining: number[]; holders: { slot: number; owner: string }[]; stuck: { slot: number; reason: string; pids: number[] }[] }
export class PlayPool {
  constructor(data: string, world: string, engineRoot?: string, options?: PoolOptions)
  dir: string
  root(id: number): string
  state(): Promise<import('../../../../../../src/shared/play').PlayPoolState>
  configure(cap: number): Promise<{ cap: number; draining: number[] }>
  acquire(owner: string, pid?: number, preferred?: number, takeover?: boolean): Promise<PoolLease | null>
  waitInfo(owner: string, pid?: number): Promise<PoolWait>
  check(id: number, token: string): Promise<string>
  recordEditor(id: number, token: string, pid: number): Promise<void>
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
export function poolDirectory(data: string, world: string): string
export function stuckMessage(id: number, result: { reason?: string; pids?: number[] }): string
export function mentionsRoot(command: string, root: string): boolean
export function listProcesses(): Promise<PoolProcess[]>
