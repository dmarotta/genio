export interface LivePlay { key: string; version: 1; pid: number; project?: string; since: number }
export interface LiveOptions { isAlive?: (pid: number) => boolean; set?: (pid: number, priority: number) => void }
export const PRIORITY: { aboveNormal: number; normal: number; belowNormal: number }
export function liveDir(data: string): string
export function markPlayLive(data: string, key: string, options?: { project?: string; since?: number; pid?: number }): void
export function clearPlayLive(data: string, key: string): void
export function livePlays(data: string | undefined, options?: LiveOptions): LivePlay[]
export function playIsLive(data: string | undefined, options?: LiveOptions): boolean
export function setProcessPriority(pid: number | undefined, priority: number, options?: LiveOptions): boolean
export function lowWhileLive<A extends unknown[], R>(data: string | undefined, run: (...args: A) => R, options?: LiveOptions): (...args: A) => R
