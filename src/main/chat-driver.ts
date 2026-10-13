import type { ChatImageInput } from '@shared/chat-images'
import type { ChatMessage, WkspActivity, WkspInfo } from '@shared/types'
import type { ChatDriverCapabilities } from '@shared/chat-driver-capabilities'

export type ChatProvider = 'claude' | 'codex'
export interface ChatTurn {
  kind: 'player' | 'events' | 'system'
  prompt: string
  images?: ChatImageInput[]
  ackThrough?: number
  msgId?: string
  limitRetried?: boolean
}
export interface ChatDriverEvents {
  onStart?(item: ChatTurn): void
  onMessage(message: ChatMessage, final: boolean): void
  onDelta(id: string, text: string): void
  onActivity(activity: WkspActivity, detail?: string): void
  onTurnEnd(item: ChatTurn | undefined, ok: boolean, text: string, cashCost: number): void
  onSessionId(id: string): void
  onError(message: string): void
  onLimit?(limit: WkspInfo['limit']): void
  onRequeue?(item: ChatTurn): void
  onUsage?(usage: { provider: ChatProvider; input: number; cached: number; output: number; cashCost: number }): void
}

/** The service owns transcript, wake acknowledgement and permissions. Drivers
 * own provider sessions and never choose an alternate provider or billing route. */
export interface ChatDriver {
  readonly capabilities: ChatDriverCapabilities
  sessionId?: string
  readonly busy: boolean
  readonly idle: boolean
  readonly queued: number
  start(): Promise<void>
  send(turn: ChatTurn): void
  interrupt(): Promise<void>
  resume(fresh?: boolean): void
  stop(): void
  cancel(id: string): ChatTurn | undefined
  hasEventsQueued(): boolean
}

export function chatRoute(value?: string): { provider: ChatProvider; model?: string } {
  if (value?.startsWith('codex:OpenAI:')) return { provider: 'codex', model: value.slice('codex:OpenAI:'.length) }
  return { provider: 'claude', model: value?.replace(/^claude:Anthropic:/, '').trim() || undefined }
}
