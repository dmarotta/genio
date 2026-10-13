import type { BacklogItem } from './types'

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
