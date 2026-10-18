import { useSyncExternalStore } from 'react'

interface Clock {
  now: number
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
  snapshot: () => number
}

const clocks = new Map<number, Clock>()
let timer: ReturnType<typeof setInterval> | undefined

/** One ticker per renderer; slower subscribers only render at their requested cadence. */
function clockFor(intervalMs: number): Clock {
  const cadence = Math.max(1000, intervalMs)
  const existing = clocks.get(cadence)
  if (existing) return existing
  const clock: Clock = {
    now: Date.now(),
    listeners: new Set(),
    snapshot: () => clock.now,
    subscribe: listener => {
      if (!clock.listeners.size) clock.now = Date.now()
      clock.listeners.add(listener)
      if (timer === undefined) timer = setInterval(() => {
        const now = Date.now()
        for (const [ms, c] of clocks) {
          if (!c.listeners.size || now - c.now < ms) continue
          c.now = now
          c.listeners.forEach(notify => notify())
        }
      }, 1000)
      return () => {
        clock.listeners.delete(listener)
        if (![...clocks.values()].some(c => c.listeners.size)) {
          clearInterval(timer)
          timer = undefined
        }
      }
    }
  }
  clocks.set(cadence, clock)
  return clock
}

export function useNow(intervalMs = 1000): number {
  const clock = clockFor(intervalMs)
  return useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot)
}
