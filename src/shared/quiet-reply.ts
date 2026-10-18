import type { ChatMessage } from './types'

/**
 * Replies the player must never see: what an event turn says when nothing needs them. The contract tells
 * Genio to end such a turn with no text at all; a model can still answer with the old sentence ("All clear,
 * Alex.") or the placeholder the Claude CLI writes for an empty message. The check is exact: the whole reply
 * must be one of these, whatever its case, quotes, emphasis or closing punctuation, so a real message that
 * merely starts with "All clear" is shown.
 */

const PLACEHOLDERS = new Set(['(no content)', 'no response requested'])
const WRAP = '\\s"\'`\u201c\u201d\u2018\u2019\u00ab\u00bb*_~'
const LEADING = new RegExp(`^[${WRAP}]+`)
const TRAILING = new RegExp(`[${WRAP}.!\u2026]+$`)
const CLOSING = new RegExp(`^[${WRAP}.!\u2026]*$`)
const GREETINGS = ['', 'gg, ', 'gg ']

/** A reply in its comparable form: no zero-width characters, quotes, emphasis or closing punctuation; one case, one space. */
function core(text: string): string {
  return text.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(LEADING, '').replace(TRAILING, '')
    .toLowerCase().replace(/\s+/g, ' ').replace(/ ,/g, ',')
}

function sentences(names: readonly string[]): string[] {
  const who = names.map((n) => core(n)).filter(Boolean)
  return GREETINGS.flatMap((g) => [`${g}all clear`, ...who.flatMap((n) => [`${g}all clear, ${n}`, `${g}all clear ${n}`])])
}

/** True for a reply that is empty, a placeholder, or exactly the no-op sentence ("All clear" or "All clear, <player>"). */
export function isQuietReply(text: string, names: readonly string[] = []): boolean {
  const c = core(text)
  return c === '' || PLACEHOLDERS.has(c) || sentences(names).includes(c)
}

/**
 * True while streamed text is still a prefix of a quiet reply (or has only closing punctuation after one): the
 * stream is held back until it is clear whether it is the no-op sentence or a real message.
 */
export function couldBecomeQuietReply(prefix: string, names: readonly string[] = []): boolean {
  const p = prefix.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(LEADING, '').toLowerCase().replace(/\s+/g, ' ').replace(/ ,/g, ',')
  if (!p) return true
  return [...sentences(names), ...PLACEHOLDERS].some((s) => s.startsWith(p) || (p.startsWith(s) && CLOSING.test(p.slice(s.length))))
}

/**
 * A chat log written before event turns stopped recording their no-op replies: those rows (a Genio or system
 * message that is only the sentence, with no tools or reaction) are dropped, and so is an empty Genio message.
 * A sentence that directly follows a player message is kept: asked "anything new?", "All clear, Alex." is the answer.
 */
export function withoutQuietReplies(list: readonly ChatMessage[], names: readonly string[] = []): ChatMessage[] {
  return list.filter((m, i) => {
    const reply = m.role === 'genio' || (m.role === 'system' && !m.shell && !m.from)
    if (!reply || m.tools?.length || m.reaction || m.generation || m.generating || m.images?.length || !isQuietReply(m.text, names)) return true
    return !!m.text.trim() && list[i - 1]?.role === 'player'
  })
}
