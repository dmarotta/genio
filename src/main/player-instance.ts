import fs from 'node:fs'
import path from 'node:path'
import type { AppCtx } from './services'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots, type PlayerCopySource, type PlayerInstanceStatus, type PlayerMachineStatus, type PlayerSettings, type PlayInput } from '@shared/play'
import { PlayerCopies, processCreated } from '../../resources/unit-skills/genio/lib/player-copy.mjs'
import { createDesktopApi, inspectDesktop, launchEditor, type DesktopApi, type EditorLaunch } from '../../resources/unit-skills/genio/lib/hidden-desktop.mjs'
import { unityVersionOf } from '../../resources/unit-skills/genio/lib/git-mirror.mjs'
import { checkCopyPath } from '../../resources/unit-skills/genio/lib/unity-seed.mjs'
import { editorHolders, editorSeatsDir } from '../../resources/unit-skills/genio/lib/unity-editors.mjs'
import { poolDirectory } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { playerCopyService } from './player-copy'
import { playService } from './play'
import { UnityAdapter } from './play-unity'
import { PlayStream } from './play-stream'
import { biggestConsumers, closePlayerRoot, opensRoot, playerSystem, playerTree, sameProcess, type PlayerProcess, type PlayerSystem } from './player-process'

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
export interface PlayerRuntime {
  request<T = unknown>(command: string, parameters?: object): Promise<T>
  stream(width: number, height: number, onFrame: (b: Buffer) => void, onDisconnect: () => void): Promise<void>
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
  return {
    request: (command, parameters) => adapter.request(command, parameters),
    async stream(width, height, onFrame, onDisconnect) {
      stream?.close(); const next = stream = new PlayStream()
      next.onFrame = onFrame; next.onDisconnect = onDisconnect
      try { const credentials = await next.listen(); await adapter.request('genio_set_resolution', { width, height }); await adapter.request('genio_stream_start', { ...credentials, width, height }) }
      catch (e) { next.close(); if (stream === next) stream = undefined; throw e }
    },
    stopStream() { stream?.close(); stream = undefined },
    input(input) { if (!stream && input.type === 'release') return; if (!stream) throw new Error('Start the player stream first'); stream.input(input) }
  }
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
  private polling = false
  private exiting = false
  private startup?: Promise<void>
  private system: PlayerSystem
  private desktop: DesktopApi
  private data: string
  private settings: PlayerSettings
  constructor(private ctx: AppCtx, private options: PlayerInstanceOptions = {}) {
    this.data = ctx.main.home.data
    this.copies = options.copies ?? playerCopyService(ctx).copies
    this.system = options.system ?? playerSystem
    this.desktop = options.desktop ?? createDesktopApi(this.data)
    this.settings = { idleMinutes: 10, maxEditors: 2 }
    try { this.settings = this.validate(JSON.parse(fs.readFileSync(this.settingsFile(), 'utf8'))) } catch { /* defaults */ }
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
      await this.copies.sweep({ protectedKeys: [...this.instances.values()].filter(i => i.launch || i.state === 'close-stuck').map(i => this.copies.keyOf(i.project)) })
      if (!this.exiting) { this.timer = setInterval(() => void this.poll().catch(() => {}), 5000); this.timer.unref() }
    })()
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
  syncCopy(world: string, source: PlayerCopySource) {
    const { project, engineRoot } = this.project(world)
    return this.serial(project, async () => {
      await this.start()
      if (this.instances.get(project)?.launch) throw new Error('Use player instance Play to sync a running editor safely')
      await this.copies.ensure(project, engineRoot)
      return this.copies.sync(project, source)
    })
  }
  ensureCopy(world: string) {
    const { project, engineRoot } = this.project(world)
    return this.serial(project, async () => { await this.start(); return this.copies.ensure(project, engineRoot) })
  }
  async deleteCopy(world: string) {
    await this.quit(world)
    const copy = this.copies.status(this.project(world).project)
    return { deleted: !copy, record: copy }
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
  /** The editor cap, then (with memory) the RAM check. Play runs both before copying; launch re-checks the cap. */
  private async admit(i: Instance, startAnyway: boolean, memory = true) {
    const procs = await this.system.list()
    const running = [...this.instances.values()].filter(v => v.launch && procs.some(p => sameProcess(p, v.launch!)))
    const copies = this.copies.list()
    const other = copies.filter(c => !running.some(v => v.project === c.project) && procs.some(p => opensRoot(p, c.root))).length
    if (running.length + other >= this.settings.maxEditors) {
      const warm = running.filter(v => v !== i && v.state === 'stopped-warm' && !this.operations.has(v.project)).sort((a, b) => (a.stoppedAt ?? 0) - (b.stoppedAt ?? 0))
      while (running.length + other >= this.settings.maxEditors && warm.length) {
        const victim = warm.shift()!; await this.serial(victim.project, () => this.close(victim, 'warm instance replaced'))
        if (!victim.launch) running.splice(running.indexOf(victim), 1)
      }
      if (running.length + other >= this.settings.maxEditors) { this.state(i, 'limit-reached', `The player editor limit (${this.settings.maxEditors}) is reached. Stop or quit another project's player instance.`); throw new Error(i.message) }
    }
    if (memory) await this.admitMemory(i, startAnyway)
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
    for (const v of [...this.instances.values()].filter(v => v !== i && v.launch && ['stopped-warm', 'compile-errors'].includes(v.state) && !this.operations.has(v.project))) {
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
  private async launch(i: Instance, startAnyway: boolean, visible: boolean, signal?: AbortSignal, memoryChecked = false) {
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
      await this.admit(i, startAnyway, !memoryChecked)
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
  private async ready(i: Instance, mode?: 'playing' | 'stopped', signal?: AbortSignal) {
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
        try { fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, stat.size - chunk.length)); i.startup = chunk.toString('utf8').trim().split(/\r?\n/).slice(-4).join('\n') } finally { fs.closeSync(fd) }
      } catch { /* Log not created yet. */ }
      this.save(i); await this.system.sleep(1000)
    }
    throw new Error('Unity is still starting or importing. Check the player editor log or hidden dialog.')
  }
  play(world: string, source: PlayerCopySource, options: { startAnyway?: boolean; visible?: boolean; scene?: string } = {}) {
    const { project, engineRoot } = this.project(world)
    this.controllers.get(project)?.abort(); this.copies.cancel(project)
    const generation = (this.generations.get(project) ?? 0) + 1
    this.generations.set(project, generation)
    return this.serial(project, async () => {
      await this.start(); if (this.exiting) throw new Error('Genio is exiting')
      const controller = new AbortController()
      const check = () => { if (controller.signal.aborted || this.generations.get(project) !== generation) throw new Error('Play cancelled') }
      check(); this.controllers.set(project, controller)
      const i = await this.instance(project)
      if (i.state === 'close-stuck') { this.controllers.delete(project); throw new Error('Close the stuck player editor before playing again') }
      delete i.dialog; delete i.stoppedAt; delete i.deadline; delete i.lowMemory
      let suspended = false
      // A cold start is admitted before the copy, so a refusal never follows a minute of copying.
      const memoryChecked = !i.launch
      try {
        if (memoryChecked) await this.admit(i, options.startAnyway === true)
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
        const report = await this.copies.sync(project, source, { signal: controller.signal, beforeApply: async advice => {
          check()
          if (advice.needed && i.launch) {
            await this.close(i, 'source needs an editor restart', true)
            if (i.launch) throw new Error(i.message)
            suspended = false
            this.state(i, 'syncing')
          }
        } })
        check()
        await this.embed(i)
        if (report.lfs.pointers.length) throw new Error(`This source has ${report.lfs.pointers.length} LFS files that are not downloaded`)
        if (suspended) { await this.local(i).request('genio_sync_end'); suspended = false }
        if (!i.launch) await this.launch(i, options.startAnyway === true, options.visible === true, controller.signal, memoryChecked)
        await this.ready(i, undefined, controller.signal)
        // Pipeline's console may retain errors from an earlier compile; query Unity's current flag.
        const compilation = await this.local(i).request<{ success: boolean; result: boolean }>('eval', { code: 'return UnityEditor.EditorUtility.scriptCompilationFailed;' })
        if (!compilation.success || typeof compilation.result !== 'boolean') throw new Error('Could not read Unity compilation status')
        if (compilation.result) {
          this.state(i, 'compile-errors', 'Fix the compile errors in the source, then Play again.'); throw new Error(i.message)
        }
        this.state(i, 'entering-play')
        check()
        if (options.scene) {
          if (!/^Assets\/.+\.unity$/.test(options.scene) || options.scene.split('/').includes('..') || options.scene.includes('\\')) throw new Error('Invalid scene path')
          await this.local(i).request('open_scene', { path: options.scene })
        }
        await this.local(i).request('editor_play')
        await this.ready(i, 'playing', controller.signal)
        check()
        await this.copies.playing(project, this.system.now()); this.state(i, 'playing')
        this.ctx.stats.unlock('play-first')
        return this.status(world)
      } catch (e) {
        if (suspended && i.launch) await this.local(i).request('genio_sync_end').catch(() => {})
        if (!['stuck-dialog', 'close-stuck', 'compile-errors', ...REFUSED].includes(i.state)) {
          const cancelled = controller.signal.aborted || this.generations.get(project) !== generation
          this.state(i, cancelled ? i.launch ? 'stopped-warm' : 'idle' : 'error', (e as Error).message)
        }
        if (i.launch && !['close-stuck'].includes(i.state)) await this.idle(i)
        // A refused copy has no editor to time out with it: give the copy itself the idle deadline (poll deletes it).
        else if (!i.launch && REFUSED.includes(i.state) && this.copies.status(project)) await this.copies.stopped(project, this.system.now(), this.settings.idleMinutes * 60000)
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
  stop(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => {
      await this.start()
      const i = this.instances.get(project)
      // Cancel on an admission prompt dismisses it; the refused copy keeps its idle deadline.
      if (!i?.launch) { if (i && REFUSED.includes(i.state)) { delete i.lowMemory; this.state(i, 'idle') } return this.status(world) }
      this.local(i).stopStream()
      try { await this.local(i).request('editor_stop'); await this.ready(i, 'stopped'); this.state(i, 'stopped-warm') }
      catch (e) { if (i.state !== 'stuck-dialog') this.state(i, 'error', (e as Error).message); throw e }
      finally { await this.idle(i) }
      if (!this.settings.idleMinutes) await this.close(i, 'idle timeout')
      return this.status(world)
    })
  }
  keepAlive(world: string) {
    const { project } = this.project(world)
    return this.serial(project, async () => { const i = this.instances.get(project); if (i?.launch && i.stoppedAt !== undefined) await this.idle(i); return this.status(world) })
  }
  quit(world: string) {
    const { project } = this.project(world)
    this.cancel(project)
    return this.serial(project, async () => { await this.start(); const i = this.instances.get(project); if (i) await this.close(i, 'player quit'); else await this.copies.editorGone(project); return this.status(world) })
  }
  async restart(world: string, visible = false) {
    const source = this.instances.get(this.project(world).project)?.source
    if (!source) throw new Error('Choose a source and Play first')
    const result = await this.quit(world)
    if (result.state === 'close-stuck') throw new Error(result.message)
    return this.play(world, source, { visible })
  }
  private async close(i: Instance, reason: string, keepCopy = false) {
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
    if (!keepCopy) await this.copies.editorGone(i.project, reason)
  }
  async poll() {
    if (this.polling || this.exiting) return
    this.polling = true
    try {
      const procs = await this.system.list()
      for (const i of this.instances.values()) {
        if (!i.launch || this.operations.has(i.project)) continue
        await this.serial(i.project, async () => {
          const p = procs.find(p => sameProcess(p, i.launch!) && opensRoot(p, i.root!))
          if (!p) {
            try { i.exitCode = JSON.parse(fs.readFileSync(path.join(i.launch!.dir!, 'exit.json'), 'utf8')).exitCode } catch { /* no helper exit yet */ }
            await this.close(i, 'editor exited'); if (!i.launch && i.state !== 'close-stuck') this.state(i, 'crashed', 'The player editor exited. Play again to restart.'); return
          }
          i.tracked = playerTree(procs, [p], i.root!)
          const workingSet = i.tracked.reduce((sum, p) => sum + (p.workingSet ?? 0), 0)
          i.peakWorkingSet = Math.max(i.peakWorkingSet ?? 0, workingSet) || i.peakWorkingSet
          // The estimate learns from an editor at rest in Play or ready, not from the import peak; a new session replaces it.
          if (workingSet > 0 && (i.state === 'playing' || i.state === 'stopped-warm')) { i.steadyWorkingSet = i.sampled ? Math.max(i.steadyWorkingSet ?? 0, workingSet) : workingSet; i.sampled = true }
          const watched = await inspectDesktop(this.desktop, i.launch, { now: this.system.now() })
          if (watched.blocked) { this.local(i).stopStream(); i.dialog = watched.blocked; this.state(i, 'stuck-dialog', watched.blocked.message); if (i.stoppedAt === undefined) await this.idle(i) }
          if (i.deadline !== undefined && i.deadline <= this.system.now()) await this.close(i, 'idle timeout')
          else this.save(i)
        })
      }
      // Copies without an editor (refused for memory, say) go at their own deadline.
      for (const copy of this.copies.due(this.system.now())) {
        if (this.operations.has(copy.project) || this.instances.get(copy.project)?.launch) continue
        await this.serial(copy.project, async () => { if (!this.instances.get(copy.project)?.launch) await this.copies.editorGone(copy.project, 'idle timeout') })
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
  async stream(world: string, width: number, height: number, frame: (b: Buffer) => void, disconnect: () => void) {
    const { project } = this.project(world)
    if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 1920)) throw new Error('Stream dimensions must be 16–1920')
    return this.serial(project, async () => { const i = this.instances.get(project); if (!i?.launch || i.state !== 'playing') throw new Error('Play this project before streaming'); await this.local(i).stream(width, height, frame, disconnect) })
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
    if (!i?.launch || i.state !== 'playing') { if (input.type === 'release') return; throw new Error('The player instance is not playing') }
    if (input.type !== 'release' && !this.supportsInput(i)) throw new Error('Legacy input is view-only')
    this.local(i).input(input)
  }
  /** The hidden desktop's screenshot taken when a dialog blocked this instance, as a PNG data URL. */
  dialogScreenshot(world: string): string | undefined {
    const i = this.instances.get(this.project(world).project), file = i?.dialog?.screenshot, dir = i?.launch?.dir
    if (!file || !dir || path.dirname(path.resolve(file)) !== path.resolve(dir) || !/^blocked-\d+\.png$/.test(path.basename(file))) return undefined
    try { const bytes = fs.readFileSync(file); return bytes.length <= 16 * 2 ** 20 ? `data:image/png;base64,${bytes.toString('base64')}` : undefined } catch { return undefined }
  }
  detach(world: string) { return this.stop(world) }
  /** Cancel copies now; close editors in parallel. Deletion is already a background job and is never awaited. */
  async shutdown() {
    this.exiting = true; clearInterval(this.timer)
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
