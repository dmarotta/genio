/**
 * Push for the Modeller's live view. While a unit page reads a model (the modellerLive call), main
 * watches the unit's step data and its step scripts folder and pushes the new state as soon as
 * something the view shows changes (a step lands, Blender starts the next, a script appears), instead
 * of the page finding out on its next poll. The poll stays as the fallback and keeps the watch alive:
 * a unit's watch closes after `idleMs` without a read.
 */
import fs from 'node:fs'

/** A unit's watch closes this long after the last read. */
export const WATCH_IDLE_MS = 15_000
/** Changes within this window make one push: a manifest write is a temp file and a rename. */
export const WATCH_SETTLE_MS = 25

/** What the live view reads: the manifest, staging folders, the lock and step scripts; never Blender logs or bakes. */
export const relevantChange = (file: string | null): boolean =>
  file === null || /(^|[\\/])(manifest\.json|\.lock|\.pending-s\d+)$|\.py$/i.test(file)

export interface LiveWatch {
  /** Watch `dirs` (those that exist; the others are tried again on the next touch) and call `push` on a relevant change. */
  touch(key: string, dirs: string[], push: () => void): void
  close(): void
}

type Watch = (dir: string, opts: { recursive: boolean }, listener: (event: string, file: string | null) => void) => fs.FSWatcher

export function createLiveWatch({ idleMs = WATCH_IDLE_MS, settleMs = WATCH_SETTLE_MS, watch = fs.watch as unknown as Watch } = {}): LiveWatch {
  const units = new Map<string, { watchers: Map<string, fs.FSWatcher>; push: () => void; idle?: NodeJS.Timeout; settle?: NodeJS.Timeout }>()
  const drop = (key: string): void => {
    const u = units.get(key)
    if (!u) return
    clearTimeout(u.idle)
    clearTimeout(u.settle)
    for (const w of u.watchers.values()) w.close()
    units.delete(key)
  }
  return {
    touch(key, dirs, push) {
      let u = units.get(key)
      if (!u) units.set(key, u = { watchers: new Map(), push })
      const unit = u
      unit.push = push
      clearTimeout(unit.idle)
      unit.idle = setTimeout(() => drop(key), idleMs)
      unit.idle.unref?.()
      for (const dir of dirs) {
        if (unit.watchers.has(dir) || !fs.existsSync(dir)) continue
        try {
          const w = watch(dir, { recursive: true }, (_event, file) => {
            if (!relevantChange(file) || unit.settle) return
            unit.settle = setTimeout(() => { unit.settle = undefined; try { unit.push() } catch { /* the poll still reads it */ } }, settleMs)
            unit.settle.unref?.()
          })
          // A removed or unreadable folder: forget the watcher, so a later touch tries again.
          w.on('error', () => { w.close(); if (unit.watchers.get(dir) === w) unit.watchers.delete(dir) })
          unit.watchers.set(dir, w)
        } catch { /* the poll covers it */ }
      }
    },
    close() { for (const key of [...units.keys()]) drop(key) }
  }
}
