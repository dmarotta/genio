export interface InstalledBlender { path: string; version: number[] }
export function findBlender(): string | null
export function blenderVersion(p: string): number[] | null
export function listBlenders(): InstalledBlender[]
export function pickModellerBlender(found: InstalledBlender[]): InstalledBlender | null
