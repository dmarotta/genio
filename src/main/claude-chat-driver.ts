import { SessionCostLedger, SessionQuotaPolicy, isQuotaError } from './session-usage'
import type { ChatDriver, ChatTurn, ChatDriverEvents } from './chat-driver'
import type { Query, SDKMessage, SDKUserMessage, Options, EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, WkspInfo, Settings, ToolTrace } from '@shared/types'
import { userContent, type ChatImageInput } from '@shared/chat-images'
import type { InventoryContext } from '@shared/inventory-context'
import type { AppCtx } from './services'
import type { ToolRole } from './wksp-tools'
import type { ClaudeRateLimitInfo } from './usage'
import { claudeLimitState } from './claude-limit'
import { registerModelQuery, supportedClaudeEfforts } from './model-discovery'
import { nowIso, rid, truncate } from './util'
type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<Sdk> | undefined
export const loadSdk = (): Promise<Sdk> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

export { decideTool, isReadOnlyCommand } from './chat-tool-policy'
export type { ToolDecision } from './chat-tool-policy'

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface SessionConfig {
  model?: string
  effort?: EffortLevel
}

/** Model/effort for a session: allies keep their own overrides, the Bot keeps botModel at low effort. */
export function sessionConfig(role: ToolRole, s: Pick<Settings, 'botModel' | 'wkspModel' | 'wkspEffort'>, ally?: Pick<Ally, 'model' | 'effort'>): SessionConfig {
  const model = (role === 'bot' ? s.botModel : ally?.model || s.wkspModel)?.trim() || undefined
  const effort = (role === 'bot' ? 'low' : ally?.effort || s.wkspEffort) || undefined
  const allowed = role === 'bot' ? EFFORT_LEVELS : supportedClaudeEfforts(model) ?? EFFORT_LEVELS
  return { model, effort: effort && allowed.includes(effort) ? (effort as EffortLevel) : undefined }
}

const sameConfig = (a: SessionConfig, b: SessionConfig): boolean => a.model === b.model && a.effort === b.effort

/** The live controls a running query exposes for model/effort changes. */
export type LiveControls = Pick<Query, 'setModel' | 'applyFlagSettings'>

/** Apply model/effort to a running session; false means the caller should restart it with resume. */
export async function applyLiveConfig(q: LiveControls, from: SessionConfig, to: SessionConfig): Promise<boolean> {
  try {
    if (from.model !== to.model) await q.setModel(to.model)
    // null clears the override back to the model's default effort
    if (from.effort !== to.effort) await q.applyFlagSettings({ effortLevel: to.effort ?? null })
    return true
  } catch {
    return false
  }
}

/** The chat record of an incoming message: the player's own, a synthesized prompt, or a request routed from main Genio. */
export function inboundMessage(wksp: string, text: string, origin: 'player' | 'system' | 'genio'): ChatMessage {
  const m: ChatMessage = { id: `p-${rid(6)}`, wksp, role: origin === 'player' ? 'player' : 'system', text, ts: nowIso() }
  if (origin === 'genio') m.from = 'genio'
  return m
}

/** A message the player typed in a chat tab: it goes to that chat's base only (main or one ally). */
export function sendPlayerChat(ctx: Pick<AppCtx, 'home'>, wksp: string, text: string, images?: ChatImageInput[], context?: InventoryContext): Promise<void> {
  return ctx.home(wksp).wksp.send(text, 'player', images, context)
}


// ------------------------------------------------------------------ input queue

/** The SDK user message for a turn: plain text, or image blocks plus text when images are attached. */
export function userMessage(text: string, images?: readonly ChatImageInput[]): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: userContent(text, images) }, parent_tool_use_id: null, session_id: '' } as unknown as SDKUserMessage
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter?: (v: IteratorResult<SDKUserMessage>) => void
  private closed = false
  push(text: string, images?: readonly ChatImageInput[]): void {
    const msg = userMessage(text, images)
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: msg, done: false })
    } else this.items.push(msg)
  }
  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = undefined
      w({ value: undefined as unknown as SDKUserMessage, done: true })
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const it = this.items.shift()
        if (it) return Promise.resolve({ value: it, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true })
        return new Promise((resolve) => (this.waiter = resolve))
      }
    }
  }
}

export type TurnItem = ChatTurn
export interface SessionHooks extends ChatDriverEvents {
  onRateLimit(info: ClaudeRateLimitInfo): void
}

/** One SDK conversation (Genio or the Bot). */
export class AgentSession implements ChatDriver {
  readonly capabilities = { mode: 'driver' as const, guardedTools: true }
  start(): Promise<void> { return this.ensureStarted() }
  send(item: TurnItem): void { this.enqueue(item) }
  resume(fresh = false): void { this.restart(fresh) }
  q?: Query
  input?: InputQueue
  busy = false
  current?: TurnItem
  pending: TurnItem[] = []
  sessionId?: string
  private limit?: WkspInfo['limit']
  private limitPaused = false
  private latestLimit?: ClaudeRateLimitInfo
  private limitTimer?: ReturnType<typeof setTimeout>
  private assistantLimit = ''
  private gotInit = false
  private resumedFrom?: string
  private retryTimer?: ReturnType<typeof setTimeout>
  private msgs = new Map<string, ChatMessage>()
  private blockText = new Map<string, string[]>()
  private toolOwner = new Map<string, string>()
  private turnMsgIds: string[] = []
  private streamMsgId?: string
  private lastText = ''
  private stderrTail = ''
  private generation = 0
  private initTimer?: ReturnType<typeof setTimeout>
  private starting?: Promise<void>
  /** model/effort the running query was started with or last switched to */
  private applied?: SessionConfig

  constructor(
    readonly label: string,
    private readonly build: (resume?: string) => Promise<Options>,
    private readonly hooks: SessionHooks,
    private readonly wkspName: string,
    private readonly config: () => SessionConfig,
    private readonly quotaPolicy: () => SessionQuotaPolicy,
    private readonly costs: SessionCostLedger
  ) {}

  get queued(): number {
    return this.pending.length
  }

  enqueue(item: TurnItem): void {
    if (item.kind === 'player') {
      // player turns jump ahead of queued event turns
      const idx = this.pending.findIndex((p) => p.kind !== 'player')
      if (idx === -1) this.pending.push(item)
      else this.pending.splice(idx, 0, item)
    } else this.pending.push(item)
    void this.pump()
  }

  hasEventsQueued(): boolean {
    return this.current?.kind === 'events' || this.pending.some((p) => p.kind === 'events')
  }

  /** nothing running and nothing waiting: a new item starts right away */
  get idle(): boolean {
    return !this.busy && !this.pending.length && !this.limitPaused
  }

  /** Take a waiting chat message's turn back out of the queue; undefined once the session picked it up. */
  cancel(msgId: string): TurnItem | undefined {
    const i = this.pending.findIndex((p) => p.msgId === msgId)
    return i < 0 ? undefined : this.pending.splice(i, 1)[0]
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    const waiting = this.pending[0]
    if (waiting && !this.quotaPolicy().canStartTurn(waiting.kind, Date.now(), true, `${this.wkspName}:${this.label}`)) {
      if (this.hooks.onDeferred) {
        this.pending.shift()
        this.hooks.onDeferred(waiting, this.quotaPolicy().limitState())
        return
      }
      this.setLimit(this.quotaPolicy().limitState())
      // Local polling can detect new on-disk evidence without spending provider quota.
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.pump() }, 30_000)
        this.retryTimer.unref?.()
      }
      return
    }
    if (waiting && this.limitPaused) this.reset()
    if (waiting) this.setLimit()
    const next = this.pending.shift()
    if (!next) return
    this.busy = true
    this.current = next
    this.hooks.onStart?.(next)
    this.turnMsgIds = []
    this.lastText = ''
    this.assistantLimit = ''
    this.hooks.onActivity('thinking')
    try {
      await this.syncConfig()
      if (this.current !== next) return
      await this.ensureStarted()
      if (this.current !== next) return // stopped or timed out during setup
      this.input!.push(next.prompt, next.images)
    } catch (e) {
      if (this.current !== next) return
      this.reset()
      this.busy = false
      this.current = undefined
      this.hooks.onError(`Genio could not start: ${(e as Error).message}`)
      this.hooks.onTurnEnd(next, false, '', 0)
      this.hooks.onActivity('error', (e as Error).message)
    }
  }

  private setLimit(limit?: WkspInfo['limit']): void {
    if (limit) limit = { ...limit, restartRequired: !!limit.restartRequired }
    if (this.limitTimer) clearTimeout(this.limitTimer)
    this.limitTimer = undefined
    const changed = JSON.stringify(this.limit) !== JSON.stringify(limit)
    this.limit = limit
    this.limitPaused = !!limit
    if (changed) this.hooks.onLimit?.(limit)
    if (limit?.resetsAt && !limit.restartRequired) {
      const delay = limit.resetsAt - Date.now()
      if (delay > 0) this.limitTimer = setTimeout(() => {
        // A rate event can precede the result. Never interrupt a still-running turn.
        if (this.limit?.resetsAt && this.limit.resetsAt > Date.now()) this.setLimit(this.limit)
        else if (!this.busy) this.retryLimit()
      }, Math.min(delay + 100, 2_147_483_647))
    }
  }

  /** Recycle only this query, retaining its conversation and every queued turn. */
  retryLimit(): void {
    if (this.busy) return
    this.reset()
    if (this.limitTimer) clearTimeout(this.limitTimer)
    this.limitTimer = undefined
    this.limitPaused = false
    void this.pump()
  }

  restart(fresh = false): void {
    if (this.current && this.limit) {
      this.pending.unshift(this.current)
      this.hooks.onRequeue?.(this.current)
    }
    this.reset()
    this.busy = false
    this.current = undefined
    for (const waiting of this.pending) waiting.limitRetried = false
    this.latestLimit = undefined
    this.setLimit()
    if (fresh) this.sessionId = undefined
    this.hooks.onActivity('offline')
    void this.pump()
  }

  private limited(text: string): void {
    const state = claudeLimitState(text, this.latestLimit)
    this.quotaPolicy().rejectError(text)
    this.quotaPolicy().observe({ status: 'rejected', rateLimitType: this.latestLimit?.rateLimitType ?? 'error', resetsAt: state.resetsAt === undefined ? undefined : state.resetsAt / 1000 })
    if (state.resetsAt !== undefined && this.latestLimit?.status === 'rejected') {
      this.hooks.onRateLimit({ ...this.latestLimit, resetsAt: state.resetsAt / 1000 })
    }
    const item = this.current
    this.busy = false
    this.current = undefined
    if (item) {
      this.pending.unshift(item)
      this.hooks.onRequeue?.(item)
    }
    this.hooks.onActivity('idle')
    if (state.stale && item && !item.limitRetried && this.quotaPolicy().canStartTurn(item.kind, Date.now(), false)) {
      this.setLimit()
      item.limitRetried = true
      this.retryLimit()
      return
    }
    this.setLimit({ resetsAt: state.resetsAt, restartRequired: state.stale })
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting
    if (this.q) return Promise.resolve()
    const starting = this.initialize().finally(() => { if (this.starting === starting) this.starting = undefined })
    this.starting = starting
    return starting
  }

  private async initialize(): Promise<void> {
    const gen = ++this.generation
    this.stderrTail = ''
    this.initTimer = setTimeout(() => {
      if (gen !== this.generation) return
      this.ended(`Claude initialization timed out after 30 seconds; the request was not replayed.${this.stderrTail ? `\n${truncate(this.stderrTail.trim(), 600)}` : ''}`)
      // Failed wake acknowledgements remain pending. Require deliberate recovery
      // so the wake scheduler cannot replay an attempt with an unknown outcome.
      this.setLimit({ provider: 'claude', restartRequired: true,
        reason: 'Claude initialization timed out. The request outcome is unknown; restart the session to continue.' })
    }, 30_000)
    this.initTimer.unref?.()
    const sdk = await loadSdk()
    if (gen !== this.generation) return
    this.input = new InputQueue()
    this.gotInit = false
    this.resumedFrom = this.sessionId
    const options = await this.build(this.sessionId)
    if (gen !== this.generation) return
    this.applied = { model: options.model, effort: options.effort as EffortLevel | undefined }
    options.stderr = (d: string): void => {
      if (gen !== this.generation) return
      this.stderrTail = (this.stderrTail + d).slice(-2000)
    }
    this.q = sdk.query({ prompt: this.input, options })
    const unregister = registerModelQuery(this.q)
    void this.consume(this.q, gen).finally(unregister)
  }

  /**
   * Bring a running session up to the current model/effort settings. Runs only between turns
   * (from pump), so a turn in progress is never interrupted; if the live controls fail, the
   * session is closed and the next start resumes the same conversation with the new options.
   */
  private async syncConfig(): Promise<void> {
    if (!this.q || !this.applied) return
    const want = this.config()
    if (sameConfig(this.applied, want)) return
    if (await applyLiveConfig(this.q, this.applied, want)) this.applied = want
    else this.reset()
  }

  private async consume(q: Query, gen: number): Promise<void> {
    try {
      for await (const msg of q) {
        if (gen !== this.generation) return
        this.handle(msg)
      }
      if (gen === this.generation) this.ended('session ended')
    } catch (e) {
      if (gen !== this.generation) return
      const msg = (e as Error)?.message ?? String(e)
      if (this.resumedFrom && !this.gotInit && !isQuotaError(msg)) {
        // resume failed: start a fresh conversation and retry the turn
        this.hooks.onError('Could not resume the previous Genio conversation; starting a fresh one (records on disk are intact).')
        this.sessionId = undefined
        this.resumedFrom = undefined
        this.reset()
        if (this.current) this.pending.unshift(this.current)
        this.busy = false
        this.current = undefined
        void this.pump()
        return
      }
      this.ended(`${msg}${this.stderrTail ? `\n${truncate(this.stderrTail.trim(), 600)}` : ''}`)
    }
  }

  private ended(reason: string): void {
    const item = this.current
    const wasBusy = this.busy
    this.reset()
    this.busy = false
    this.current = undefined
    if (wasBusy) {
      this.hooks.onError(`Genio session stopped: ${reason}`)
      this.hooks.onTurnEnd(item, false, '', 0)
      this.hooks.onActivity('error', truncate(reason, 160))
    } else this.hooks.onActivity('offline')
    if (this.pending.length) setTimeout(() => void this.pump(), 2000)
  }

  private reset(): void {
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = undefined
    this.starting = undefined
    this.generation++
    try {
      this.input?.close()
    } catch {
      /* ignore */
    }
    try {
      ;(this.q as unknown as { close?: () => void })?.close?.()
    } catch {
      /* ignore */
    }
    this.q = undefined
    this.input = undefined
  }

  private chatFor(apiId: string): ChatMessage {
    const id = `m-${apiId}`
    let m = this.msgs.get(id)
    if (!m) {
      m = { id, wksp: this.wkspName, role: 'genio', text: '', ts: nowIso(), tools: [], partial: true }
      this.msgs.set(id, m)
      this.turnMsgIds.push(id)
    }
    return m
  }

  private handle(msg: SDKMessage): void {
    const m = msg as { type: string; subtype?: string } & Record<string, unknown>
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          if (this.initTimer) clearTimeout(this.initTimer)
          this.initTimer = undefined
          this.gotInit = true
          const sid = (m as { session_id?: string }).session_id
          if (sid && sid !== this.sessionId) {
            this.sessionId = sid
            this.hooks.onSessionId(sid)
          }
        }
        return
      }
      case 'stream_event': {
        const ev = (m as { event?: { type: string; message?: { id: string }; delta?: { type: string; text?: string } } }).event
        if (!ev || (m as { parent_tool_use_id?: string | null }).parent_tool_use_id) return
        if (ev.type === 'message_start' && ev.message?.id) {
          this.streamMsgId = ev.message.id
          this.hooks.onActivity('thinking')
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text && this.streamMsgId) {
          const cm = this.chatFor(this.streamMsgId)
          this.hooks.onDelta(cm.id, ev.delta.text)
        }
        return
      }
      case 'assistant': {
        if ((m as { parent_tool_use_id?: string | null }).parent_tool_use_id) return
        const am = m as { message?: { id?: string; content?: unknown[] }; error?: unknown }
        const errorText = (am.message?.content ?? []).map(b => (b as { text?: string }).text ?? '').join(' ')
        if (am.error && (isQuotaError(errorText) || isQuotaError(String(am.error)))) {
          this.assistantLimit = errorText || String(am.error)
          return
        }
        const apiId = am.message?.id ?? rid(6)
        const cm = this.chatFor(apiId)
        const texts = this.blockText.get(cm.id) ?? []
        for (const block of (am.message?.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text)
          } else if (block.type === 'tool_use' && block.id) {
            const trace: ToolTrace = { id: block.id, name: block.name ?? 'tool', input: truncate(JSON.stringify(block.input ?? {}), 2000) }
            cm.tools = [...(cm.tools ?? []).filter((t) => t.id !== block.id), trace]
            this.toolOwner.set(block.id, cm.id)
            this.hooks.onActivity('tool', prettyTool(block.name ?? ''))
          }
        }
        this.blockText.set(cm.id, texts)
        cm.text = texts.join('\n\n')
        if (cm.text) this.lastText = cm.text
        if (am.error) this.hooks.onError(`Model error: ${typeof am.error === 'string' ? am.error : JSON.stringify(am.error)}`)
        this.hooks.onMessage({ ...cm }, false)
        return
      }
      case 'user': {
        const content = (m as { message?: { content?: unknown } }).message?.content
        if (!Array.isArray(content)) return
        for (const block of content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          const owner = this.toolOwner.get(block.tool_use_id)
          const cm = owner ? this.msgs.get(owner) : undefined
          if (!cm) continue
          const text = Array.isArray(block.content)
            ? (block.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
            : String(block.content ?? '')
          cm.tools = (cm.tools ?? []).map((t) => (t.id === block.tool_use_id ? { ...t, result: truncate(text, 4000), isError: !!block.is_error } : t))
          this.hooks.onMessage({ ...cm }, false)
        }
        this.hooks.onActivity('thinking')
        return
      }
      case 'result': {
        const r = m as { is_error?: boolean; total_cost_usd?: number; result?: string; errors?: string[]; subtype?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } }
        const errorText = (r.errors ?? []).join('; ') || r.result || this.assistantLimit
        const limitError = (r.is_error && isQuotaError(errorText)) || !!this.assistantLimit
        const resultId = typeof m.uuid === 'string' ? m.uuid : ''
        const cost = this.costs.record(this.sessionId ?? this.label, resultId, r.total_cost_usd, Boolean(this.resumedFrom))
        if (cost.duplicate) return
        const delta = cost.delta
        if (r.usage) this.hooks.onUsage?.({ provider: 'claude', input: r.usage.input_tokens ?? 0,
          cached: r.usage.cache_read_input_tokens ?? 0, output: r.usage.output_tokens ?? 0, cashCost: delta })
        for (const id of this.turnMsgIds) {
          const cm = this.msgs.get(id)
          if (!cm) continue
          cm.partial = false
          if (id === this.turnMsgIds[this.turnMsgIds.length - 1]) cm.costUsd = delta
          if (!cm.text && !(cm.tools ?? []).length) continue
          this.hooks.onMessage({ ...cm }, true)
          this.msgs.delete(id)
          this.blockText.delete(id)
        }
        if (limitError) {
          // Cost still belongs to this attempt, but failed wake events must not be acknowledged.
          this.hooks.onTurnEnd(undefined, false, '', delta)
          this.limited(errorText)
          return
        }
        const okTurn = !r.is_error
        if (okTurn) this.setLimit()
        if (!okTurn) this.hooks.onError(`Turn ended with an error (${r.subtype ?? 'error'}): ${(r.errors ?? []).join('; ') || r.result || 'unknown'}`)
        const item = this.current
        this.busy = false
        this.current = undefined
        this.turnMsgIds = []
        this.hooks.onTurnEnd(item, okTurn, this.lastText, delta)
        this.hooks.onActivity('idle')
        void this.pump()
        return
      }
      case 'rate_limit_event': {
        const info = (m as { rate_limit_info?: ClaudeRateLimitInfo }).rate_limit_info
        if (info) {
          this.latestLimit = info
          this.hooks.onRateLimit(info)
          if (info.status === 'allowed') {
            const waiting = !!this.limit
            this.setLimit()
            if (waiting && !this.busy) this.retryLimit()
          } else if (info.status === 'rejected') {
            const state = claudeLimitState('', info)
            if (!state.stale) this.setLimit({ resetsAt: state.resetsAt })
          }
        }
        return
      }
      default:
        return
    }
  }

  async interrupt(): Promise<void> {
    if (!this.q || !this.busy) return
    try {
      await this.q.interrupt()
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.setLimit()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.pending = []
    this.reset()
    this.busy = false
    this.current = undefined
  }
}

function prettyTool(name: string): string {
  return name.replace(/^mcp__genio__/, '').replace(/_/g, ' ')
}

