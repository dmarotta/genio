import path from 'node:path'
import type { Task } from '@shared/types'
import { unitCaps } from '@shared/usage-mode'
import type { AppCtx } from './services'
import { globalMode, worldUsage } from './usage-policy'
import { nowIso, readJson, truncate, writeJsonAtomic } from './util'

/** The regular launch services remain authoritative for reservations, quota and consent. */
function hasCapacity(ctx: AppCtx, project: string): boolean {
  const global = ctx.dispatch.capacity()
  if (global.used >= global.cap) return false
  const settings = ctx.settings.get(), world = ctx.projects.get(project)
  const own = worldUsage(settings, world)
  const caps = unitCaps(globalMode(settings), { mode: own.source === 'global' ? undefined : own.mode, capacity: world?.capacity })
  const used = [...ctx.homes.values()].reduce((n, h) => n + h.crew.capacityUsed(project), 0)
  return caps.world === undefined || used < caps.world
}

/** One call per window open, after app startup; deliberately independent of the Hub UI. */
export async function reconcileProjectOpen(ctx: AppCtx, project: string, wksp: string, isOpen: () => boolean): Promise<void> {
  try {
    await reconcile(ctx, project, wksp, isOpen)
  } catch (error) {
    // The chat holds sends until the opening turn: a failed reconcile must still open it, or they wait forever.
    if (isOpen()) ctx.home(wksp).wksp.wakeProject(`Project: ${project}. Startup reconciliation failed: ${truncate(String((error as Error)?.message ?? error), 300)}. Check fleet_view before acting on units or quests.`)
    throw error
  }
}

async function reconcile(ctx: AppCtx, project: string, wksp: string, isOpen: () => boolean): Promise<void> {
  const target = ctx.home(wksp)
  const file = path.join(target.home.state, 'project-open.json')
  const previous = readJson<{ openedAt?: string }>(file, {}).openedAt
  const openedAt = nowIso()
  const results: string[] = []
  const homes = [...ctx.homes.values()]

  // A dislike whose grace period ran out while Genio was down pauses its work now, before anything is resumed.
  for (const home of homes) await home.reactions?.recover().catch(() => 0)

  // Unread done/blocked/paused lines must be applied before deciding to resume.
  // This is overwatch's durable status batch path, without scheduling a turn.
  for (const home of homes) {
    await home.crew.reconcileOnStart(project)
    home.supervisor.replayStatus(project)
    // A final progress line may restore 'working' after stale terminals were
    // cleared. A replayed done line can start a fresh Gauntlet, which must stay
    // validating rather than being cancelled by another liveness reconcile.
    for (const task of home.crew.list().filter(t => t.project === project)) {
      if (!['working', 'spawning', 'stale', 'exited'].includes(task.state) || (task.terminalId && ctx.terminals.get(task.terminalId)?.alive)) continue
      // A quest the player already closed is never resumed.
      const quest = home.crew.questState(task)
      if (quest === 'done' || quest === 'dropped') {
        if (task.state !== 'exited') home.crew.update(task.id, { state: 'exited', stateReason: `quest ${quest}; not resumed after restart` })
      } else home.crew.update(task.id, { state: 'detached', stateReason: 'Project reopened; resume unfinished work' })
    }
  }
  for (const home of homes) {
    for (const task of home.crew.list().filter(t => t.project === project && t.state === 'detached')) {
      if (!isOpen()) return
      if (['done', 'dropped'].includes(home.crew.questState(task) ?? '')) continue
      if (!hasCapacity(ctx, project)) {
        results.push(`Unit ${task.id} waiting for capacity.`)
        continue
      }
      try {
        const result = await home.crew.control(task.id, 'relaunch', 'Project reopened. Resume the existing authorized mission from its durable brief and progress.', true)
        results.push(`Unit ${task.id}: ${result.ok ? 'resumed' : truncate(result.message, 300)}`)
      } catch (error) {
        results.push(`Unit ${task.id}: ${truncate(String((error as Error).message), 300)}`)
      }
    }
  }

  // Ask each owning quest log again after every launch: cap usage and in-flight
  // state may change during preparation. Never dispatch another project's rows.
  for (const home of homes) {
    const attempted = new Set<string>()
    while (isOpen() && hasCapacity(ctx, project)) {
      const quest = home.backlog.dispatchable(project, attempted).find(q => q.project === project)
      if (!quest) break
      attempted.add(quest.id)
      if (quest.hold) home.backlog.release(quest.id) // only an expired dated hold is dispatchable
      try {
        const task = await home.crew.spawn({ kind: quest.kind as 'ship' | 'scout', project, title: quest.title,
          intent: quest.notes.trim() || quest.title, backlogId: quest.id, mode: quest.mode, yolo: quest.yolo, wksp: home.home.name })
        results.push(`Quest ${quest.id}: started as ${task.id}.`)
      } catch (error) {
        results.push(`Quest ${quest.id}: still queued (${truncate(String((error as Error).message), 300)}).`)
      }
    }
  }
  if (!isOpen()) return
  // Choices answered while this chat was closed or down reach it once, in the opening turn's events.
  for (const home of homes) home.decisions.deliverAnswers(project)
  // Legacy tasks keep their home; move their durable wakes to this project chat.
  ctx.main.wksp.deliverWakes()
  const tasks = homes.flatMap(h => h.crew.list()).filter(t => t.project === project)
  const quests = homes.flatMap(h => h.backlog.list()).filter(q => q.project === project)
  const decisions = homes.flatMap(h => h.decisions.list(false)).filter(d => d.project === project || (!d.project && d.wksp === wksp))
  const landed = tasks.filter(t => t.landedAt && (!previous || t.landedAt > previous))
  const running = tasks.filter(t => t.terminalId && ctx.terminals.get(t.terminalId)?.alive && !['ready', 'merged', 'done', 'cleaned'].includes(t.state))
  const waiting = tasks.filter(t => ['blocked', 'needs-decision', 'paused', 'failed', 'detached'].includes(t.state))
  const describe = (t: Task): string => `${t.id}: ${truncate(t.title, 120)} (${t.state}${t.stateReason ? `; ${truncate(t.stateReason, 180)}` : ''})${t.pr?.url ? ` ${t.pr.url}` : ''}`
  const section = (label: string, rows: string[]): string => `${label} (${rows.length}):\n${rows.slice(0, 8).map(s => `- ${s}`).join('\n') || '- none'}${rows.length > 8 ? '\n- More in fleet_view.' : ''}`
  const recap = [
    `Project: ${project}. Previous visit: ${previous ?? 'first recorded visit'}. Opened: ${openedAt}.`,
    section('Startup reconciliation', results), section('Landed since last visit', landed.map(describe)),
    section('Running', running.map(describe)), section('Blocked or waiting units', waiting.map(describe)),
    section('Ready outcomes', tasks.filter(t => t.state === 'ready' || t.state === 'done').map(describe)),
    section('Waiting for player decisions', decisions.map(d => `${d.id}: ${truncate(d.question, 240)}`)),
    section('Quests waiting for the player', quests.filter(q => q.hold && q.state !== 'done' && q.state !== 'dropped').map(q => `${q.id}: ${truncate(q.title, 120)}; ${truncate(q.hold?.reason ?? 'waiting', 180)}`)),
    `Queued quests: ${quests.filter(q => q.state === 'queued').length}. Ready outcomes: ${tasks.filter(t => t.state === 'ready').length}.`,
    'Status events are historical; the snapshot above is current. Existing successful actions must not be repeated.'
  ].join('\n\n')
  target.wksp.wakeProject(recap)
  writeJsonAtomic(file, { openedAt })
  target.supervisor.start()
}
