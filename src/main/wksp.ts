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
import type {
  Query, SDKMessage, SDKUserMessage, Options, CanUseTool, PermissionResult, EffortLevel
} from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, WkspActivity, WkspInfo, Settings, ToolTrace } from '@shared/types'
import { userContent, type ChatImageInput } from '@shared/chat-images'
import { bus } from './bus'
import { chatImageDir, saveChatImages } from './chat-images'
import type { Home } from './home'
import { buildTools, type ToolRole } from './wksp-tools'
import {
  HELP_TEXT, afkPrompt, botContract, eventsPrompt, genioContract, recapPrompt, returnPrompt, savePrompt, sessionStartPrompt,
  statusPrompt
} from './prompts'
import type { AppCtx, WkspService } from './services'
import { claudeLimitsFile, recordClaudeRateLimit, type ClaudeRateLimitInfo } from './usage'
import { appendJsonl, nowIso, readJson, readJsonl, readText, rid, truncate, writeJson } from './util'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<Sdk> | undefined
const loadSdk = (): Promise<Sdk> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

// ------------------------------------------------------------------ tool policy

/** companion subagent guard: Genio delegates to units, never to in-session subagents. */
const SUBAGENT_RE = /agent|subagent|^task$|^task(create|update|output|stop|get|list)?$|workflow|cron|schedul|worktree|delegate|spawn|dispatch|handoff|remote|sendmessage|monitor/i
const DISALLOWED = ['Agent', 'Task', 'Workflow', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree', 'RemoteTrigger', 'SendMessage', 'Monitor', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']
const ALLOWED = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch'])

const READ_ONLY_SEGMENTS: RegExp[] = [
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|show|branch|rev-parse|ls-files|blame|shortlog|describe|remote(\s+-v)?|tag\s+(-l|--list)|worktree\s+list|config\s+--get)\b/i,
  /^(ls|dir|cat|type|head|tail|rg|grep|wc|pwd|echo|tree|stat|file|which|where|sort|uniq|jq|du|date|whoami|cut|awk)\b/i,
  /^find\b(?!.*\s-(exec|execdir|delete|ok|fprint)\b)/i,
  /^gh\s+(pr\s+(view|list|checks|diff|status)|run\s+(view|list)|repo\s+view|issue\s+(view|list)|search\s+prs|auth\s+status)\b/i,
  /^glab\s+(mr\s+(view|list)|ci\s+(view|list|status))\b/i,
  /^cd\s+\S+$/i,
  /^(node|npm|python|py|cargo|godot|dotnet)\s+(-v|--version)$/i
]

/** True when every segment of a shell command is a known read-only command and nothing writes. */
export function isReadOnlyCommand(cmd: string): boolean {
  const c = cmd.trim()
  if (!c) return false
  if (/[`]|\$\(|<\(|>\(/.test(c)) return false
  // allow only harmless stderr redirections; any other '>' writes a file
  const scrubbed = c.replace(/2>&1|2>\s*\/dev\/null|2>\s*nul\b/gi, '')
  if (/>/.test(scrubbed)) return false
  const segments = scrubbed.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
  return segments.every((s) => READ_ONLY_SEGMENTS.some((re) => re.test(s.trim())))
}

export type ToolDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string } | { behavior: 'ask'; input: string; reason?: string }

/** Pure tool policy for a Genio/Bot session; 'ask' goes to the player's permission prompt. */
export function decideTool(role: ToolRole, toolName: string, input: unknown, shellMode: Settings['chatShellMode']): ToolDecision {
  if (toolName.startsWith('mcp__genio__')) return { behavior: 'allow' }
  if (ALLOWED.has(toolName)) return { behavior: 'allow' }
  if (DISALLOWED.includes(toolName) || SUBAGENT_RE.test(toolName)) {
    return { behavior: 'deny', message: 'Genio delegates work to units (deploy) and never writes worlds or spawns in-session subagents.' }
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = String((input as { command?: string } | undefined)?.command ?? '')
    if (isReadOnlyCommand(cmd)) return { behavior: 'allow' }
    // the Bot stays read-only whatever the chat's approval mode
    if (role === 'bot') return { behavior: 'deny', message: 'The Bot only runs read-only commands while the player is away.' }
    if (shellMode === 'auto-shell' || shellMode === 'all') return { behavior: 'allow' }
    return { behavior: 'ask', input: cmd, reason: 'Not on the read-only list' }
  }
  if (role === 'bot') return { behavior: 'deny', message: 'Not available to the Bot.' }
  if (shellMode === 'all') return { behavior: 'allow' }
  return { behavior: 'ask', input: truncate(JSON.stringify(input), 1500) }
}

const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface SessionConfig {
  model?: string
  effort?: EffortLevel
}

/** Model/effort for a session: allies keep their own overrides, the Bot keeps botModel at low effort. */
export function sessionConfig(role: ToolRole, s: Pick<Settings, 'botModel' | 'wkspModel' | 'wkspEffort'>, ally?: Pick<Ally, 'model' | 'effort'>): SessionConfig {
  const model = (role === 'bot' ? s.botModel : ally?.model || s.wkspModel)?.trim() || undefined
  const effort = (role === 'bot' ? 'low' : ally?.effort || s.wkspEffort) || undefined
  return { model, effort: effort && EFFORT_LEVELS.includes(effort) ? (effort as EffortLevel) : undefined }
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
  kind: 'player' | 'events' | 'system'
  /** what the model receives */
  prompt: string
  /** images sent alongside the prompt as image blocks */
  images?: ChatImageInput[]
  /** wake ack cursor to commit when the turn succeeds */
  ackThrough?: number
}

interface SessionHooks {
  onMessage(m: ChatMessage, final: boolean): void
  onDelta(id: string, text: string): void
  onActivity(a: WkspActivity, detail?: string): void
  onTurnEnd(item: TurnItem | undefined, ok: boolean, lastText: string, costDelta: number): void
  onSessionId(id: string): void
  onError(text: string): void
  onRateLimit(info: ClaudeRateLimitInfo): void
}

/** One SDK conversation (Genio or the Bot). */
class AgentSession {
  q?: Query
  input?: InputQueue
  busy = false
  current?: TurnItem
  pending: TurnItem[] = []
  sessionId?: string
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

  private async pump(): Promise<void> {
    if (this.busy) return
    const next = this.pending.shift()
    if (!next) return
    this.busy = true
    this.current = next
    this.turnMsgIds = []
    this.lastText = ''
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
    void this.consume(this.q, gen)
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
        const okTurn = !r.is_error
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
        if (info) this.hooks.onRateLimit(info)
        if (info?.status === 'rejected') {
          const when = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : 'later'
          this.hooks.onError(`Usage limit reached; Genio can act again around ${when}.`)
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
  let history: ChatMessage[] | undefined
  let eventsBackoffUntil = 0
  let bootDone = false
  let stopped = false

  const settings = (): ReturnType<AppCtx['settings']['get']> => getCtx().settings.get()
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
    if (!history) history = readJsonl<ChatMessage>(home.chatFile).slice(-1000)
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
    const { model, effort } = sessionConfig(role, s, ally)
    const opts: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
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
      // read the mode at decision time so a switch applies without restarting the session
      const d = decideTool(role, toolName, input, settings().chatShellMode ?? 'ask')
      if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input }
      if (d.behavior === 'deny') return d
      const allowed = await getCtx().permissions.ask({ wksp: name, tool: toolName, input: d.input, reason: d.reason })
      if (allowed) return { behavior: 'allow', updatedInput: input }
      const shell = toolName === 'Bash' || toolName === 'PowerShell'
      return { behavior: 'deny', message: shell ? `${gamertag()} declined this command.` : `${gamertag()} declined ${toolName}.` }
    }
  }

  // ---------------------------------------------------------- sessions

  // plan limits are per account: every base records into the main base (Systems → Accounts)
  const rateLimit = (rl: ClaudeRateLimitInfo): void => safe(() => recordClaudeRateLimit(claudeLimitsFile(getCtx().main.home.data), rl))

  const genio = new AgentSession(
    'genio',
    (resume) => buildOptions('genio', resume),
    {
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
    () => sessionConfig('genio', settings(), ally)
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
          if (getCtx().away.state().mode === 'afk') safe(() => getCtx().away.capture({ wksp: name, text: `The Bot hit a problem: ${text}`, severity: 'failure' }))
        },
        onRateLimit: rateLimit
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
      ctx.away.capture({ wksp: name, text, severity })
    } else {
      say(`Bot: ${text}`, 'system')
      ctx.notifier.notify(severity === 'ready' ? 'Ready for review' : severity === 'decision' ? 'Your move' : severity === 'failure' ? 'Problem' : 'Genio', text, severity)
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

  const svc: WkspService = {
    info: () => ({ ...info, queued: genio.queued + (bot?.queued ?? 0) }),
    history(limit = 200) {
      const h = loadHistory()
      return h.slice(-limit)
    },
    async send(text, origin = 'player', images = []) {
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
      const stored = saveChatImages(chatImageDir(home.data), images)
      const ctx = getCtx()
      let prompt = trimmed
      // companion: the first ordinary player message after AFK ends it with a return brief
      if (origin === 'player' && home.isMain && ctx.away.state().mode === 'afk') {
        const brief = ctx.away.takeReturnBrief()
        await ctx.away.set('online')
        prompt = `${returnPrompt(gamertag(), brief)}\n\nThen handle ${gamertag()}'s new message:\n${trimmed || '(see the attached image)'}`
      }
      const m: ChatMessage = { id: `p-${rid(6)}`, wksp: name, role: origin === 'player' ? 'player' : 'system', text: trimmed, ts: nowIso() }
      if (stored.refs.length) m.images = stored.refs
      record(m, true)
      bus.publish({ type: 'sfx', sound: 'send' })
      genio.enqueue({ kind: origin === 'player' ? 'player' : 'system', prompt, images: stored.send.length ? stored.send : undefined })
      publishInfo()
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
    async restart(fresh) {
      genio.stop()
      bot?.stop()
      if (fresh) {
        genio.sessionId = undefined
        if (bot) bot.sessionId = undefined
        saveState()
        say(`Fresh Genio session started, ${gamertag()}. Records on disk are intact.`, 'system')
      } else say('Genio session restarted (conversation resumes on the next message).', 'system')
      info.activity = 'offline'
      info.activityDetail = undefined
      stopped = false
      publishInfo()
      setTimeout(() => svc.deliverWakes(), 500)
    },
    async stop() {
      stopped = true
      genio.stop()
      bot?.stop()
      info.activity = 'offline'
      saveState()
    },
    say
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

function safeRead(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ''
  }
}
