import type { InventoryContext } from './inventory-context'
import type { ChatImageInput } from './chat-images'
import type { Ally, ChatMessage, Settings } from './types'
import { hasMojibake, repairMojibake, trimZeroWidth } from './encoding'

const ROUTED_RE = /^\[FROM GENIO MAIN corr=([\w-]+)\]\s*([\s\S]*?)(?:\n\nWhen finished \(or blocked\), answer with report_to_main[\s\S]*)?$/

/**
 * A request main Genio routed to an ally, as shown in the ally's chat tab:
 * the request text without the routing envelope, plus its correlation id.
 */
export function routedRequest(m: Pick<ChatMessage, 'role' | 'text' | 'from'>): { corr: string; text: string } | null {
  if (m.from !== 'genio' && m.role !== 'system') return null
  const hit = ROUTED_RE.exec(m.text)
  if (hit) return { corr: hit[1], text: hit[2].trim() }
  return m.from === 'genio' ? { corr: '', text: m.text } : null
}

/** The chat controls (approval mode, model, effort) every chat pane carries. */
export interface ChatControls {
  shellMode: Settings['chatShellMode']
  /** '' = the tool's default model */
  model: string
  /** '' = auto */
  effort: string
}

/** Per-ally overrides; '' clears an override so the ally follows the main chat again. */
export interface AllyControlsPatch {
  model?: string
  effort?: string
  shellMode?: Settings['chatShellMode'] | ''
}

const SHELL_MODES: readonly string[] = ['ask', 'auto-shell', 'all']

/**
 * Effective controls of a chat. The main chat reads the Genio settings
 * (chatShellMode, wkspModel, wkspEffort); an ally uses its own saved values and
 * falls back to the main chat's for anything it has not set.
 */
/** Where the renderer keeps a chat's messages, draft and scroll position: the wksp, or the wksp and a design chat's id. */
export const chatKey = (wksp: string, conversation?: string): string => (conversation ? `${wksp}#${conversation}` : wksp)

export function chatControls(s: Pick<Settings, 'chatShellMode' | 'wkspModel' | 'wkspEffort'> | null | undefined, ally?: Pick<Ally, 'model' | 'effort' | 'shellMode'>): ChatControls {
  return {
    shellMode: ally?.shellMode || s?.chatShellMode || 'ask',
    model: ally?.model || s?.wkspModel || '',
    effort: ally?.effort || s?.wkspEffort || ''
  }
}

// ------------------------------------------------------------------ queued messages

/** A queued message taken back out of a chat: what goes back into the composer. */
export interface UnqueuedChat {
  text: string
  images?: ChatImageInput[]
  context?: InventoryContext
}

/**
 * What Send now did with a queued message. `ok`: it steers (or goes first when nothing can be steered);
 * `note` says what it waits for when the turn cannot stop right away. Otherwise `reason` says why not.
 */
export type SendNowResult = { ok: true; note?: string } | { ok: false; reason: string }

/**
 * A chat log as written on disk (one line per write): the last write of an id
 * wins and sets its place, and cancelled messages drop out.
 */
export function compactChat(lines: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of lines) {
    byId.delete(m.id)
    byId.set(m.id, m)
  }
  return [...byId.values()].filter((m) => m.queue !== 'cancelled')
}

/** After a restart nothing is waiting in any session: messages still queued are shown as not sent. */
export function strandQueued(list: readonly ChatMessage[]): { list: ChatMessage[]; stranded: ChatMessage[] } {
  const stranded: ChatMessage[] = []
  const next = list.map((m) => {
    if (m.queue !== 'queued') return m
    const { steering: _was, ...rest } = m
    const u: ChatMessage = { ...rest, queue: 'unsent' }
    stranded.push(u)
    return u
  })
  return { list: next, stranded }
}

/**
 * A Genio-side message as the chat shows it: UTF-8 that something upstream
 * read as Windows-1252 decoded back, and stray zero-width characters at its
 * ends dropped (a finished message only: a stream may still be mid-sequence).
 * Tool results get the same repair; the player's own words are never touched.
 */
export function cleanChatMessage(m: ChatMessage): ChatMessage {
  if (m.role === 'player') return m
  const repaired = repairMojibake(m.text)
  const text = m.partial ? repaired : trimZeroWidth(repaired)
  let tools = m.tools
  if (tools?.some((t) => t.result && hasMojibake(t.result))) tools = tools.map((t) => (t.result ? { ...t, result: repairMojibake(t.result) } : t))
  return text === m.text && tools === m.tools ? m : { ...m, text, tools }
}

/**
 * One chat event applied to a chat's messages. A cancelled message is removed;
 * a queued message the session picked up moves to the end, which is where the
 * log already showed it (queued bubbles sit under everything else).
 */
export function applyChatEvent(list: readonly ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (m.queue === 'cancelled') return i < 0 ? [...list] : list.filter((x) => x.id !== m.id)
  if (i < 0) return [...list, m]
  // A rejected turn goes back to the front of the waiting queue.
  if (m.queue === 'queued' && list[i].queue !== 'queued') {
    const copy = list.filter(x => x.id !== m.id)
    const first = copy.findIndex(x => x.queue === 'queued')
    copy.splice(first < 0 ? copy.length : first, 0, m)
    return copy
  }
  if (list[i].queue === 'queued' && !m.queue) return [...list.slice(0, i), ...list.slice(i + 1), m]
  const copy = list.slice()
  copy[i] = m
  return copy
}

/** Split a chat for the log: what was said, then what is still waiting for the session (in send order). */
export function splitQueued(list: readonly ChatMessage[]): { log: ChatMessage[]; queued: ChatMessage[] } {
  const queued = list.filter((m) => m.queue === 'queued')
  return { log: queued.length ? list.filter((m) => m.queue !== 'queued') : [...list], queued }
}

/** Apply an overrides patch to an ally record (pure: returns a new record). */
export function patchAllyControls<A extends Pick<Ally, 'model' | 'effort' | 'shellMode'>>(ally: A, patch: AllyControlsPatch): A {
  const next = { ...ally }
  for (const k of ['model', 'effort', 'shellMode'] as const) {
    if (!(k in patch)) continue
    const v = patch[k]?.trim()
    if (k === 'shellMode' && v && !SHELL_MODES.includes(v)) continue
    if (v) (next as Record<string, unknown>)[k] = v
    else delete next[k]
  }
  return next
}
