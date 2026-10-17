import type { ChatMessage } from '@shared/types'
import { couldBecomeQuietReply, isQuietReply } from '@shared/quiet-reply'
import type { ChatTurn } from './chat-driver'

/** A turn Genio starts itself (an events batch or the session start), not one the player asked for. */
export function isEventTurn(item: Pick<ChatTurn, 'kind' | 'prompt'> | undefined): boolean {
  return !!item && (item.kind === 'events' || item.prompt.includes('[GENIO SESSION START]'))
}

/**
 * What an event turn may show. Nothing needing the player means no text at all, but a model can still end
 * with the no-op sentence or an empty message; those never reach the chat, its log, the voice or the sounds.
 * Only event turns are checked: a reply to the player is always shown, and so is any real message.
 */
export class QuietTurn {
  private active = false
  /** a streamed message's text so far, withheld while it could still turn out to be the no-op sentence */
  private held = new Map<string, string>()
  private released = new Set<string>()

  constructor(private readonly names: () => string[]) {}

  begin(item: Pick<ChatTurn, 'kind' | 'prompt'> | undefined): void {
    this.active = isEventTurn(item)
    this.held.clear()
    this.released.clear()
  }

  end(): void {
    this.active = false
    this.held.clear()
    this.released.clear()
  }

  /** The stream piece to show now ('' while it is held back); a released message sends what was held in one piece. */
  delta(id: string, text: string): string {
    if (!this.active || this.released.has(id)) return text
    const soFar = (this.held.get(id) ?? '') + text
    if (couldBecomeQuietReply(soFar, this.names())) {
      this.held.set(id, soFar)
      return ''
    }
    this.held.delete(id)
    this.released.add(id)
    return soFar
  }

  /** The message to record and show, or undefined when it is an event turn's empty or no-op reply (or still could be). */
  message(m: ChatMessage, final: boolean): ChatMessage | undefined {
    if (!this.active || m.role !== 'genio') return m
    const names = this.names()
    if ((m.tools ?? []).length || m.generation || m.generating || m.images?.length) {
      // a tool trace stays; the sentence beside it does not
      return isQuietReply(m.text, names) && m.text ? { ...m, text: '' } : m
    }
    if (isQuietReply(m.text, names)) {
      this.held.delete(m.id)
      return undefined
    }
    if (!final && couldBecomeQuietReply(m.text, names)) return undefined
    this.held.delete(m.id)
    return m
  }

  /** True when the turn's last words are not for the player (no sound, no voice, no welcome unlocked). */
  silent(lastText: string): boolean {
    return this.active && isQuietReply(lastText, this.names())
  }
}

