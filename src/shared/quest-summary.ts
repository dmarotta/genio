import type { BacklogItem, FleetSnapshot } from './types'

/** Planned work is the open part of the board; dated holds join the queue when released. */
export function questCounts(items: BacklogItem[], now = Date.now()) {
  let comingNext = 0
  let running = 0
  let planned = 0
  for (const q of items) {
    if (q.state === 'done' || q.state === 'dropped') continue
    if (q.state === 'in-flight') { running++; continue }
    planned++
    const held = !!q.hold || q.state === 'held'
    if (!held || (q.hold?.until && Date.parse(q.hold.until) <= now)) comingNext++
  }
  return { comingNext, running, planned }
}

export interface LootEntry { key: string; title: string; detail: string; completedAt: string }

/** A short completion history from the same live snapshot as the stats, without report IPC. */
export function recentLoot(snap: Pick<FleetSnapshot, 'tasks' | 'backlog'>): LootEntry[] {
  const completed = snap.tasks.filter(t => t.landedAt || t.state === 'merged' || t.state === 'done')
  const taskIds = new Set(completed.map(t => t.id))
  const entries: LootEntry[] = completed.map(t => ({
    key: `unit-${t.id}`, title: t.title,
    detail: t.kind === 'scout' ? 'Recon report delivered' : t.landedAt || t.state === 'merged' ? 'Build landed' : 'Build finished',
    completedAt: t.landedAt ?? t.updatedAt
  }))
  for (const q of snap.backlog) {
    if (q.state !== 'done' || (q.taskId && taskIds.has(q.taskId))) continue
    entries.push({ key: `quest-${q.id}`, title: q.title, detail: 'Quest completed', completedAt: q.doneAt ?? q.updatedAt })
  }
  return entries.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.key.localeCompare(b.key)).slice(0, 10)
}
