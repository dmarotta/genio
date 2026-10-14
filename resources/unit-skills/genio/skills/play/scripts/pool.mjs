import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { checkCopyPath, checkFreeSpace, seedLibrary, treeStats } from '../../../lib/unity-seed.mjs'
import { assertMounted, volumeHome, volumeMissing, volumePlacement } from './clone.mjs'
const exec = promisify(execFile)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const canonical = p => { const v = fs.realpathSync(p); return process.platform === 'win32' ? v.toLowerCase() : v }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const LEASE_MS = 30000
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
    this.closes = new Set()
    fs.mkdirSync(this.dir, { recursive: true })
  }
  /** Folder holding slot-N copies. Decided once per pool by place(); until then, the pool folder. */
  slots() {
    if (this.slotsDir) return this.slotsDir
    try {
      const { dir } = JSON.parse(fs.readFileSync(path.join(this.dir, 'placement.json'), 'utf8'))
      // A placement on a detached volume falls back to the pool folder rather than failing every call.
      if (typeof dir === 'string' && path.isAbsolute(dir) && !volumeMissing(dir)) return (this.slotsDir = dir)
    } catch { /* Not placed yet. */ }
    return this.dir
  }
  slotDir(id) { return path.join(this.slots(), `slot-${id}`) }
  /**
   * Block cloning needs the copies on the project's volume. When the project sits on a Dev Drive (or other
   * block-cloning volume) apart from Genio's data, slots go to <volume>/.genio/<key>/play-pools/<pool>.
   * Decided once, before the first slot exists, and shared by every process through placement.json.
   */
  async place() {
    const file = path.join(this.dir, 'placement.json')
    if (fs.existsSync(file)) return this.slots()
    // Probed once per process; an unplaced pool keeps using the pool folder.
    return this.placing ??= (async () => {
      let dir = this.dir
      if (!fs.readdirSync(this.dir).some(n => /^slot-\d+$/.test(n))) {
        const volume = await volumePlacement(this.world, this.dir, this.clone)
        if (!volume) return this.dir
        dir = path.join(volumeHome(this.data, volume), 'play-pools', path.basename(this.dir))
        try { fs.mkdirSync(dir, { recursive: true }) } catch { dir = this.dir }
      }
      try { fs.writeFileSync(file, JSON.stringify({ dir, at: Date.now() }), { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') return this.dir }
      return this.slots()
    })()
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
    for (const mark of reclaimed) { const p = this.finishClose(...mark).catch(() => {}); this.closes.add(p); p.finally(() => this.closes.delete(p)) }
    return result
  }
  /** Waits for background closes this process started (reclaimed slots). */
  async settle() { while (this.closes.size) await Promise.all([...this.closes]) }
  endLease(state, slot) {
    if (slot.lease?.since) state.durations = [...(state.durations ?? []), Date.now() - slot.lease.since].slice(-10)
    delete slot.lease
  }
  markClosing(slot) {
    const token = randomUUID()
    slot.closing = { pid: process.pid, token, expires: Date.now() + this.graceMs + this.forceMs + 120000 }
    return [slot.id, slot.editor?.pid, token]
  }
  root(id) { if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('Invalid Play slot'); return path.join(this.slotDir(id), this.engineRoot) }
  async state() {
    return this.transaction(s => ({ cap: s.cap, slots: s.slots.map(v => {
      const editor = this.editorRunning(v)
      const draining = this.draining(s, v, editor)
      return { id: v.id, root: this.root(v.id), revision: v.revision, owner: v.lease?.owner, expires: v.lease?.expires, preparing: v.preparing, preparation: v.preparation, editor, closing: !!v.closing, stuck: v.stuck && { reason: v.stuck.reason, pids: v.stuck.pids, at: v.stuck.at }, draining, retired: v.id > s.cap && !draining }
    }), queue: s.queue.map(q => q.owner) }))
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
  async check(id, token) { return this.transaction(s => { const v = s.slots.find(v => v.id === id); if (!v?.lease || v.lease.token !== token) throw new Error('Play lease lost; stop controlling this editor'); v.lease.expires = Date.now() + LEASE_MS; return this.root(id) }) }
  /** Records the editor this lease launched, so a later close stops exactly that process tree. */
  async recordEditor(id, token, pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid editor process')
    return this.transaction(s => { const v = s.slots.find(v => v.id === id); if (v?.lease?.token !== token) throw new Error('Play lease lost'); v.editor = { pid, owner: v.lease.owner, at: Date.now() } })
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
  async finishClose(id, launched, token) {
    let result
    try { result = await this.closeEditor(id, launched) } catch (e) { result = { closed: false, pids: [], reason: `could not inspect slot processes (${e.message})` } }
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
  async closeEditor(id, launched) {
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
      if (!p.command) unknown.push(pid)
      else if (mentionsRoot(p.command, root)) editors.push(p)
    }
    // Stale records (exited editor, reused PID) are not this slot's editor and are never touched.
    if (!editors.length && unknown.length) return { closed: false, pids: unknown, reason: 'a recorded process could not be verified as this slot editor' }
    if (!editors.length) return this.clearEditorFiles(root, [], false)
    let targets = this.tree(before, editors, root, guard)
    if (!await this.quitViaPipeline(root, editors.map(e => e.pid))) for (const e of editors) await this.system.terminate(e.pid).catch(() => {})
    if (await this.gone(targets, this.graceMs)) return this.clearEditorFiles(root, targets.map(t => t.pid), false)
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
  async gone(targets, ms) {
    const deadline = Date.now() + ms
    while (targets.some(t => alive(t.pid))) { if (Date.now() >= deadline) return false; await sleep(250) }
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
    for (let id = 1; id <= 8; id++) { const dir = path.join(this.dir, `slot-${id}`); if (fs.existsSync(dir)) out[id] = await bytesUnder(dir) }
    return out
  }
  async prepare(id, token, source = this.world) {
    await this.check(id, token)
    // Source must be the registered repository or one of its git worktrees.
    const gitOptions = { windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(this.dir, 'no-hooks') } }
    const git = async (cwd, args) => (await exec('git', args, { ...gitOptions, cwd })).stdout.trim()
    const common = async cwd => canonical(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])))
    if (await common(source) !== await common(this.world)) throw new Error('Play source must belong to the registered project')
    const revision = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const dest = this.slotDir(id)
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
      const gitBytes = !fs.existsSync(dest) ? (await treeStats(path.join(commonDir, 'objects'), { rejectLinks: false })).bytes : 0
      const missingLfsBytes = checkout.lfs.filter(v => !fs.existsSync(path.join(lfsStorage, 'objects', v.oid.slice(0, 2), v.oid.slice(2, 4), v.oid))).reduce((sum, v) => sum + v.size, 0)
      if (missingLfsBytes) await checkFreeSpace(lfsStorage, missingLfsBytes)
      const space = await checkFreeSpace(dest, checkout.bytes + libraryBytes + gitBytes + missingLfsBytes)
      const preflightMs = Date.now() - started, gitStarted = Date.now()
      if (!fs.existsSync(dest)) await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', this.world, dest], gitOptions)
      if (await git(dest, ['status', '--porcelain', '--untracked-files=normal'])) {
        // A new --no-checkout clone has an empty index and appears entirely deleted.
        const populated = fs.existsSync(path.join(dest, '.git', 'genio-play-ready'))
        if (populated) throw new Error('Play slot has local changes; preserve them before switching branches')
      }
      // Share bytes, not filesystem links. Configure before checkout so LFS smudge
      // reads the project store rather than fetching another store per slot.
      await git(dest, ['config', '--local', 'lfs.storage', lfsStorage])
      await git(dest, ['fetch', '--', source, revision])
      await this.check(id, token)
      await exec('git', [...(checkout.lfs.length ? ['-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true'] : []), 'checkout', '--detach', revision], { ...gitOptions, cwd: dest, env: { ...gitOptions.env, GIT_LFS_SKIP_SMUDGE: '0' } })
      const gitMs = Date.now() - gitStarted
      // A Unity import may write anywhere under these trees. Reject links before
      // opening the editor so a copied project's link cannot reach another world.
      await this.validateCopy(id)
      const library = await seedLibrary(this.root(id), original, { data: this.data, clone: this.clone })
      // Marker lives in .git, never dirties the copied project.
      fs.writeFileSync(path.join(dest, '.git', 'genio-play-ready'), revision)
      const size = await treeStats(dest)
      const preparation = { at: Date.now(), elapsedMs: Date.now() - started, preflightMs, gitMs, ...size, estimatedBytes: checkout.bytes + libraryBytes + gitBytes + missingLfsBytes, ...space, lfsStorage, library }
      await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token !== token) throw new Error('Play lease lost'); slot.revision = revision; slot.preparing = false; slot.preparation = preparation })
      return this.root(id)
    } catch (e) { await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token === token) slot.preparing = false }); throw e }
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
