import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { AppCtx } from './services'
import { UnityAdapter, type EngineAdapter } from './play-unity'
import { unityEditor } from './play-editor'
import { effectiveEngine } from '@shared/engine'
import { supportsPlay, type PlayAction, type PlayInput, type PlayScene } from '@shared/play'
import { PlayStream } from './play-stream'
import { installPlayPackage } from './play-package'
import { PlayPool, type PoolLease } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'

export function assertPlayWindow(binding: { project: string } | undefined, world: unknown): void {
  if (!binding || world !== binding.project) throw new Error('Play is bound to this project window; open the project first')
}

export class PlayService {
  private adapters = new Map<string, EngineAdapter>()
  private opening = new Map<string, number>()
  private generations = new Map<string, number>()
  private driving = new Map<string, number>()
  private streams = new Map<string, PlayStream>()
  private pools = new Map<string, PlayPool>()
  private leases = new Map<string, PoolLease>()
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private poolBusy = new Set<string>()
  private streamHeartbeats = new Map<string, ReturnType<typeof setInterval>>()
  private lostSlots = new Set<string>()
  private pendingDetach = new Set<string>()
  constructor(private ctx: AppCtx) {}
  private project(world: string, main = false) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error('Unknown Play project')
    const { engine, root: engineRoot } = effectiveEngine(p)
    if (!supportsPlay(engine)) throw new Error('Snapshot Play currently supports Unity projects')
    if (!main && this.lostSlots.has(world)) throw new Error('Play slot lease was taken over. Select main or lease a slot again.')
    return { p, root: !main && this.leases.has(world) ? this.leases.get(world)!.root : path.resolve(p.path, engineRoot), engineRoot }
  }
  pool(world: string): PlayPool {
    let pool = this.pools.get(world)
    if (!pool) { const { p, engineRoot } = this.project(world, true); pool = new PlayPool(this.ctx.main.home.data, p.path, engineRoot); this.pools.set(world, pool) }
    return pool
  }
  async poolState(world: string) { return { ...await this.pool(world).state(), selected: this.leases.get(world)?.id } }
  async configurePool(world: string, cap: number) { await this.pool(world).configure(cap); this.ctx.stats.unlock('play-pool-configured') }
  async selectSlot(world: string, id?: number, takeover = false): Promise<void> {
    if (this.poolBusy.has(world)) throw new Error('Play slot preparation is already running')
    this.poolBusy.add(world)
    try {
      await this.stopStream(world)
      this.lostSlots.delete(world)
      const pool = this.pool(world), old = this.leases.get(world)
      if (old && old.id === id) return
      if (old) { await pool.release(old.id, old.token); this.leases.delete(world) }
      clearInterval(this.heartbeats.get(world)); this.heartbeats.delete(world)
      if (id === undefined) { await pool.cancel(`player:${process.pid}`); return }
      const lease = await pool.acquire(`player:${process.pid}`, process.pid, id, takeover)
      if (!lease) throw new Error('All requested Play slots are leased; queued. Retry to keep your place, or take over explicitly.')
      this.leases.set(world, lease)
      const timer = setInterval(() => void pool.check(lease.id, lease.token).catch(() => {
        clearInterval(timer); this.lostSlots.add(world); this.leases.delete(world); this.stopStreamLocal(world)
      }), 5000)
      timer.unref(); this.heartbeats.set(world, timer)
      try { if (!(await pool.state()).slots.find(s => s.id === lease.id)?.revision) await pool.prepare(lease.id, lease.token) }
      catch (error) { clearInterval(timer); this.heartbeats.delete(world); this.leases.delete(world); await pool.release(lease.id, lease.token); throw error }
      this.ctx.stats.unlock(takeover ? 'play-takeover' : 'play-slot')
    } finally {
      this.poolBusy.delete(world)
      if (this.pendingDetach.delete(world)) await this.detach(world)
    }
  }
  async enableStreaming(world: string) {
    if (this.leases.has(world)) throw new Error('Enable the package on the main copy and commit it before preparing a slot')
    const { p, root } = this.project(world, true)
    installPlayPackage(this.ctx.appRoot, p.path, root)
    this.ctx.stats.unlock('play-package')
  }
  async startStream(world: string, width: number, height: number, onFrame: (frame: Buffer) => void, onDisconnect: () => void): Promise<void> {
    if (![width, height].every(n => Number.isInteger(n) && n >= 16 && n <= 1920)) throw new Error('Stream dimensions must be 16–1920')
    await this.stopStream(world)
    const stream = new PlayStream()
    this.streams.set(world, stream)
    stream.onFrame = frame => { this.ctx.stats.unlock('play-stream'); onFrame(frame) }
    stream.onDisconnect = onDisconnect
    try {
      const credentials = await stream.listen()
      if (this.streams.get(world) !== stream) throw new Error('Stream start cancelled')
      const adapter = this.adapter(world)
      if (!adapter.stream) throw new Error('Streaming is unavailable for this engine')
      await adapter.stream({ ...credentials, width, height })
      if (this.streams.get(world) !== stream) throw new Error('Stream start cancelled')
      const lease = this.leases.get(world)
      const heartbeat = setInterval(() => void (lease ? this.pool(world).check(lease.id, lease.token) : this.pool(world).mainControl()).catch(() => this.stopStreamLocal(world)), 5000)
      heartbeat.unref(); this.streamHeartbeats.set(world, heartbeat)
    } catch (e) { if (this.streams.get(world) === stream) this.stopStreamLocal(world); else stream.close(); throw e }
  }
  async input(world: string, input: PlayInput): Promise<void> {
    const lease = this.leases.get(world)
    if (lease) await this.pool(world).check(lease.id, lease.token)
    else await this.pool(world).mainControl()
    this.generations.set(world, (this.generations.get(world) ?? 0) + 1)
    const stream = this.streams.get(world)
    if (!stream) { if (input.type === 'release') return; throw new Error('Start live streaming first') }
    stream.input(input)
    if (input.type === 'state') this.ctx.stats.unlock('play-input')
  }
  private stopStreamLocal(world: string): void {
    clearInterval(this.streamHeartbeats.get(world)); this.streamHeartbeats.delete(world)
    const stream = this.streams.get(world); this.streams.delete(world); stream?.close()
  }
  async stopStream(world: string): Promise<void> {
    if (!this.streams.has(world)) return
    this.stopStreamLocal(world)
    // Closing the socket tears down Unity's session and releases input. Do not send
    // a delayed stop command: it could disconnect a successor's new stream.
  }
  async detach(world: string): Promise<void> {
    if (this.poolBusy.has(world)) { this.pendingDetach.add(world); this.stopStreamLocal(world); return }
    await this.selectSlot(world); await this.pool(world).releaseMain()
  }
  adapter(world: string): EngineAdapter {
    const { root } = this.project(world)
    const lease = this.leases.get(world)
    const key = `${root}:${lease?.token ?? 'main'}`
    let a = this.adapters.get(key)
    if (!a) {
      const guard = async () => {
        if (lease) { if (this.leases.get(world)?.token !== lease.token) throw new Error('Play target changed'); await this.pool(world).check(lease.id, lease.token) }
        else { if (this.leases.has(world) || this.lostSlots.has(world)) throw new Error('Play target changed'); await this.pool(world).mainControl() }
      }
      a = new UnityAdapter(root, guard); this.adapters.set(key, a)
    }
    return a
  }
  async status(world: string) {
    const status = await this.adapter(world).status()
    if (status.connected && status.state === 'playing') this.ctx.stats.unlock('play-first')
    return { ...status, genioDriving: (this.driving.get(world) ?? 0) > 0 }
  }
  async scenes(world: string): Promise<PlayScene[]> {
    const { root } = this.project(world)
    const open = await this.adapter(world).scenes()
    const all = new Map(open.map(s => [s.path, s]))
    const scan = async (dir: string): Promise<void> => {
      for (const entry of await fs.promises.readdir(path.join(root, dir), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) await scan(rel)
        else if (entry.name.endsWith('.unity') && !all.has(rel)) all.set(rel, { name: entry.name.slice(0,-6), path: rel })
      }
    }
    await scan('Assets')
    return [...all.values()]
  }
  async act(world: string, action: PlayAction, actor: 'player' | 'genio', words?: string) {
    if (actor === 'genio' && !words?.trim()) throw new Error('Play control requires player_words quoting the explicit request')
    const version = this.generations.get(world) ?? 0
    if (actor === 'player') this.generations.set(world, version + 1)
    // Yield so already queued player input pre-empts chat actions.
    await Promise.resolve()
    if (actor === 'genio' && version !== (this.generations.get(world) ?? 0)) throw new Error('Player took control')
    if (actor === 'genio') this.driving.set(world, (this.driving.get(world) ?? 0) + 1)
    try {
      await this.adapter(world).act(action, () => actor === 'player' || version === (this.generations.get(world) ?? 0))
      if (action.type === 'step') this.ctx.stats.unlock('play-step')
      if (action.type === 'resolution') this.ctx.stats.unlock('play-resolution')
    } finally {
      if (actor === 'genio') this.driving.set(world, Math.max(0, (this.driving.get(world) ?? 1) - 1))
    }
  }
  async frame(world: string, width = 1280, height = 720, observed = false) {
    const frame = await this.adapter(world).frame(width, height)
    this.ctx.stats.unlock('play-snapshot')
    if (observed) this.ctx.stats.unlock('play-observed')
    return frame
  }
  async screenshot(world: string) {
    const frame = await this.frame(world)
    const dir = path.join(this.ctx.main.home.data, 'play-screenshots')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2,8)}.png`)
    fs.writeFileSync(file, Buffer.from(frame.base64, 'base64'), { flag: 'wx' })
    return file
  }
  async open(world: string) {
    const { root } = this.project(world)
    if ((await this.status(world)).connected) return
    if (Date.now() - (this.opening.get(root) ?? 0) < 180000) throw new Error('Unity is already opening; wait for import')
    // An editor without Pipeline must never trigger a second launch.
    const lock = path.join(root, 'Temp/UnityLockfile')
    if (fs.existsSync(lock)) throw new Error('Unity may already be open without Pipeline or waiting on a dialog. Focus Unity.')
    let editorPid: number | undefined
    try { editorPid = JSON.parse(fs.readFileSync(path.join(root, 'Library/EditorInstance.json'), 'utf8')).process_id } catch { /* No recorded editor. */ }
    if (Number.isInteger(editorPid) && editorPid! > 0) {
      let alive = false
      try { process.kill(editorPid!, 0); alive = true } catch { /* Previous editor exited. */ }
      if (alive) throw new Error('An editor process already owns this project. Focus Unity.')
    }
    const editor = unityEditor(root)
    if (!editor) throw new Error('Install the project Unity version through Unity Hub first')
    this.opening.set(root, Date.now())
    const lease = this.leases.get(world)
    if (lease) { await this.pool(world).validateCopy(lease.id); await this.pool(world).check(lease.id, lease.token) }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [...(lease ? ['-automated'] : []), '-projectPath', root], { detached: true, stdio: 'ignore', windowsHide: !!lease })
      child.once('error', () => { this.opening.delete(root); reject(new Error('Could not open Unity')) })
      child.once('spawn', () => { child.unref(); resolve() })
    })
  }
}
const services = new WeakMap<AppCtx, PlayService>()
export function playService(ctx: AppCtx): PlayService {
  let service = services.get(ctx)
  if (!service) { service = new PlayService(ctx); services.set(ctx, service) }
  return service
}
