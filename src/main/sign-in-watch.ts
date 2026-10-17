/**
 * The one sign-in warning: which of Claude and Codex needs a sign-in (never FAL,
 * Uthana, GitHub, Unity or any other). Read from the same account rows the
 * Accounts screen shows, at start, every few minutes, when a login or logout
 * ends and whenever Accounts is read; published only when the list changes.
 * It clears itself as soon as the sign-in works.
 */
import { signInNeeds, type AccountStatus } from '@shared/api'
import { bus } from './bus'
import { listSignInAccounts } from './accounts'

const EVERY_MS = 10 * 60_000

let needs: string[] = []
let timer: ReturnType<typeof setInterval> | undefined

export const currentSignInNeeds = (): string[] => needs

/** Take the latest account rows; tells the windows only when the list changed. */
export function noteSignInAccounts(list: AccountStatus[]): void {
  const next: string[] = signInNeeds(list)
  if (next.join() === needs.join()) return
  needs = next
  bus.publish({ type: 'sign-in-needed', tools: next })
}

/** Read Claude's and Codex's sign-in now. A failed read keeps the last answer. */
export async function refreshSignInNeeds(): Promise<void> {
  try {
    noteSignInAccounts(await listSignInAccounts())
  } catch {
    /* the warning is advisory */
  }
}

export function startSignInWatch(everyMs = EVERY_MS): void {
  stopSignInWatch()
  void refreshSignInNeeds()
  timer = setInterval(() => void refreshSignInNeeds(), everyMs)
  timer.unref?.()
}

export function stopSignInWatch(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  needs = []
}
