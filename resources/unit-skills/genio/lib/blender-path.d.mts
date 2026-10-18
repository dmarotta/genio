export interface InstalledBlender { path: string; version: number[] }
export function findBlender(): string | null
export function blenderVersion(p: string): number[] | null
export function blenderCacheDir(env?: Record<string, string | undefined>): string
export const LIST_TTL_MS: number
export function listBlenders(o?: { fresh?: boolean; env?: Record<string, string | undefined> }): InstalledBlender[]
export function pickModellerBlender(found: InstalledBlender[]): InstalledBlender | null
