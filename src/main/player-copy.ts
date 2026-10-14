import type { AppCtx } from './services'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots, type PlayerCopySource } from '@shared/play'
import { PlayerCopies } from '../../resources/unit-skills/genio/lib/player-copy.mjs'

/**
 * The player's own Play copy, one per project: kept outside the units' slot pool, cap and queue, synced from
 * any source of the project (main checkout, worktree, unit worktree, branch), and deleted in the background
 * once its editor is gone. Play's instance lifecycle (build 2) and screen (build 3) drive it; no UI here.
 */
export class PlayerCopyService {
  readonly copies: PlayerCopies
  constructor(private ctx: AppCtx) { this.copies = new PlayerCopies(ctx.main.home.data) }
  private project(world: string) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error('Unknown Unity project')
    const { engine, root: engineRoot } = effectiveEngine(p)
    if (!supportsUnitySlots(engine)) throw new Error('Play copies only support Unity projects')
    return { path: p.path, engineRoot }
  }
  /** Every project's record; one project window sees only its own. */
  list(world?: string) {
    const all = this.copies.list()
    return world === undefined ? all : all.filter(r => r.key === this.copies.keyOf(this.project(world).path))
  }
  status(world: string) { return this.copies.status(this.project(world).path) ?? null }
  ensure(world: string) { const p = this.project(world); return this.copies.ensure(p.path, p.engineRoot) }
  async sync(world: string, source: PlayerCopySource) {
    const p = this.project(world)
    await this.copies.ensure(p.path, p.engineRoot)
    return this.copies.sync(p.path, source)
  }
  cancel(world: string) { return this.copies.cancel(this.project(world).path) }
  stopped(world: string, at?: number, idleMs?: number) { return this.copies.stopped(this.project(world).path, at, idleMs) }
  playing(world: string) { return this.copies.playing(this.project(world).path) }
  /** Build 2 calls this once the copy's editor process is gone. */
  editorGone(world: string, reason?: string) { return this.copies.editorGone(this.project(world).path, reason) }
  deleteInBackground(world: string) { return this.copies.deleteInBackground(this.project(world).path, { reason: 'the player deleted it' }) }
  sizes(world: string) { const p = this.project(world); return this.copies.sizes(p.path, p.engineRoot) }
  /** At start: finish pending deletions and remove copies a previous Genio session left behind. */
  sweep() { return this.copies.sweep() }
}
const services = new WeakMap<AppCtx, PlayerCopyService>()
export function playerCopyService(ctx: AppCtx): PlayerCopyService {
  let service = services.get(ctx)
  if (!service) { service = new PlayerCopyService(ctx); services.set(ctx, service) }
  return service
}
