import type { KeyObject } from 'node:crypto'

export interface GrantEntry { usd: number; at: string; by: 'player'; how: string; decision?: string }
export interface SpendGrant {
  schema: string
  unit: string
  project?: string
  total_usd: number
  grants: GrantEntry[]
  updated: string
  signature?: string
}
export type GrantRead =
  | { ok: true; total_usd: number; grants: GrantEntry[]; approval: string; file: string }
  | { ok: false; reason: string }

export const GRANT_SCHEMA: string
export const GRANT_FILE: string
export const GRANT_FILE_ENV: string
export const GRANT_KEY_ENV: string
export const ASK: string
export function grantTotal(entries: GrantEntry[] | undefined): number
export function signGrant(grant: SpendGrant, privateKey: KeyObject): SpendGrant & { signature: string }
export function publicKeyOf(b64: string): KeyObject
export function verifyGrant(grant: unknown, publicKey: string | KeyObject): boolean
export function grantApproval(grant: Pick<SpendGrant, 'grants'> | undefined): string
export function readGrant(env?: Record<string, string | undefined>): GrantRead
