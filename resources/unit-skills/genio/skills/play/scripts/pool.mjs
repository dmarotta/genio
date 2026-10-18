import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { checkCopyPath, checkFreeSpace, seedLibrary, treeStats } from '../../../lib/unity-seed.mjs'
import { FLAT_MARKER, assertMounted, claimFlatFolder, flatBase, volumeMissing, volumePlacement } from './clone.mjs'
import { longPathWarning } from '../../../lib/path-length.mjs'
import { createDesktopApi, inspectDesktop, launchEditor } from '../../../lib/hidden-desktop.mjs'
import { initSubmodules, noHooksPath } from '../../../lib/git-submodules.mjs'
import { waitForQuiet } from '../../../lib/quiet-start.mjs'
const exec = promisify(execFile)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const canonical = p => { const v = fs.realpathSync(p); return process.platform === 'win32' ? v.toLowerCase() : v }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEASE_MS = 30000
// A first open of a seeded copy compiles every script and imports for minutes before Pipeline is serviceable.
export const READY_MS = 20 * 60000
const PORT_FILE = 'Library/Pipeline/.unity-pipeline-port'
/** Slots of an older layout are deleted once none was used for this long (the player copy's keep time). */
const LEGACY_KEEP_MS = 24 * 60 * 60 * 1000
/** An older layout's slots folder <base>/ps/<short id of the pool>/slot-N is named by genio-pool.json. */
const OWNER = 'genio-pool.json'
const poolOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8')).pool } catch { return undefined } }
const QUIT = 'UnityEditor.EditorApplication.delayCall += () => UnityEditor.EditorApplication.Exit(0); return true;'
const slashed = p => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
/** True when a command line opens exactly this project root (not a sibling such as slot-1/Game2). */
export function mentionsRoot(command, root) {
  const text = command.replace(/\\/g, '/').toLowerCase(), want = slashed(root)
  for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) if (!/[\w.-]/.test(text[at + want.length] ?? '')) return true
  return false
}
/** Every process as { pid, ppid, created, command }. created orders a child after its parent so a reused PID is never adopted. */
export async function listProcesses() {
  if (process.platform === 'win32') {
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { @($_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }), $_.CommandLine) -join [char]9 }"
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split(/\r?\n/).filter(Boolean).map(line => { const [pid, ppid, created, ...command] = line.split('\t'); return { pid: Number(pid), ppid: Number(ppid), created: created || '', command: command.join('\t') } }).filter(p => p.pid > 0)
  }
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s?(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), created: '', command: m[3] }))
}
const defaultSystem = {
  list: listProcesses,
  // Windows: taskkill without /F asks the window to close. Elsewhere SIGTERM is Unity's own clean exit.
  terminate: async pid => { if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid)], { windowsHide: true }); else process.kill(pid, 'SIGTERM') },
  kill: async pid => { process.kill(pid, 'SIGKILL') }
}
export function stuckMessage(id, result) {
  return `Play slot ${id} is stuck: ${result.reason}${result.pids?.length ? ` (PIDs ${result.pids.join(', ')})` : ''}. Report "blocked: Play slot ${id} stuck" to Genio; Genio or the player recovers it. Never stop Unity processes yourself.`
}
async function bytesUnder(dir, skip = []) {
  let bytes = 0
  const scan = async dir => { for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) { if (e.isSymbolicLink() || skip.includes(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) await scan(p); else if (e.isFile()) bytes += (await fs.promises.stat(p)).size } }
  await scan(dir)
  return bytes
}
/** Size the committed checkout, using LFS pointer sizes instead of the tiny Git blobs. */
async function checkoutStats(cwd, revision, options) {
  const { stdout } = await exec('git', ['ls-tree', '-r', '-l', '-z', revision], { ...options, cwd, maxBuffer: 64 * 1024 * 1024 })
  let bytes = 0
  const small = new Map()
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t/)
    if (!match) continue
    if (match[1] === '120000') throw new Error('Unity copies cannot contain symlinks, junctions or hardlinks')
    const size = Number(match[3]); bytes += size
    if (size <= 1024) {
      const item = small.get(match[2]) ?? { size, count: 0 }
      item.count++; small.set(match[2], item)
    }
  }
  const lfs = []
  if (small.size) {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'], { ...options, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks = []; let stderr = '', length = 0
      child.on('error', reject); child.stdin.on('error', reject)
      child.stdout.on('data', b => { length += b.length; if (length > 64 * 1024 * 1024) { child.kill(); reject(new Error('Git checkout size scan exceeded its buffer')) } else chunks.push(b) })
      child.stderr.on('data', b => { stderr += b })
      child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Git checkout size scan failed: ${stderr}`)))
      child.stdin.end([...small.keys()].join('\n') + '\n')
    })
    for (let at = 0; at < output.length;) {
      const end = output.indexOf(10, at), header = output.subarray(at, end).toString().split(' ')
      const size = Number(header[2])
      if (end < at || header[1] !== 'blob' || !Number.isFinite(size)) throw new Error('Invalid Git checkout size response')
      const body = output.subarray(end + 1, end + 1 + size).toString()
      const pointer = body.match(/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n(?:.*\r?\n)*oid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/)
      if (pointer) { const logical = Number(pointer[2]); bytes += (logical - size) * small.get(header[0]).count; lfs.push({ oid: pointer[1], size: logical }) }
      at = end + 1 + size + 1
    }
  }
  return { bytes, lfs }
}
/**
 * A slot's folder: the flat layout names it in placement.json (<base>/<9 hex>, a placeholder until assigned); the older
 * layout is <slots>/slot-N. Shared with the unit guards, which read the same files.
 */
export function slotPath(poolDir, placement, slots, id) {
  return placement?.flat ? path.join(slots, placement.folders?.[id] ?? `unassigned-${id}`) : path.join(slots, `slot-${id}`)
}
export function poolDirectory(data, world) { return path.join(data, 'play-pools', createHash('sha256').update(canonical(world)).digest('hex').slice(0, 24)) }
export class PlayPool {
  constructor(data, world, engineRoot = '', options = {}) {
    assertMounted(world)
    this.world = fs.realpathSync(world)
    if (path.isAbsolute(engineRoot) || /[:\x00-\x1f]/.test(engineRoot) || engineRoot.split(/[\\/]/).includes('..')) throw new Error('Invalid Unity root')
    this.engineRoot = engineRoot
    this.data = data
    // Lease state always lives here; slot copies may live on the project's volume (placement.json).
    this.dir = poolDirectory(data, world)
    this.graceMs = options.graceMs ?? 60000
    this.forceMs = options.forceMs ?? 15000
    this.system = { ...defaultSystem, ...options.system }
    this.clone = options.clone
    // Slot editors open on a hidden desktop (lib/hidden-desktop.mjs); tests inject a fake desktop and spawn.
    this.desktop = options.desktop ?? createDesktopApi(data)
    this.spawnVisible = options.spawnVisible
    this.quiet = options.quiet
    this.platform = options.platform ?? process.platform
    this.closes = new Set()
    fs.mkdirSync(this.dir, { recursive: true })
  }
  /** placement.json: where this pool's slot folders live, or undefined before the pool is placed. */
  placement() { try { const p = JSON.parse(fs.readFileSync(path.join(this.dir, 'placement.json'), 'utf8')); return p && typeof p === 'object' ? p : undefined } catch { return undefined } }
  /**
   * The folder the slot copies live under, read from placement.json on every call. Flat layout: the base holding
   * one <9 hex> folder per slot. Older layout: the folder holding slot-N copies. Unplaced, the pool folder.
   */
  slots() {
    const dir = this.placement()?.dir
    // A placement on a detached volume falls back to the pool folder rather than failing every call.
    if (typeof dir === 'string' && path.isAbsolute(dir) && !volumeMissing(dir)) return dir
    return this.dir
  }
  slotDir(id) { return slotPath(this.dir, this.placement(), this.slots(), id) }
  /**
   * Gives a slot of the flat layout its folder, once: a new <9 hex> under the base, claimed with mkdir so no folder
   * of another owner is reused, and recorded in placement.json. Called inside the pool transaction (or by the
   * only process preparing the slot). The folder's manifest (.genio-copy.json) is written once the clone exists.
   */
  assign(id) {
    const p = this.placement()
    if (!p?.flat || p.folders?.[id]) return this.slotDir(id)
    const dir = claimFlatFolder(this.slots(), `${path.basename(this.dir)}:slot-${id}`)
    const file = path.join(this.dir, 'placement.json'), temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ ...p, folders: { ...p.folders, [id]: path.basename(dir) } }))
    fs.renameSync(temp, file)
    return dir
  }
  /** Writes the slot folder's manifest and keeps it out of the clone's status. Idempotent. */
  mark(id) {
    const dir = this.slotDir(id), file = path.join(dir, FLAT_MARKER)
    if (!this.placement()?.flat || !fs.existsSync(path.join(dir, '.git'))) return
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ kind: 'genio-play-slot', purpose: 'play-slot', pool: path.basename(this.dir), slot: id, project: this.world, createdAt: Date.now() }, null, 2))
    const exclude = path.join(dir, '.git', 'info', 'exclude')
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!text.split(/\r?\n/).includes(`/${FLAT_MARKER}`)) fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/${FLAT_MARKER}\n`)
  }
  /**
   * Slots go to one flat folder each, <base>/<9 hex>: nothing else in the path, so Unity's deepest paths stay under
   * Windows' 260 characters. Block cloning needs the copies on the project's volume, so when the project sits on a
   * Dev Drive (or other block-cloning volume) apart from Genio's data, <base> is <volume>/.genio; else it is Genio's
   * data folder. Decided once, before the first slot exists, and shared by every process through placement.json.
   */
  async place() {
    const file = path.join(this.dir, 'placement.json')
    if (fs.existsSync(file)) return this.slots()
    // Probed once per process. A pool that already has slots in its own folder waits for retireLegacy().
    return this.placing ??= (async () => {
      if (fs.readdirSync(this.dir).some(n => /^slot-\d+$/.test(n))) return this.dir
      const volume = await volumePlacement(this.world, this.dir, this.clone)
      const dir = flatBase(this.data, volume)
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ dir, flat: true, folders: {}, at: Date.now() }), { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') return this.dir }
      return this.slots()
    })()
  }
  /**
   * Slots of an older layout (<data>/play-pools/<pool>/slot-N, <base>/ps/<id>/slot-N) are disposable clones: while no
   * slot is leased, preparing, closing, stuck or open in an editor, and the newest of them was last used more than
   * LEGACY_KEEP_MS ago, they are moved aside and deleted in the background and the pool is placed again in the
   * flat layout. Otherwise they stay and keep working. Returns true when the legacy slots are gone.
   */
  async retireLegacy() {
    const from = this.slots(), placement = this.placement()
    if (placement?.flat) return false
    const names = () => { try { return fs.readdirSync(from).filter(n => /^slot-\d+$/.test(n)) } catch { return [] } }
    if (!placement && !names().length) return false
    const retired = await this.transaction(s => {
      if (s.slots.some(v => v.lease || v.preparing || v.closing || v.stuck || this.editorRunning(v))) return false
      const slots = names()
      if (slots.some(n => this.editorAlive(Number(n.slice(5))))) return false
      const used = n => { let at = 0; for (const p of [path.join(from, n), path.join(from, n, '.git', 'genio-play-ready')]) { try { at = Math.max(at, fs.statSync(p).mtimeMs) } catch { /* Absent. */ } } return at }
      if (slots.some(n => Date.now() - used(n) < LEGACY_KEEP_MS)) return false
      const aside = []
      try {
        for (const n of slots) { const to = path.join(from, `trash-${randomUUID()}`); fs.renameSync(path.join(from, n), to); aside.push(to) }
      } catch {
        for (const to of aside) { try { fs.renameSync(to, path.join(from, slots[aside.indexOf(to)])) } catch { /* Left aside, deleted below. */ } }
        return false
      }
      fs.rmSync(path.join(this.dir, 'placement.json'), { force: true })
      s.slots = []
      // A short slots folder of this pool goes with them; the pool folder itself never does.
      if (from !== this.dir && poolOf(from) === path.basename(this.dir)) aside.push(from)
      for (const dir of aside) this.removeInBackground(dir)
      return true
    })
    if (retired) this.placing = undefined
    return retired
  }
  removeInBackground(dir) {
    const p = fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
    this.closes.add(p); p.finally(() => this.closes.delete(p))
  }
  async transaction(fn) {
    const lock = path.join(this.dir, 'mutex')
    let acquired = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { fs.mkdirSync(lock); acquired = true; break } catch (e) { if (e.code !== 'EEXIST') throw e }
      await new Promise(r => setTimeout(r, 20))
    }
    // Never race another writer by deleting its lock. A crashed transaction needs inspection.
    if (!acquired) throw new Error(`Play pool transaction locked; inspect ${lock} before recovery`)
    const reclaimed = []
    let result
    try {
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
      const file = path.join(this.dir, 'state.json')
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cap: 1, slots: [], queue: [] }
      const now = Date.now()
      state.queue = state.queue.filter(q => q.expires > now && alive(q.pid))
      for (const s of state.slots) {
        // An interrupted close restarts; a dead or expired owner never leaves its editor running in a free slot.
        let stale = false
        if (s.closing && (!alive(s.closing.pid) || s.closing.expires <= now)) { delete s.closing; stale = true }
        if (s.lease && (!alive(s.lease.pid) || !s.preparing && s.lease.expires <= now)) { this.endLease(state, s); s.preparing = false; stale = true }
        if (stale && !s.lease && !s.stuck && this.editorRunning(s)) reclaimed.push(this.markClosing(s))
      }
      result = fn(state)
      const temp = path.join(this.dir, 'state.tmp')
      fs.writeFileSync(temp, JSON.stringify(state, null, 2))
      fs.renameSync(temp, file)
    } finally { fs.rmSync(lock, { recursive: true }) }
    // Closing takes far longer than a transaction may hold the lock. The slot stays
    // marked closing, so nobody leases it until the editor is gone or marked stuck.
    for (const mark of reclaimed) this.closeInBackground(mark)
    return result
  }
  closeInBackground(mark) { const p = this.finishClose(...mark).catch(() => {}); this.closes.add(p); p.finally(() => this.closes.delete(p)) }
  /** Waits for background closes this process started (reclaimed slots). */
  async settle() { while (this.closes.size) await Promise.all([...this.closes]) }
  endLease(state, slot) {
    if (slot.lease?.since) state.durations = [...(state.durations ?? []), Date.now() - slot.lease.since].slice(-10)
    delete slot.lease
  }
  markClosing(slot) {
    const token = randomUUID()
    slot.closing = { pid: process.pid, token, expires: Date.now() + this.graceMs + this.forceMs + 120000 }
    return [slot.id, slot.editor?.pid, token, slot.editor]
  }
  root(id) { if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('Invalid Play slot'); return path.join(this.slotDir(id), this.engineRoot) }
  async state() {
    return this.transaction(s => ({ cap: s.cap, launch: s.launch ?? 'hidden', slots: s.slots.map(v => {
      const editor = this.editorRunning(v)
      const draining = this.draining(s, v, editor)
      return { id: v.id, root: this.root(v.id), revision: v.revision, owner: v.lease?.owner, expires: v.lease?.expires, preparing: v.preparing, preparation: v.preparation, editor, closing: !!v.closing, stuck: v.stuck && { reason: v.stuck.reason, pids: v.stuck.pids, at: v.stuck.at }, draining, retired: v.id > s.cap && !draining,
        ...(editor && v.editor ? { window: v.editor.desktop ? 'hidden' : 'visible', ...(v.editor.warning ? { warning: v.editor.warning } : {}) } : {}),
        ...(v.failure ? { failure: { message: v.failure.message, at: v.failure.at, screenshot: v.failure.screenshot } } : {}) }
    }), queue: s.queue.map(q => q.owner) }))
  }
  /** Settings › This project › Unity slots: hidden (default) or visible slot editor windows, for every later launch. */
  async configureLaunch(visible) {
    return this.transaction(s => { s.launch = visible ? 'visible' : 'hidden'; return { launch: s.launch } })
  }
  /** Above the cap: draining while still in use, retired once idle (kept with its Library for reuse if the cap rises). */
  draining(s, v, editor = this.editorRunning(v)) { return v.id > s.cap && !!(v.lease || v.preparing || v.closing || editor) }
  /**
   * Applies at once and never refuses. Slots above a lowered cap drain: their leases and editors
   * are left alone, they take no new lease, and release closes their editor (see release).
   */
  async configure(cap) {
    if (!Number.isInteger(cap) || cap < 1 || cap > 8) throw new Error('Play cap must be 1–8')
    return this.transaction(s => {
      s.cap = cap
      return { cap, draining: s.slots.filter(v => this.draining(s, v)).map(v => v.id) }
    })
  }
  editorAlive(id) {
    const root = this.root(id)
    if (fs.existsSync(path.join(root, 'Temp/UnityLockfile'))) return true
    try { const d = JSON.parse(fs.readFileSync(path.join(root, 'Library/EditorInstance.json'), 'utf8')); return Number.isInteger(d.process_id) && d.process_id > 0 && alive(d.process_id) } catch { return false }
  }
  editorRunning(slot) { return this.editorAlive(slot.id) || this.slotPids(slot.id, slot.editor?.pid).some(alive) }
  /** PIDs recorded for one project root: Genio's launch record, Unity's instance file and Pipeline's descriptor. */
  recordedPids(root, launched) {
    const pids = new Set(Number.isInteger(launched) && launched > 0 ? [launched] : [])
    for (const [file, key] of [['Library/EditorInstance.json', 'process_id'], ['Library/Pipeline/.unity-pipeline-port', 'pid']]) {
      try { const v = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[key]; if (Number.isInteger(v) && v > 0) pids.add(v) } catch { /* Not recorded. */ }
    }
    return [...pids]
  }
  slotPids(id, launched) { return this.recordedPids(this.root(id), launched) }
  async acquire(owner, pid = process.pid, preferred, takeover = false) {
    if (typeof owner !== 'string' || !owner || owner.length > 160 || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) throw new Error('Invalid Play owner')
    if (preferred !== undefined) this.root(preferred)
    await this.place()
    if (await this.retireLegacy()) await this.place()
    return this.transaction(s => {
      if (preferred > s.cap) throw new Error(`Slot ${preferred} is above the cap of ${s.cap}; it takes no new leases`)
      const existing = s.slots.find(v => v.lease?.owner === owner && v.lease.pid === pid)
      if (existing) { existing.lease.expires = Date.now() + LEASE_MS; return { id: existing.id, token: existing.lease.token, root: this.root(existing.id) } }
      let request = s.queue.find(q => q.owner === owner && q.pid === pid)
      if (!request) { request = { owner, pid, expires: 0 }; s.queue.push(request) }
      request.expires = Date.now() + LEASE_MS
      if (!takeover && s.queue[0] !== request) return null
      // Closing and stuck slots are never handed out: their editor may still be running.
      let slot = s.slots.find(v => v.id <= s.cap && (!preferred || v.id === preferred) && !v.closing && !v.stuck && (!v.lease || takeover && !v.preparing))
      if (!slot) {
        const id = Array.from({ length: s.cap }, (_, i) => i + 1).find(id => (!preferred || preferred === id) && !s.slots.some(v => v.id === id))
        if (id) { slot = { id }; s.slots.push(slot) }
      }
      if (!slot) return null
      this.assign(slot.id)
      if (slot.lease) this.endLease(s, slot)
      slot.lease = { owner, pid, token: randomUUID(), since: Date.now(), expires: Date.now() + LEASE_MS }
      s.queue = s.queue.filter(q => q !== request)
      return { id: slot.id, token: slot.lease.token, root: this.root(slot.id) }
    })
  }
  /** Queue position, a rough wait from recent lease lengths, and slots that block everyone. */
  async waitInfo(owner, pid = process.pid) {
    return this.transaction(s => {
      const now = Date.now(), position = s.queue.findIndex(q => q.owner === owner && q.pid === pid) + 1
      const average = s.durations?.length ? s.durations.reduce((a, b) => a + b, 0) / s.durations.length : 600000
      const usable = Array.from({ length: s.cap }, (_, i) => s.slots.find(v => v.id === i + 1)).filter(v => !v?.stuck)
      const remaining = usable.map(v => v?.lease ? Math.max(0, average - (now - (v.lease.since ?? now))) : v?.closing ? 60000 : 0).sort((a, b) => a - b)
      const index = Math.max(0, position - 1)
      const estimateMs = remaining.length && position ? Math.round(remaining[index % remaining.length] + Math.floor(index / remaining.length) * average) : null
      const inUse = Array.from({ length: s.cap }, (_, i) => s.slots.find(v => v.id === i + 1)).filter(v => v && (v.lease || v.preparing || v.closing || v.stuck)).length
      return { position, length: s.queue.length, estimateMs, cap: s.cap, inUse, draining: s.slots.filter(v => this.draining(s, v)).map(v => v.id), holders: s.slots.filter(v => v.lease).map(v => ({ slot: v.id, owner: v.lease.owner })), stuck: s.slots.filter(v => v.stuck && v.id <= s.cap).map(v => ({ slot: v.id, reason: v.stuck.reason, pids: v.stuck.pids })) }
    })
  }
  /** A lease the dialog watcher failed reports why, instead of a bare "lease lost". */
  lost(v, token) { return new Error(v?.failure?.token === token ? v.failure.message : 'Play lease lost; stop controlling this editor') }
  async check(id, token) { return this.transaction(s => { const v = s.slots.find(v => v.id === id); if (!v?.lease || v.lease.token !== token) throw this.lost(v, token); v.lease.expires = Date.now() + LEASE_MS; return this.root(id) }) }
  /**
   * Records the editor this lease launched, so a later close stops exactly that process tree.
   * launch (from launchEditor) adds its creation time and, for a hidden launch, its desktop.
   */
  async recordEditor(id, token, pid, launch = {}) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid editor process')
    return this.transaction(s => {
      const v = s.slots.find(v => v.id === id); if (v?.lease?.token !== token) throw new Error('Play lease lost')
      v.editor = { pid, owner: v.lease.owner, at: Date.now(), ...(/^\d+$/.test(launch.created ?? '') ? { created: launch.created } : {}),
        ...(launch.hidden && launch.desktop ? { desktop: launch.desktop, dir: launch.dir, helper: launch.helper } : {}), ...(launch.warning ? { warning: launch.warning } : {}) }
      delete v.failure
    })
  }
  /**
   * The only way a slot editor is started (units' play.mjs sessions):
   * `-automated -projectPath <slot>`, on a hidden desktop unless the player chose visible windows in
   * Settings › This project › Unity slots, or the hidden desktop is unavailable (then visible, with a warning).
   */
  async launchEditor(id, token, executable, { env = process.env, cwd } = {}) {
    await this.validateCopy(id)
    const visible = await this.transaction(s => { const v = s.slots.find(v => v.id === id); if (v?.lease?.token !== token) throw this.lost(v, token); return s.launch === 'visible' })
    // Windows: Unity cannot open a file whose path reaches 260 characters. A warning only; the launch goes on.
    const long = await longPathWarning(this.root(id), { platform: this.platform, packageCache: path.join(this.world, this.engineRoot, 'Library', 'PackageCache') })
    const launch = await launchEditor({ file: executable, args: ['-automated', '-projectPath', this.root(id)], cwd, env, data: this.data, visible, label: `slot${id}`, api: this.desktop, ...(this.spawnVisible ? { spawnVisible: this.spawnVisible } : {}) })
    if (long) launch.warning = launch.warning ? `${launch.warning} ${long}` : long
    await this.recordEditor(id, token, launch.pid, launch)
    return launch
  }
  /**
   * A slot is ready only when its own editor wrote Library/Pipeline/.unity-pipeline-port for this root and
   * Pipeline's GET /api/status (answered off the main thread) says "ready". Unity writes that file once the
   * Pipeline package loads, after the first script compile, and reports "settling" through the first import.
   * Bounded; the error names what was still missing. A lease lost meanwhile (a blocking dialog) ends the wait.
   */
  async waitReady(id, token, { timeoutMs = READY_MS, intervalMs = 1000, reportMs = 30000, onProgress } = {}) {
    const root = this.root(id), started = Date.now()
    const editor = await this.transaction(s => { const v = s.slots.find(v => v.id === id); if (v?.lease?.token !== token) throw this.lost(v, token); return v.editor })
    let cause = `it has not written its Pipeline endpoint file ${PORT_FILE} yet (still compiling or importing, or the Pipeline package did not load)`, reported = started
    for (;;) {
      await this.check(id, token)
      // The editor's own records only: Genio's launch and Unity's instance file, never the descriptor being judged.
      let instance
      try { instance = JSON.parse(fs.readFileSync(path.join(root, 'Library/EditorInstance.json'), 'utf8')).process_id } catch { /* Not written yet. */ }
      const known = [...new Set([editor?.pid, instance].filter(pid => Number.isInteger(pid) && pid > 0))]
      if (known.length && !known.some(alive)) throw new Error(`Play slot ${id} editor exited before it was ready. Editor log: ${path.join(root, 'Logs', 'Editor.log')}`)
      const probe = await this.probePipeline(root, known)
      if (probe.ready) return { port: probe.port, pid: probe.pid, waitedMs: Date.now() - started }
      if (probe.cause) cause = probe.cause
      if (Date.now() - started >= timeoutMs) throw new Error(`Play slot ${id} editor was not ready after ${Math.round(timeoutMs / 60000) || 1} min: ${cause}. Editor log: ${path.join(root, 'Logs', 'Editor.log')}. Report "blocked: Play slot ${id} not ready" to Genio; never start or stop Unity yourself.`)
      if (onProgress && Date.now() - reported >= reportMs) { reported = Date.now(); onProgress({ elapsedSeconds: Math.round((Date.now() - started) / 1000), message: `Play slot ${id} editor is starting: ${cause}.` }) }
      await sleep(intervalMs)
    }
  }
  /** One readiness probe: { ready, port, pid } or { cause } naming why not. Never throws. */
  async probePipeline(root, known = []) {
    let d
    try { d = JSON.parse(fs.readFileSync(path.join(root, PORT_FILE), 'utf8')) } catch (e) { return e.code === 'ENOENT' ? {} : { cause: 'its Pipeline endpoint file is being written or is unreadable' } }
    if (!d.projectPath || slashed(d.projectPath) !== slashed(root) || d.mode !== 'editor') return { cause: `the Pipeline endpoint file names another editor (${d.mode ?? 'unknown mode'} for ${d.projectPath ?? 'no project'})` }
    if (!Number.isInteger(d.pid) || d.pid <= 0 || !alive(d.pid)) return { cause: `the Pipeline endpoint file is stale: its editor (PID ${d.pid}) is gone` }
    if (known.length && !known.includes(d.pid)) return { cause: `the Pipeline endpoint file belongs to PID ${d.pid}, not this slot's editor (PID ${known.join(', ')})` }
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || typeof d.evalToken !== 'string' || !d.evalToken || /[\r\n]/.test(d.evalToken)) return { cause: 'the Pipeline endpoint file has no valid port or token' }
    const answer = await new Promise(resolve => {
      const req = http.request({ hostname: '127.0.0.1', port: d.port, path: '/api/status', method: 'GET', headers: { Authorization: `Bearer ${d.evalToken}` } }, res => {
        const chunks = []
        res.on('data', c => { if (chunks.length < 64) chunks.push(c) })
        res.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* not JSON */ } resolve({ code: res.statusCode, body }) })
        res.on('error', () => resolve({ error: true }))
      })
      req.setTimeout(5000, () => req.destroy()); req.on('error', () => resolve({ error: true })); req.end()
    })
    if (answer.error) return { cause: `nothing answers on its Pipeline port ${d.port} yet (a half-started editor)` }
    // The token rotates; the file catches up on the next heartbeat.
    if (answer.code === 401) return { cause: 'Pipeline refused the token in its endpoint file (HTTP 401; it rotates, retrying with the current file)' }
    if (answer.code !== 200) return { cause: `Pipeline /api/status answered HTTP ${answer.code}` }
    const status = answer.body?.status
    if (status === 'ready') return { ready: true, port: d.port, pid: d.pid }
    if (status === 'settling') return { cause: 'Pipeline reports "settling": the editor is still importing or compiling' }
    if (status === 'blocked_by_dialog') return { cause: `a modal dialog blocks the editor${answer.body.dialog?.title ? ` ("${String(answer.body.dialog.title).slice(0, 120)}")` : ''}` }
    return { cause: `Pipeline reports status ${JSON.stringify(status ?? null)}` }
  }
  /**
   * The dialog watcher, run by the lease holder's heartbeat. Safe buttons are pressed; a blocking dialog
   * fails the lease with a clear message (also what check() answers from then on) and closes the editor.
   * A watcher error never ends a lease.
   */
  async watchEditor(id, token, options = {}) {
    const editor = await this.transaction(s => { const v = s.slots.find(v => v.id === id); if (v?.lease?.token !== token) throw this.lost(v, token); return v.editor })
    if (!editor?.desktop || !this.editorRunning({ id, editor })) return { watched: false, clicked: [] }
    let result
    try { result = await inspectDesktop(this.desktop, editor, options) } catch (e) { return { watched: false, clicked: [], error: e.message } }
    if (!result.blocked) return result
    const message = `Play slot ${id} editor ${result.blocked.message}`
    const mark = await this.transaction(s => {
      const v = s.slots.find(v => v.id === id)
      if (v?.lease?.token !== token) return
      v.failure = { token, message, at: Date.now(), screenshot: result.blocked.screenshot, dialog: { title: result.blocked.title, text: result.blocked.text, buttons: result.blocked.buttons, rule: result.blocked.rule } }
      this.endLease(s, v); v.preparing = false
      return this.markClosing(v)
    })
    if (mark) await this.finishClose(...mark)
    throw new Error(message)
  }
  /**
   * Release means the slot editor is gone: it is closed before the slot is free again.
   * keepEditor leaves it running for the next lease of the same revision, except on a draining
   * slot (above a lowered cap): that one closes and retires, as no lease may follow there.
   * Returns undefined when the token no longer holds the slot (a successor keeps it).
   */
  async release(id, token, { keepEditor = false } = {}) {
    const mark = await this.transaction(s => {
      const v = s.slots.find(v => v.id === id)
      if (v?.lease?.token !== token) return
      const owner = v.lease.owner
      this.endLease(s, v); v.preparing = false
      if (v.stuck) return { closed: false, pids: v.stuck.pids, reason: v.stuck.reason }
      if (!this.editorRunning(v)) return { closed: true, pids: [] }
      if (keepEditor && v.id <= s.cap) { v.editor = { ...v.editor, owner }; return { closed: false, kept: true, pids: [] } }
      return this.markClosing(v)
    })
    return Array.isArray(mark) ? this.finishClose(...mark) : mark
  }
  /** Player or Genio recovery. force revokes a live lease (the player confirmed); otherwise leased slots are refused. */
  async closeSlot(id, { force = false } = {}) {
    this.root(id)
    const mark = await this.transaction(s => {
      let v = s.slots.find(v => v.id === id)
      if (!v) { if (!fs.existsSync(this.slotDir(id))) return; v = { id }; s.slots.push(v) }
      if (v.closing) throw new Error(`Play slot ${id} editor is already closing`)
      if (v.preparing) throw new Error(`Play slot ${id} is preparing; wait for it to finish`)
      if (v.lease) { if (!force) throw new Error(`Play slot ${id} is leased by ${v.lease.owner}; it closes its editor on release`); this.endLease(s, v) }
      delete v.stuck
      return this.markClosing(v)
    })
    return mark ? this.finishClose(...mark) : { closed: true, pids: [] }
  }
  /** A unit's own recovery (play.mjs --close): its leases, kept editors and stuck slots. */
  async closeOwned(owner) {
    const marks = await this.transaction(s => s.slots.filter(v => !v.closing && !v.preparing && (v.lease ? v.lease.owner === owner : v.editor?.owner === owner || v.stuck?.owner === owner)).map(v => {
      if (v.lease) this.endLease(s, v)
      delete v.stuck
      return this.markClosing(v)
    }))
    return Promise.all(marks.map(async mark => ({ slot: mark[0], ...await this.finishClose(...mark) })))
  }
  async finishClose(id, launched, token, editor) {
    let result
    try { result = await this.closeEditor(id, launched, editor) } catch (e) { result = { closed: false, pids: [], reason: `could not inspect slot processes (${e.message})` } }
    await this.transaction(s => {
      const v = s.slots.find(v => v.id === id)
      if (v?.closing?.token !== token) return
      delete v.closing
      if (result.closed) { delete v.editor; delete v.stuck } else v.stuck = { reason: result.reason, pids: result.pids, at: Date.now(), owner: v.editor?.owner }
    })
    return result
  }
  /**
   * Graceful quit (Pipeline, then the platform's polite close), a timed wait, then a forced
   * stop of only this slot's verified editor and its children. A recorded PID counts only
   * while its command line opens this slot root: never the main editor or another Unity.
   */
  async closeEditor(id, launched, editor) {
    const root = this.root(id)
    const main = path.join(this.world, this.engineRoot)
    const guard = new Set([process.pid, process.ppid, ...this.recordedPids(main)])
    const recorded = this.slotPids(id, launched).filter(pid => !guard.has(pid))
    if (!recorded.some(alive)) return this.clearEditorFiles(root, [], false)
    const before = await this.system.list()
    const editors = [], unknown = []
    for (const pid of recorded) {
      const p = before.find(p => p.pid === pid)
      if (!p) continue
      // A recorded launch identity rules out a reused PID before its command line is even read.
      if (pid === launched && editor?.created && p.created && p.created !== editor.created) continue
      if (!p.command) unknown.push(pid)
      else if (mentionsRoot(p.command, root)) editors.push(p)
    }
    // Stale records (exited editor, reused PID) are not this slot's editor and are never touched.
    if (!editors.length && unknown.length) return { closed: false, pids: unknown, reason: 'a recorded process could not be verified as this slot editor' }
    if (!editors.length) return this.clearEditorFiles(root, [], false)
    let targets = this.tree(before, editors, root, guard)
    // taskkill's polite close cannot reach windows on another desktop; the helper posts WM_CLOSE there.
    const hidden = editor?.desktop ? editor : undefined
    const polite = hidden ? async pid => { if (!await this.desktop.close(hidden.desktop, pid).catch(() => false)) await this.system.terminate(pid) } : this.system.terminate
    if (!await this.quitViaPipeline(root, editors.map(e => e.pid))) for (const e of editors) await polite(e.pid).catch(() => {})
    // Nobody sees "save changes?" on a hidden desktop: dismiss safe dialogs while waiting.
    const tick = hidden && (() => inspectDesktop(this.desktop, hidden, { benignOnly: true }).catch(() => {}))
    if (await this.gone(targets, this.graceMs, tick)) return this.clearEditorFiles(root, targets.map(t => t.pid), false)
    // Late children (import workers) appear after the first listing; adopt only descendants
    // of the verified editors, matched by PID and creation time.
    const after = await this.system.list()
    const same = (a, b) => a.pid === b.pid && a.created === b.created
    const current = targets.map(t => after.find(p => same(p, t))).filter(Boolean)
    targets = this.tree(after, current, root, guard)
    for (const t of targets) await this.system.kill(t.pid).catch(() => {})
    if (!await this.gone(targets, this.forceMs)) return { closed: false, pids: targets.filter(t => alive(t.pid)).map(t => t.pid), reason: 'its Unity processes survived a forced stop' }
    return this.clearEditorFiles(root, targets.map(t => t.pid), true)
  }
  tree(procs, roots, root, guard) {
    const out = new Map(roots.map(p => [p.pid, p]))
    // The licensing client is shared by every Unity editor; a child naming another project is not ours.
    const foreign = p => /Unity\.Licensing\.Client/i.test(p.command) || /-projectpath/i.test(p.command) && !mentionsRoot(p.command, root)
    for (let grew = true; grew;) {
      grew = false
      for (const p of procs) {
        const parent = out.get(p.ppid)
        if (!parent || out.has(p.pid) || guard.has(p.pid) || foreign(p) || p.created && parent.created && Number(p.created) < Number(parent.created)) continue
        out.set(p.pid, p); grew = true
      }
    }
    return [...out.values()]
  }
  async gone(targets, ms, tick) {
    const deadline = Date.now() + ms
    let next = Date.now() + 2000
    while (targets.some(t => alive(t.pid))) {
      if (Date.now() >= deadline) return false
      if (tick && Date.now() >= next) { await tick(); next = Date.now() + 2000 }
      await sleep(250)
    }
    return true
  }
  async quitViaPipeline(root, editors) {
    let d
    try { d = JSON.parse(fs.readFileSync(path.join(root, 'Library/Pipeline/.unity-pipeline-port'), 'utf8')) } catch { return false }
    if (!d.projectPath || slashed(d.projectPath) !== slashed(root) || d.mode !== 'editor' || !editors.includes(d.pid) || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || typeof d.evalToken !== 'string' || !d.evalToken || /[\r\n]/.test(d.evalToken)) return false
    return new Promise(resolve => {
      const body = JSON.stringify({ command: 'eval', parameters: { code: QUIT }, timeout: 5000 })
      const req = http.request({ hostname: '127.0.0.1', port: d.port, path: '/api/exec', method: 'POST', headers: { Authorization: `Bearer ${d.evalToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); res.on('error', () => resolve(false)) })
      req.setTimeout(8000, () => req.destroy()); req.on('error', () => resolve(false)); req.end(body)
    })
  }
  /** Unity removes these on a clean exit; a crash or forced stop leaves them and the slot would look open forever. */
  clearEditorFiles(root, pids, forced) {
    for (const file of ['Library/EditorInstance.json', 'Library/Pipeline/.unity-pipeline-port']) fs.rmSync(path.join(root, file), { force: true })
    // Windows keeps the lockfile open while any editor uses the project, so this fails for an editor Genio never recorded.
    try { fs.rmSync(path.join(root, 'Temp/UnityLockfile'), { force: true }) } catch { return { closed: false, pids, reason: 'an editor Genio did not record still holds the slot lockfile' } }
    return { closed: true, pids, forced }
  }
  async cancel(owner, pid = process.pid) { return this.transaction(s => { s.queue = s.queue.filter(q => q.owner !== owner || q.pid !== pid) }) }
  async mainControl() {
    return this.transaction(s => {
      if (s.main && s.main.pid !== process.pid && alive(s.main.pid) && s.main.expires > Date.now()) throw new Error('The main editor is controlled by another Genio process')
      s.main = { pid: process.pid, expires: Date.now() + LEASE_MS }
    })
  }
  async releaseMain() { return this.transaction(s => { if (s.main?.pid === process.pid) delete s.main }) }
  async estimate() {
    const options = { windowsHide: true, env: { ...process.env, GIT_CONFIG_COUNT: '0' } }
    const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { ...options, cwd: this.world })
    const common = path.resolve(this.world, stdout.trim())
    const checkout = await checkoutStats(this.world, 'HEAD', options)
    const library = path.join(this.world, this.engineRoot, 'Library')
    return checkout.bytes + (await treeStats(path.join(common, 'objects'), { rejectLinks: false })).bytes + (fs.existsSync(library) ? (await treeStats(library, { library: true })).bytes : 0)
  }
  /** Disk each slot copy uses now, clone and Library included, by slot id. */
  async disk() {
    const out = {}
    for (let id = 1; id <= 8; id++) { const dir = this.slotDir(id); if (fs.existsSync(dir)) out[id] = await bytesUnder(dir) }
    return out
  }
  async prepare(id, token, source = this.world) {
    await this.check(id, token)
    // Source must be the registered repository or one of its git worktrees.
    // Not a plain empty folder: git-lfs would install its hooks there and every later checkout would run them.
    // Submodules are checked out by prepareSubmodules alone: a fetch recursing into them would reach their network origin.
    const hooksPath = noHooksPath(this.dir)
    const gitOptions = { windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksPath, GIT_CONFIG_KEY_1: 'fetch.recurseSubmodules', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'submodule.recurse', GIT_CONFIG_VALUE_2: 'false' } }
    const git = async (cwd, args) => (await exec('git', args, { ...gitOptions, cwd })).stdout.trim()
    const common = async cwd => canonical(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])))
    if (await common(source) !== await common(this.world)) throw new Error('Play source must belong to the registered project')
    const revision = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const dest = this.assign(id)
    let ready
    for (let attempt = 0; ; attempt++) {
      ready = await this.transaction(s => {
        const slot = s.slots.find(v => v.id === id)
        if (slot?.lease?.token !== token) throw new Error('Play lease lost')
        // Same revision: reuse the running editor instead of relaunching.
        if (slot.revision === revision && fs.existsSync(this.root(id))) return true
        if (this.editorRunning(slot)) {
          if (attempt) throw new Error(`Play slot ${id} editor reopened while switching branches; report it to Genio`)
          return this.markClosing(slot)
        }
        slot.preparing = true; return false
      })
      if (!Array.isArray(ready)) break
      // Another revision is open in this slot: close its editor first so FIFO handoff needs no manual step.
      const closed = await this.finishClose(...ready)
      if (!closed.closed) throw new Error(stuckMessage(id, closed))
    }
    if (ready) return this.root(id)
    const started = Date.now()
    try {
      // Quiet start: a new clone or Library seed waits while the player's Play starts, at most the cap (quiet-start.mjs).
      if (!fs.existsSync(path.join(dest, '.git')) || !fs.existsSync(path.join(this.root(id), 'Library'))) {
        const quiet = await (this.quiet ?? (() => waitForQuiet(this.data)))()
        if (quiet.deferred) await this.check(id, token)
      }
      await checkCopyPath(dest)
      await checkCopyPath(this.root(id))
      const checkout = await checkoutStats(source, revision, gitOptions)
      const commonDir = path.resolve(this.world, await git(this.world, ['rev-parse', '--git-common-dir']))
      let lfsStorage = path.join(commonDir, 'lfs')
      if (checkout.lfs.length) {
        const env = await git(this.world, ['lfs', 'env'])
        lfsStorage = env.match(/^LfsStorageDir=(.+)$/m)?.[1]?.trim()
        if (!lfsStorage || !path.isAbsolute(lfsStorage)) throw new Error('Cannot resolve the project shared LFS store')
      }
      await checkCopyPath(lfsStorage)
      const original = path.join(this.world, this.engineRoot, 'Library')
      const libraryBytes = !fs.existsSync(path.join(this.root(id), 'Library')) && fs.existsSync(original) ? (await treeStats(original, { library: true })).bytes : 0
      const gitBytes = !fs.existsSync(path.join(dest, '.git')) ? (await treeStats(path.join(commonDir, 'objects'), { rejectLinks: false })).bytes : 0
      const missingLfsBytes = checkout.lfs.filter(v => !fs.existsSync(path.join(lfsStorage, 'objects', v.oid.slice(0, 2), v.oid.slice(2, 4), v.oid))).reduce((sum, v) => sum + v.size, 0)
      if (missingLfsBytes) await checkFreeSpace(lfsStorage, missingLfsBytes)
      const space = await checkFreeSpace(dest, checkout.bytes + libraryBytes + gitBytes + missingLfsBytes)
      const preflightMs = Date.now() - started, gitStarted = Date.now()
      if (!fs.existsSync(path.join(dest, '.git'))) await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', this.world, dest], gitOptions)
      this.mark(id)
      // A new --no-checkout clone has an empty index and appears entirely deleted; only a populated slot resets.
      const reset = fs.existsSync(path.join(dest, '.git', 'genio-play-ready')) ? await this.resetSlot(dest, git) : undefined
      // Share bytes, not filesystem links. Configure before checkout so LFS smudge
      // reads the project store rather than fetching another store per slot.
      await git(dest, ['config', '--local', 'lfs.storage', lfsStorage])
      await git(dest, ['fetch', '--', source, revision])
      await this.check(id, token)
      // --force: the slot is Genio's own copy; edits Unity made to tracked files never block a switch.
      await exec('git', [...(checkout.lfs.length ? ['-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true'] : []), 'checkout', '--force', '--detach', revision], { ...gitOptions, cwd: dest, env: { ...gitOptions.env, GIT_LFS_SKIP_SMUDGE: '0' } })
      const submodules = await this.prepareSubmodules(id, dest, source, gitOptions)
      const gitMs = Date.now() - gitStarted
      // A Unity import may write anywhere under these trees. Reject links before
      // opening the editor so a copied project's link cannot reach another world.
      await this.validateCopy(id)
      const library = await seedLibrary(this.root(id), original, { data: this.data, clone: this.clone })
      // Marker lives in .git, never dirties the copied project.
      fs.writeFileSync(path.join(dest, '.git', 'genio-play-ready'), revision)
      const size = await treeStats(dest)
      const preparation = { at: Date.now(), elapsedMs: Date.now() - started, preflightMs, gitMs, ...size, estimatedBytes: checkout.bytes + libraryBytes + gitBytes + missingLfsBytes, ...space, lfsStorage, library, ...(reset ? { reset } : {}), ...(submodules ? { submodules } : {}) }
      await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token !== token) throw new Error('Play lease lost'); slot.revision = revision; slot.preparing = false; slot.preparation = preparation })
      return this.root(id)
    } catch (e) { await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token === token) slot.preparing = false }); throw e }
  }
  /**
   * A clone leaves submodule folders empty (lands-of-old keeps packages there). Check them out from the
   * source's own submodule git dirs; a branch switch touches only submodules whose commit changed. A
   * submodule Unity needs (under the Unity root) that cannot be checked out fails the preparation, so a
   * Library is never seeded into a copy missing packages. undefined when the project has no submodules.
   */
  async prepareSubmodules(id, dest, source, gitOptions) {
    // A removed submodule leaves an untracked checkout behind after a switch: clean it (-ff), never Library.
    if (fs.existsSync(path.join(dest, '.git', 'modules'))) await exec('git', ['clean', '-ffdq', '-e', 'Library/', '-e', 'Temp/', '-e', 'Logs/', '-e', 'UserSettings/'], { ...gitOptions, cwd: dest })
    const report = await initSubmodules(dest, { source, force: true, hooksPath: noHooksPath(this.dir), env: gitOptions.env })
    if (!report.submodules.length && report.ok) return undefined
    const root = this.root(id)
    const needed = report.submodules.filter(s => (s.action === 'failed' || s.action === 'skipped') && path.relative(root, path.join(dest, s.path)).split(/[\\/]/)[0] !== '..')
    if (needed.length) throw new Error(`Play slot ${id} cannot check out the git submodules Unity needs: ${needed.map(s => `${s.path}: ${s.reason}`).join('; ')}`)
    return { elapsedMs: report.elapsedMs, entries: report.submodules.map(s => ({ path: s.path, action: s.action })), ...(report.problems.length ? { problems: report.problems } : {}) }
  }
  /**
   * Unity writes into a slot it opens (.meta files for assets a commit lacks, packages-lock, upgraded
   * ProjectSettings). A Genio-owned slot resets itself instead of refusing the next switch: untracked
   * files are cleaned in the slot's own clone (never the source, never Library/Temp/Logs/UserSettings),
   * and the checkout that follows is forced. Returns what was reset, or undefined when it was clean.
   */
  async resetSlot(dest, git) {
    const changes = (await git(dest, ['status', '--porcelain', '--untracked-files=normal'])).split('\n').filter(Boolean)
    if (!changes.length) return undefined
    // Never a parent repository: the slot must be the top of its own clone.
    if (!fs.existsSync(path.join(dest, '.git')) || canonical(await git(dest, ['rev-parse', '--show-toplevel'])) !== canonical(dest)) throw new Error('Play slot is not its own clone; report it to Genio')
    await git(dest, ['clean', '-fdq', '-e', 'Library/', '-e', 'Temp/', '-e', 'Logs/', '-e', 'UserSettings/'])
    return { at: Date.now(), untracked: changes.filter(l => l.startsWith('??')).length, modified: changes.filter(l => !l.startsWith('??')).length }
  }
  async validateCopy(id) {
    const slot = this.slotDir(id)
    let current = slot
    await checkParents(slot)
    for (const part of this.engineRoot.split(/[\\/]/).filter(Boolean)) { current = path.join(current, part); await checkParents(current) }
    for (const name of ['Assets', 'Packages', 'ProjectSettings', 'Library']) if (fs.existsSync(path.join(current, name))) await treeStats(path.join(current, name))
    async function checkParents(p) { if ((await fs.promises.lstat(p)).isSymbolicLink()) throw new Error('Play root cannot follow a link') }
  }
}
