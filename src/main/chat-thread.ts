/**
 * One visible chat's transcript and send queue, shared by the project chat (wksp.ts) and design chats
 * (design-chats.ts): the log on disk, messages shown queued before their turn is ready, steering, and the
 * images a queued message carries. The owner keeps its own session and what a turn means.
 */
import type { ChatMessage } from '@shared/types'
import type { ChatImageInput } from '@shared/chat-images'
import type { InventoryContext } from '@shared/inventory-context'
import { applyChatEvent, compactChat, strandQueued, type SendNowResult, type UnqueuedChat } from '@shared/chat'
import type { ProviderChatSession } from './provider-chat-session'
import type { ChatProvider, ChatTurn } from './chat-driver'
import { inboundMessage } from './claude-chat-driver'
import { loadChatImages, saveChatImages } from './chat-images'
import { bus } from './bus'
import { appendJsonl, nowIso, readJsonl, readJsonlAsync, rid } from './util'

export interface ChatThreadOptions {
  /** the base name every message carries */
  wksp: string
  file: string
  imageDir: string
  readOnly?: boolean
  /** who reads the messages, for the player ("Genio picked that message up already.") */
  reader: string
  session(): ProviderChatSession
  publish(m: ChatMessage): void
  /** the queue or its state changed (the owner republishes its info) */
  changed(): void
  /** the visible turn in progress can be steered now */
  canSteer(): boolean
  /** why a steering message just queued is not read at once */
  steerNote(): string | undefined
  /** the provider and model a new message goes to */
  route(): { provider: ChatProvider; model?: string }
  /** a waiting message became a sent one */
  sent?(m: ChatMessage): void
  /** why queue changes are refused (an archived chat) */
  refused?(): string | undefined
}

/** A player's message, on screen as queued the moment it is submitted: before slow thumbnails or earlier sends. */
export interface ShownMessage { m: ChatMessage; send: ChatImageInput[] }

export type ChatThread = ReturnType<typeof createChatThread>

export function createChatThread(o: ChatThreadOptions) {
  let history: ChatMessage[] | undefined
  /** Player messages already shown as queued whose turn is still being prepared (images, project opening). */
  const preparing = new Set<string>()
  /** Player messages that steer once their turn is ready: the visible turn in progress ends and they are read first. */
  const steerIds = new Set<string>()
  /**
   * Set while the visible turn in progress is being ended for the player's steering message (cleared when
   * that turn ends). Meanwhile the chat's tool policy starts no new tool call.
   */
  let steering: object | undefined
  let pendingSend: Promise<void> = Promise.resolve()

  /** First read in this run: anything still queued was lost with the previous session. */
  const adopt = (log: ChatMessage[]): ChatMessage[] => {
    const { list, stranded } = strandQueued(compactChat(log).slice(-1000))
    if (!o.readOnly) for (const m of stranded) appendJsonl(o.file, m)
    return (history = list)
  }
  const load = (): ChatMessage[] => history ?? adopt(readJsonl<ChatMessage>(o.file))
  /** The same first read without blocking the main process (a long log takes a few hundred ms to open and read). */
  let preloading: Promise<void> | undefined
  const preload = (): Promise<void> =>
    preloading ??= history ? Promise.resolve() : readJsonlAsync<ChatMessage>(o.file).then(log => { if (!history) adopt(log) })
  const record = (m: ChatMessage, persist: boolean): void => {
    if (o.readOnly) return
    const h = load()
    const i = h.findIndex((x) => x.id === m.id)
    if (i >= 0) h[i] = m
    else h.push(m)
    if (h.length > 1200) h.splice(0, h.length - 1000)
    if (persist) appendJsonl(o.file, m)
    o.publish(m)
  }
  const say = (text: string, role: ChatMessage['role'] = 'genio'): ChatMessage => {
    const m: ChatMessage = { id: `s-${rid(6)}`, wksp: o.wksp, role, text, ts: nowIso() }
    record(m, true)
    return m
  }
  const waiting = (id: string): boolean => load().find((x) => x.id === id)?.queue === 'queued'

  /** A waiting message leaves the queue: it becomes a normal sent message at the end of the log. */
  const markSent = (id: string): void => {
    const h = load()
    const i = h.findIndex((x) => x.id === id)
    if (i < 0 || h[i].queue !== 'queued') return
    preparing.delete(id)
    const { queue: _was, steering: _steered, ...sent } = h[i]
    h.splice(i, 1)
    const m = { ...sent, ts: nowIso() }
    record(m, true)
    o.sent?.(m)
  }
  /** The session picked a queued message up. */
  const delivered = (item: ChatTurn): void => {
    if (item.msgId) markSent(item.msgId)
  }
  /** A waiting message taken out of the chat (cancelled, edited, or its send failed). */
  const withdraw = (m: ChatMessage): void => {
    preparing.delete(m.id)
    steerIds.delete(m.id)
    history = load().filter((x) => x.id !== m.id)
    const gone: ChatMessage = { ...m, queue: 'cancelled' }
    appendJsonl(o.file, gone)
    o.publish(gone)
  }
  /** The session queue was dropped: whatever still waited is shown as not sent, never left looking queued. */
  const strandWaiting = (): void => {
    preparing.clear()
    steerIds.clear()
    if (o.readOnly || !history) return
    const { list, stranded } = strandQueued(history)
    history = list
    for (const m of stranded) {
      appendJsonl(o.file, m)
      o.publish(m)
    }
  }
  /** A turn the driver gave back (a limit, a retry): its message shows queued again. */
  const requeued = (item: ChatTurn): void => {
    const m = load().find(m => m.id === item.msgId)
    if (m) {
      const queued: ChatMessage = { ...m, queue: 'queued' }
      history = applyChatEvent(load(), queued)
      record(queued, true)
    }
  }

  /** A waiting message the player steered with shows it ("Steering") until the session reads it. */
  const markSteering = (id: string): void => {
    const m = load().find((x) => x.id === id)
    if (m?.queue === 'queued' && !m.steering) record({ ...m, steering: true }, false)
  }
  /** A ready turn goes first; when it steers, the visible turn in progress ends at a safe point. */
  const enqueue = (item: ChatTurn): void => {
    const session = o.session()
    if (!item.msgId || !steerIds.delete(item.msgId)) { session.enqueue(item); return }
    // marked before it is queued: an idle session reads it at once, and reading it clears the mark
    markSteering(item.msgId)
    const yieldTurn = o.canSteer()
    const token = {}
    if (yieldTurn) steering = token
    void session.steer(item, yieldTurn).finally(() => {
      if (steering === token) steering = undefined
      o.changed()
    })
  }

  const showQueued = (text: string, images: ChatImageInput[], context?: InventoryContext): ShownMessage => {
    // stored first so a bad image fails the send before anything is shown (the composer keeps the draft)
    const stored = saveChatImages(o.imageDir, images)
    const m = inboundMessage(o.wksp, text, 'player')
    const route = o.route()
    m.queue = 'queued'
    m.provider = route.provider
    m.providerModel = route.model
    if (stored.refs.length) m.images = stored.refs
    if (context) m.context = context
    preparing.add(m.id)
    record(m, true)
    bus.publish({ type: 'sfx', sound: 'send' })
    o.changed()
    return { m, send: stored.send }
  }

  /**
   * Sends run one after another in click order. A shown message whose turn could not be prepared leaves the
   * chat and the composer gets the draft back; once its turn is queued (or it was taken back) the send succeeded.
   */
  const serial = (shown: ShownMessage | undefined, run: () => Promise<void>): Promise<void> => {
    const sending = pendingSend.then(run)
    const settled = shown ? sending.catch((e) => {
      if (!shown || !preparing.has(shown.m.id)) return
      const current = load().find((x) => x.id === shown.m.id)
      if (current) withdraw(current)
      else preparing.delete(shown.m.id)
      o.changed()
      throw e
    }) : sending
    pendingSend = settled.catch(() => undefined)
    return settled
  }

  const sendNow = (id: string): SendNowResult => {
    const refused = o.refused?.()
    if (refused) return { ok: false, reason: refused }
    const m = load().find((x) => x.id === id)
    if (!m || m.queue !== 'queued') {
      // the chat on screen is behind: show the message as it really is
      if (m) o.publish(m)
      return { ok: false, reason: !m ? 'That message is no longer in this chat.'
        : m.queue === 'unsent' ? 'The session stopped before reading that message. Edit it to send it again.'
        : `${o.reader} picked that message up already.` }
    }
    steerIds.add(id)
    // still being prepared: it steers as soon as its turn is ready
    if (preparing.has(id)) {
      markSteering(id)
      return { ok: true, note: 'It is still being prepared (images or the project opening) and steers as soon as it is ready.' }
    }
    const session = o.session()
    const item = session.cancel(id)
    if (!item) {
      steerIds.delete(id)
      // Its record says queued but no turn waits for it: never leave it looking queued.
      if (session.runningMsgId === id) {
        markSent(id)
        return { ok: false, reason: `${o.reader} is already reading that message.` }
      }
      record(strandQueued([m]).list[0], true)
      o.changed()
      return { ok: false, reason: 'That message was no longer waiting in the session, so it is marked Not sent. Edit it to send it again.' }
    }
    enqueue(item)
    o.changed()
    return { ok: true, note: o.steerNote() }
  }

  const unqueue = (id: string): UnqueuedChat | null => {
    if (o.refused?.()) return null
    const h = load()
    const m = h.find((x) => x.id === id)
    if (!m || (m.queue !== 'queued' && m.queue !== 'unsent')) return null
    const item = m.queue === 'queued' ? o.session().cancel(id) : undefined
    // Filter stored refs before reading: a missing thumbnail must not drop a pasted image.
    const automatic = m.context?.thumbnail?.status === 'attached'
    const refs = automatic ? m.images?.filter(i => i.file !== m.context?.thumbnail?.image?.file) : m.images
    const images = item ? (automatic ? item.images?.slice(0, -1) : item.images)
      : refs?.length ? loadChatImages(o.imageDir, refs) : undefined
    // a message still being prepared is never enqueued once withdrawn
    withdraw(m)
    o.changed()
    // The automatic preview belongs to its chip, not the pasted-image draft.
    return { text: m.text, ...(images?.length ? { images } : {}), ...(m.context ? { context: m.context } : {}) }
  }

  return {
    load, preload, record, say, waiting, markSent, delivered, withdraw, strandWaiting, requeued, markSteering, enqueue,
    showQueued, serial, sendNow, unqueue, preparing, steerIds,
    /** the steering token while a visible turn is being ended for the player's message */
    get steering(): object | undefined { return steering },
    set steering(v: object | undefined) { steering = v }
  }
}
