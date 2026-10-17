/** Pure behaviour of the floating answer cards, kept apart from React so it can be tested in node. */
import type { AwayMode, Decision, Settings } from '@shared/types'

/** How many pending choices float at once; the rest wait behind the "+K waiting" pill. */
export const CARD_LIMIT = 3
/** Exit (slide and fade) duration; the card leaves the DOM when it ends. */
export const CARD_EXIT_MS = 200
export const CARD_ENTER_MS = 220

/** Urgent approvals first regardless of age, then oldest first. */
export function cardOrder(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((a, b) =>
    a.urgency !== b.urgency ? (a.urgency === 'urgent' ? -1 : 1) : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/**
 * The cards on screen and how many wait. A pinned choice (a notification target) is
 * shown even when it would be waiting, in place of the last ordinary card; urgent
 * cards are never pushed out for it.
 */
export function cardQueue(decisions: readonly Decision[], pin?: string, limit = CARD_LIMIT): { queue: Decision[]; shown: Decision[]; waiting: number } {
  const queue = cardOrder(decisions)
  let shown = queue.slice(0, limit)
  const pinned = pin ? queue.find(d => d.id === pin) : undefined
  if (pinned && !shown.includes(pinned) && shown.length && shown[shown.length - 1].urgency !== 'urgent') shown = [...shown.slice(0, -1), pinned]
  return { queue, shown, waiting: queue.length - shown.length }
}

export type CardPhase = 'in' | 'idle' | 'out'
export interface CardSlot {
  id: string
  d: Decision
  phase: CardPhase
  /** offsetTop held while it animates out of the flow */
  top?: number
  /** an exiting card keeps the open/compact look it had */
  open?: boolean
}

/**
 * Next rendered slots when the shown set changes: newcomers enter, cards that left the
 * set exit (kept, out of flow at their last position, until the exit ends), and a card
 * that comes back while still exiting re-enters.
 */
export function reconcileSlots(prev: readonly CardSlot[], shown: readonly Decision[], tops: ReadonlyMap<string, number> = new Map()): CardSlot[] {
  const before = new Map(prev.map(s => [s.id, s]))
  const ids = new Set(shown.map(d => d.id))
  const next: CardSlot[] = shown.map(d => {
    const s = before.get(d.id)
    return { id: d.id, d, phase: !s || s.phase === 'out' ? 'in' : s.phase }
  })
  for (const s of prev) if (!ids.has(s.id)) next.push(s.phase === 'out' ? s : { ...s, phase: 'out', top: tops.get(s.id) ?? s.top ?? 0 })
  return next
}

/**
 * Which cues a change of the queue earns: 'in' when a card appears for a choice that was not
 * already waiting (a promotion is not an arrival), 'out' when a shown card left the queue
 * (answered, snoozed or resolved elsewhere). The first render earns none.
 */
export function cardCues(before: { queue: readonly string[]; shown: readonly string[] } | undefined, after: { queue: readonly Decision[]; shown: readonly Decision[] }): { in: boolean; urgent: boolean; out: boolean } {
  if (!before) return { in: false, urgent: false, out: false }
  const waited = new Set(before.queue)
  const queued = new Set(after.queue.map(d => d.id))
  const arrived = after.shown.filter(d => !waited.has(d.id))
  return { in: arrived.length > 0, urgent: arrived.some(d => d.urgency === 'urgent'), out: before.shown.some(id => !queued.has(id)) }
}

/**
 * Card sounds follow the window: never with sound off or from an unfocused background
 * window. An arrival also stays quiet under DND/AFK (those capture escalations instead)
 * and under Clean chat unless it is urgent; the dequeue cue answers the player's own
 * action, like the send sound, so presence does not mute it.
 */
export function cardCueAllowed(cue: 'card-in' | 'card-out', ctx: { settings: Settings | null | undefined; away: AwayMode; focused: boolean; urgent?: boolean }): boolean {
  if (!ctx.settings?.sound || !ctx.focused) return false
  if (cue === 'card-out') return true
  if (ctx.away !== 'online') return false
  return !ctx.settings.calm || !!ctx.urgent
}
