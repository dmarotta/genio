/**
 * Play priorities. While a Play is live (entering Play, playing or paused) the hidden editor needs the CPU, so
 * Genio's own background work (a unit's shell, node_modules and Library copies, npm ci) runs at below-normal
 * priority; outside a live Play nothing changes. Each live Play leaves one marker, <data>/play-live/<key>.json,
 * written by the main process; any process (the main process, a unit's scripts) reads them. A marker left by a
 * process that is gone no longer counts. Only processes Genio started are ever touched. Node standard library only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SUB = 'play-live'
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export const liveDir = data => path.join(data, SUB)
const markerFile = (data, key) => { if (!/^[\w.-]+$/.test(key)) throw new Error('Invalid Play key'); return path.join(liveDir(data), `${key}.json`) }

/** A Play that is entering, playing or paused. since is when it went live. */
export function markPlayLive(data, key, { project, since = Date.now(), pid = process.pid } = {}) {
  const file = markerFile(data, key), temp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, JSON.stringify({ version: 1, pid, project, since }))
  fs.renameSync(temp, file)
}

/** The Play is over: stopped, failed or its editor gone. */
export function clearPlayLive(data, key) { fs.rmSync(markerFile(data, key), { force: true }) }

/** Live Plays: their owning process is alive. */
export function livePlays(data, { isAlive = alive } = {}) {
  if (!data) return []
  let names = []
  try { names = fs.readdirSync(liveDir(data)).filter(n => n.endsWith('.json')) } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(liveDir(data), name), 'utf8'))
      if (isAlive(m.pid)) out.push({ key: name.slice(0, -'.json'.length), ...m })
    } catch { /* Being replaced, or not a marker. */ }
  }
  return out
}

export const playIsLive = (data, options) => livePlays(data, options).length > 0

/** The priority classes by name. Windows maps them to its classes: above normal, normal, below normal. */
export const PRIORITY = { aboveNormal: os.constants.priority.PRIORITY_ABOVE_NORMAL, normal: os.constants.priority.PRIORITY_NORMAL, belowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL }

/** Set one process's priority. Never throws: a process that is gone or refuses keeps its priority. Returns whether it was set. */
export function setProcessPriority(pid, priority, { set = os.setPriority } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { set(pid, priority); return true } catch { return false }
}

/**
 * Wrap an execFile-style runner (robocopy, a copy helper) so that, while a Play is live, the process it starts runs
 * at below-normal priority. The process it starts is the only one touched.
 */
export function lowWhileLive(data, run, options = {}) {
  return (...args) => {
    const started = run(...args)
    try { if (data && playIsLive(data, options)) setProcessPriority(started?.child?.pid, PRIORITY.belowNormal, options) } catch { /* priority is best effort */ }
    return started
  }
}
