/**
 * The player's own Play copy: one per project (one per project window), outside the units' Play slots, cap
 * and queue. A record per project at <data>/player-copies/<key>/instance.json names the copy folder, which
 * sits on the project's volume when that volume block clones (like the slots) so the first copy is cheap.
 * The copy follows any source of its project through the git-guided mirror and keeps one Library, seeded
 * once from the main checkout. Copies survive editor and Genio shutdown; cleanup removes unused copies
 * after 24 hours or when their volume is short of space. Unity is never started or stopped here: the lifecycle calls
 * stopped(), due() and editorGone(). Node standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { checkCopyPath, seedLibrary, treeStats } from './unity-seed.mjs'
import { volumeChild, volumeHome, volumePlacement } from '../skills/play/scripts/clone.mjs'
import { applyMirror, describeSource, removeFile, resolveSource, scanSource, sourceMissing, unityVersionOf } from './git-mirror.mjs'
import { waitForQuiet } from './quiet-start.mjs'
const exec = promisify(execFile)

/** What happens to a copy once its editor has quit. Keeping copies is one line: keepCopyWhenEditorQuits: true. */
export const PLAYER_COPY_POLICY = Object.freeze({ keepCopyWhenEditorQuits: true })
export const PLAYER_COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PLAYER_COPY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
/** The editor quits this long after the last Play stopped; its copy stays on disk. */
export const DEFAULT_IDLE_MS = 10 * 60 * 1000
const SUB = 'player-copies'
const MARKER = 'genio-player-copy.json'
const MANIFEST = 'mirror-manifest.json'
const TRASH = 'trash'
const KIND = 'genio-player-copy'

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const key = p => { const v = path.resolve(p); return process.platform === 'win32' ? v.toLowerCase() : v }
const real = p => { try { return key(fs.realpathSync(p)) } catch { return key(p) } }
const inside = (child, parent) => { const r = path.relative(key(parent), key(child)); return r === '' || !r.startsWith('..') && !path.isAbsolute(r) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const yieldNow = () => new Promise(r => setImmediate(r))
const safeVersion = v => typeof v === 'string' && /^[\w.]+$/.test(v) ? v : undefined

/** Process creation time (FILETIME, UTC) so a reused PID is never taken for the Genio that owned a copy. */
export async function processCreated(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return ''
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p -and $p.CreationDate) { $p.CreationDate.ToFileTimeUtc() }`
  try { return (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 })).stdout.trim() } catch { return '' }
}

export class PlayerCopies {
  /**
   * data: Genio's data folder. options: policy, clone (block-clone fixtures), io.copyFile (tests), statfs,
   * system { alive, created }, deletion { concurrency, timeoutMs, retries }, env (git environment),
   * quiet(signal) (the quiet-start wait deletions take before they start and between files; quiet-start.mjs).
   */
  constructor(data, options = {}) {
    this.data = data
    this.dir = path.join(data, SUB)
    this.policy = { ...PLAYER_COPY_POLICY, ...options.policy }
    this.clone = options.clone
    this.io = options.io
    this.statfs = options.statfs
    this.env = options.env
    this.system = { alive, created: processCreated, ...options.system }
    this.deletion = { concurrency: 2, timeoutMs: 30 * 60 * 1000, retries: 6, ...options.deletion }
    this.quiet = options.quiet ?? (signal => waitForQuiet(data, { signal }))
    this.locks = new Map()
    this.syncs = new Map()
    this.jobs = new Map()
    this.trashJobs = new Set()
  }

  keyOf(world) { return createHash('sha256').update(real(world)).digest('hex').slice(0, 24) }
  recordFile(k) { return path.join(this.dir, k, 'instance.json') }
  read(k) {
    try { const r = JSON.parse(fs.readFileSync(this.recordFile(k), 'utf8')); return r && r.version === 1 && typeof r.dir === 'string' ? r : undefined } catch { return undefined }
  }
  write(k, rec) {
    const file = this.recordFile(k), temp = `${file}.${process.pid}.tmp`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify(rec, null, 2))
    fs.renameSync(temp, file)
  }
  /** One operation at a time per project; deletions run outside, so they never hold up a Play. */
  exclusive(k, fn) {
    const run = (this.locks.get(k) ?? Promise.resolve()).then(fn)
    const settled = run.catch(() => {}).finally(() => { if (this.locks.get(k) === settled) this.locks.delete(k) })
    this.locks.set(k, settled)
    return run
  }
  async me() { return this.self ??= { pid: process.pid, created: await this.system.created(process.pid) } }
  async ownerAlive(owner) {
    if (!owner || !Number.isInteger(owner.pid) || !this.system.alive(owner.pid)) return false
    if (!owner.created) return true
    const now = await this.system.created(owner.pid)
    return !now || now === owner.created
  }
  async mine(rec) { const me = await this.me(); return rec.owner?.pid === me.pid && (rec.owner.created ?? '') === me.created }
  async claim(rec) {
    if (rec.owner && !await this.mine(rec) && await this.ownerAlive(rec.owner)) throw new Error(`The player copy of ${rec.project} belongs to another running Genio (PID ${rec.owner.pid})`)
    rec.owner = await this.me()
  }
  markerOk(rec) {
    try { const m = JSON.parse(fs.readFileSync(path.join(rec.dir, MARKER), 'utf8')); return m.kind === KIND && m.id === rec.id } catch { return false }
  }

  /** Every project's record, with live sync or deletion progress. */
  list() {
    let names = []
    try { names = fs.readdirSync(this.dir).filter(n => /^[0-9a-f]{24}$/.test(n)) } catch { return [] }
    return names.map(k => { const r = this.read(k); return r && this.view(k, r) }).filter(Boolean)
  }
  status(world) { const k = this.keyOf(world), r = this.read(k); return r && this.view(k, r) }
  view(k, rec) {
    const sync = this.syncs.get(k)?.progress, deletion = this.jobs.get(k)?.progress
    return { ...rec, key: k, ...(sync ? { progress: { ...sync } } : {}), ...(rec.deletion || deletion ? { deletion: { ...rec.deletion, ...deletion } } : {}) }
  }

  /**
   * The project's copy, created if missing (no files yet: the first sync seeds it). A copy waiting to be
   * deleted is revived instead: re-syncing what was already deleted never costs more than a fresh copy.
   */
  async ensure(world, engineRoot = '') {
    if (path.isAbsolute(engineRoot) || /[:\x00-\x1f]/.test(engineRoot) || engineRoot.split(/[\\/]/).includes('..')) throw new Error('Invalid Unity root')
    if (!fs.existsSync(world)) throw new Error(`Project not found: ${world}`)
    const k = this.keyOf(world)
    return this.exclusive(k, async () => {
      let rec = this.read(k)
      if (rec) {
        await this.claim(rec)
        if (rec.engineRoot !== engineRoot) throw new Error('The project\'s Unity folder changed; delete its player copy first')
        if (rec.state === 'pending-delete' || rec.state === 'deleting') {
          await this.stopDeletion(k)
          rec = this.read(k)
          if (rec && fs.existsSync(rec.dir) && this.markerOk(rec)) {
            await this.claim(rec)
            rec.state = 'ready'; rec.revivedAt = Date.now(); delete rec.deletion; delete rec.stoppedAt; delete rec.deadline
            if (rec.lastSync) rec.lastSync.complete = false
            this.write(k, rec)
            this.purgeTrash(rec)
            return this.view(k, rec)
          }
          if (rec) fs.rmSync(this.recordFile(k), { force: true })
          rec = undefined
        } else {
          if (!fs.existsSync(rec.dir)) this.makeDir(rec)
          else if (!this.markerOk(rec)) throw new Error(`${rec.dir} is not marked as this project's player copy; Genio will not reuse or delete it`)
          if (rec.state === 'syncing' && !this.syncs.has(k)) { rec.state = 'ready'; if (rec.lastSync) rec.lastSync.complete = false }
          this.write(k, rec)
          return this.view(k, rec)
        }
      }
      const volume = await volumePlacement(world, this.dir, this.clone)
      const base = volume ? path.join(volumeHome(this.data, volume), SUB, k) : path.join(this.dir, k)
      const dir = path.join(base, 'copy')
      const name = path.basename(path.resolve(world)).replace(/[^\w .-]/g, '_').replace(/^[ .]+|[ .]+$/g, '') || 'project'
      rec = { version: 1, id: randomUUID(), project: path.resolve(world), engineRoot, dir, root: path.join(dir, name, engineRoot), state: 'ready', createdAt: Date.now(), owner: await this.me(), idleMs: DEFAULT_IDLE_MS }
      // The record comes first: a copy folder never exists without a record that can delete it.
      this.write(k, rec)
      if (fs.existsSync(dir)) this.trashStray(dir)
      this.makeDir(rec)
      return this.view(k, rec)
    })
  }
  makeDir(rec) {
    fs.mkdirSync(rec.dir, { recursive: true })
    fs.writeFileSync(path.join(rec.dir, MARKER), JSON.stringify({ kind: KIND, id: rec.id, project: rec.project, createdAt: rec.createdAt }, null, 2))
  }
  /** A copy folder left without its record: only a marked one is moved aside and deleted. */
  trashStray(dir) {
    let marked = false
    try { marked = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).kind === KIND } catch { /* Unmarked. */ }
    if (!marked) throw new Error(`${dir} exists and is not a Genio player copy; Genio will not use or delete it`)
    const aside = path.join(path.dirname(dir), `${TRASH}-${randomUUID()}`)
    fs.renameSync(dir, aside)
    this.removeInBackground(aside)
  }

  /**
   * Mirror source into the copy: { path } for a checkout of the project, { ref } for a commit without one.
   * Seeds the Library on the first sync. options: signal, onProgress, exclude (Unity-root-relative paths).
   */
  async sync(world, source, options = {}) {
    const k = this.keyOf(world)
    return this.exclusive(k, async () => {
      const rec = this.read(k)
      if (!rec) throw new Error('This project has no player copy; call ensure() first')
      await this.claim(rec)
      if (rec.state !== 'ready' && rec.state !== 'syncing') throw new Error(`The player copy is ${rec.state}; call ensure() first`)
      if (!this.markerOk(rec)) throw new Error(`${rec.dir} is not marked as this project's player copy`)
      await checkCopyPath(rec.root)
      const controller = new AbortController()
      const relay = () => controller.abort()
      options.signal?.addEventListener('abort', relay)
      if (options.signal?.aborted) controller.abort()
      const progress = { phase: 'scanning', startedAt: Date.now() }
      this.syncs.set(k, { controller, progress })
      const started = Date.now()
      rec.state = 'syncing'; this.write(k, rec)
      let described
      try {
        const src = await resolveSource(rec.project, rec.engineRoot, source, { env: this.env })
        described = describeSource(src)
        progress.source = described
        const scan = await scanSource(src, { exclude: options.exclude, env: this.env })
        const mainLibrary = path.join(rec.project, rec.engineRoot, 'Library')
        const seeding = !fs.existsSync(path.join(rec.root, 'Library')) && fs.existsSync(mainLibrary) && unityVersionOf(path.join(rec.project, rec.engineRoot)) === scanVersion(scan)
        const extraBytes = seeding ? (await treeStats(mainLibrary, { library: true, rejectLinks: false })).bytes : 0
        const onProgress = p => { Object.assign(progress, p); options.onProgress?.({ ...progress }) }
        const report = await applyMirror(scan, rec.root, path.join(rec.dir, MANIFEST), { signal: controller.signal, onProgress, beforeApply: options.beforeApply, io: this.io, statfs: this.statfs, extraBytes, exclude: options.exclude, env: this.env })
        onProgress({ phase: 'library', ...(extraBytes ? { bytes: { done: 0, total: extraBytes } } : {}) })
        report.library = await this.prepareLibrary(rec, controller.signal)
        if (controller.signal.aborted) { const e = new Error('Sync cancelled'); e.code = 'ABORT_ERR'; throw e }
        rec.source = described
        rec.lastSync = { at: Date.now(), source: described, complete: true, elapsedMs: Date.now() - started, files: report.files, bytes: report.bytes, restart: report.restart, ...(report.lfs.pointers.length ? { lfsPointers: report.lfs.pointers } : {}), ...(report.warnings.length ? { warnings: report.warnings.slice(0, 20) } : {}) }
        return { ...report, source: described, elapsedMs: Date.now() - started }
      } catch (err) {
        let e = err
        // A source that vanished mid-read (a unit's worktree merged and removed, a deleted branch) is not a
        // fault: the mirror stops before touching the copy, which stays as the previous sync left it.
        // The error keeps its own words (a missing folder, git's refusal); only its code says why.
        if (e?.code !== 'SOURCE_GONE' && await sourceMissing(rec.project, source, { env: this.env })) {
          e = Object.assign(e instanceof Error ? e : new Error(String(e)), { code: 'SOURCE_GONE' })
        }
        rec.lastSync = { at: Date.now(), ...(described ? { source: described } : {}), complete: false, elapsedMs: Date.now() - started, error: e.message, ...(e.code === 'ABORT_ERR' ? { cancelled: true } : {}), ...(e.code === 'SOURCE_GONE' ? { sourceGone: true } : {}) }
        throw e
      } finally {
        options.signal?.removeEventListener('abort', relay)
        this.syncs.delete(k)
        rec.state = 'ready'
        this.write(k, rec)
      }
    })
  }
  /** Stop a running sync between files; the copy is untouched while staging, and the next sync reuses what was staged. */
  cancel(world) { const s = this.syncs.get(this.keyOf(world)); if (s) s.controller.abort(); return !!s }

  /**
   * One Library per copy. After a Unity version change it is renamed to Library@<old> (upgrades are one way)
   * and Library@<new> comes back if an earlier sync kept one; a missing Library is seeded from the main
   * checkout when that runs the same Unity version. Renames fail while an editor holds the folder: deferred.
   */
  async prepareLibrary(rec, signal) {
    const version = unityVersionOf(rec.root)
    const library = path.join(rec.root, 'Library')
    const out = { version }
    const known = rec.library?.version
    try {
      if (fs.existsSync(library) && known && version && known !== version && safeVersion(known)) {
        const stash = path.join(rec.root, `Library@${known}`)
        if (fs.existsSync(stash)) await fs.promises.rm(stash, { recursive: true, force: true, maxRetries: 3 })
        await fs.promises.rename(library, stash)
        out.stashed = known
      }
      const kept = safeVersion(version) && path.join(rec.root, `Library@${version}`)
      if (!fs.existsSync(library) && kept && fs.existsSync(kept)) { await fs.promises.rename(kept, library); out.restored = version }
    } catch (e) { return { ...out, deferred: `the Library folder is in use (${e.code ?? e.message}); restart the editor first` } }
    if (!fs.existsSync(library)) {
      const main = path.join(rec.project, rec.engineRoot)
      // A cancel stops robocopy; the seed stages in the copy's Temp, so nothing half-copied is left as Library.
      const run = this.io?.run ?? ((file, args, options) => exec(file, args, { ...options, signal }))
      if (unityVersionOf(main) === version) {
        try { out.seed = await seedLibrary(rec.root, path.join(main, 'Library'), { data: this.data, clone: this.clone, statfs: this.statfs, run }) }
        catch (e) { if (signal?.aborted) return out; throw e }
      } else out.seed = { seeded: false, reason: 'version-mismatch', elapsedMs: 0 }
    }
    if (fs.existsSync(library)) rec.library = { version, at: Date.now() }
    return out
  }

  /** The last Play stopped at `at`: the editor (and with it the copy) goes idleMs later. */
  async stopped(world, at = Date.now(), idleMs) {
    const k = this.keyOf(world)
    return this.exclusive(k, async () => {
      const rec = this.read(k)
      if (!rec || rec.state === 'pending-delete' || rec.state === 'deleting') return rec && this.view(k, rec)
      if (Number.isFinite(idleMs) && idleMs >= 0) rec.idleMs = idleMs
      rec.stoppedAt = at; rec.deadline = at + (rec.idleMs ?? DEFAULT_IDLE_MS)
      this.write(k, rec)
      return this.view(k, rec)
    })
  }
  /** Play started again: no idle deadline while playing. */
  async playing(world, at = Date.now()) {
    const k = this.keyOf(world)
    return this.exclusive(k, async () => {
      const rec = this.read(k)
      if (!rec || rec.state === 'pending-delete' || rec.state === 'deleting') return rec && this.view(k, rec)
      delete rec.stoppedAt; delete rec.deadline; rec.lastPlayedAt = at
      this.write(k, rec)
      return this.view(k, rec)
    })
  }
  /** Copies whose idle deadline has passed: build 2 quits their editor, then calls editorGone(). */
  due(now = Date.now()) { return this.list().filter(r => r.state === 'ready' && Number.isFinite(r.deadline) && r.deadline <= now) }
  /**
   * The editor has gone. By default every shutdown keeps the copy for a later incremental sync.
   * The legacy policy remains available to scripts; explicit deletion bypasses this hook.
   */
  async editorGone(world, reason = 'the editor quit', { manual = false, at = Date.now(), idleMs } = {}) {
    if (this.policy.keepCopyWhenEditorQuits) return this.exclusive(this.keyOf(world), async () => {
      const k = this.keyOf(world), rec = this.read(k)
      if (!rec) return { kept: true }
      delete rec.stoppedAt; delete rec.deadline
      this.write(k, rec)
      return { kept: true, record: this.view(k, rec) }
    })
    if (manual && idleMs !== 0) {
      const record = await this.stopped(world, at, idleMs)
      if (record && record.state !== 'pending-delete' && record.state !== 'deleting') return { kept: true, record }
      if (!record) return { deleted: true }
    }
    return this.deleteInBackground(world, { reason })
  }

  /**
   * Mark the copy for deletion and delete it in the background, at low priority, never blocking a Play or
   * Genio's exit. Unfinished work (a lock, a timeout, Genio exiting) stays 'pending-delete' for the startup
   * sweep or the next ensure(), which may revive it instead.
   */
  async deleteInBackground(world, { reason = 'requested' } = {}) {
    const k = this.keyOf(world)
    this.syncs.get(k)?.controller.abort()
    const rec = await this.exclusive(k, async () => {
      const rec = this.read(k)
      if (!rec) return undefined
      if (rec.state !== 'deleting') { rec.state = 'pending-delete'; rec.deletion = { reason, requestedAt: Date.now() }; this.write(k, rec) }
      return rec
    })
    if (!rec) return { deleted: true }
    this.startDeletion(k)
    return { deleted: false, record: this.view(k, this.read(k) ?? rec) }
  }
  /** deleteInBackground, awaited: for tests, scripts and the startup sweep's report. */
  async delete(world, options) {
    const k = this.keyOf(world)
    const started = await this.deleteInBackground(world, options)
    if (started.deleted) return started
    await this.jobs.get(k)?.promise
    const rec = this.read(k)
    return rec ? { deleted: false, record: this.view(k, rec) } : { deleted: true }
  }
  startDeletion(k, inUse = () => false) {
    if (this.jobs.has(k)) return this.jobs.get(k)
    const job = { controller: new AbortController(), progress: { phase: 'starting' }, inUse }
    job.promise = this.runDeletion(k, job).catch(() => {}).finally(() => this.jobs.delete(k))
    this.jobs.set(k, job)
    return job
  }
  async stopDeletion(k) { const job = this.jobs.get(k); if (!job) return; job.controller.abort(); await job.promise }

  /** Why this record's folder must not be deleted, or undefined when it is safe. */
  refusal(k, rec) {
    const dir = path.resolve(rec.dir)
    if (!path.isAbsolute(rec.dir) || path.basename(dir) !== 'copy' || path.basename(path.dirname(dir)) !== k) return 'its folder is not a player-copy folder'
    if (!inside(dir, this.dir) && volumeChild(dir, this.data, SUB) !== k) return 'its folder is outside Genio\'s player-copy area'
    if (inside(dir, rec.project) || inside(rec.project, dir)) return 'its folder overlaps the project'
    if (!fs.existsSync(dir)) return undefined
    try { if (fs.lstatSync(dir).isSymbolicLink()) return 'its folder is a link' } catch { return undefined }
    if (!this.markerOk(rec)) return 'its folder has no matching Genio marker'
    // The copy is never a git checkout: a .git at its top or its project folder means this is not Genio's copy.
    const name = path.relative(dir, path.resolve(rec.root)).split(/[\\/]/)[0]
    if (!name || name === '..' || !inside(rec.root, dir)) return 'its Unity folder is outside it'
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, name, '.git'))) return 'its folder looks like a git checkout'
    return undefined
  }
  /** PIDs of a Unity editor that has the copy open (its instance file, Pipeline descriptor or held lockfile). */
  editorPids(root) {
    const pids = []
    for (const [file, field] of [['Library/EditorInstance.json', 'process_id'], ['Library/Pipeline/.unity-pipeline-port', 'pid']]) {
      try { const v = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))[field]; if (Number.isInteger(v) && v > 0 && this.system.alive(v)) pids.push(v) } catch { /* Not recorded. */ }
    }
    const lock = path.join(root, 'Temp', 'UnityLockfile')
    if (!pids.length && fs.existsSync(lock)) { try { fs.closeSync(fs.openSync(lock, 'r+')) } catch (e) { if (e.code === 'EBUSY' || e.code === 'EPERM') pids.push(0) } }
    return [...new Set(pids)]
  }

  async runDeletion(k, job) {
    if (!this.read(k)) return
    // Quiet start: a deletion waits while a Play starts (at most the cap), and pauses between files below.
    await this.quiet(job.controller.signal)
    let rec = this.read(k)
    if (!rec || job.controller.signal.aborted) return
    if (job.inUse(rec) || this.syncs.has(k)) return
    const save = patch => { const now = this.read(k); if (!now || now.id !== rec.id) return; rec = { ...now, ...patch }; this.write(k, rec) }
    const refusal = this.refusal(k, rec)
    if (refusal) { save({ state: 'pending-delete', deletion: { ...rec.deletion, blocked: `Genio will not delete ${rec.dir}: ${refusal}` } }); return }
    const editor = fs.existsSync(rec.dir) ? this.editorPids(rec.root) : []
    if (editor.length) { save({ state: 'pending-delete', deletion: { ...rec.deletion, blocked: `Unity still has the copy open${editor.some(Boolean) ? ` (PID ${editor.filter(Boolean).join(', ')})` : ''}` } }); return }
    save({ state: 'deleting', deletion: { ...rec.deletion, startedAt: Date.now(), blocked: undefined, error: undefined } })
    const p = job.progress
    // Time spent paused for a Play start does not count toward the timeout.
    let deadline = Date.now() + this.deletion.timeoutMs
    const pause = async () => { deadline += (await this.quiet(job.controller.signal)).waitedMs }
    let persisted = Date.now(), editorChecked = 0
    const tick = () => {
      // Lifecycle use is checked on every file; external editor metadata is sampled once a second.
      let editorRunning = false
      if (Date.now() - editorChecked >= 1000) { editorChecked = Date.now(); editorRunning = this.editorPids(rec.root).length > 0 }
      if (job.controller.signal.aborted || job.inUse(rec) || this.syncs.has(k) || editorRunning) { const e = new Error('Deletion stopped: the copy is in use or was revived'); e.code = 'ABORT_ERR'; throw e }
      if (Date.now() > deadline) { const e = new Error('Deletion timed out; it continues at the next start'); e.code = 'ETIMEDOUT'; throw e }
      if (Date.now() - persisted > 5000) { persisted = Date.now(); save({ deletion: { ...rec.deletion, ...p } }) }
    }
    try {
      if (fs.existsSync(rec.dir)) {
        const total = await sizeTree(rec.dir)
        Object.assign(p, { phase: 'mirror', bytesTotal: total.bytes, filesTotal: total.files, bytesLeft: total.bytes, filesLeft: total.files })
        const opts = { tick, pause, progress: p, concurrency: this.deletion.concurrency, retries: this.deletion.retries }
        // The project files go first: a revived copy re-syncs them. Each Library moves aside whole before
        // its files go, so a revived copy never opens a half-deleted Library.
        const libraries = await libraryDirs(rec.root)
        await deleteTree(rec.root, opts, rel => libraries.includes(rel.split('/')[0]))
        p.phase = 'library'
        const trash = path.join(rec.dir, TRASH)
        for (const name of libraries) {
          tick()
          fs.mkdirSync(trash, { recursive: true })
          await renameRetry(path.join(rec.root, name), path.join(trash, `${name.replace(/[^\w.@-]/g, '_')}-${randomUUID()}`), this.deletion.retries)
        }
        await deleteTree(trash, opts)
        p.phase = 'finishing'
        await deleteTree(rec.dir, opts, rel => rel === MARKER || rel === MANIFEST)
        await removeFile(path.join(rec.dir, MANIFEST), { retries: this.deletion.retries })
        await removeFile(path.join(rec.dir, MARKER), { retries: this.deletion.retries })
        await rmdirRetry(rec.dir, this.deletion.retries)
      }
      fs.rmSync(this.recordFile(k), { force: true })
      for (const d of [path.join(this.dir, k), path.dirname(rec.dir)]) { try { fs.rmdirSync(d) } catch { /* Not empty or gone. */ } }
      p.phase = 'done'
    } catch (e) {
      save({ state: 'pending-delete', deletion: { ...rec.deletion, ...p, phase: 'stopped', ...(e.code === 'ABORT_ERR' ? {} : { error: e.message }) } })
      if (e.code !== 'ABORT_ERR' && e.code !== 'ETIMEDOUT') throw e
    }
  }
  /** Leftovers of a revived copy's deletion: deleted in the background, outside the project tree. */
  purgeTrash(rec) {
    let names = []
    try { names = fs.readdirSync(rec.dir).filter(n => n === TRASH) } catch { return }
    for (const n of names) this.removeInBackground(path.join(rec.dir, n))
  }
  removeInBackground(dir) {
    const run = this.quiet().then(() => deleteTree(dir, { tick: () => {}, pause: () => this.quiet(), concurrency: this.deletion.concurrency, retries: this.deletion.retries })).then(() => rmdirRetry(dir, this.deletion.retries)).catch(() => {})
    this.trashJobs.add(run); run.finally(() => this.trashJobs.delete(run))
  }
  /** Waits for every background deletion this process started. */
  async settle() { while (this.jobs.size || this.trashJobs.size) await Promise.all([...[...this.jobs.values()].map(j => j.promise), ...this.trashJobs]) }

  /**
   * Reclaim unused copies, oldest Play first. Never-played copies age from creation. Check space on
   * each copy's own volume, and remeasure after each deletion (estimates cannot account for block clones).
   * isInUse is live, not a startup snapshot: a queued Play or launch protects the copy immediately.
   */
  async cleanup({ now = Date.now(), isInUse = () => false } = {}) {
    const playedAt = rec => Number.isFinite(rec.lastPlayedAt) ? rec.lastPlayedAt : rec.createdAt
    const out = []
    for (const candidate of this.list().sort((a, b) => playedAt(a) - playedAt(b))) {
      const k = candidate.key
      if (this.locks.has(k) || this.syncs.has(k) || this.jobs.has(k) || isInUse(candidate)) continue
      const job = await this.exclusive(k, async () => {
        const rec = this.read(k)
        if (!rec || rec.id !== candidate.id || this.syncs.has(k) || isInUse(rec)) return
        if (!await this.mine(rec) && await this.ownerAlive(rec.owner)) return
        const expired = playedAt(rec) < now - PLAYER_COPY_MAX_AGE_MS
        let low = false
        if (!expired) {
          try {
            const stat = await (this.statfs ?? fs.promises.statfs)(rec.dir, { bigint: true })
            const free = Number(stat.bavail) * Number(stat.bsize), total = Number(stat.blocks) * Number(stat.bsize)
            low = free < 15 * 2 ** 30 || total > 0 && free / total < 0.1
          } catch { /* An unavailable volume is not a reason to delete a recent copy. */ }
        }
        // The checks above can yield to a new lifecycle operation. Recheck before marking anything.
        if ((!expired && !low) || isInUse(rec) || this.syncs.has(k) || this.editorPids(rec.root).length) return
        rec.owner = await this.me()
        if (isInUse(rec)) return
        rec.state = 'pending-delete'
        rec.deletion = { reason: expired ? 'not played for 24 hours' : 'low disk space', requestedAt: now }
        this.write(k, rec)
        return this.startDeletion(k, isInUse)
      })
      if (job) {
        await job.promise
        out.push({ key: k, project: candidate.project, deleted: !this.read(k) })
      }
    }
    return out
  }

  /**
   * At Genio's start: finish pending deletions, adopt copies whose owning Genio is gone, and remove marked folders left without
   * a record. Runs in the background; returns what it started.
   */
  async sweep({ protectedKeys = [], isInUse = () => false } = {}) {
    const out = []
    let names = []
    try { names = fs.readdirSync(this.dir).filter(n => /^[0-9a-f]{24}$/.test(n)) } catch { return out }
    for (const k of names) {
      if (protectedKeys.includes(k)) { out.push({ key: k, action: 'kept' }); continue }
      const rec = this.read(k)
      if (!rec) {
        const copy = path.join(this.dir, k, 'copy')
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(copy, MARKER), 'utf8'))
          const editor = fs.readdirSync(copy, { withFileTypes: true }).filter(e => e.isDirectory()).some(e => this.editorPids(path.join(copy, e.name)).length)
          if (marker.kind === KIND && !editor && !isInUse(marker)) { this.removeInBackground(copy); out.push({ key: k, action: 'stray-deleted' }) }
        } catch { /* Nothing marked here. */ }
        continue
      }
      if (this.locks.has(k) || this.syncs.has(k) || isInUse(rec)) { out.push({ key: k, action: 'kept' }); continue }
      if (!await this.mine(rec) && await this.ownerAlive(rec.owner)) { out.push({ key: k, project: rec.project, action: 'owned', pid: rec.owner.pid }); continue }
      const listing = dir => { try { return fs.readdirSync(dir) } catch { return [] } }
      // Folders moved aside by an earlier copy of this project.
      for (const n of listing(path.dirname(rec.dir))) if (n.startsWith(`${TRASH}-`)) this.removeInBackground(path.join(path.dirname(rec.dir), n))
      if (rec.state === 'pending-delete' || rec.state === 'deleting') { this.startDeletion(k, isInUse); out.push({ key: k, project: rec.project, action: 'deleting' }); continue }
      if (await this.mine(rec)) { this.purgeTrash(rec); continue }
      if (await this.ownerAlive(rec.owner)) { out.push({ key: k, project: rec.project, action: 'owned', pid: rec.owner.pid }); continue }
      const editor = fs.existsSync(rec.dir) ? this.editorPids(rec.root) : []
      if (editor.length) { out.push({ key: k, project: rec.project, action: 'editor-running', pids: editor.filter(Boolean) }); continue }
      if (this.policy.keepCopyWhenEditorQuits) { rec.owner = await this.me(); if (rec.state === 'syncing') rec.state = 'ready'; this.write(k, rec); out.push({ key: k, project: rec.project, action: 'kept' }); continue }
      rec.state = 'pending-delete'; rec.deletion = { reason: 'its Genio session ended', requestedAt: Date.now() }; rec.owner = await this.me()
      this.write(k, rec)
      this.startDeletion(k)
      out.push({ key: k, project: rec.project, action: 'deleting' })
    }
    return out
  }

  /**
   * Disk used by the project's copy, by part; without a copy, the first copy's estimate (the source's
   * files under the Unity root plus the main checkout's seedable Library).
   */
  async sizes(world, engineRoot = '') {
    const rec = this.read(this.keyOf(world))
    if (rec && fs.existsSync(rec.dir)) {
      const parts = { projectBytes: 0, libraryBytes: 0, stashBytes: 0, trashBytes: 0, files: 0 }
      const root = path.resolve(rec.root), top = path.resolve(rec.dir)
      // Which part a folder's files count toward: set once at Library, Library@<version> or trash.
      const partOf = (parent, name) => parent === root && /^library$/i.test(name) ? 'libraryBytes' : parent === root && /^library@/i.test(name) ? 'stashBytes' : parent === top && name.startsWith(TRASH) ? 'trashBytes' : undefined
      const walk = async (dir, part) => {
        let entries = []
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) await walk(p, part ?? partOf(dir, e.name))
          else if (e.isFile()) { parts[part ?? 'projectBytes'] += (await fs.promises.lstat(p)).size; parts.files++ }
        }
      }
      await walk(top)
      return { exists: true, state: rec.state, ...parts, totalBytes: parts.projectBytes + parts.libraryBytes + parts.stashBytes + parts.trashBytes, ...(this.jobs.get(this.keyOf(world)) ? { deletion: { ...this.jobs.get(this.keyOf(world)).progress } } : {}) }
    }
    const scan = await scanSource(await resolveSource(world, engineRoot, { path: world }, { env: this.env }), { env: this.env })
    let projectBytes = 0
    for (const e of scan.entries.values()) projectBytes += e.size
    const library = path.join(world, engineRoot, 'Library')
    const libraryBytes = fs.existsSync(library) ? (await treeStats(library, { library: true, rejectLinks: false })).bytes : 0
    return { exists: false, estimate: { projectBytes, libraryBytes, totalBytes: projectBytes + libraryBytes, files: scan.entries.size } }
  }
}

function scanVersion(scan) {
  const e = scan.entries.get('ProjectSettings/ProjectVersion.txt')
  if (e?.kind !== 'file') return undefined
  try { return fs.readFileSync(e.abs, 'utf8').match(/^m_EditorVersion:\s*(\S+)/m)?.[1] } catch { return undefined }
}

async function libraryDirs(root) {
  try { return (await fs.promises.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && /^library(@.*)?$/i.test(e.name)).map(e => e.name) } catch { return [] }
}

async function sizeTree(dir) {
  let bytes = 0, files = 0
  const visit = async d => {
    let entries = []
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await visit(p)
      else { files++; if (e.isFile()) bytes += (await fs.promises.lstat(p).catch(() => ({ size: 0 }))).size }
    }
  }
  await visit(dir)
  return { bytes, files }
}

/**
 * Delete everything under dir (links removed, never followed), files a few at a time, folders after their
 * files. skip(rel) keeps top-level entries. Progress counts down bytesLeft and filesLeft. pause() runs every
 * 64 files, so a Play starting stops the deletion between files until it is ready.
 */
async function deleteTree(dir, { tick, pause, progress, concurrency = 2, retries = 6 }, skip) {
  // One pause holds every worker.
  let since = 0, gate
  const visit = async (d, rel) => {
    let entries
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    const files = [], dirs = []
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && skip?.(r)) continue
      if (e.isDirectory()) dirs.push(e.name); else files.push(e.name)
    }
    let next = 0
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (next < files.length) {
        while (gate) await gate
        if (next >= files.length) break
        tick()
        const p = path.join(d, files[next++])
        const size = (await fs.promises.lstat(p).catch(() => undefined))?.size ?? 0
        await removeFile(p, { retries })
        if (progress) { progress.bytesLeft = Math.max(0, (progress.bytesLeft ?? 0) - size); progress.filesLeft = Math.max(0, (progress.filesLeft ?? 0) - 1) }
        if (++since % 64 === 0) {
          await yieldNow()
          if (pause && !gate) { gate = pause().finally(() => { gate = undefined }); await gate }
        }
      }
    }))
    for (const name of dirs) {
      tick()
      await visit(path.join(d, name), rel ? `${rel}/${name}` : name)
      await rmdirRetry(path.join(d, name), retries)
    }
  }
  await visit(dir, '')
}

async function rmdirRetry(dir, retries) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rmdir(dir); return } catch (e) {
      if (e.code === 'ENOENT') return
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) || attempt >= retries) throw e
      await sleep(Math.min(2000, 50 * 2 ** attempt))
    }
  }
}

async function renameRetry(from, to, retries) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return } catch (e) {
      if (e.code === 'ENOENT') return
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || attempt >= retries) throw e
      await sleep(Math.min(2000, 50 * 2 ** attempt))
    }
  }
}
