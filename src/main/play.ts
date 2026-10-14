import path from 'node:path'
import type { AppCtx } from './services'
import { UnityAdapter, type EngineAdapter } from './play-unity'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots, type PlayAction } from '@shared/play'
import { PlayPool, stuckMessage } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'

export function assertProjectWindow(binding: { project: string } | undefined, world: unknown): void {
  if (!binding || world !== binding.project) throw new Error('Unity slots are bound to this project window; open the project first')
}

/**
 * The shared Unity slot pool (Settings › This project › Unity slots and Genio's slot recovery) and
 * Genio's chat tools on the project's main editor (play_status, play_frame, play_console, play_stats, play_control).
 */
export class PlayService {
  private adapters = new Map<string, EngineAdapter>()
  private pools = new Map<string, PlayPool>()
  private closing = new Set<string>()
  constructor(private ctx: AppCtx) {}
  private project(world: string) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error('Unknown Unity project')
    const { engine, root: engineRoot } = effectiveEngine(p)
    if (!supportsUnitySlots(engine)) throw new Error('Unity slots and editor tools only support Unity projects')
    return { p, root: path.resolve(p.path, engineRoot), engineRoot }
  }
  pool(world: string): PlayPool {
    let pool = this.pools.get(world)
    if (!pool) { const { p, engineRoot } = this.project(world); pool = new PlayPool(this.ctx.main.home.data, p.path, engineRoot); this.pools.set(world, pool) }
    return pool
  }
  async poolState(world: string) { return this.pool(world).state() }
  /** Settings › This project › Unity slots. Never refuses and never closes anything: extra slots drain. */
  async configurePool(world: string, cap: number) { const result = await this.pool(world).configure(cap); this.ctx.stats.unlock('play-pool-configured'); return result }
  /** Settings › This project › Unity slots: hidden (default) or visible slot editor windows, from the next launch. */
  async configureLaunch(world: string, visible: boolean) { return this.pool(world).configureLaunch(visible) }
  /**
   * The supported recovery for a slot editor: graceful quit, timed wait, then a forced stop of
   * only that slot's verified processes. The player (confirmed in Settings › This project › Unity slots) may revoke
   * a live lease; Genio recovers only free, orphaned or stuck slots.
   */
  async closeSlotEditor(world: string, id: number, actor: 'player' | 'genio'): Promise<void> {
    if (this.closing.has(world)) throw new Error('A slot editor is already closing; try again when it finishes')
    this.closing.add(world)
    try {
      const result = await this.pool(world).closeSlot(id, { force: actor === 'player' })
      if (!result.closed) throw new Error(actor === 'player' ? `Slot ${id} editor could not be closed: ${result.reason}${result.pids.length ? ` (PIDs ${result.pids.join(', ')})` : ''}. Close that Unity window yourself, then use Close slot editor again.` : stuckMessage(id, result))
    } finally {
      this.closing.delete(world)
    }
  }
  /** The project's main editor, coordinated between Genio processes by the pool's main lease. */
  adapter(world: string): EngineAdapter {
    const { root } = this.project(world)
    let a = this.adapters.get(root)
    if (!a) { a = new UnityAdapter(root, () => this.pool(world).mainControl()); this.adapters.set(root, a) }
    return a
  }
  async status(world: string) {
    const status = await this.adapter(world).status()
    if (status.connected && status.state === 'playing') this.ctx.stats.unlock('play-first')
    return status
  }
  async act(world: string, action: PlayAction, words: string) {
    if (!words?.trim()) throw new Error('Play control requires player_words quoting the explicit request')
    await this.adapter(world).act(action)
  }
  async frame(world: string, width = 1280, height = 720) {
    const frame = await this.adapter(world).frame(width, height)
    this.ctx.stats.unlock('play-observed')
    return frame
  }
}
const services = new WeakMap<AppCtx, PlayService>()
export function playService(ctx: AppCtx): PlayService {
  let service = services.get(ctx)
  if (!service) { service = new PlayService(ctx); services.set(ctx, service) }
  return service
}
