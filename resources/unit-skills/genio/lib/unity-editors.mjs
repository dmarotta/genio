/**
 * Machine-wide seats for batch Unity editors. genio-unity takes a seat before
 * it starts an editor on a unit's copy, and the Gauntlet shares the same seats,
 * so the machine never runs more batch editors than its RAM allows. A seat is
 * a mkdir mutex, the same primitive as the Play pool's transaction lock. Node
 * 18+, standard library only.
 *
 *   <dir>/cap.json              optional {"cap": n}, 1–8, written by Genio
 *   <dir>/seat-<n>/owner.json   {pid, owner, project, token, at}
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

export const editorSeatsDir = data => path.join(data, 'unity-editors')
/** One batch editor, two on a machine with at least 32 GB of RAM. */
export const defaultEditorCap = (totalBytes = os.totalmem()) => totalBytes >= 32 * 2 ** 30 ? 2 : 1
export function editorCap(dir) {
  try {
    const cap = JSON.parse(fs.readFileSync(path.join(dir, 'cap.json'), 'utf8')).cap
    if (Number.isInteger(cap) && cap >= 1 && cap <= 8) return cap
  } catch { /* no override */ }
  return defaultEditorCap()
}

const seatPath = (dir, n) => path.join(dir, `seat-${n}`)
function owner(seat) { try { return JSON.parse(fs.readFileSync(path.join(seat, 'owner.json'), 'utf8')) } catch { return null } }
// A seat whose owner died is free. A seat without an owner record is being taken; it is stale only after a minute.
function stale(seat) {
  const o = owner(seat)
  if (o) return !(Number.isInteger(o.pid) && o.pid > 0 && alive(o.pid))
  try { return Date.now() - fs.statSync(seat).mtimeMs > 60_000 } catch { return false }
}
// Rename before deleting so a seat another process just took is never removed under it.
function remove(dir, seat, still = () => true) {
  const grave = path.join(dir, `free-${randomUUID()}`)
  try { fs.renameSync(seat, grave) } catch { return false }
  if (!still(grave)) { try { fs.renameSync(grave, seat); return false } catch { /* the seat was retaken: drop the record we moved */ } }
  fs.rmSync(grave, { recursive: true, force: true })
  return true
}

/** Live holders, for status lines and waiting messages. */
export function editorHolders(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter(n => /^seat-\d+$/.test(n)).filter(n => !stale(path.join(dir, n)))
    .map(n => { const o = owner(path.join(dir, n)) ?? {}; return { seat: Number(n.slice(5)), pid: o.pid, owner: o.owner, project: o.project, at: o.at } })
}

export function tryAcquireEditor(dir, { owner: who, project = '', cap = editorCap(dir), pid = process.pid } = {}) {
  if (typeof who !== 'string' || !who) throw new Error('Editor seat owner required')
  fs.mkdirSync(dir, { recursive: true })
  for (let n = 1; n <= cap; n++) {
    const seat = seatPath(dir, n)
    if (fs.existsSync(seat) && stale(seat)) remove(dir, seat, stale)
    try { fs.mkdirSync(seat) } catch (e) { if (e.code === 'EEXIST') continue; throw e }
    const token = randomUUID()
    fs.writeFileSync(path.join(seat, 'owner.json'), JSON.stringify({ pid, owner: who, project, token, at: Date.now() }))
    return { seat: n, token, release: () => releaseEditor(dir, n, token) }
  }
  return null
}

export function releaseEditor(dir, n, token) {
  const seat = seatPath(dir, n)
  return owner(seat)?.token === token && remove(dir, seat, grave => owner(grave)?.token === token)
}

/** Wait for a seat; null when `waitMs` passes first. `onWait` gets the holders on every poll. */
export async function acquireEditor(dir, { waitMs = 30 * 60_000, pollMs = 1000, onWait, ...seat } = {}) {
  const start = Date.now()
  for (;;) {
    const got = tryAcquireEditor(dir, seat)
    if (got) return { ...got, waitedMs: Date.now() - start }
    if (Date.now() - start >= waitMs) return null
    onWait?.(editorHolders(dir))
    await sleep(pollMs)
  }
}
