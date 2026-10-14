import path from 'node:path'
import type { AppCtx } from './services'
import type { Task } from '@shared/types'
import { effectiveEngine } from '@shared/engine'
import { supportsUnitySlots, type PlayerCopySource, type PlayerSourceOption } from '@shared/play'
import { git, localBranches, repoTop, sameFolder, worktreeList } from './git'

/** Units whose worktree can still be played: not cleaned up. */
const playable = (t: Task): boolean => t.state !== 'cleaned' && !!t.worktree

function projectTasks(ctx: AppCtx, world: string): Task[] {
  return [...ctx.homes.values()].flatMap((h) => h.crew.list()).filter((t) => t.project === world && playable(t))
}

/** Uncommitted files in a checkout; undefined when git is slow or fails (a huge tree must not stall the picker). */
async function dirtyCount(dir: string): Promise<number | undefined> {
  const r = await git(dir, ['status', '--porcelain=v1', '--untracked-files=normal'], 15_000)
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).length : undefined
}

/**
 * The Play screen's sources for a project: its main checkout, the player's own worktrees, units' worktrees by
 * unit name, and local branches without a checkout (played from commits). Genio's copies are never offered.
 */
export async function playerSources(ctx: AppCtx, world: string): Promise<PlayerSourceOption[]> {
  const p = ctx.projects.get(world)
  if (!p) throw new Error('Unknown Unity project')
  if (!supportsUnitySlots(effectiveEngine(p).engine)) throw new Error('Play only supports Unity projects')
  const top = path.resolve((await repoTop(p.path)) || p.path)
  const trees = await worktreeList(top)
  const tasks = projectTasks(ctx, world)
  const data = ctx.main.home.data
  const genioCopy = (dir: string): boolean => {
    const rel = path.relative(data, dir)
    return (!rel.startsWith('..') && !path.isAbsolute(rel) && /^(play-pools|player-copies)([\\/]|$)/.test(rel)) || /[\\/]\.genio[\\/][^\\/]+[\\/](play-pools|player-copies)[\\/]/i.test(dir)
  }
  const options: PlayerSourceOption[] = []
  const main = trees.find((t) => sameFolder(t.path, top))
  // A checkout is its top folder; the mirror finds the Unity root inside it from the project's engine root.
  options.push({ id: 'main', group: 'main', label: 'Main checkout', source: { path: top }, ...(main?.branch ? { branch: main.branch } : {}), ...(main?.head ? { head: main.head } : {}) })
  const checkouts = new Set(main?.branch ? [main.branch] : [])
  for (const t of trees) {
    if (t === main || genioCopy(t.path)) continue
    const source = { path: t.path }
    const task = tasks.find((k) => sameFolder(k.worktree, t.path))
    if (t.branch) checkouts.add(t.branch)
    options.push(task
      ? { id: `unit:${task.id}`, group: 'unit', label: task.title, task: task.id, source, ...(t.branch ? { branch: t.branch } : {}), ...(t.head ? { head: t.head } : {}) }
      : { id: `worktree:${t.path}`, group: 'worktree', label: path.basename(t.path), source, ...(t.branch ? { branch: t.branch } : {}), ...(t.head ? { head: t.head } : {}) })
  }
  await Promise.all(options.map(async (o) => { if ('path' in o.source) { const n = await dirtyCount(o.source.path); if (n !== undefined) o.dirty = n } }))
  for (const b of await localBranches(top)) {
    if (checkouts.has(b.name)) continue
    options.push({ id: `branch:${b.name}`, group: 'branch', label: b.name, source: { ref: b.name }, branch: b.name, head: b.head })
  }
  const order = { main: 0, worktree: 1, unit: 2, branch: 3 }
  return options.sort((a, b) => order[a.group] - order[b.group])
}

/** The unit whose worktree this source plays, if any (achievements and the screen's facts). */
export function sourceUnit(ctx: AppCtx, world: string, source: PlayerCopySource): Task | undefined {
  if (!('path' in source)) return undefined
  return projectTasks(ctx, world).find((t) => sameFolder(t.worktree, source.path))
}
