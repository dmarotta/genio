import { claudeLimitState, isClaudeLimit } from './claude-limit'
import { registerModelQuery, supportedClaudeEfforts } from './model-discovery'
/**
 * Genio agent sessions (companion's primary harness session, in-process).
 *
 * Each base has one WkspService. It owns:
 *   - the Genio session: a Claude Agent SDK query() in streaming-input mode,
 *     started lazily so an idle base spends zero tokens;
 *   - (main base only) the Bot session: Genio's away supervisor that handles
 *     events while the player is DND/AFK and escalates what they must see.
 * Events from overwatch are drained into one turn and acknowledged only after
 * that turn completes, so a crash re-presents them.
 */
import { unitPluginSource } from './unitskills'
import path from 'node:path'
import type {
  Query, SDKMessage, SDKUserMessage, Options, CanUseTool, PermissionResult, EffortLevel
} from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, WkspActivity, WkspInfo, Settings, ToolTrace } from '@shared/types'
import { userContent, type ChatImageInput } from '@shared/chat-images'
import { inventoryContextBlock, validateInventoryContext, type InventoryContext } from '@shared/inventory-context'
import { prepareInventoryContext } from './inventory-context'
import { bus } from './bus'
import { chatImageDir, loadChatImages, saveChatImages } from './chat-images'
import { attachedIdsNote } from './chat-imagegen'
import type { Home } from './home'
import { buildTools, type ToolRole } from './wksp-tools'
import { closeChatToolBridges } from './chat-tool-bridge'
import { formatNotification } from './notify-format'
import {
  HELP_TEXT, afkPrompt, botContract, eventsPrompt, genioContract, recapPrompt, returnPrompt, savePrompt, sessionStartPrompt,
  statusPrompt
} from './prompts'
import { applyChatEvent, chatControls, compactChat, strandQueued } from '@shared/chat'
import type { AppCtx, WkspService } from './services'
import { claudeLimitsFile, recordClaudeRateLimit, type ClaudeRateLimitInfo } from './usage'
import { appendJsonl, nowIso, readJson, readJsonl, readText, rid, truncate, writeJson } from './util'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<Sdk> | undefined
const loadSdk = (): Promise<Sdk> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

export { decideTool, isReadOnlyCommand } from './chat-tool-policy'
export type { ToolDecision } from './chat-tool-policy'
import { DISALLOWED, enforceTool } from './chat-tool-policy'

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

const NOOP_RE = /^all clear[,!.]?(\s+[\w .'-]{0,40})?[.!]?$/i

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

interface TurnItem {
  limitRetried?: boolean
  kind: 'player' | 'events' | 'system'
  /** what the model receives */
  prompt: string
  /** images sent alongside the prompt as image blocks */
  images?: ChatImageInput[]
  /** wake ack cursor to commit when the turn succeeds */
  ackThrough?: number
  /** the player's chat message this turn carries (it shows as queued until the session picks it up) */
  msgId?: string
}

interface SessionHooks {
  /** the session picked this item up and is starting its turn */
  onStart?(item: TurnItem): void
  onMessage(m: ChatMessage, final: boolean): void
  onDelta(id: string, text: string): void
  onActivity(a: WkspActivity, detail?: string): void
  onTurnEnd(item: TurnItem | undefined, ok: boolean, lastText: string, costDelta: number): void
  onSessionId(id: string): void
  onError(text: string): void
  onRateLimit(info: ClaudeRateLimitInfo): void
  onLimit?(limit: WkspInfo['limit']): void
  onRequeue?(item: TurnItem): void
}

/** One SDK conversation (Genio or the Bot). */
export class AgentSession {
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
  private lastTotalCost = 0
  private msgs = new Map<string, ChatMessage>()
  private blockText = new Map<string, string[]>()
  private toolOwner = new Map<string, string>()
  private turnMsgIds: string[] = []
  private streamMsgId?: string
  private lastText = ''
  private stderrTail = ''
  private generation = 0
  /** model/effort the running query was started with or last switched to */
  private applied?: SessionConfig

  constructor(
    readonly label: string,
    private readonly build: (resume?: string) => Promise<Options>,
    private readonly hooks: SessionHooks,
    private readonly wkspName: string,
    private readonly config: () => SessionConfig
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
    if (this.busy || this.limitPaused) return
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
      await this.ensureStarted()
      this.input!.push(next.prompt, next.images)
    } catch (e) {
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
    if (state.stale && item && !item.limitRetried) {
      this.setLimit()
      item.limitRetried = true
      this.retryLimit()
      return
    }
    this.setLimit({ resetsAt: state.resetsAt, restartRequired: state.stale })
  }

  private async ensureStarted(): Promise<void> {
    if (this.q) return
    const sdk = await loadSdk()
    const gen = ++this.generation
    this.input = new InputQueue()
    this.gotInit = false
    this.resumedFrom = this.sessionId
    const options = await this.build(this.sessionId)
    this.applied = { model: options.model, effort: options.effort as EffortLevel | undefined }
    options.stderr = (d: string): void => {
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
      if (this.resumedFrom && !this.gotInit) {
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
        if (am.error && (isClaudeLimit(errorText) || isClaudeLimit(String(am.error)))) {
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
        const r = m as { is_error?: boolean; total_cost_usd?: number; result?: string; errors?: string[]; subtype?: string }
        const errorText = (r.errors ?? []).join('; ') || r.result || this.assistantLimit
        const limitError = (r.is_error && isClaudeLimit(errorText)) || !!this.assistantLimit
        const total = r.total_cost_usd ?? 0
        const delta = total >= this.lastTotalCost ? total - this.lastTotalCost : total
        this.lastTotalCost = total
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
    this.pending = []
    this.reset()
    this.busy = false
    this.current = undefined
  }
}

function prettyTool(name: string): string {
  return name.replace(/^mcp__genio__/, '').replace(/_/g, ' ')
}

// ------------------------------------------------------------------ service

interface WkspState {
  sessionId?: string
  botSessionId?: string
  costUsd?: number
  turns?: number
}

export function createWkspService(getCtx: () => AppCtx, home: Home, ally?: Ally): WkspService {
  const name = home.name
  const persisted = readJson<WkspState>(home.wkspFile, {})
  const info: WkspInfo = {
    name,
    displayName: ally ? ally.name : 'Genio',
    scope: ally?.scope,
    charter: ally?.charter,
    model: ally?.model,
    effort: ally?.effort,
    activity: 'offline',
    costUsd: persisted.costUsd ?? 0,
    turns: persisted.turns ?? 0,
    queued: 0,
    sessionId: persisted.sessionId
  }
  let contextSessionStart = nowIso()
  let history: ChatMessage[] | undefined
  let eventsBackoffUntil = 0
  let bootDone = false
  let stopped = false

  const settings = (): ReturnType<AppCtx['settings']['get']> => getCtx().settings.get()
  /** the ally record as saved now (its chat controls can change while the base runs) */
  const liveAlly = (): Ally | undefined => (ally ? (safeGet(() => getCtx().allies.list().find((a) => a.name === ally.name && !a.retiredAt)) ?? ally) : undefined)
  const gamertag = (): string => settings().gamertag || 'Player'

  const saveState = (): void => {
    writeJson(home.wkspFile, { sessionId: genio.sessionId, botSessionId: bot?.sessionId, costUsd: info.costUsd, turns: info.turns } satisfies WkspState)
  }
  const publishInfo = (): void => {
    info.queued = genio.queued + (bot?.queued ?? 0)
    info.sessionId = genio.sessionId
    bus.publish({ type: 'wksp', wksp: { ...info } })
  }

  const loadHistory = (): ChatMessage[] => {
    if (!history) {
      // first read in this run: anything still queued was lost with the previous session
      const { list, stranded } = strandQueued(compactChat(readJsonl<ChatMessage>(home.chatFile)).slice(-1000))
      for (const m of stranded) appendJsonl(home.chatFile, m)
      history = list
    }
    return history
  }
  const record = (m: ChatMessage, persist: boolean): void => {
    const h = loadHistory()
    const i = h.findIndex((x) => x.id === m.id)
    if (i >= 0) h[i] = m
    else h.push(m)
    if (h.length > 1200) h.splice(0, h.length - 1000)
    if (persist) appendJsonl(home.chatFile, m)
    bus.publish({ type: 'chat', message: m })
  }

  const say = (text: string, role: ChatMessage['role'] = 'genio'): ChatMessage => {
    const m: ChatMessage = { id: `s-${rid(6)}`, wksp: name, role, text, ts: nowIso() }
    record(m, true)
    return m
  }

  /** The session picked a queued message up: it becomes a normal sent message at the end of the log. */
  const delivered = (item: TurnItem): void => {
    const h = loadHistory()
    const i = item.msgId ? h.findIndex((x) => x.id === item.msgId) : -1
    if (i < 0 || h[i].queue !== 'queued') return
    const { queue: _was, ...sent } = h[i]
    h.splice(i, 1)
    record({ ...sent, ts: nowIso() }, true)
  }

  // ---------------------------------------------------------- options

  async function buildOptions(role: ToolRole, resume?: string): Promise<Options> {
    const ctx = getCtx()
    const sdk = await loadSdk()
    const s = settings()
    const mem = ctx.memory
    const toolDefs = buildTools(sdk.tool, getCtx, home, role, { escalate: (text, severity) => botEscalate(text, severity) })
    const server = sdk.createSdkMcpServer({ name: 'genio', version: '1.0.0', tools: toolDefs, alwaysLoad: true })
    const worlds = ctx.projects.list().map((p) => p.path)
    const append =
      role === 'bot'
        ? `${botContract(gamertag())}\n\n${genioContract({ gamertag: gamertag(), base: name, isAlly: !home.isMain, charter: ally?.charter, scope: ally?.scope, playerProfile: safeRead(() => mem.read('player', home)), lore: safeRead(() => mem.read('lore', home)) })}`
        : genioContract({
            gamertag: gamertag(),
            base: name,
            isAlly: !home.isMain,
            charter: ally ? readText(`${home.data}/charter.md`, ally.charter) : undefined,
            scope: ally?.scope,
            playerProfile: safeRead(() => mem.read('player', home)),
            sharedProfile: safeRead(() => mem.read('player-shared', home)),
            lore: safeRead(() => mem.read('lore', home))
          })
    const { model, effort } = sessionConfig(role, s, liveAlly())
    const opts: Options = {
      // settingSources is deliberately empty: inject the umbrella so skill discovery is not assumed.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: append + (role === 'bot' || !ctx.appRoot ? '' : '\n\nAssets skill directory (resolve the following skill references relative to it): ' + path.join(unitPluginSource(ctx.appRoot), 'skills/assets') + '\n' + readText(path.join(unitPluginSource(ctx.appRoot), 'skills/assets/SKILL.md'))) },
      cwd: home.root,
      additionalDirectories: worlds,
      settingSources: [],
      includePartialMessages: role !== 'bot',
      mcpServers: { genio: server },
      disallowedTools: DISALLOWED,
      canUseTool: makePolicy(role),
      permissionMode: 'default',
      model,
      effort,
      resume,
      env: { ...process.env, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_AGENT_SDK_CLIENT_APP: 'genio/0.1.0' }
    }
    if (s.claudePath?.trim()) opts.pathToClaudeCodeExecutable = s.claudePath.trim()
    return opts
  }

  function makePolicy(role: ToolRole): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      const d = await enforceTool({ role, chat: name, shellMode: () => chatControls(settings(), liveAlly()).shellMode,
        permissions: getCtx().permissions, player: gamertag() }, { runtime: 'claude', name: toolName, input })
      return d.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : d
    }
  }

  // ---------------------------------------------------------- sessions

  // plan limits are per account: every base records into the main base (Systems → Accounts)
  const rateLimit = (rl: ClaudeRateLimitInfo): void => safe(() => recordClaudeRateLimit(claudeLimitsFile(getCtx().main.home.data), rl))

  const genio = new AgentSession(
    'genio',
    (resume) => buildOptions('genio', resume),
    {
      onStart: delivered,
      onRequeue(item) {
        const m = loadHistory().find(m => m.id === item.msgId)
        if (m) {
          const queued: ChatMessage = { ...m, queue: 'queued' }
          history = applyChatEvent(loadHistory(), queued)
          record(queued, true)
        }
      },
      onLimit(limit) {
        info.limit = limit
        info.lastError = undefined
        publishInfo()
      },
      onMessage(m, final) {
        let msg = m
        if (final && msg.text && NOOP_RE.test(msg.text.trim()) && !(msg.tools ?? []).length) msg = { ...msg, role: 'system' }
        record(msg, final)
      },
      onDelta(id, text) {
        bus.publish({ type: 'chat-delta', wksp: name, id, text })
      },
      onActivity(a, detail) {
        info.activity = a
        info.activityDetail = detail
        publishInfo()
      },
      onTurnEnd(item, ok, lastText, cost) {
        if (ok) info.lastError = undefined
        info.turns++
        info.costUsd += cost
        if (cost > 0) safe(() => getCtx().stats.addCost(cost))
        saveState()
        if (item?.kind === 'events' && item.ackThrough !== undefined) {
          if (ok) safe(() => getCtx().home(name).wakes.ack(item.ackThrough!))
          else eventsBackoffUntil = Date.now() + 60_000
        }
        if (ok && lastText && !NOOP_RE.test(lastText.trim())) {
          bus.publish({ type: 'sfx', sound: 'blip' })
          if (settings().voice) bus.publish({ type: 'speak', text: lastText })
        }
        publishInfo()
        setTimeout(() => svc.deliverWakes(), 250)
      },
      onSessionId(id) {
        info.sessionId = id
        saveState()
        publishInfo()
      },
      onError(text) {
        info.lastError = text
        say(text, 'error')
        bus.publish({ type: 'sfx', sound: 'error' })
      },
      onRateLimit: rateLimit
    },
    name,
    () => sessionConfig('genio', settings(), liveAlly())
  )
  genio.sessionId = persisted.sessionId

  let bot: AgentSession | undefined
  const botFile = `${home.data}/bot.jsonl`
  if (home.isMain) {
    bot = new AgentSession(
      'bot',
      (resume) => buildOptions('bot', resume),
      {
        onMessage(m, final) {
          if (final) appendJsonl(botFile, m)
        },
        onDelta() {
          /* the Bot's turns are off-screen */
        },
        onActivity(a, detail) {
          if (a === 'thinking' || a === 'tool') {
            info.activityDetail = `Bot: ${detail ?? 'on overwatch'}`
            publishInfo()
          }
        },
        onTurnEnd(item, ok, _last, cost) {
          info.costUsd += cost
          if (cost > 0) safe(() => getCtx().stats.addCost(cost))
          if (item?.kind === 'events' && item.ackThrough !== undefined) {
            if (ok) safe(() => getCtx().home(name).wakes.ack(item.ackThrough!))
            else eventsBackoffUntil = Date.now() + 60_000
          }
          saveState()
          publishInfo()
          setTimeout(() => svc.deliverWakes(), 250)
        },
        onSessionId() {
          saveState()
        },
        onError(text) {
          appendJsonl(botFile, { ts: nowIso(), error: text })
          if (getCtx().away.state().mode === 'afk') safe(() => getCtx().away.capture({ wksp: name, text: `The Bot hit a problem: ${text}`, severity: 'failure', target: { view: 'comms', wksp: name } }))
        },
        onRateLimit: rateLimit,
        onLimit(limit) {
          info.botLimit = limit
          publishInfo()
        }
      },
      name,
      () => sessionConfig('bot', settings())
    )
    bot.sessionId = persisted.botSessionId
  }

  function botEscalate(text: string, severity: 'info' | 'decision' | 'failure' | 'ready'): void {
    const ctx = getCtx()
    const mode = ctx.away.state().mode
    if (mode === 'afk') {
      ctx.away.capture({ wksp: name, text, severity, target: { view: 'comms', wksp: name } })
    } else {
      say(`Bot: ${text}`, 'system')
      const { title, body } = formatNotification({ kind: severity, text, where: name })
      ctx.notifier.notify(title, body, severity, { target: { view: 'comms', wksp: name } })
      ctx.notifier.sfx(severity === 'failure' ? 'alert' : severity === 'decision' ? 'decision' : 'ready')
    }
  }

  // ---------------------------------------------------------- boot

  function needsSessionStart(): boolean {
    try {
      const hc = getCtx().home(name)
      const live = hc.crew.list().some((t) => !['cleaned', 'done'].includes(t.state))
      return live || hc.wakes.pending().length > 0 || hc.decisions.list(false).length > 0
    } catch {
      return false
    }
  }

  setTimeout(() => {
    if (stopped || bootDone) return
    bootDone = true
    if (!needsSessionStart()) return
    let drain = { text: '', ackThrough: -1, count: 0 }
    try {
      drain = getCtx().home(name).wakes.drain()
    } catch {
      /* no events */
    }
    const toBot = home.isMain && getCtx().away.state().mode === 'afk' && bot
    const target = toBot ? bot! : genio
    target.enqueue({
      kind: drain.count ? 'events' : 'system',
      prompt: `${sessionStartPrompt(gamertag())}${drain.count ? `\n\n${drain.text}` : ''}`,
      ackThrough: drain.count ? drain.ackThrough : undefined
    })
    publishInfo()
  }, 7000)

  // ---------------------------------------------------------- slash commands

  async function slash(text: string): Promise<boolean> {
    const m = text.trim().match(/^\/(\w+)\b\s*(.*)$/s)
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const rest = m[2].trim()
    const ctx = getCtx()
    const player = (): void => void record({ id: `p-${rid(6)}`, wksp: name, role: 'player', text, ts: nowIso() }, true)
    switch (cmd) {
      case 'help':
        player()
        say(HELP_TEXT, 'system')
        return true
      case 'recap':
        player()
        genio.enqueue({ kind: 'player', prompt: recapPrompt(gamertag()) })
        publishInfo()
        return true
      case 'status': {
        player()
        const file = /\bfile\b/i.test(rest)
        const prs = /include\s+prs?\b/i.test(rest)
        genio.enqueue({ kind: 'player', prompt: statusPrompt(gamertag(), file, prs) })
        publishInfo()
        return true
      }
      case 'save':
        player()
        safe(() => ctx.stats.award('save'))
        genio.enqueue({ kind: 'player', prompt: savePrompt(gamertag(), !home.isMain) })
        publishInfo()
        return true
      case 'afk':
        if (!home.isMain) return false
        player()
        await ctx.away.set('afk')
        genio.enqueue({ kind: 'player', prompt: afkPrompt(gamertag(), rest) })
        publishInfo()
        return true
      case 'dnd':
      case 'quiet': {
        if (!home.isMain) return false
        player()
        const off = /^(off|stop|no)$/i.test(rest)
        if (off) {
          await ctx.away.set('online')
          say(`Back online, ${gamertag()}. Events come straight to Comms again.`, 'system')
        } else {
          await ctx.away.set('dnd')
          say(`DND on, ${gamertag()}. The Bot handles routine events off-screen; anything you ask still happens right away. /dnd off to end it.`, 'system')
        }
        return true
      }
      case 'online':
      case 'back': {
        if (!home.isMain) return false
        player()
        const mode = ctx.away.state().mode
        if (mode === 'afk') {
          const brief = ctx.away.takeReturnBrief()
          await ctx.away.set('online')
          genio.enqueue({ kind: 'player', prompt: returnPrompt(gamertag(), brief) })
        } else {
          await ctx.away.set('online')
          say(`Online, ${gamertag()}.`, 'system')
        }
        publishInfo()
        return true
      }
      case 'patch':
      case 'update': {
        player()
        const info2 = await ctx.update.check()
        if (!info2.isGitCheckout) say('Genio is not running from a git checkout, so there is nothing to patch from.', 'system')
        else if (info2.error) say(`Patch check failed: ${info2.error}`, 'error')
        else if (!info2.behind) say(`Genio is already on the latest patch, ${gamertag()}.`, 'system')
        else if (!info2.canFastForward) say(`A patch is available (${info2.behind} commit(s)) but the Genio checkout ${info2.dirty ? 'has local edits' : 'has diverged'}, so it can't fast-forward safely.`, 'system')
        else {
          say(`Patching ${info2.behind} update(s):\n${info2.incoming.slice(0, 10).map((l) => `- ${l}`).join('\n')}`, 'system')
          const r = await ctx.update.apply()
          say(r.message, r.ok ? 'system' : 'error')
        }
        return true
      }
      default:
        return false
    }
  }

  // ---------------------------------------------------------- service

  const performSend: WkspService['send'] = async (text, origin = 'player', images = [], context) => {
    stopped = false
    bootDone = true
    const trimmed = text.trim()
    if (!trimmed && !images.length) return
    try {
      if (origin === 'player' && !images.length && trimmed.startsWith('/') && (await slash(trimmed))) return
    } catch (e) {
      say(`Command failed: ${(e as Error).message}`, 'error')
      return
    }
    // stored before anything else so a bad image fails the send (the composer keeps the draft)
    const ctx = getCtx()
    const prepared = await prepareInventoryContext(context, images, (world, asset) => ctx.inventory.thumbnail(world, asset),
      () => loadHistory().filter(m => m.ts >= contextSessionStart))
    const stored = saveChatImages(chatImageDir(home.data), prepared.images)
    if (prepared.context?.thumbnail?.status === 'attached') prepared.context.thumbnail.image = stored.refs.at(-1)
    let prompt = trimmed
    // companion: the first ordinary player message after AFK ends it with a return brief
    if (origin === 'player' && home.isMain && ctx.away.state().mode === 'afk') {
      const brief = ctx.away.takeReturnBrief()
      await ctx.away.set('online')
      prompt = `${returnPrompt(gamertag(), brief)}\n\nThen handle ${gamertag()}'s new message:\n${trimmed || '(see the attached image)'}`
    }
    const m = inboundMessage(name, trimmed, origin)
    if (stored.refs.length) m.images = stored.refs
    if (prepared.context) m.context = prepared.context
    const player = origin === 'player'
    // mid-turn: the message waits in the log as queued until the session picks it up
    if (player && !genio.idle) m.queue = 'queued'
    record(m, true)
    bus.publish({ type: 'sfx', sound: 'send' })
    // the ids let Genio pass pasted images to generate_image as refs
    prompt += inventoryContextBlock(m.context) + attachedIdsNote(stored.refs)
    genio.enqueue({ kind: player ? 'player' : 'system', prompt, images: stored.send.length ? stored.send : undefined, msgId: player ? m.id : undefined })
    if (m.context) ctx.stats.unlock('inventory-chat')
    publishInfo()
  }
  let pendingSend: Promise<void> = Promise.resolve()

  const svc: WkspService = {
    info: () => ({ ...info, queued: genio.queued + (bot?.queued ?? 0) }),
    history(limit = 200) {
      const h = loadHistory()
      return h.slice(-limit)
    },
    send(text, origin = 'player', images = [], context) {
      // Thumbnail decoding may be slow: retain click order and freeze the visible chips now.
      const snapshot = context && validateInventoryContext(context)
      const sending = pendingSend.then(() => performSend(text, origin, images, snapshot))
      pendingSend = sending.catch(() => undefined)
      return sending
    },
    unqueue(id) {
      const h = loadHistory()
      const m = h.find((x) => x.id === id)
      if (!m || (m.queue !== 'queued' && m.queue !== 'unsent')) return null
      const item = m.queue === 'queued' ? genio.cancel(id) : undefined
      // Filter stored refs before reading: a missing thumbnail must not drop a pasted image.
      const automatic = m.context?.thumbnail?.status === 'attached'
      const refs = automatic ? m.images?.filter(i => i.file !== m.context?.thumbnail?.image?.file) : m.images
      const images = item ? (automatic ? item.images?.slice(0, -1) : item.images)
        : refs?.length ? loadChatImages(chatImageDir(home.data), refs) : undefined
      history = h.filter((x) => x.id !== id)
      const gone: ChatMessage = { ...m, queue: 'cancelled' }
      appendJsonl(home.chatFile, gone)
      bus.publish({ type: 'chat', message: gone })
      publishInfo()
      // The automatic preview belongs to its chip, not the pasted-image draft.
      return { text: m.text, ...(images?.length ? { images } : {}), ...(m.context ? { context: m.context } : {}) }
    },
    deliverWakes() {
      if (stopped) return
      try {
        if (Date.now() < eventsBackoffUntil) {
          setTimeout(() => svc.deliverWakes(), eventsBackoffUntil - Date.now() + 50)
          return
        }
        if (genio.hasEventsQueued() || bot?.hasEventsQueued()) return
        const ctx = getCtx()
        const wk = ctx.home(name).wakes
        const pend = wk.pending()
        if (!pend.length) return
        const mode = home.isMain ? ctx.away.state().mode : 'online'
        const allRoutine = pend.every((w) => w.routine)
        const target = bot && (mode === 'afk' || (mode === 'dnd' && allRoutine)) ? bot : genio
        const d = wk.drain()
        if (!d.count) return
        bootDone = true
        target.enqueue({ kind: 'events', prompt: eventsPrompt(d.text), ackThrough: d.ackThrough })
        publishInfo()
      } catch (e) {
        info.lastError = (e as Error).message
      }
    },
    async interrupt() {
      await genio.interrupt()
      await bot?.interrupt()
    },
    async restart(fresh, role = 'genio') {
      await closeChatToolBridges(getCtx(), name, role)
      if (role === 'bot') {
        bot?.restart(fresh)
      } else {
        if (fresh) contextSessionStart = nowIso()
        genio.restart(fresh)
        info.lastError = undefined
      }
      stopped = false
      saveState()
      publishInfo()
      setTimeout(() => svc.deliverWakes(), 500)
    },
    async stop() {
      stopped = true
      await closeChatToolBridges(getCtx(), name)
      genio.stop()
      bot?.stop()
      info.activity = 'offline'
      saveState()
    },
    say,
    post: record
  }
  return svc
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    /* optional collaborator */
  }
}

function safeGet<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function safeRead(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ''
  }
}
