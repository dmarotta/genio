import type { ChatDriver, ChatDriverEvents, ChatProvider, ChatTurn } from './chat-driver'
import type { WkspInfo } from '@shared/types'

export interface ProviderSessions {
  active?: ChatProvider
  ids?: Partial<Record<ChatProvider, string>>
}

/** Queue above the runtimes: a provider change waits for turn completion. Old
 * sessions retain their IDs; every cross-provider transition adds fresh context. */
export class ProviderChatSession {
  private driver?: ChatDriver
  private provider: ChatProvider
  private ids: Partial<Record<ChatProvider, string>>
  private pending: ChatTurn[] = []
  private paused = false
  private dispatching = false
  private handoff = ''
  private retryTimer?: ReturnType<typeof setTimeout>
  private configuration: { model?: string; effort?: string } = {}
  constructor(private readonly options: {
    selection(): ChatProvider
    config?(): { model?: string; effort?: string }
    hold?(provider: ChatProvider, item: ChatTurn): WkspInfo['limit']
    create(provider: ChatProvider, events: ChatDriverEvents, config: () => { model?: string; effort?: string }): ChatDriver
    events: ChatDriverEvents
    persisted?: ProviderSessions
    handoff(excludeMessageId?: string): string
    switched(from: ChatProvider, to: ChatProvider): void
  }) {
    this.provider = options.persisted?.active ?? 'claude'
    this.ids = { ...options.persisted?.ids }
  }
  get sessionId(): string | undefined { return this.driver?.sessionId ?? this.ids[this.provider] }
  set sessionId(id: string | undefined) { if (id) this.ids[this.provider] = id }
  get currentProvider(): ChatProvider { return this.provider }
  get busy(): boolean { return this.dispatching || !!this.driver?.busy }
  get queued(): number { return this.pending.length + (this.driver?.queued ?? 0) }
  get idle(): boolean { return !this.busy && !this.queued && !this.paused }
  state(): ProviderSessions {
    if (this.sessionId) this.ids[this.provider] = this.sessionId
    return { active: this.provider, ids: { ...this.ids } }
  }
  hasEventsQueued(): boolean { return this.pending.some(t => t.kind === 'events') || !!this.driver?.hasEventsQueued() }
  enqueue(item: ChatTurn): void {
    // Status delivery must also pass optional system work held by plan protection.
    const i = item.kind === 'player' ? this.pending.findIndex(t => t.kind !== 'player')
      : item.kind === 'events' ? this.pending.findIndex(t => t.kind === 'system') : -1
    if (i < 0) this.pending.push(item); else this.pending.splice(i, 0, item)
    this.pump()
  }
  cancel(id: string): ChatTurn | undefined {
    const i = this.pending.findIndex(t => t.msgId === id)
    return i < 0 ? this.driver?.cancel(id) : this.pending.splice(i, 1)[0]
  }
  private pump(): void {
    if (this.busy || this.paused || !this.pending.length) return
    const want = this.options.selection()
    const hold = this.options.hold?.(want, this.pending[0])
    if (hold) { this.defer(hold); return }
    this.options.events.onLimit?.(undefined)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.configuration = this.options.config?.() ?? {}
    if (want !== this.provider) {
      if (this.driver?.queued) return // a rejected/paused turn still belongs to its route
      this.state(); this.driver?.stop(); this.driver = undefined
      const from = this.provider; this.provider = want
      this.handoff = this.options.handoff(this.pending[0]?.msgId)
      this.options.switched(from, want)
    }
    if (!this.driver) {
      const provider = this.provider
      this.driver = this.options.create(provider, {
        ...this.options.events,
        onDeferred: (item, limit) => {
          this.dispatching = false
          this.pending.unshift(item)
          this.defer(limit)
        },
        onMessage: (message, final) => this.options.events.onMessage({ ...message, provider, providerModel: this.configuration.model, providerSession: this.sessionId }, final),
        onTurnEnd: (...args) => {
          this.dispatching = false
          this.options.events.onTurnEnd(...args)
          queueMicrotask(() => this.pump())
        },
        onLimit: limit => { this.paused = !!limit; this.options.events.onLimit?.(limit); if (!limit) queueMicrotask(() => this.pump()) },
        onSessionId: id => { this.ids[provider] = id; this.options.events.onSessionId(id) }
      }, () => this.configuration)
      this.driver.sessionId = this.ids[provider]
    }
    const next = this.pending.shift()!
    if (this.handoff) { next.prompt = `${this.handoff}\n\nCurrent request:\n${next.prompt}`; this.handoff = '' }
    this.dispatching = true
    this.driver.send(next)
  }
  private defer(limit: WkspInfo['limit']): void {
    this.options.events.onLimit?.(limit)
    if (!this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.pump() }, 30_000)
      this.retryTimer.unref?.()
    }
  }
  /**
   * The player's steering turn goes first (after earlier steering, ahead of every other waiting turn,
   * whose order is kept) and, when `yieldTurn`, the turn in progress ends at a safe point so it is read next.
   */
  async steer(item: ChatTurn, yieldTurn = true): Promise<void> {
    item.steer = true
    const i = this.pending.findIndex(t => !t.steer)
    if (i < 0) this.pending.push(item); else this.pending.splice(i, 0, item)
    if (yieldTurn && this.driver?.busy) await this.driver.yieldTurn()
    this.pump()
  }
  async interrupt(): Promise<void> {
    await this.driver?.interrupt()
    // Explicit cancellation authorizes a queued provider change, but does not replay the active turn.
    this.dispatching = false
    if (this.options.selection() !== this.provider) { this.paused = false; this.pump() }
  }
  restart(fresh = false): void {
    this.paused = false; this.dispatching = false
    this.driver?.resume(fresh)
    if (fresh) delete this.ids[this.provider]
    this.pump()
  }
  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.state(); this.driver?.stop(); this.dispatching = false; this.pending = []
  }
}
