import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { AppCtx } from './services'
import { detectEngine } from './projects'
import { UnityAdapter, type EngineAdapter } from './play-unity'
import { unityEditor } from './play-editor'
import type { PlayAction, PlayScene } from '@shared/play'

export function assertPlayWindow(binding: { project: string } | undefined, world: unknown): void {
  if (!binding || world !== binding.project) throw new Error('Play is bound to this project window; open the project first')
}

export class PlayService {
  private adapters = new Map<string, EngineAdapter>()
  private opening = new Map<string, number>()
  private generations = new Map<string, number>()
  private driving = new Map<string, number>()
  constructor(private ctx: AppCtx) {}
  private project(world: string) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error('Unknown Play world')
    const detected = detectEngine(p.path)
    if (detected.engine !== 'unity') throw new Error('Snapshot Play currently supports Unity projects')
    return { p, root: path.resolve(p.path, detected.engineRoot) }
  }
  adapter(world: string): EngineAdapter {
    const { root } = this.project(world)
    let a = this.adapters.get(root)
    if (!a) { a = new UnityAdapter(root); this.adapters.set(root, a) }
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
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, ['-projectPath', root], { detached: true, stdio: 'ignore', windowsHide: false })
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
