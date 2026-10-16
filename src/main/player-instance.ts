import fs from 'node:fs'
import path from 'node:path'
import type { AppCtx } from './services'
import { effectiveEngine } from '@shared/engine'
import { decodeBytes, lineStart } from '@shared/encoding'
import { sameSource, sourceGoneText, supportsUnitySlots, type PlayerCopySource, type PlayerInstanceStatus, type PlayerMachineStatus, type PlayerScene, type PlayerSettings, type PlayerSourceGone, type PlayInput } from '@shared/play'
import { PlayerCopies, PLAYER_COPY_CLEANUP_INTERVAL_MS, processCreated } from '../../resources/unit-skills/genio/lib/player-copy.mjs'
import { createDesktopApi, inspectDesktop, launchEditor, type DesktopApi, type EditorLaunch } from '../../resources/unit-skills/genio/lib/hidden-desktop.mjs'
import { sourceMissing, unityVersionOf } from '../../resources/unit-skills/genio/lib/git-mirror.mjs'
import { checkCopyPath } from '../../resources/unit-skills/genio/lib/unity-seed.mjs'
import { editorHolders, editorSeatsDir } from '../../resources/unit-skills/genio/lib/unity-editors.mjs'
import { poolDirectory } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { playerCopyService } from './player-copy'
import { playService } from './play'
import { UnityAdapter } from './play-unity'
import { PlayStream } from './play-stream'
import { biggestConsumers, closePlayerRoot, opensRoot, playerSystem, playerTree, sameProcess, type PlayerProcess, type PlayerSystem } from './player-process'
import { repoTop, sameFolder } from './git'
import { leaseSource, onSourceRemoved, type SourceLease } from './source-leases'

const GiB = 2 ** 30
/** First-run estimate until a session teaches the project's steady working set, and the RAM kept back on top. */
const FIRST_RUN_ESTIMATE = 6 * GiB, RESERVE = GiB
/** Admission refusals: the state stays until Play, Start anyway or Cancel. */
const REFUSED: readonly string[] = ['low-memory', 'missing-editor', 'limit-reached']
const QUIT = 'UnityEditor.EditorApplication.delayCall += () => UnityEditor.EditorApplication.Exit(0); return true;'
interface Instance extends PlayerInstanceStatus {
  /** sampled: this session has recorded a steady working set, so later samples raise it instead of replacing it. */
  owner: { pid: number; created: string }; launch?: EditorLaunch; tracked: PlayerProcess[]; sampled?: boolean
}
/** A Genio slot editor no unit holds; closing it loses no work. */
export interface IdleEditor { label: string; close(): Promise<unknown> }
async function idleSlotEditors(ctx: AppCtx): Promise<IdleEditor[]> {
  const play = playService(ctx), out: IdleEditor[] = []
  for (const p of ctx.projects.list()) {
    try {
      if (!supportsUnitySlots(effectiveEngine(p).engine) || !fs.existsSync(poolDirectory(ctx.main.home.data, p.path))) continue
      for (const s of (await play.pool(p.name).state()).slots) if (s.editor && !s.owner && !s.preparing && !s.closing && !s.stuck)
        out.push({ label: `${p.name} slot ${s.id} editor`, close: () => play.closeSlotEditor(p.name, s.id, 'genio') })
    } catch { /* project folder missing or its pool busy */ }
  }
  return out
}
const gb = (bytes: number) => (bytes / GiB).toFixed(1)
/** Regular closes retain the copy; a restart inside a sync must not acquire the copy's lock again. */
type CopyAfterClose = 'delete' | 'keep' | 'restart'
export interface PlayerRuntime {
  request<T = unknown>(command: string, parameters?: object): Promise<T>
  stream(width: number, height: number, onFrame: (b: Buffer) => void, onDisconnect: () => void): Promise<void>
  /** A new stream size behind the same frame and disconnect callbacks, so the renderer's port and Play stay. */
  resize(width: number, height: number): Promise<void>
  stopStream(): void
  input(input: PlayInput): void
}
export interface PlayerInstanceOptions {
  copies?: PlayerCopies; system?: PlayerSystem; desktop?: DesktopApi
  launch?: typeof launchEditor; executable?: (version: string) => string | undefined
  runtime?: (root: string, pid: () => number | undefined) => PlayerRuntime
  ownerCreated?: () => Promise<string>; readyMs?: number; graceMs?: number; forceMs?: number
  idleSlots?: () => Promise<IdleEditor[]>
}
function runtime(root: string, pid: () => number | undefined): PlayerRuntime {
  const adapter = new UnityAdapter(root, async () => {}, pid)
  let stream: PlayStream | undefined
  const connect = async (next: PlayStream, width: number, height: number) => {
    const credentials = await next.listen()
    await adapter.request('genio_set_resolution', { width, height }); await adapter.request('genio_stream_start', { ...credentials, width, height })
  }
  return {
    request: (command, parameters) => adapter.request(command, parameters),
    async stream(width, height, onFrame, onDisconnect) {
      stream?.close(); const next = stream = new PlayStream()
      next.onFrame = onFrame; next.onDisconnect = onDisconnect
      try { await connect(next, width, height) }
      catch (e) { next.close(); if (stream === next) stream = undefined; throw e }
    },
    async resize(width, height) {
      const old = stream
      if (!old) throw new Error('Start the player stream first')
      const { onFrame, onDisconnect } = old, next = stream = new PlayStream()
      next.onFrame = onFrame; next.onDisconnect = onDisconnect
      // Unity drops the old session when the new one starts: a swap, not a disconnect that would exit Play.
      old.onDisconnect = undefined
      try { await connect(next, width, height); old.close() }
      catch (e) {
        next.close(); old.onDisconnect = onDisconnect
        if (stream === next) stream = old
        if (!old.connected) { old.close(); if (stream === old) stream = undefined; onDisconnect?.() }
        throw e
      }
    },
    stopStream() { stream?.close(); stream = undefined },
    input(input) { if (!stream && input.type === 'release') return; if (!stream) throw new Error('Start the player stream first'); stream.input(input) }
  }
}
function checkScene(scene: string) {
  if (typeof scene !== 'string' || !/^Assets\/.+\.unity$/.test(scene) || scene.split('/').includes('..') || scene.includes('\\')) throw new Error('Invalid scene path')
}
/** EditorBuildSettings.asset's scene list, in build order. */
function buildScenes(root: string): { path: string; enabled: boolean }[] {
  try {
    const text = fs.readFileSync(path.join(root, 'ProjectSettings/EditorBuildSettings.asset'), 'utf8')
    return [...text.matchAll(/-\s+enabled:\s*(\d)\s*\r?\n\s+path:\s*(.+?)\s*$/gm)].map(m => ({ path: m[2], enabled: m[1] === '1' }))
  } catch { return [] }
}
/** Every scene file under Assets, skipping the folders Unity ignores (hidden and ~ suffixed) and links. */
function sceneFiles(root: string, limit = 2000): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= limit || e.name.startsWith('.') || e.name.endsWith('~')) continue
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (e.isFile() && e.name.endsWith('.unity')) out.push(child)
    }
  }
  walk('Assets')
  return out.sort((a, b) => a.localeCompare(b))
}
function sceneList(build: { path: string; enabled?: boolean }[], files: string[], open: { path: string; isActive?: boolean }[]): PlayerScene[] {
  const scenes = new Map<string, PlayerScene>()
  const add = (p: string, extra: Partial<PlayerScene>) => {
    try { checkScene(p) } catch { return }
    scenes.set(p, { ...scenes.get(p), path: p, name: path.posix.basename(p, '.unity'), ...extra })
  }
  for (const s of build) add(s.path, { inBuild: true, enabled: s.enabled !== false })
  for (const f of files) if (!scenes.has(f)) add(f, {})
  for (const s of open) if (scenes.has(s.path)) add(s.path, { open: true, ...(s.isActive ? { active: true } : {}) })
  return [...scenes.values()]
}

/** Main-process owner of one player editor per project window. Units' slots and the main editor are independent. */
export class PlayerInstanceService {
  readonly copies: PlayerCopies
  private instances = new Map<string, Instance>()
  private runtimes = new Map<string, PlayerRuntime>()
  private operations = new Map<string, Promise<unknown>>()
  private generations = new Map<string, number>()
  private controllers = new Map<string, AbortController>()
  private launches: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private cleanupTimer?: ReturnType<typeof setInterval>
  private cleanupRun?: Promise<unknown>
  private polling = false
  private exiting = false
  private startup?: Promise<void>
  private system: PlayerSystem
  private desktop: DesktopApi
  private data: string
  private settings: PlayerSettings
  private unlisten: () => void
  constructor(private ctx: AppCtx, private options: PlayerInstanceOptions = {}) {
    this.data = ctx.main.home.data
    this.copies = options.copies ?? playerCopyService(ctx).copies
    this.system = options.system ?? playerSystem
    this.desktop = options.desktop ?? createDesktopApi(this.data)
    this.settings = { idleMinutes: 10, maxEditors: 2 }
    try { this.settings = this.validate(JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8'))) } catch { /* defaults */ }
    // Genio removed a unit's worktree: an instance playing from it notes that at once (a running sync has its lease).
    this.unlisten = onSourceRemoved(dir => { for (const i of this.instances.values()) this.noteRemoved(i, dir) })
  }
  /** The unit whose worktree a checkout source is, in any state (merged and despawned included). */
  private unitOf(source: PlayerCopySource) {
    if (!('path' in source)) return undefined
    try { return [...(this.ctx.homes?.values() ?? [])].flatMap(h => h.crew.list()).find(t => !!t.worktree && sameFolder(t.worktree, source.path)) } catch { return undefined }
  }
  private gone(source: PlayerCopySource, when: PlayerSourceGone['when']): PlayerSourceGone {
    const t = this.unitOf(source)
    const merged = !!t && (t.state === 'merged' || !!t.landedCommit || /landed/.test(t.stateReason ?? ''))
    return { when, at: this.system.now(), ...(t ? { unit: t.title, merged, base: t.baseBranch } : {}) }
  }
  /** The main checkout, the fallback when a chosen source is gone. */
  private async mainSource(project: string): Promise<PlayerCopySource> {
    return { path: path.resolve((await repoTop(project).catch(() => '')) || project) }
  }
  private noteRemoved(i: Instance, dir: string) {
    if (!i.source || !('path' in i.source) || i.sourceGone || !sameFolder(i.source.path, dir)) return
    // A copy or sync in progress learns it from its lease and reports 'loading' itself.
    if (i.state === 'copying' || i.state === 'syncing') return
    i.sourceGone = this.gone(i.source, 'running')
    try { this.save(i) } catch { /* shown from memory; saved with the next change */ }
  }
  /** The last guard: an unexpected failure in a background step is logged and shown with Retry, never thrown on. */
  private fault(i: Instance, e: unknown) {
    console.error('[player-instance]', e)
    if (['close-stuck', 'stuck-dialog'].includes(i.state)) return
    const message = `Play hit an unexpected problem: ${(e as Error)?.message ?? String(e)}. Retry, or Stop Unity.`
    try {
      // A game still playing keeps its controls; the message alone says what went wrong.
      if (i.launch && (i.state === 'playing' || i.state === 'paused')) { i.message = message; this.save(i) }
      else this.state(i, 'error', message)
    } catch { /* the record could not be saved; the status still shows it */ }
  }
  private settingsFile() { return path.join(this.data, 'player-copies', 'settings.json') }
  private validate(value: PlayerSettings): PlayerSettings {
    if (!Number.isInteger(value.idleMinutes) || value.idleMinutes < 0 || value.idleMinutes > 60 || !Number.isInteger(value.maxEditors) || value.maxEditors < 1 || value.maxEditors > 8) throw new Error('Player idle time must be 0–60 minutes and the editor limit 1–8')
    return { idleMinutes: value.idleMinutes, maxEditors: value.maxEditors }
  }
  private project(world: string) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error('Unknown Unity project')
    const { engine, root: engineRoot } = effectiveEngine(p)
    if (!supportsUnitySlots(engine)) throw new Error('Player instances only support Unity projects')
    return { project: p.path, engineRoot }
  }
  private file(project: string) { return path.join(this.copies.dir, this.copies.keyOf(project), 'player.json') }
  private save(i: Instance) {
    const file = this.file(i.project); fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(i, null, 2)); fs.renameSync(temp, file)
  }
  private state(i: Instance, state: Instance['state'], message?: string) { i.state = state; i.message = message; this.save(i) }
  private local(i: Instance) {
    let r = this.runtimes.get(i.project)
    if (!r) { r = (this.options.runtime ?? runtime)(i.root!, () => i.launch?.pid); this.runtimes.set(i.project, r) }
    return r
  }
  private serial<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(project) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.operations.set(project, next)
    void next.finally(() => { if (this.operations.get(project) === next) this.operations.delete(project) }).catch(() => {})
    return next
  }
  private async instance(project: string): Promise<Instance> {
    let i = this.instances.get(project)
    if (!i) {
      i = { state: 'idle', project, owner: { pid: process.pid, created: await (this.options.ownerCreated ?? (() => processCreated(process.pid)))() }, tracked: [] }
      try {
        const previous = JSON.parse(fs.readFileSync(this.file(project), 'utf8'))
        for (const key of ['peakWorkingSet', 'steadyWorkingSet'] as const) if (previous.project === project && Number.isFinite(previous[key]) && previous[key] > 0) i[key] = previous[key]
      } catch { /* first session */ }
      this.instances.set(project, i)
    }
    return i
  }
  /** Complete verified orphan shutdown before any copy sweep or new Play. */
  start(): Promise<void> {
    return this.startup ??= (async () => {
      const procs = await this.system.list()
      for (const copy of this.copies.list()) {
        let i: Instance
        try { i = JSON.parse(fs.readFileSync(this.file(copy.project), 'utf8')) } catch { continue }
        if (i.project !== copy.project || i.root !== copy.root || !this.copies.markerOk(copy)) continue
        if (i.owner && procs.some(p => sameProcess(p, i.owner))) continue
        i.tracked ??= []
        this.instances.set(i.project, i)
        await this.close(i, 'Genio orphan sweep')
        i.owner = { pid: process.pid, created: await (this.options.ownerCreated ?? (() => processCreated(process.pid)))() }
        this.save(i)
        if (!i.launch) this.instances.delete(i.project)
      }
      await this.copies.sweep({ isInUse: copy => this.copyInUse(copy) })
      if (!this.exiting) {
        void this.cleanup().catch(e => console.error('[player-instance] cleanup', e))
        this.cleanupTimer = setInterval(() => void this.cleanup().catch(e => console.error('[player-instance] cleanup', e)), PLAYER_COPY_CLEANUP_INTERVAL_MS)
        this.cleanupTimer.unref()
        this.timer = setInterval(() => void this.poll().catch(() => {}), 5000); this.timer.unref()
      }
    })()
  }
  private copyInUse(copy: { project: string }) {
    const i = this.instances.get(copy.project)
    return this.exiting || this.operations.has(copy.project) || !!i?.launch || i?.state === 'close-stuck'
  }
  /** Startup and hourly maintenance run off the Play path; overlapping sweeps share one run. */
  cleanup(): Promise<unknown> {
    return this.cleanupRun ??= this.copies.cleanup({ now: this.system.now(), isInUse: copy => this.copyInUse(copy) }).finally(() => { this.cleanupRun = undefined })
  }
  status(world: string): PlayerInstanceStatus {
    const { project } = this.project(world), i = this.instances.get(project)
    if (!i) return { state: 'idle', project, copy: this.copies.status(project) }
    const { owner: _owner, launch, tracked: _tracked, sampled: _sampled, ...visible } = i
    return { ...visible, ...(launch ? { pid: launch.pid, created: launch.created, desktop: launch.desktop } : {}), capabilities: { input: this.supportsInput(i) }, copy: this.copies.status(project) }
  }
  private supportsInput(i: Instance) {
    try { return !/activeInputHandler:\s*0\b/.test(fs.readFileSync(path.join(i.root!, 'ProjectSettings/ProjectSettings.asset'), 'utf8')) } catch { return false }
  }
  /** False when the source can no longer be read (a unit's worktree merged and removed, a deleted branch). */
  async sourceAvailable(world: string, source: PlayerCopySource): Promise<boolean> {
    return !(await sourceMissing(this.project(world).project, source))
  }
  syncCopy(world: string, source: PlayerCopySource) {
    const { project, engineRoot } = this.project(world)
    return this.serial(project, async () => {
      await this.start()
      if (this.instances.get(project)?.launch) throw new Error('Use player instance Play to sync a running editor safely')
      await this.copies.ensure(project, engineRoot)
      const lease = 'path' in source ? leaseSource(source.path, () => this.copies.cancel(project)) : undefined
      return this.copies.sync(project, source).finally(() => lease?.release())
    })
  }
  ensureCopy(world: string) {
    const { project, engineRoot } = this.project(world)
    return this.serial(project, async () => { await this.start(); return this.copies.ensure(project, engineRoot) })
  }
  async deleteCopy(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => {
      await this.start()
      const i = this.instances.get(project)
      if (i) await this.close(i, 'the player deleted it', 'delete')
      else await this.copies.deleteInBackground(project, { reason: 'the player deleted it' })
      const copy = this.copies.status(project)
      return { deleted: !copy, record: copy }
    })
  }
  async configure(world: string, patch: Partial<PlayerSettings>) {
    this.project(world)
    this.settings = this.validate({ ...this.settings, ...patch })
    fs.mkdirSync(path.dirname(this.settingsFile()), { recursive: true }); fs.writeFileSync(this.settingsFile(), JSON.stringify(this.settings))
    for (const i of this.instances.values()) if (i.stoppedAt !== undefined && i.launch) {
      await this.serial(i.project, async () => {
        if (i.stoppedAt === undefined || !i.launch) return
        i.deadline = i.stoppedAt + this.settings.idleMinutes * 60000
        await this.copies.stopped(i.project, i.stoppedAt, this.settings.idleMinutes * 60000); this.save(i)
      })
    }
    return { ...this.settings }
  }
  /** The editor cap. Warm (ready) editors of other projects make room, oldest first. */
  private async limit(i: Instance) {
    const procs = await this.system.list()
    const running = [...this.instances.values()].filter(v => v.launch && procs.some(p => sameProcess(p, v.launch!)))
    const copies = this.copies.list()
    const other = copies.filter(c => !running.some(v => v.project === c.project) && procs.some(p => opensRoot(p, c.root))).length
    if (running.length + other >= this.settings.maxEditors) {
      const warm = running.filter(v => v !== i && v.state === 'ready' && !this.operations.has(v.project)).sort((a, b) => (a.stoppedAt ?? 0) - (b.stoppedAt ?? 0))
      while (running.length + other >= this.settings.maxEditors && warm.length) {
        const victim = warm.shift()!; await this.serial(victim.project, () => this.close(victim, 'warm instance replaced'))
        if (!victim.launch) running.splice(running.indexOf(victim), 1)
      }
      if (running.length + other >= this.settings.maxEditors) { this.state(i, 'limit-reached', `The player editor limit (${this.settings.maxEditors}) is reached. Stop or quit another project's player instance.`); throw new Error(i.message) }
    }
  }
  /** Admission for a cold start, before any copy, so a refusal never follows a minute of copying (D3). */
  private async admit(i: Instance, startAnyway: boolean) {
    await this.limit(i)
    await this.admitMemory(i, startAnyway)
  }
  /**
   * Available memory (standby included) must cover the estimate plus a 1 GiB reserve. When short, Genio first closes
   * its own idle player and slot editors, never the player's editors. Still short, it asks: Start anyway, unless Windows
   * cannot even commit the estimate, which nothing overrides.
   */
  private async admitMemory(i: Instance, startAnyway: boolean) {
    const need = i.steadyWorkingSet ?? FIRST_RUN_ESTIMATE
    const measure = async () => ({ available: this.system.memory().freeBytes, commit: await this.system.commit().catch(() => undefined) })
    const short = (m: { available: number; commit?: number }) => m.available < need + RESERVE || m.commit !== undefined && m.commit < need
    delete i.lowMemory
    let m = await measure()
    if (!short(m)) return
    const closed: string[] = []
    for (const v of [...this.instances.values()].filter(v => v !== i && v.launch && ['ready', 'compile-errors'].includes(v.state) && !this.operations.has(v.project))) {
      await this.serial(v.project, () => this.close(v, 'memory for another Play'))
      if (!v.launch) closed.push(`${path.basename(v.project)} player`)
    }
    for (const editor of await (this.options.idleSlots ?? (() => idleSlotEditors(this.ctx)))().catch(() => [])) {
      try { await editor.close(); closed.push(editor.label) } catch { /* now leased, closing or stuck: not idle */ }
    }
    if (closed.length) { m = await measure(); if (!short(m)) return }
    const hard = m.commit !== undefined && m.commit < need
    if (startAnyway && !hard) return
    const consumers = biggestConsumers(await this.system.usage().catch(() => []))
    const biggest = consumers.length ? ` Biggest: ${consumers.map(c => `${c.name} ${gb(c.bytes)} GB`).join(', ')}.` : ''
    const freed = closed.length ? ` Genio already closed its idle ${closed.join(', ')}.` : ''
    i.lowMemory = { availableBytes: m.available, neededBytes: need, ...(m.commit !== undefined ? { commitBytes: m.commit } : {}), hard, consumers, closed }
    this.state(i, 'low-memory', hard
      ? `Windows cannot commit enough memory for Unity: ${gb(m.commit!)} GB left to commit; Unity needs about ${gb(need)} GB.${biggest}${freed} Close something, then press Play again.`
      : `${gb(m.available)} GB available; Unity needs about ${gb(need)} GB.${biggest}${freed} Close something, or Start anyway.`)
    throw new Error(i.message)
  }
  private async launch(i: Instance, visible: boolean, signal?: AbortSignal) {
    const next = this.launches.then(async () => {
      if (this.exiting) throw new Error('Genio is exiting')
      if (signal?.aborted) throw new Error('Play cancelled')
      if (!/^\d+$/.test(i.owner.created)) throw new Error('Cannot start a player editor without the Genio process creation identity')
      i.unityVersion = unityVersionOf(i.root!)
      const version = i.unityVersion
      const executable = version && (this.options.executable ?? (v => {
        const file = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor', v, 'Editor/Unity.exe')
        return fs.existsSync(file) ? file : undefined
      }))(version)
      if (!executable) { this.state(i, 'missing-editor', `Install Unity ${version ?? 'for this project'} in Unity Hub.`); throw new Error(i.message) }
      // Checked again inside the launch chain, so parallel starts cannot pass the cap together.
      await this.limit(i)
      if (this.exiting || signal?.aborted) throw new Error('Play cancelled')
      this.state(i, 'starting'); i.sampled = false
      const log = path.join(path.dirname(this.file(i.project)), 'editor.log')
      const launched = await (this.options.launch ?? launchEditor)({ file: executable, args: ['-automated', '-projectPath', i.root!, '-logFile', log], cwd: i.root, data: this.data, api: this.desktop, visible, label: 'player', owner: i.owner })
      i.launch = launched
      if (!launched.created) {
        const p = (await this.system.list()).find(p => p.pid === launched.pid && opensRoot(p, i.root!))
        if (p) launched.created = p.created
      }
      this.save(i)
      if (!launched.created) throw new Error('The player editor creation time could not be verified')
      this.runtimes.delete(i.project)
    })
    this.launches = next.catch(() => {}); await next
  }
  private async embed(i: Instance) {
    const from = path.join(this.ctx.appRoot, 'resources/unity/com.genio.play'), to = path.join(i.root!, 'Packages/com.genio.play')
    if (!this.copies.markerOk(this.copies.status(i.project)!)) throw new Error('Refusing an unmarked player copy')
    await checkCopyPath(to)
    const copy = (source: string, target: string) => {
      const dir = fs.lstatSync(target, { throwIfNoEntry: false })
      if (dir?.isSymbolicLink()) throw new Error('The embedded player package cannot contain links')
      fs.mkdirSync(target, { recursive: true })
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const src = path.join(source, entry.name), dst = path.join(target, entry.name)
        if (entry.isDirectory()) copy(src, dst)
        else if (entry.isFile()) {
          const targetStat = fs.lstatSync(dst, { throwIfNoEntry: false })
          if (targetStat?.isSymbolicLink() || targetStat?.isFile() && targetStat.nlink > 1) throw new Error('The embedded player package cannot contain links')
          const bytes = fs.readFileSync(src)
          if (!fs.existsSync(dst) || !bytes.equals(fs.readFileSync(dst))) fs.writeFileSync(dst, bytes)
        }
      }
    }
    copy(from, to)
  }
  private async ready(i: Instance, mode?: 'playing' | 'paused' | 'stopped', signal?: AbortSignal) {
    const deadline = this.system.now() + (this.options.readyMs ?? 10 * 60000)
    while (this.system.now() <= deadline) {
      if (this.exiting) throw new Error('Genio is exiting')
      if (signal?.aborted) throw new Error('Play cancelled')
      const procs = await this.system.list()
      if (!i.launch || !procs.some(p => sameProcess(p, i.launch!) && opensRoot(p, i.root!))) throw new Error('The player editor exited while starting')
      const watched = await inspectDesktop(this.desktop, i.launch, { now: this.system.now() })
      if (watched.blocked) { i.dialog = watched.blocked; this.state(i, 'stuck-dialog', watched.blocked.message); throw new Error(i.message) }
      try {
        const status = await this.local(i).request<{ compiling?: boolean; domainReloadInProgress?: boolean; playMode?: string }>('editor_status')
        if (!status.compiling && !status.domainReloadInProgress && (!mode || status.playMode === mode)) return
      } catch { /* Import or domain reload; poll rather than repeat the mutation. */ }
      try {
        const file = path.join(path.dirname(this.file(i.project)), 'editor.log'), stat = fs.statSync(file)
        const fd = fs.openSync(file, 'r'), chunk = Buffer.alloc(Math.min(4096, stat.size))
        // A tail that starts mid-file starts at its first whole line, never inside a character.
        try { fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, stat.size - chunk.length)); i.startup = decodeBytes(stat.size > chunk.length ? chunk.subarray(lineStart(chunk)) : chunk).trim().split(/\r?\n/).slice(-4).join('\n') } finally { fs.closeSync(fd) }
      } catch { /* Log not created yet. */ }
      this.save(i); await this.system.sleep(1000)
    }
    throw new Error('Unity is still starting or importing. Check the player editor log or hidden dialog.')
  }
  /** Start Unity on the copy and leave it ready in edit mode (warming up only); a no-op while the editor is open. */
  startUnity(world: string, source: PlayerCopySource, options: { startAnyway?: boolean; visible?: boolean } = {}) {
    return this.open(world, source, options, false)
  }
  /** Enter Play: from Off this starts Unity first, in the same call (D1); a running editor syncs the source, then plays. */
  enterPlay(world: string, source: PlayerCopySource, options: { startAnyway?: boolean; visible?: boolean; scene?: string } = {}) {
    return this.open(world, source, options, true)
  }
  play(world: string, source: PlayerCopySource, options: { startAnyway?: boolean; visible?: boolean; scene?: string } = {}) {
    return this.enterPlay(world, source, options)
  }
  private open(world: string, chosen: PlayerCopySource, options: { startAnyway?: boolean; visible?: boolean; scene?: string }, enter: boolean) {
    const { project, engineRoot } = this.project(world)
    let source = chosen
    if (options.scene !== undefined) checkScene(options.scene)
    // Enter Play replaces any Play in progress; Start Unity only warms up and never cancels one.
    if (enter) {
      this.controllers.get(project)?.abort(); this.copies.cancel(project)
      this.generations.set(project, (this.generations.get(project) ?? 0) + 1)
    }
    const generation = this.generations.get(project) ?? 0
    return this.serial(project, async () => {
      await this.start(); if (this.exiting) throw new Error('Genio is exiting')
      const controller = new AbortController()
      const check = () => { if (controller.signal.aborted || (this.generations.get(project) ?? 0) !== generation) throw new Error('Play cancelled') }
      check()
      const i = await this.instance(project)
      if (i.state === 'close-stuck') throw new Error('Close the stuck player editor before playing again')
      if (!enter && i.launch) return this.status(world)
      this.controllers.set(project, controller)
      if (options.scene !== undefined) i.scene = options.scene
      delete i.dialog; delete i.stoppedAt; delete i.deadline; delete i.lowMemory; delete i.sourceGone
      // A source already gone (a unit merged and removed since it was chosen) plays the main checkout instead.
      const main = await this.mainSource(project)
      if (!sameSource(source, main) && await sourceMissing(project, source)) { i.sourceGone = this.gone(source, 'fallback'); source = main }
      check()
      const previous = i.source
      let suspended = false, lease: SourceLease | undefined
      try {
        // A cold start is admitted before the copy, so a refusal never follows a minute of copying.
        if (!i.launch) await this.admit(i, options.startAnyway === true)
        check()
        const copy = await this.copies.ensure(project, engineRoot); i.root = copy.root; i.source = source
        check()
        if (i.launch) {
          this.local(i).stopStream()
          await this.local(i).request('editor_stop')
          await this.ready(i, 'stopped', controller.signal)
          suspended = true; await this.local(i).request('genio_sync_begin')
        }
        this.state(i, i.launch ? 'syncing' : 'copying')
        // The lease covers the reads of the source; Genio's cleanup waits for it (bounded) or stops it before removing a worktree.
        if ('path' in source) lease = leaseSource(source.path, () => this.copies.cancel(project))
        const report = await this.copies.sync(project, source, { signal: controller.signal, beforeApply: async advice => {
          // Everything is staged: the source is not read again.
          lease?.release()
          check()
          if (advice.needed && i.launch) {
            await this.close(i, 'source needs an editor restart', 'restart')
            if (i.launch) throw new Error(i.message)
            suspended = false
            this.state(i, 'syncing')
          }
        } }).finally(() => lease?.release())
        check()
        await this.embed(i)
        if (report.lfs.pointers.length) throw new Error(`This source has ${report.lfs.pointers.length} LFS files that are not downloaded`)
        if (suspended) { await this.local(i).request('genio_sync_end'); suspended = false }
        if (!i.launch) await this.launch(i, options.visible === true, controller.signal)
        await this.ready(i, undefined, controller.signal)
        // Pipeline's console may retain errors from an earlier compile; query Unity's current flag.
        const compilation = await this.local(i).request<{ success: boolean; result: boolean }>('eval', { code: 'return UnityEditor.EditorUtility.scriptCompilationFailed;' })
        if (!compilation.success || typeof compilation.result !== 'boolean') throw new Error('Could not read Unity compilation status')
        if (compilation.result) {
          this.state(i, 'compile-errors', 'Fix the compile errors in the source, then Play again.'); throw new Error(i.message)
        }
        check()
        if (!enter) {
          // A zero idle time quits right after Play stops; an explicit Start Unity then stays up until Stop Unity.
          this.state(i, 'ready'); if (this.settings.idleMinutes) await this.idle(i)
          return this.status(world)
        }
        this.state(i, 'entering-play')
        if (i.scene) await this.local(i).request('open_scene', { path: i.scene })
        await this.local(i).request('editor_play')
        await this.ready(i, 'playing', controller.signal)
        check()
        await this.copies.playing(project, this.system.now()); this.state(i, 'playing')
        this.ctx.stats.unlock('play-first')
        return this.status(world)
      } catch (e) {
        if (suspended && i.launch) await this.local(i).request('genio_sync_end').catch(() => {})
        // The source vanished while it was read: the copy still holds the previous sync, untouched. Not a failure:
        // Unity (if it runs) stays ready on that copy, and the screen offers the main checkout.
        if (((e as { code?: string })?.code === 'SOURCE_GONE' || lease?.gone) && !['stuck-dialog', 'close-stuck'].includes(i.state)) {
          if (previous) i.source = previous; else delete i.source
          i.sourceGone = this.gone(source, 'loading')
          this.state(i, i.launch ? 'ready' : 'idle', sourceGoneText(i.sourceGone))
          if (i.launch) await this.idle(i)
          else await this.copies.editorGone(project, 'the source was removed', { manual: true, at: this.system.now(), idleMs: this.settings.idleMinutes * 60000 }).catch(() => {})
          return this.status(world)
        }
        if (!['stuck-dialog', 'close-stuck', 'compile-errors', ...REFUSED].includes(i.state)) {
          const cancelled = controller.signal.aborted || (this.generations.get(project) ?? 0) !== generation
          this.state(i, cancelled ? i.launch ? 'ready' : 'idle' : 'error', (e as Error).message)
        }
        if (i.launch && !['close-stuck'].includes(i.state)) await this.idle(i)
        // Refused, cancelled or failed starts retain the copy for the next incremental sync.
        else if (!i.launch) await this.copies.editorGone(project, 'the start did not finish', { manual: true, at: this.system.now(), idleMs: this.settings.idleMinutes * 60000 }).catch(() => {})
        throw e
      } finally { if (this.controllers.get(project) === controller) this.controllers.delete(project) }
    })
  }
  private cancel(project: string) {
    this.generations.set(project, (this.generations.get(project) ?? 0) + 1)
    this.controllers.get(project)?.abort(); this.copies.cancel(project)
  }
  private async idle(i: Instance) {
    i.stoppedAt = this.system.now(); i.deadline = i.stoppedAt + this.settings.idleMinutes * 60000
    await this.copies.stopped(i.project, i.stoppedAt, this.settings.idleMinutes * 60000); this.save(i)
  }
  /** Exit Play and keep Unity ready (cancels an Enter Play in progress). The idle deadline starts. */
  exitPlay(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => {
      await this.start()
      const i = this.instances.get(project)
      // Cancel on an admission prompt dismisses it; an existing copy stays available.
      if (!i?.launch) { if (i && REFUSED.includes(i.state)) { delete i.lowMemory; this.state(i, 'idle') } return this.status(world) }
      this.local(i).stopStream()
      if (i.state === 'playing' || i.state === 'paused') this.state(i, 'exiting-play')
      try { await this.local(i).request('editor_stop'); await this.ready(i, 'stopped'); this.state(i, 'ready') }
      catch (e) { if (i.state !== 'stuck-dialog') this.state(i, 'error', (e as Error).message); throw e }
      finally { await this.idle(i) }
      if (!this.settings.idleMinutes) await this.close(i, 'idle timeout')
      return this.status(world)
    })
  }
  stop(world: string) { return this.exitPlay(world) }
  /**
   * Stop Unity (D2): exit Play, quit the editor and keep the copy between sessions, so the next start skips
   * the copy. Cancels a copy or start in progress, and retries a close that got stuck.
   */
  stopUnity(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => {
      await this.start()
      const i = this.instances.get(project); if (!i) return this.status(world)
      delete i.lowMemory
      if (i.launch && (i.state === 'playing' || i.state === 'paused')) {
        this.local(i).stopStream(); this.state(i, 'exiting-play')
        await this.local(i).request('editor_stop').catch(() => { /* the quit ends Play too */ })
      }
      await this.close(i, 'the player stopped Unity')
      return this.status(world)
    })
  }
  /** Quit Unity when the project window closes, retaining its copy. */
  quit(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => { await this.start(); const i = this.instances.get(project); if (i) await this.close(i, 'player quit'); else await this.copies.editorGone(project); return this.status(world) })
  }
  async restart(world: string, visible = false) {
    const { project } = this.project(world)
    const source = this.instances.get(project)?.source
    if (!source) throw new Error('Choose a source and Play first')
    this.cancel(project)
    const result = await this.serial(project, async () => { await this.start(); const i = this.instances.get(project); if (i) await this.close(i, 'player restart', 'restart'); return this.status(world) })
    if (result.state === 'close-stuck') throw new Error(result.message)
    return this.enterPlay(world, source, { visible })
  }
  /** Pause or resume Play; without `paused` it toggles. editor_pause toggles, so Unity's playMode decides whether to send it. */
  pause(world: string, paused?: boolean) {
    const { project } = this.project(world)
    return this.serial(project, async () => {
      const i = this.live(project)
      await this.paused(i, paused)
      return this.status(world)
    })
  }
  /** Advance one frame: pauses a running Play first, as Unity's Step does. */
  step(world: string) {
    const { project } = this.project(world)
    return this.serial(project, async () => {
      const i = this.live(project)
      await this.paused(i, true)
      await this.local(i).request('genio_step')
      return this.status(world)
    })
  }
  private live(project: string) {
    const i = this.instances.get(project)
    if (!i?.launch || (i.state !== 'playing' && i.state !== 'paused')) throw new Error('Enter Play first')
    return i
  }
  private async paused(i: Instance, paused?: boolean) {
    const { playMode } = await this.local(i).request<{ playMode?: string }>('editor_status')
    if (playMode !== 'playing' && playMode !== 'paused') throw new Error('Unity is not in Play Mode')
    const target = paused ?? playMode !== 'paused'
    if (target !== (playMode === 'paused')) { await this.local(i).request('editor_pause'); await this.ready(i, target ? 'paused' : 'playing') }
    this.state(i, target ? 'paused' : 'playing')
  }
  /**
   * The scene dropdown: Unity's build settings and open scenes while the editor answers, else the files (the copy,
   * or the source before the first copy). Build order first, then the project's other scenes.
   */
  async scenes(world: string): Promise<PlayerScene[]> {
    const { project, engineRoot } = this.project(world)
    const i = this.instances.get(project), copy = i?.root ?? this.copies.status(project)?.root
    const root = copy && fs.existsSync(path.join(copy, 'Assets')) ? copy : path.join(project, engineRoot)
    let build: { path: string; enabled?: boolean }[] | undefined, open: { path: string; isActive?: boolean }[] = []
    if (i?.launch && ['ready', 'playing', 'paused', 'compile-errors'].includes(i.state)) {
      try {
        build = (await this.local(i).request<{ scenes?: { path: string; enabled?: boolean }[] }>('get_build_settings')).scenes
        open = (await this.local(i).request<{ scenes?: { path: string; isActive?: boolean }[] }>('list_open_scenes')).scenes ?? []
      } catch { build = undefined; open = [] }
    }
    return sceneList(Array.isArray(build) ? build : buildScenes(root), sceneFiles(root), open)
  }
  /** Choose the scene: kept for the next Enter Play while Unity is off, opened at once when ready; a running Play exits, opens it and enters again. */
  async setScene(world: string, scene: string) {
    checkScene(scene)
    const { project } = this.project(world)
    const replay = await this.serial(project, async () => {
      const i = await this.instance(project); i.scene = scene; this.save(i)
      if (i.launch && i.state === 'ready') { await this.local(i).request('open_scene', { path: scene }); return undefined }
      return i.launch && (i.state === 'playing' || i.state === 'paused') ? i.source : undefined
    })
    return replay ? this.enterPlay(world, replay) : this.status(world)
  }
  private async close(i: Instance, reason: string, copy: CopyAfterClose = 'keep') {
    this.runtimes.get(i.project)?.stopStream()
    this.state(i, 'shutting-down')
    if (i.launch) {
      const result = await closePlayerRoot(i.root!, i.launch, i.tracked, this.system, this.desktop,
        () => this.local(i).request('eval', { code: QUIT }), this.options.graceMs, this.options.forceMs)
      if (!result.closed) { this.state(i, 'close-stuck', `${result.reason} (PIDs ${result.pids.join(', ')})`); return }
    }
    this.runtimes.delete(i.project); i.tracked = []
    if (i.root) for (const name of ['Library/EditorInstance.json', 'Library/Pipeline/.unity-pipeline-port', 'Temp/UnityLockfile']) {
      try { await checkCopyPath(path.join(i.root, name)); fs.rmSync(path.join(i.root, name), { force: true }) } catch { this.state(i, 'close-stuck', 'The editor still holds this copy, or its metadata path contains a link'); return }
    }
    delete i.launch
    delete i.stoppedAt; delete i.deadline; this.state(i, 'idle')
    if (copy === 'delete') await this.copies.deleteInBackground(i.project, { reason })
    else if (copy === 'keep') await this.copies.editorGone(i.project, reason)
  }
  async poll() {
    if (this.polling || this.exiting) return
    this.polling = true
    try {
      const procs = await this.system.list()
      for (const i of this.instances.values()) {
        if (!i.launch || this.operations.has(i.project)) continue
        // The periodic validity check: a source removed outside Genio's cleanup (or a deleted branch) shows too.
        if (i.source && !i.sourceGone && await sourceMissing(i.project, i.source)) { i.sourceGone = this.gone(i.source, 'running'); this.save(i) }
        try { await this.serial(i.project, async () => {
          const p = procs.find(p => sameProcess(p, i.launch!) && opensRoot(p, i.root!))
          if (!p) {
            try { i.exitCode = JSON.parse(fs.readFileSync(path.join(i.launch!.dir!, 'exit.json'), 'utf8')).exitCode } catch { /* no helper exit yet */ }
            await this.close(i, 'editor exited'); if (!i.launch && i.state !== 'close-stuck') this.state(i, 'crashed', 'The player editor exited. Play again to restart.'); return
          }
          i.tracked = playerTree(procs, [p], i.root!)
          const workingSet = i.tracked.reduce((sum, p) => sum + (p.workingSet ?? 0), 0)
          i.peakWorkingSet = Math.max(i.peakWorkingSet ?? 0, workingSet) || i.peakWorkingSet
          // The estimate learns from an editor at rest in Play or ready, not from the import peak; a new session replaces it.
          if (workingSet > 0 && ['playing', 'paused', 'ready'].includes(i.state)) { i.steadyWorkingSet = i.sampled ? Math.max(i.steadyWorkingSet ?? 0, workingSet) : workingSet; i.sampled = true }
          const watched = await inspectDesktop(this.desktop, i.launch, { now: this.system.now() })
          if (watched.blocked) { this.local(i).stopStream(); i.dialog = watched.blocked; this.state(i, 'stuck-dialog', watched.blocked.message); if (i.stoppedAt === undefined) await this.idle(i) }
          else if (i.state === 'playing' || i.state === 'paused') {
            // A pause or stop made in Unity itself shows here.
            try {
              const { playMode } = await this.local(i).request<{ playMode?: string }>('editor_status')
              if ((playMode === 'playing' || playMode === 'paused') && playMode !== i.state) this.state(i, playMode)
              else if (playMode === 'stopped') { this.local(i).stopStream(); this.state(i, 'ready'); await this.idle(i) }
            } catch { /* Busy or reloading; the next poll asks again. */ }
          }
          if (i.deadline !== undefined && i.deadline <= this.system.now()) await this.close(i, 'idle timeout')
          else this.save(i)
        }) } catch (e) { this.fault(i, e) }
      }
    } finally { this.polling = false }
  }
  async machine(world: string): Promise<PlayerMachineStatus> {
    this.project(world)
    const procs = await this.system.list(), { freeBytes, totalBytes } = this.system.memory()
    const players = procs.filter(p => [...this.instances.values()].some(i => i.launch && sameProcess(p, i.launch)))
    const units = new Set<number>()
    const pools = path.join(this.data, 'play-pools')
    for (const name of fs.existsSync(pools) ? fs.readdirSync(pools) : []) {
      try { const s = JSON.parse(fs.readFileSync(path.join(pools, name, 'state.json'), 'utf8')); for (const slot of s.slots ?? []) if (slot.editor?.pid && procs.some(p => p.pid === slot.editor.pid && (!slot.editor.created || p.created === slot.editor.created))) units.add(slot.editor.pid) } catch { /* other project starting */ }
    }
    const holders = editorHolders(editorSeatsDir(this.data))
    const batch = procs.filter(p => /-batchmode\b/i.test(p.command) && holders.some(h => h.project && opensRoot(p, h.project)))
    const editors = new Set([...players.map(p => p.pid), ...units, ...batch.map(p => p.pid)])
    return { settings: { ...this.settings }, playerEditors: players.length, unitEditors: units.size, batchEditors: batch.length, totalEditors: editors.size,
      workingSetBytes: procs.filter(p => editors.has(p.pid)).reduce((n, p) => n + (p.workingSet ?? 0), 0), freeBytes, totalBytes }
  }
  private streamable(project: string) {
    const i = this.instances.get(project)
    if (!i?.launch || (i.state !== 'playing' && i.state !== 'paused')) throw new Error('Play this project before streaming')
    return i
  }
  async stream(world: string, width: number, height: number, frame: (b: Buffer) => void, disconnect: () => void) {
    const { project } = this.project(world)
    if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 1920)) throw new Error('Stream dimensions must be 16–1920')
    return this.serial(project, async () => { await this.local(this.streamable(project)).stream(width, height, frame, disconnect) })
  }
  /** Change the streamed resolution during Play without closing the renderer's port, so Play goes on. */
  async resize(world: string, width: number, height: number) {
    const { project } = this.project(world)
    if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 1920)) throw new Error('Stream dimensions must be 16–1920')
    return this.serial(project, async () => { await this.local(this.streamable(project)).resize(width, height); return this.status(world) })
  }
  console(world: string, cursor?: number, session?: string) {
    const { project } = this.project(world)
    return this.serial(project, async () => {
      const i = this.instances.get(project)
      if (!i?.launch) throw new Error('The player editor is not running')
      return this.local(i).request<import('@shared/play').PlayConsole>('console', { tail: 100, ...(cursor !== undefined ? { since: cursor, since_session: session } : {}) })
    })
  }
  input(world: string, input: PlayInput) {
    const i = this.instances.get(this.project(world).project)
    if (!i?.launch || (i.state !== 'playing' && i.state !== 'paused')) { if (input.type === 'release') return; throw new Error('The player instance is not playing') }
    if (input.type !== 'release' && !this.supportsInput(i)) throw new Error('Legacy input is view-only')
    this.local(i).input(input)
  }
  /** The Play screen left: exit Play and keep Unity ready. */
  detach(world: string) { return this.exitPlay(world) }
  /** Cancel starts and maintenance now; close editors in parallel, keeping their copies. */
  async shutdown() {
    this.exiting = true; clearInterval(this.timer); clearInterval(this.cleanupTimer); this.unlisten()
    for (const i of this.instances.values()) { this.cancel(i.project); this.runtimes.get(i.project)?.stopStream() }
    await Promise.allSettled([...this.instances.values()].map(i => this.serial(i.project, () => this.close(i, 'Genio exit'))))
  }
}
const services = new WeakMap<AppCtx, PlayerInstanceService>()
export function playerInstanceService(ctx: AppCtx) {
  let service = services.get(ctx)
  if (!service) { service = new PlayerInstanceService(ctx); services.set(ctx, service) }
  return service
}
