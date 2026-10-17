import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ChatMessage } from '@shared/types'
import type { RawModel } from '@shared/model-catalogue'
import { killTree, nowIso, which } from './util'
import { codexRolloutState } from './codex-session'
import type { ChatDriver, ChatDriverEvents, ChatTurn } from './chat-driver'
import { settingsPath } from '@shared/settings-pages'

const OPEN_ACCOUNTS = `Open ${settingsPath('accounts')}`

// These are chat restrictions, deliberately independent of harness.ts.
export const CODEX_CHAT_DISABLED = ['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'remote_plugin', 'hooks', 'code_mode', 'computer_use', 'browser_use',
  'browser_use_external', 'image_generation', 'goals', 'worktrees', 'skill_mcp_dependency_install',
  'skill_search', 'tool_suggest', 'memories', 'request_permissions_tool'] as const

type RpcValue = Record<string, any>
export interface CodexRpc {
  request(method: string, params: unknown): Promise<RpcValue>
  notify(method: string, params: unknown): void
  close(): void
}
export interface CodexWireEvents {
  notification(method: string, params: RpcValue): void
  request(method: string, params: RpcValue): Promise<unknown>
  closed(): void
}

/** Bounded newline RPC transport. A timeout has an unknown outcome and is never retried. */
export function spawnCodexChat(events: CodexWireEvents, extraEnv: Record<string, string> = {}): CodexRpc {
  const file = which('codex')
  if (!file) throw new Error(`Codex is not installed. ${OPEN_ACCOUNTS}.`)
  const args = ['app-server', '--listen', 'stdio://', ...CODEX_CHAT_DISABLED.flatMap(name => ['--disable', name])]
  const shim = /\.(cmd|bat)$/i.test(file)
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  // Never turn a logged-out subscription session into API-credit billing.
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  const child: ChildProcessWithoutNullStreams = spawn(shim ? 'cmd.exe' : file,
    shim ? ['/d', '/s', '/c', `"${file}" ${args.join(' ')}`] : args,
    { env, windowsHide: true, windowsVerbatimArguments: shim, detached: process.platform !== 'win32' })
  child.stderr.resume()
  // decoded across chunk boundaries (readline would too; this keeps it explicit)
  child.stdout.setEncoding('utf8')
  let sequence = 0, closed = false
  const pending = new Map<number, { resolve(v: RpcValue): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const send = (message: unknown): void => { if (!closed) child.stdin.write(JSON.stringify(message) + '\n') }
  const lines = createInterface({ input: child.stdout })
  const close = (): void => {
    if (closed) return
    closed = true
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed; request was not retried.')) }
    pending.clear(); lines.close(); child.stdin.end(); killTree(child.pid)
    events.closed()
  }
  child.on('error', close); child.on('exit', close); child.stdin.on('error', close)
  lines.on('line', line => {
    if (line.length > 16 * 1024 * 1024) { close(); return }
    let m: RpcValue
    try { m = JSON.parse(line) } catch { close(); return }
    if (m.method && m.id !== undefined) {
      void events.request(m.method, m.params ?? {}).then(result => send({ id: m.id, result }),
        () => send({ id: m.id, error: { code: -32603, message: 'Request denied or unavailable' } }))
    } else if (m.method) events.notification(m.method, m.params ?? {})
    else {
      const p = pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer); pending.delete(m.id)
      if (m.error) p.reject(new Error(String(m.error.message || 'Codex request failed')))
      else p.resolve(m.result ?? {})
    }
  })
  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error('Codex connection closed'))
      return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out; outcome unknown.')); close() }, 30_000)
        pending.set(id, { resolve, reject, timer }); send({ id, method, params })
      })
    },
    notify: (method, params) => send({ method, params }), close
  }
}

export interface CodexBridge {
  list(): Promise<{ name: string; description: string; inputSchema: unknown }[]>
  call(name: string, args: unknown): Promise<{ isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string }[] }>
  close(): Promise<void>
}
export interface CodexDriverOptions {
  wksp: string
  cwd: string
  config(): { model: string; effort?: string }
  instructions(): string
  bridge(signal: AbortSignal): Promise<CodexBridge>
  /** Bridge handlers own mutation consent; this only handles runtime elicitation. */
  approve(text: string): Promise<boolean>
  approvalMode?(): 'ask' | 'auto-shell' | 'all'
  usage?(thread: string, usage: RpcValue): void
  rateLimits?(limits: RpcValue): void
  unavailable?(reason: string): void
  /** The Codex home this connection runs in (Genio's own when signed in); absent = the inherited one. */
  home?(): Promise<{ env: Record<string, string>; codexHome: string }>
  /** Bounded context for a fresh thread that replaces one the home does not hold. */
  handoff?(): string
  wire?(events: CodexWireEvents, env: Record<string, string>): CodexRpc
}

export function codexEffort(model: RawModel, desired?: string): string | undefined {
  const allowed = model.supportedReasoningEfforts?.map(e => e.reasoningEffort).filter(e => e !== 'ultra') ?? []
  if (desired && allowed.includes(desired)) return desired
  const fallback = (model as RawModel & { defaultReasoningEffort?: string }).defaultReasoningEffort
  return fallback && allowed.includes(fallback) ? fallback : allowed.includes('medium') ? 'medium' : allowed[0]
}

/** A single provider conversation. No native tool can acquire Genio authority.
 * Dynamic calls are forwarded to the authenticated app-owned bridge, including
 * Bot reads. Native approvals and permission expansion are always denied. */
export class CodexChatDriver implements ChatDriver {
  readonly capabilities = { mode: 'driver' as const, guardedTools: true }
  sessionId?: string
  busy = false
  private pending: ChatTurn[] = []
  private current?: ChatTurn
  private rpc?: CodexRpc
  private bridge?: CodexBridge
  private lifetime?: AbortController
  private starting?: Promise<void>
  private submitted = false
  private turnId?: string
  private paused = false
  private closed = false
  private notice = false
  private models: RawModel[] = []
  private messages = new Map<string, ChatMessage>()
  private calls = new Map<string, Promise<unknown>>()
  private toolNames = new Set<string>()
  private yielding?: Promise<void>
  private generation = 0
  /** handoff for the first turn of a thread that replaced one from another home */
  private carry?: string

  constructor(private readonly options: CodexDriverOptions, private readonly events: ChatDriverEvents) {}
  get queued(): number { return this.pending.length }
  get running(): ChatTurn | undefined { return this.current }
  get idle(): boolean { return !this.busy && !this.pending.length && !this.paused }
  hasEventsQueued(): boolean { return this.current?.kind === 'events' || this.pending.some(t => t.kind === 'events') }
  cancel(id: string): ChatTurn | undefined {
    const i = this.pending.findIndex(t => t.msgId === id)
    return i < 0 ? undefined : this.pending.splice(i, 1)[0]
  }
  send(turn: ChatTurn): void {
    const i = turn.kind === 'player' ? this.pending.findIndex(t => t.kind !== 'player') : -1
    if (i < 0) this.pending.push(turn); else this.pending.splice(i, 0, turn)
    void this.pump()
  }
  start(): Promise<void> {
    if (this.starting) return this.starting
    if (this.rpc && this.bridge) return Promise.resolve()
    const starting = this.connect().finally(() => { if (this.starting === starting) this.starting = undefined })
    this.starting = starting
    return starting
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.closed = false
    const lifetime = this.lifetime = new AbortController()
    const checkLive = (): void => { if (lifetime.signal.aborted || generation !== this.generation) throw new Error('Chat closed') }
    const home = await this.options.home?.()
    checkLive()
    // A thread only resumes in the home that holds it. One from another home (the chat
    // moved into Genio's own) is left there; a fresh thread here carries the handoff.
    if (this.sessionId && home && await codexRolloutState(this.sessionId, home.codexHome) !== 'live') {
      this.sessionId = undefined
      this.carry = this.options.handoff?.() || undefined
    }
    checkLive()
    const rpc = this.rpc = (this.options.wire ?? spawnCodexChat)({
      notification: (method, params) => { if (generation === this.generation) this.notification(method, params) },
      request: (method, params) => generation === this.generation ? this.serverRequest(method, params) : Promise.reject(new Error('Stale session')),
      closed: () => { if (!this.closed && generation === this.generation) this.fail(`Codex disconnected. ${OPEN_ACCOUNTS}, then resume deliberately.`) }
    }, home?.env ?? {})
    await rpc.request('initialize', { clientInfo: { name: 'genio_chat', version: '1.0' }, capabilities: { experimentalApi: true } })
    checkLive()
    rpc.notify('initialized', {})
    const account = await rpc.request('account/read', { refreshToken: true })
    checkLive()
    if (!['chatgpt', 'chatgptAuthTokens'].includes(account.account?.type)) throw new Error(`Codex ChatGPT login required. ${OPEN_ACCOUNTS}.`)
    const config = (await rpc.request('config/read', { includeLayers: false })).config
    checkLive()
    if (CODEX_CHAT_DISABLED.some(name => config?.features?.[name] !== false)) throw new Error('Codex cannot verify chat tool confinement; route unavailable.')
    if (config.model_providers?.openai) throw new Error('A custom OpenAI provider override cannot be validated for subscription-only chat.')
    const overrides: RpcValue = { model_provider: 'openai', forced_login_method: 'chatgpt', web_search: 'disabled',
      model_reasoning_effort: 'medium', 'tools.view_image': false, project_doc_max_bytes: 0 }
    // Config maps merge: disable every inherited MCP server individually.
    for (const name of Object.keys(config.mcp_servers ?? {})) {
      if (!/^[\w-]+$/.test(name)) throw new Error('An inherited MCP server configuration cannot be safely isolated for chat.')
      overrides[`mcp_servers.${name}.enabled`] = false
    }
    let cursor: string | undefined
    const seen = new Set<string>()
    this.models = []
    do {
      const page = await rpc.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) })
      checkLive()
      this.models.push(...page.data)
      cursor = page.nextCursor || undefined
      if (cursor && seen.has(cursor)) throw new Error('Repeated model catalogue cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    const wanted = this.options.config()
    const model = this.models.find(m => (m.model ?? m.id) === wanted.model && !m.hidden)
    if (!model) throw new Error(`Selected model unavailable in the signed-in Codex catalogue. ${OPEN_ACCOUNTS}.`)
    overrides.model_reasoning_effort = codexEffort(model, wanted.effort)
    const bridge = await this.options.bridge(lifetime.signal)
    if (lifetime.signal.aborted) { await bridge.close(); checkLive() }
    this.bridge = bridge
    const definitions = await bridge.list()
    checkLive()
    this.toolNames = new Set(definitions.map(t => `genio_${t.name}`))
    const thread = await rpc.request(this.sessionId ? 'thread/resume' : 'thread/start', {
      ...(this.sessionId ? { threadId: this.sessionId } : {}),
      model: wanted.model, modelProvider: 'openai', allowProviderModelFallback: false,
      cwd: this.options.cwd, approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only',
      environments: [], selectedCapabilityRoots: [], config: overrides,
      baseInstructions: this.options.instructions(),
      dynamicTools: definitions.map(t => ({ type: 'function', ...t, name: `genio_${t.name}`, deferLoading: false }))
    })
    checkLive()
    if (thread.model !== wanted.model || thread.modelProvider !== 'openai' || thread.sandbox?.type !== 'readOnly' ||
      thread.sandbox.networkAccess !== false || thread.approvalPolicy !== 'untrusted' || thread.approvalsReviewer !== 'user' || thread.reasoningEffort === 'ultra') {
      throw new Error('Codex did not honor chat confinement; route unavailable.')
    }
    this.sessionId = thread.thread.id
    this.events.onSessionId(this.sessionId!)
    this.notice = false
    const limits = await rpc.request('account/rateLimits/read', {})
    if (limits.rateLimits) this.notification('account/rateLimits/updated', limits)
  }
  private async pump(): Promise<void> {
    if (this.busy || this.paused || !this.pending.length) return
    this.busy = true
    this.current = this.pending.shift()!
    const turn = this.current
    try {
      await this.start()
      if (this.current !== turn || this.closed) return
      const wanted = this.options.config()
      const model = this.models.find(m => (m.model ?? m.id) === wanted.model && !m.hidden)
      if (!model) throw new Error(`Selected Codex model is unavailable. ${OPEN_ACCOUNTS}.`)
      if (turn.images?.length && !model.inputModalities?.includes('image')) throw new Error('This model does not support the attached images. Remove them or select an image-capable model.')
      this.events.onStart?.(turn)
      this.events.onActivity('thinking')
      this.submitted = true
      const text = this.carry ? `${this.carry}\n\nCurrent request:\n${turn.prompt}` : turn.prompt
      const result = await this.rpc!.request('turn/start', { threadId: this.sessionId,
        model: wanted.model, effort: codexEffort(model, wanted.effort),
        input: [{ type: 'text', text }, ...(turn.images ?? []).map(i => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` }))] })
      this.carry = undefined
      if (this.current === turn && !this.closed) this.turnId = result.turn.id
    } catch (error) { if (this.current === turn && !this.closed) this.fail((error as Error).message) }
  }
  private fail(reason: string): void {
    this.paused = true
    // Only a turn never submitted to the runtime can be queued for a deliberate retry.
    // Once started its mutations may have completed: never replay it automatically.
    const current = this.current
    this.finishMessages()
    if (current && !this.submitted) { this.pending.unshift(current); this.events.onRequeue?.(current) }
    else if (current) this.events.onTurnEnd(current, false, '', 0)
    this.current = undefined; this.busy = false
    this.events.onLimit?.({ restartRequired: true, provider: 'codex', reason })
    this.options.unavailable?.(reason)
    if (!this.notice) { this.notice = true; this.events.onError(`${reason} Execution paused; open ${settingsPath('accounts')} and restart to resume. No provider or paid fallback was used.`) }
    this.disconnect()
    this.events.onActivity('error', 'Codex unavailable — Accounts & keys')
  }
  private finishMessages(): string {
    let text = ''
    for (const m of this.messages.values()) {
      m.partial = false
      // a message with neither words nor tool calls leaves no empty bubble
      if (m.text.trim() || (m.tools ?? []).length) this.events.onMessage({ ...m }, true)
      if (m.text) text = m.text
    }
    this.messages.clear()
    return text
  }
  private message(id: string): ChatMessage {
    let m = this.messages.get(id)
    if (!m) {
      m = { id: `codex-${id}`, wksp: this.options.wksp, role: 'genio', text: '', ts: nowIso(), partial: true, tools: [] }
      this.messages.set(id, m)
    }
    return m
  }
  private notification(method: string, p: RpcValue): void {
    if (method === 'account/rateLimits/updated') {
      this.options.rateLimits?.(p)
      const limits = p.rateLimits
      if ([limits?.primary, limits?.secondary].some(w => w?.usedPercent >= 100)) this.fail('Codex plan limit reached.')
      return
    }
    if (method === 'account/updated' && !['chatgpt', 'chatgptAuthTokens'].includes(p.authMode)) { this.fail('Codex ChatGPT login is unavailable.'); return }
    if (p.threadId && p.threadId !== this.sessionId) return
    if (method === 'thread/tokenUsage/updated') {
      this.options.usage?.(this.sessionId!, p.tokenUsage)
      const usage = p.tokenUsage?.last
      if (usage) this.events.onUsage?.({ provider: 'codex', input: Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)),
        cached: usage.cachedInputTokens ?? 0, output: usage.outputTokens ?? 0, cashCost: 0 })
      return
    }
    if (!this.current || !this.submitted) return
    if (method === 'turn/started') this.turnId = p.turn.id
    if (method === 'item/agentMessage/delta') {
      const m = this.message(p.itemId); m.text += p.delta
      this.events.onDelta(m.id, p.delta)
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item
      if (item.type === 'agentMessage') {
        const m = this.message(item.id)
        if (typeof item.text === 'string') m.text = item.text
        if (m.text.trim()) this.events.onMessage({ ...m }, false)
      } else if (item.type === 'dynamicToolCall') {
        const m = this.message(item.id)
        m.tools = [{ id: item.id, name: item.tool, input: JSON.stringify(item.arguments ?? {}).slice(0, 2000),
          ...(method === 'item/completed' ? { result: JSON.stringify(item.contentItems ?? []).slice(0, 3000), isError: item.success === false } : {}) }]
        this.events.onMessage({ ...m }, false)
        this.events.onActivity('tool', item.tool)
      }
    }
    if (method === 'error') { this.fail(p.error?.message || 'Codex turn failed'); return }
    if (method === 'turn/completed') {
      if (p.turn.status !== 'completed') { this.fail(p.turn.error?.message || 'Codex turn interrupted or failed'); return }
      const text = this.finishMessages()
      this.calls.clear()
      const turn = this.current
      this.current = undefined; this.turnId = undefined; this.submitted = false; this.busy = false
      this.events.onTurnEnd(turn, true, text, 0)
      this.events.onActivity('idle')
      void this.pump()
    }
  }
  private async serverRequest(method: string, p: RpcValue): Promise<unknown> {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'decline' }
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
    if (method === 'mcpServer/elicitation/request') {
      // Only a boolean consent form from our own bridge may use the existing
      // permission UI. URL flows and unknown servers never acquire authority.
      const properties = p.requestedSchema?.properties
      if (!this.current || this.lifetime?.signal.aborted || p.threadId !== this.sessionId || p.serverName !== 'genio' ||
        p.mode !== 'form' || Object.keys(properties ?? {}).join() !== 'approved' || properties.approved.type !== 'boolean') {
        return { action: 'decline', content: null }
      }
      const allowed = this.options.approvalMode?.() === 'all' || await this.options.approve(String(p.message ?? 'Genio tool approval'))
      return allowed && !this.lifetime?.signal.aborted ? { action: 'accept', content: { approved: true } } : { action: 'decline', content: null }
    }
    if (method !== 'item/tool/call' || !this.current || !this.submitted || !this.turnId || !this.bridge || this.lifetime?.signal.aborted ||
      p.threadId !== this.sessionId || p.turnId !== this.turnId || p.namespace || !this.toolNames.has(p.tool)) {
      throw new Error('Native or unknown tool denied')
    }
    // Cache promises before execution: duplicate runtime requests never repeat a mutation.
    const key = `${p.threadId}:${p.turnId}:${p.callId}`
    let result = this.calls.get(key)
    // the player is steering: what started finishes, nothing new starts
    if (!result && this.yielding) throw new Error('The player interrupted this turn; no new tool call starts')
    if (!result) {
      result = this.bridge.call(p.tool.slice('genio_'.length), p.arguments).then(r => ({ success: !r.isError,
        contentItems: r.content.flatMap<{ type: string; text?: string; imageUrl?: string }>(c => c.type === 'text' ? [{ type: 'inputText', text: c.text ?? '' }] :
          c.type === 'image' ? [{ type: 'inputImage', imageUrl: `data:${c.mimeType};base64,${c.data}` }] : []) }))
      this.calls.set(key, result)
    }
    return result
  }
  private disconnect(): void {
    this.closed = true; this.generation++
    this.starting = undefined
    this.lifetime?.abort(); void this.bridge?.close(); this.bridge = undefined
    this.rpc?.close(); this.rpc = undefined
    this.turnId = undefined; this.submitted = false
  }
  async interrupt(): Promise<void> {
    // Cancel ends the active turn, never places it back on the queue.
    const item = this.current
    const wasPaused = this.paused
    this.current = undefined
    this.lifetime?.abort()
    try { if (this.rpc && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId }) }
    finally {
      this.finishMessages()
      this.disconnect(); this.busy = false; this.paused = wasPaused
      if (item) this.events.onTurnEnd(item, false, '', 0)
      this.events.onActivity('idle')
    }
  }
  yieldTurn(): Promise<void> {
    if (!this.current) return Promise.resolve()
    return this.yielding ??= this.yieldAtSafePoint(this.current).finally(() => { this.yielding = undefined })
  }
  /** Interrupt once the turn is running and its started tool calls are done: aborting the bridge mid-call could cut a mutation in half. */
  private async yieldAtSafePoint(turn: ChatTurn): Promise<void> {
    const since = Date.now()
    while (this.current === turn && !this.turnId && !this.closed && Date.now() - since < 30_000) await new Promise(r => setTimeout(r, 50))
    if (this.current !== turn) return
    await Promise.allSettled([...this.calls.values()])
    if (this.current === turn) await this.interrupt().catch(() => undefined)
  }
  resume(fresh = false): void {
    const interrupted = this.current
    this.finishMessages()
    this.disconnect(); this.current = undefined; this.busy = false; this.paused = false; this.notice = false
    if (interrupted) this.events.onTurnEnd(interrupted, false, '', 0)
    this.messages.clear(); this.calls.clear()
    if (fresh) this.sessionId = undefined
    this.events.onLimit?.(undefined)
    void this.pump()
  }
  stop(): void { this.disconnect(); this.pending = []; this.current = undefined; this.busy = false }
}
