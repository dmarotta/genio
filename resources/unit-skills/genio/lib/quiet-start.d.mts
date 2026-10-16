export const QUIET_CAP_MS: number
export const QUIET_POLL_MS: number
export interface PlayStart { key: string; version: 1; pid: number; project?: string; phase?: string; since: number }
export interface QuietWait { waitedMs: number; deferred: boolean; resumed: 'quiet' | 'cap' | 'aborted' }
export interface QuietWaitOptions {
  capMs?: number; pollMs?: number; signal?: AbortSignal
  now?: () => number; sleep?: (ms: number) => Promise<unknown>; isAlive?: (pid: number) => boolean
  onWait?: (starts: PlayStart[]) => void
}
export function quietDir(data: string): string
export function markPlayStarting(data: string, key: string, options?: { project?: string; phase?: string; since?: number; pid?: number }): void
export function clearPlayStarting(data: string, key: string): void
export function playStarts(data: string, options?: { now?: number; capMs?: number; isAlive?: (pid: number) => boolean }): PlayStart[]
export function waitForQuiet(data: string, options?: QuietWaitOptions): Promise<QuietWait>
