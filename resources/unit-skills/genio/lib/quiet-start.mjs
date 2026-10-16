/**
 * Quiet start: while any Play instance is preparing its copy, starting Unity or entering Play, Genio defers its
 * own heavy background copies (unit node_modules setup, slot Library seeds, Play copy deletions) so they do not
 * fight Unity for the disk. Each starting Play leaves one marker, <data>/quiet-start/<key>.json, written by the
 * main process; any process (Genio's main process, a unit's scripts) waits on the markers. A wait ends when no
 * Play is starting, or after the cap, whichever comes first. A marker older than the cap or left by a process
 * that is gone no longer counts, so a Play that never gets ready never holds anything back beyond the cap.
 * Node standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const QUIET_CAP_MS = 10 * 60 * 1000
export const QUIET_POLL_MS = 2000
const SUB = 'quiet-start'
// Waiters in the process that clears a marker resume at once; other processes notice on their next poll.
const changes = new EventEmitter()
changes.setMaxListeners(0)

const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export const quietDir = data => path.join(data, SUB)
const markerFile = (data, key) => { if (!/^[\w.-]+$/.test(key)) throw new Error('Invalid Play start key'); return path.join(quietDir(data), `${key}.json`) }

/** A Play start in progress. since is when the start began and stays the same through its phases. */
export function markPlayStarting(data, key, { project, phase, since = Date.now(), pid = process.pid } = {}) {
  const file = markerFile(data, key), temp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, JSON.stringify({ version: 1, pid, project, phase, since }))
  fs.renameSync(temp, file)
}

/** The start is over: ready, playing, stopped or failed. */
export function clearPlayStarting(data, key) {
  try { fs.rmSync(markerFile(data, key), { force: true }) } finally { changes.emit('change') }
}

/** Play starts that still count: their process is alive and they began less than capMs ago. */
export function playStarts(data, { now = Date.now(), capMs = QUIET_CAP_MS, isAlive = alive } = {}) {
  let names = []
  if (!data) return []
  try { names = fs.readdirSync(quietDir(data)).filter(n => n.endsWith('.json')) } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(quietDir(data), name), 'utf8'))
      if (Number.isFinite(m.since) && m.since + capMs > now && isAlive(m.pid)) out.push({ key: name.slice(0, -'.json'.length), ...m })
    } catch { /* Being replaced, or not a marker. */ }
  }
  return out
}

/** Sleep up to ms; a marker cleared in this process or an abort ends it early. */
function nap(ms, signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); changes.off('change', done); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    changes.on('change', done)
    signal?.addEventListener('abort', done)
  })
}

/**
 * Wait until no Play is starting, for at most capMs. Never rejects: resolves with
 * { waitedMs, deferred, resumed: 'quiet' | 'cap' | 'aborted' }. onWait(starts) runs once, when it has to wait.
 */
export async function waitForQuiet(data, { capMs = QUIET_CAP_MS, pollMs = QUIET_POLL_MS, signal, now = Date.now, sleep, isAlive = alive, onWait } = {}) {
  const started = now()
  let deferred = false
  const result = resumed => ({ waitedMs: Math.max(0, now() - started), deferred, resumed })
  for (;;) {
    if (signal?.aborted) return result('aborted')
    const starts = playStarts(data, { now: now(), capMs, isAlive })
    if (!starts.length) return result('quiet')
    const left = capMs - (now() - started)
    if (left <= 0) return result('cap')
    if (!deferred) { deferred = true; try { onWait?.(starts) } catch { /* Reporting only. */ } }
    await (sleep ? sleep(Math.min(pollMs, left)) : nap(Math.min(pollMs, left), signal))
  }
}
