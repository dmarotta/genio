/**
 * The one sign-in warning: which of Claude and Codex needs a sign-in (never FAL,
 * Uthana, GitHub, Unity or any other). Read from the same account rows the
 * Accounts screen shows, at start, every few minutes, when a login or logout
 * ends and whenever Accounts is read; published only when the list changes.
 * It clears itself as soon as the sign-in works.
 *
 * The same read gives the default model its sign-ins (Claude, else Codex) and
 * the launcher its gate: no project opens while neither is signed in.
 */
import { launchNeedsSignIn, signInNeeds, signInsOf, type AccountStatus } from '@shared/api'
import type { SignIns } from '@shared/unit-model-policy'
import { bus } from './bus'
import { listSignInAccounts } from './accounts'

const EVERY_MS = 10 * 60_000

let needs: string[] = []
let gate = false
let signIns: SignIns = {}
let timer: ReturnType<typeof setInterval> | undefined
let firstRead: Promise<void> | undefined
let reader: (() => Promise<AccountStatus[]>) | undefined

export const currentSignInNeeds = (): string[] => needs

/** Claude's and Codex's sign-in as last read ({} before the first read). */
export const currentSignIns = (): SignIns => signIns

/** True while neither Claude nor Codex is signed in: the launcher opens no project. */
export const currentSignInGate = (): boolean => gate

/** Take the latest account rows; tells the windows only when the list or the gate changed. */
export function noteSignInAccounts(list: AccountStatus[]): void {
  signIns = signInsOf(list)
  const next: string[] = signInNeeds(list)
  const nextGate = launchNeedsSignIn(list)
  if (next.join() === needs.join() && nextGate === gate) return
  needs = next
  gate = nextGate
  bus.publish({ type: 'sign-in-needed', tools: next, gate })
}

/** Read Claude's and Codex's sign-in now. A failed read keeps the last answer. */
export async function refreshSignInNeeds(): Promise<void> {
  try {
    noteSignInAccounts(await (reader ?? listSignInAccounts)())
  } catch {
    /* the warning is advisory */
  }
}

/** The gate once the first read at start has finished, read again when it is closed (a sign-in may just have finished). */
export async function signInGateNow(): Promise<boolean> {
  await firstRead
  if (gate) await refreshSignInNeeds()
  return gate
}

/** The reader replaces the account check (tests never run a real CLI). */
export function startSignInWatch(everyMs = EVERY_MS, read?: () => Promise<AccountStatus[]>): void {
  stopSignInWatch()
  reader = read
  firstRead = refreshSignInNeeds()
  timer = setInterval(() => void refreshSignInNeeds(), everyMs)
  timer.unref?.()
}

export function stopSignInWatch(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  firstRead = undefined
  reader = undefined
  needs = []
  gate = false
  signIns = {}
}
