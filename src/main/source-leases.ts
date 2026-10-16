import { sameFolder } from './git'

/**
 * Short leases on Play sources while the player's copy reads them. Genio's unit cleanup (despawn after a merge)
 * asks first: a read in progress gets a few seconds to finish, then is stopped cleanly, and only then is the
 * worktree removed. The wait is bounded, so a cleanup never hangs on Play.
 */
interface Lease { dir: string; abort: () => void; done: Promise<void>; gone: boolean }
export interface SourceLease { readonly gone: boolean; release(): void }
export type YieldResult = 'free' | 'finished' | 'aborted' | 'timeout'

const leases = new Set<Lease>()
const removedListeners = new Set<(dir: string) => void>()

/** Hold a checkout folder while reading it. abort stops the read; gone tells the reader why it stopped. */
export function leaseSource(dir: string, abort: () => void): SourceLease {
  let finish!: () => void
  const lease: Lease = { dir, abort, gone: false, done: new Promise<void>((resolve) => { finish = resolve }) }
  leases.add(lease)
  return {
    get gone() { return lease.gone },
    release() { if (leases.delete(lease)) finish() }
  }
}

/** Reads holding this folder now. */
export function sourceLeases(dir: string): number {
  return [...leases].filter((l) => sameFolder(l.dir, dir)).length
}

const within = (p: Promise<unknown>, ms: number): Promise<boolean> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms)
  void p.then(() => { clearTimeout(timer); resolve(true) })
})

/**
 * Before removing a checkout: wait up to waitMs for its reads to finish, then stop them (marked gone) and wait up
 * to abortMs for them to let go. Never throws and never waits longer than both bounds together.
 */
export async function yieldSource(dir: string, { waitMs = 8000, abortMs = 10000 } = {}): Promise<YieldResult> {
  const held = [...leases].filter((l) => sameFolder(l.dir, dir))
  if (!held.length) return 'free'
  const all = Promise.all(held.map((l) => l.done))
  if (await within(all, waitMs)) return 'finished'
  for (const l of held) {
    l.gone = true
    try { l.abort() } catch { /* the read ends on its own */ }
  }
  return (await within(all, abortMs)) ? 'aborted' : 'timeout'
}

/** Cleanup removed this checkout: Play marks a source that pointed here as gone at once. */
export function sourceRemoved(dir: string): void {
  for (const listener of removedListeners) {
    try { listener(dir) } catch { /* one listener never blocks another */ }
  }
}
export function onSourceRemoved(listener: (dir: string) => void): () => void {
  removedListeners.add(listener)
  return () => { removedListeners.delete(listener) }
}
