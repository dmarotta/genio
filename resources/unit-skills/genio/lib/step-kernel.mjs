/**
 * The step kernel the Modeller and the Sound Studio share: a manifest of steps
 * with parent links, named branches with heads, a per-item lock, and revert,
 * branch and switch as plain manifest edits. Node 18+, standard library only.
 *
 * What a step runs and what it leaves on disk belongs to each tool; this core
 * only knows ids, parents, branches and history. `who` names the tool in
 * messages: { tool: 'Modeller', cli: 'modeller.mjs', thing: 'model', key: 'model' },
 * where `key` is the manifest field holding the item's name.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export const now = () => new Date().toISOString()
export const stepId = (n) => `s${String(n).padStart(3, '0')}`
export const rel = (dir, p) => path.relative(dir, p).split(path.sep).join('/')
export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
/** Parsed JSON, or null. A UTF-8 BOM (Windows PowerShell writes one) is ignored. */
export const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return null } }
export const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

// Resolve existing parents as well as symlinks before accepting a location.
function canonical(p) {
  if (fs.existsSync(p)) return fs.realpathSync(p)
  return path.join(canonical(path.dirname(p)), path.basename(p))
}

/** Throws unless `dir` lies outside every root (the project, the worktree). */
export function assertOutside(dir, roots, message) {
  for (const root of roots.filter(Boolean)) {
    const r = path.relative(canonical(root), canonical(dir))
    if (!r || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r))) throw new Error(message)
  }
}

export function checkName(kind, name) {
  if (!NAME.test(name ?? '')) throw new Error(`${kind} name must be 1-64 letters, digits, - or _ (got ${JSON.stringify(name)})`)
  return name
}

/** A viewer can hold a file for a moment on Windows: retry the rename briefly. */
export function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      pause(50)
    }
  }
}

/** Atomic manifest write (tmp + rename), so a live reader never sees half a file. */
export function writeManifest(dir, m) {
  m.updated = now()
  const file = path.join(dir, 'manifest.json'), tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1))
  renameRetry(tmp, file)
}

export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** One command at a time per item; a lock left by a dead process is taken over. */
export async function withLock(dir, fn, who) {
  const file = path.join(dir, '.lock')
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number(fs.readFileSync(file, 'utf8'))
      if (alive(pid)) throw new Error(`Another ${who.tool} command (pid ${pid}) is working on this ${who.thing}. Wait for it to finish.`)
      fs.rmSync(file, { force: true })
    }
  }
  try { return await fn() } finally { fs.rmSync(file, { force: true }) }
}

export const byId = (m, id) => m.steps.find((s) => s.id === id)

/** Steps from the root to a branch's head: the item as that branch sees it. */
export function line(m, branch = m.branch) {
  const out = []
  for (let id = m.branches[branch]?.head; id; id = byId(m, id)?.parent) out.unshift(byId(m, id))
  return out
}

/** Steps from the root to one step, whichever branch it is on. */
export function chain(m, id) {
  const out = []
  for (let s = id && byId(m, id); s; s = s.parent && byId(m, s.parent)) out.unshift(s)
  return out
}

/** A step by `3`, `s3` or `s003`. */
export function resolveStep(m, ref) {
  const n = /^s?(\d+)$/i.exec(String(ref ?? ''))
  const s = n && byId(m, stepId(Number(n[1])))
  if (!s) throw new Error(`No step ${ref}. Steps: ${m.steps.map((x) => x.id).join(', ') || 'none'}`)
  return s
}

/** Bytes under a folder. Files that go while it counts (a batch's Blender saves `model.blend@`, then renames it) count as none. */
export function dirBytes(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirBytes(p) : fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0
  }
  return total
}

/** Move the current branch's head back to a step on it. Later steps stay on disk, off the branch. */
export function revertHead(m, to, who) {
  const s = resolveStep(m, to)
  if (!line(m).includes(s)) throw new Error(`${s.id} is not on branch ${m.branch}. Branch from it instead: ${who.cli} branch ${m[who.key]} <name> --from ${s.id}`)
  const from = m.branches[m.branch].head
  m.branches[m.branch].head = s.id
  m.history.push({ op: 'revert', t: now(), branch: m.branch, from, to: s.id })
  return { reverted: from }
}

/** Start a new branch at a step (default: the head) and switch to it. */
export function addBranch(m, name, from, who) {
  checkName('Branch', name)
  if (m.branches[name]) throw new Error(`Branch ${name} already exists. Switch to it: ${who.cli} switch ${m[who.key]} ${name}`)
  const at = from != null ? resolveStep(m, from).id : m.branches[m.branch].head
  m.branches[name] = { head: at, from: at }
  m.history.push({ op: 'branch', t: now(), branch: name, from: at, parent: m.branch })
  m.branch = name
}

export function switchTo(m, name) {
  if (!m.branches[name]) throw new Error(`No branch ${name}. Branches: ${Object.keys(m.branches).join(', ')}`)
  m.history.push({ op: 'switch', t: now(), from: m.branch, to: name })
  m.branch = name
}
