/**
 * Design chats: several conversations per project base, each a thinking partner for the player's game design.
 * A design chat asks, challenges and offers options; it starts no work and spends nothing (tool role 'design',
 * DESIGN_TOOLS in chat-tool-session.ts; designContract in prompts.ts). It has no Bot, no events, no wakes and
 * no overwatch: its only turns are the player's messages, so an idle design chat costs nothing.
 *
 *   state/design-chats.json   the index: id, title (from the first message), model, effort, provider sessions
 *   data/design/<id>.jsonl    one transcript per chat, never mixed with the project chat's
 *
 * Each open conversation is one ProviderChatSession over the same drivers, homes, quota gate and cost
 * records as the project chat; the log, queue, steering and images come from chat-thread.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, DesignChatInfo, WkspActivity, WkspInfo } from '@shared/types'
import type { ChatImageInput } from '@shared/chat-images'
import { validateInventoryContext, inventoryContextBlock, type InventoryContext } from '@shared/inventory-context'
import { chatControls, type SendNowResult, type UnqueuedChat } from '@shared/chat'
import { chatUsageLine } from '@shared/usage-mode'
import { settingsPath } from '@shared/settings-pages'
import type { AppCtx } from './services'
import type { Home } from './home'
import { bus } from './bus'
import { chatSettings, claudeStatus, globalMode } from './usage-policy'
import { SessionCostLedger, SessionQuotaPolicy } from './session-usage'
import { ProviderChatSession, type ProviderSessions } from './provider-chat-session'
import { chatRoute, type ChatDriverEvents, type ChatProvider } from './chat-driver'
import { CodexChatDriver } from './codex-chat-driver'
import { AgentSession, loadSdk, sessionConfig, type TurnItem } from './claude-chat-driver'
import { chatHandoff } from './chat-handoff'
import { chatRouteUnavailable, markChatRouteUnavailable } from './model-catalogue'
import { claudeLimitsFile, recordClaudeRateLimit, recordCodexChatLimits, recordCodexChatUsage, type ClaudeRateLimitInfo } from './usage'
import { claudeLaunch } from './claude-home'
import { codexLaunch } from './codex-home'
import { buildTools } from './wksp-tools'
import { closeChatToolBridges, openCodexBridge } from './chat-tool-bridge'
import { DESIGN_NATIVE, DISALLOWED, enforceTool } from './chat-tool-policy'
import { chatImageDir, saveChatImages } from './chat-images'
import { attachedIdsNote } from './chat-imagegen'
import { createChatThread, type ChatThread, type ShownMessage } from './chat-thread'
import { prepareInventoryContext } from './inventory-context'
import { designContract } from './prompts'
import { nowIso, readJson, rid, writeJsonAtomic } from './util'

export interface DesignChatService {
  list(): DesignChatInfo[]
  /** a new, empty chat; its model and effort default to the project chat's */
  create(controls?: { model?: string; effort?: string }): DesignChatInfo
  /** stops the chat and deletes its transcript */
  remove(id: string): Promise<void>
  /** this chat's own model and effort ('' follows the project chat) */
  configure(id: string, controls: { model?: string; effort?: string }): DesignChatInfo
  history(id: string, limit?: number): ChatMessage[]
  send(id: string, text: string, images?: ChatImageInput[], context?: InventoryContext): Promise<void>
  steer(id: string, text: string, images?: ChatImageInput[], context?: InventoryContext): Promise<void>
  sendNow(id: string, messageId: string): SendNowResult
  unqueue(id: string, messageId: string): UnqueuedChat | null
  interrupt(id: string): Promise<void>
  restart(id: string, fresh: boolean): Promise<void>
  /** a tool's card for this chat (a generate_image result), shown and kept in its transcript */
  post(id: string, m: ChatMessage): void
  stop(): Promise<void>
}

interface DesignRecord {
  id: string
  title: string
  createdAt: string
  model: string
  effort: string
  providers?: ProviderSessions
  costUsd: number
  turns: number
}

interface Runtime {
  rec: DesignRecord
  thread: ChatThread
  session: ProviderChatSession
  activity: WkspActivity
  limit?: WkspInfo['limit']
  lastError?: string
}

const ID_RE = /^d-[0-9a-f]{8}$/
const TITLE_CHARS = 60

/** The chat's title: the first line of the player's first message, shortened. */
export function designTitle(text: string): string {
  const line = text.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line
}

export function createDesignChatService(getCtx: () => AppCtx, home: Home, ally?: Ally, isOpen: () => boolean = () => true): DesignChatService {
  const name = home.name
  const indexFile = path.join(home.state, 'design-chats.json')
  const dir = path.join(home.data, 'design')
  const imageDir = chatImageDir(home.data)
  const records: DesignRecord[] = readJson<{ chats?: DesignRecord[] }>(indexFile, {}).chats?.filter(c => ID_RE.test(c?.id ?? '')) ?? []
  const open = new Map<string, Runtime>()

  const settings = (): ReturnType<AppCtx['settings']['get']> => getCtx().settings.get()
  const liveAlly = (): Ally | undefined => (ally ? (safeGet(() => getCtx().allies.list().find(a => a.name === ally.name && !a.retiredAt)) ?? ally) : undefined)
  const gamertag = (): string => settings().gamertag || 'Player'
  const projects = (): string[] => liveAlly()?.projects ?? []
  const chatCwd = (): string => {
    const world = projects()[0]
    return (world && getCtx().projects.get(world)?.path) || home.root
  }
  const quotaPolicy = (): SessionQuotaPolicy => new SessionQuotaPolicy(getCtx().main.home.data)
  const costs = new SessionCostLedger(path.join(home.data, 'usage', 'session-costs.json'))
  // plan limits are per account: every chat records into the main base
  const rateLimit = (rl: ClaudeRateLimitInfo): void => {
    recordClaudeRateLimit(claudeLimitsFile(getCtx().main.home.data), rl)
    quotaPolicy().observe(rl)
  }

  const save = (): void => {
    for (const rt of open.values()) rt.rec.providers = rt.session.state()
    writeJsonAtomic(indexFile, { chats: records })
  }
  const info = (rec: DesignRecord): DesignChatInfo => {
    const rt = open.get(rec.id)
    return { id: rec.id, title: rec.title, createdAt: rec.createdAt, model: rec.model, effort: rec.effort,
      activity: rt?.activity ?? 'offline', queued: rt ? rt.session.queued + rt.thread.preparing.size : 0,
      ...(rt && rt.session.busy && !rt.limit ? { steerable: true } : {}),
      ...(rt?.limit ? { limit: rt.limit } : {}), ...(rt?.lastError ? { lastError: rt.lastError } : {}),
      costUsd: rec.costUsd, turns: rec.turns }
  }
  const publish = (): void => bus.publish({ type: 'design-chats', wksp: name, chats: svc.list() })
  const find = (id: string): DesignRecord => {
    const rec = typeof id === 'string' && ID_RE.test(id) ? records.find(r => r.id === id) : undefined
    if (!rec) throw new Error('That Lore chat no longer exists.')
    return rec
  }

  /** This chat's model value, or the project chat's when it has none. */
  const chosen = (rec: DesignRecord): string => rec.model || chatControls(settings(), liveAlly()).model
  const selection = (rec: DesignRecord): ChatProvider => chatRoute(chosen(rec)).provider
  const driverConfig = (rec: DesignRecord) => {
    const s = !rec.model && selection(rec) === 'claude' ? chatSettings(settings(), getCtx().main.home.data) : settings()
    const controls = chatControls(s, liveAlly())
    return { model: chatRoute(rec.model || controls.model).model, effort: rec.effort || controls.effort }
  }
  const quotaHold = (provider: ChatProvider, item: TurnItem): WkspInfo['limit'] =>
    provider === 'claude' && !quotaPolicy().canStartTurn(item.kind, Date.now(), false) ? quotaPolicy().limitState() : undefined
  const handoff = (rt: Runtime, excludeMessageId?: string): string => chatHandoff({
    messages: rt.thread.load().filter(m => m.id !== excludeMessageId),
    projects: getCtx().projects.list().filter(p => projects().includes(p.name)), tasks: [], decisions: [], permissions: 'ask'
  })
  const usage = (): string => chatUsageLine(globalMode(settings()), claudeStatus(getCtx().main.home.data))

  // ---------------------------------------------------------- drivers

  function policy(rt: Runtime): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      // a turn the player is steering away from starts nothing new; what already runs finishes
      if (rt.thread.steering) return { behavior: 'deny', message: `${gamertag()} interrupted this turn with a new message. Do not start anything else; stop here.` }
      const d = await enforceTool({ role: 'design', chat: name, shellMode: () => 'ask', permissions: getCtx().permissions, player: gamertag() },
        { runtime: 'claude', name: toolName, input })
      return d.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : d
    }
  }

  async function claudeOptions(rt: Runtime, resume: string | undefined, config: { model?: string; effort?: Options['effort'] }): Promise<Options> {
    const sdk = await loadSdk()
    const s = settings()
    const tools = buildTools(sdk.tool, getCtx, home, 'design', { conversation: rt.rec.id }, home.isMain ? undefined : projects())
    const opts: Options = {
      // The design prompt is the whole system prompt: no coding preset, no orchestrator contract.
      systemPrompt: designContract({ gamertag: gamertag(), project: projects()[0] ?? name }, usage()),
      cwd: chatCwd(),
      additionalDirectories: getCtx().projects.list().filter(p => projects().includes(p.name)).map(p => p.path),
      settingSources: [],
      includePartialMessages: true,
      tools: [...DESIGN_NATIVE],
      mcpServers: { genio: sdk.createSdkMcpServer({ name: 'genio', version: '1.0.0', tools, alwaysLoad: true }) },
      disallowedTools: [...DISALLOWED, 'Bash', 'PowerShell'],
      canUseTool: policy(rt),
      permissionMode: 'default',
      model: config.model,
      effort: config.effort,
      resume,
      // Genio's own Claude home; a resumed conversation stays in the home that holds it.
      env: { ...process.env, ...(await claudeLaunch(resume ? { sessionId: resume } : undefined)).env,
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_AGENT_SDK_CLIENT_APP: 'genio/0.1.0' }
    }
    if (s.claudePath?.trim()) opts.pathToClaudeCodeExecutable = s.claudePath.trim()
    return opts
  }

  function createDriver(rt: Runtime, provider: ChatProvider, events: ChatDriverEvents, config: () => { model?: string; effort?: string }) {
    const claudeConfig = () => sessionConfig('design', { ...settings(), wkspModel: config().model ?? '', wkspEffort: config().effort ?? '' })
    if (provider === 'claude') return new AgentSession(`design-${rt.rec.id}`, resume => claudeOptions(rt, resume, claudeConfig()),
      { ...events, onRateLimit: rateLimit }, name, claudeConfig, quotaPolicy, costs)
    return new CodexChatDriver({
      wksp: name, cwd: chatCwd(),
      // Genio's own Codex home keeps the chat thread out of the player's Codex app.
      home: async () => {
        const launch = await codexLaunch()
        return { env: launch.env, codexHome: launch.codexHome }
      },
      handoff: () => handoff(rt),
      config: () => ({ model: config().model!, effort: config().effort }),
      // Replaces Codex's base instructions entirely.
      instructions: () => designContract({ gamertag: gamertag(), project: projects()[0] ?? name },
        `${chatUsageLine(globalMode(settings()))}\nUse only genio_ tools. Native shell, edits, agents and plugins are unavailable.`),
      bridge: signal => openCodexBridge(getCtx, { home, role: 'design', worlds: home.isMain ? '*' : projects(), signal, hooks: { conversation: rt.rec.id } }),
      // design tools never ask for consent: any runtime elicitation is declined
      approvalMode: () => 'ask',
      approve: async () => false,
      usage: (thread, u) => recordCodexChatUsage(getCtx().main.home.data, home.root, thread, u),
      rateLimits: limits => recordCodexChatLimits(getCtx().main.home.data, limits),
      unavailable: reason => markChatRouteUnavailable('codex', reason)
    }, events)
  }

  // ---------------------------------------------------------- conversations

  function runtime(id: string): Runtime {
    const existing = open.get(id)
    if (existing) return existing
    const rec = find(id)
    const rt = { rec, activity: 'offline' } as Runtime
    rt.thread = createChatThread({
      wksp: name, file: path.join(dir, `${rec.id}.jsonl`), imageDir, reader: 'The Lore chat',
      session: () => rt.session,
      publish: m => bus.publish({ type: 'design-chat', wksp: name, conversation: rec.id, message: m }),
      changed: publish,
      canSteer: () => rt.session.busy && !rt.limit,
      steerNote: () => {
        const tool = rt.session.yieldWait()
        if (tool) return `The Lore chat stops as soon as ${tool} finishes, then reads it first.`
        if (rt.limit) return 'The Lore chat cannot take a turn right now (see the limit notice); it is read first when it resumes.'
        return undefined
      },
      route: () => ({ provider: selection(rec), model: chatRoute(chosen(rec)).model })
    })
    const key = `${name}:design:${rec.id}`
    rt.session = new ProviderChatSession({
      hold: quotaHold,
      selection: () => selection(rec),
      config: () => driverConfig(rec),
      create: (provider, events, config) => createDriver(rt, provider, events, config),
      persisted: rec.providers,
      handoff: exclude => handoff(rt, exclude),
      // a provider switch hands off within this chat only
      switched: (from, to) => {
        void closeChatToolBridges(getCtx(), name, { conversation: rec.id })
        rt.thread.say(`Provider changed: ${from} to ${to}. Shared a bounded handoff of this chat.`, 'system')
        save()
      },
      events: {
        onStart: item => rt.thread.delivered(item),
        onRequeue: rt.thread.requeued,
        onLimit(limit) {
          rt.limit = limit
          rt.lastError = undefined
          publish()
        },
        onMessage: (m, final) => rt.thread.record(m, final),
        onDelta: (mid, text) => bus.publish({ type: 'design-chat-delta', wksp: name, conversation: rec.id, id: mid, text }),
        onActivity(a) {
          rt.activity = a
          publish()
        },
        onTurnEnd(_item, ok, lastText, cost) {
          const interrupted = !!rt.thread.steering && !ok
          rt.thread.steering = undefined
          if (interrupted) rt.thread.say('Interrupted by your message.', 'system')
          if (ok) {
            rt.lastError = undefined
            if (rt.session.currentProvider === 'claude') quotaPolicy().succeeded(key)
            if (lastText.trim()) safe(() => getCtx().stats.unlock('design-chat-reply'))
          }
          rec.turns++
          rec.costUsd += cost
          if (cost > 0) safe(() => getCtx().stats.addCost(cost))
          save()
          if (ok && lastText.trim()) bus.publish({ type: 'sfx', sound: 'blip' })
          publish()
        },
        onSessionId() {
          save()
        },
        onError(text) {
          if (rt.session.currentProvider === 'claude') {
            quotaPolicy().rejectError(text)
            if (!quotaPolicy().notice(key, text)) return
          }
          rt.lastError = text
          rt.thread.say(text, 'error')
          bus.publish({ type: 'sfx', sound: 'error' })
        }
      }
    })
    open.set(id, rt)
    return rt
  }

  const checkSend = (rec: DesignRecord): void => {
    if (!isOpen()) throw new Error('Open the project window before using its Lore chats.')
    const unavailable = chatRouteUnavailable(selection(rec))
    if (unavailable) throw new Error(`${unavailable} Open ${settingsPath('accounts')} and refresh before sending. Your draft has been kept.`)
  }

  const performSend = async (rt: Runtime, shown: ShownMessage, images: ChatImageInput[], context: InventoryContext | undefined): Promise<void> => {
    if (!isOpen()) return // closing: stop() shows it as not sent
    const { thread } = rt
    if (!thread.waiting(shown.m.id)) return // taken back for an edit or cancelled while it waited
    const ctx = getCtx()
    const prepared = await prepareInventoryContext(context, images, (world, asset) => ctx.inventory.thumbnail(world, asset), () => thread.load())
    if (!thread.waiting(shown.m.id)) return
    // the shown message stored its pasted images already; only the automatic preview is new
    const added = saveChatImages(imageDir, prepared.images.slice(shown.send.length))
    const stored = { refs: [...(shown.m.images ?? []), ...added.refs], send: [...shown.send, ...added.send] }
    if (prepared.context?.thumbnail?.status === 'attached') prepared.context.thumbnail.image = stored.refs.at(-1)
    const m: ChatMessage = { ...thread.load().find(x => x.id === shown.m.id)! }
    const text = m.text
    // a chat that lost its provider session continues from its own visible transcript
    let prompt = !rt.session.sessionId && thread.load().some(x => !x.queue && !x.shell) ? `${handoff(rt, m.id)}\n\nCurrent request:\n${text}` : text
    if (stored.refs.length) m.images = stored.refs
    if (prepared.context) m.context = prepared.context
    thread.preparing.delete(m.id)
    thread.record(m, true)
    // the ids let the chat pass pasted images to generate_image as refs
    prompt += inventoryContextBlock(m.context) + attachedIdsNote(stored.refs)
    thread.enqueue({ kind: 'player', prompt, images: stored.send.length ? stored.send : undefined, msgId: m.id })
    publish()
  }

  const submit = (id: string, text: string, images: ChatImageInput[], context: InventoryContext | undefined, steer: boolean): Promise<void> => {
    let rt: Runtime, shown: ShownMessage
    let snapshot: InventoryContext | undefined
    try {
      const rec = find(id)
      checkSend(rec)
      if (!text.trim() && !images.length) return Promise.resolve()
      rt = runtime(id)
      snapshot = context && validateInventoryContext(context)
      shown = rt.thread.showQueued(text.trim(), images, snapshot)
      if (steer) rt.thread.steerIds.add(shown.m.id)
      if (!rec.title && text.trim()) {
        rec.title = designTitle(text)
        save()
        publish()
      }
    } catch (e) {
      return Promise.reject(e)
    }
    return rt.thread.serial(shown, () => performSend(rt, shown, images, snapshot))
  }

  const stopRuntime = async (rt: Runtime): Promise<void> => {
    await closeChatToolBridges(getCtx(), name, { conversation: rt.rec.id })
    rt.session.stop()
    rt.thread.strandWaiting()
    rt.activity = 'offline'
  }

  const svc: DesignChatService = {
    list: () => records.map(info),
    create(controls = {}) {
      const rec: DesignRecord = { id: `d-${rid(4)}`, title: '', createdAt: nowIso(), model: controls.model?.trim() ?? '',
        effort: controls.effort?.trim() ?? '', costUsd: 0, turns: 0 }
      records.push(rec)
      save()
      publish()
      return info(rec)
    },
    async remove(id) {
      const rec = find(id)
      const rt = open.get(id)
      if (rt) await stopRuntime(rt)
      open.delete(id)
      records.splice(records.indexOf(rec), 1)
      fs.rmSync(path.join(dir, `${rec.id}.jsonl`), { force: true })
      save()
      publish()
    },
    configure(id, controls) {
      const rec = find(id)
      if (controls.model !== undefined) rec.model = controls.model.trim()
      if (controls.effort !== undefined) rec.effort = controls.effort.trim()
      save()
      publish()
      return info(rec)
    },
    history: (id, limit = 200) => runtime(id).thread.load().slice(-limit),
    send: (id, text, images = [], context) => submit(id, text, images, context, false),
    steer: (id, text, images = [], context) => submit(id, text, images, context, true),
    sendNow: (id, messageId) => runtime(id).thread.sendNow(messageId),
    unqueue: (id, messageId) => runtime(id).thread.unqueue(messageId),
    async interrupt(id) {
      await runtime(id).session.interrupt()
    },
    async restart(id, fresh) {
      if (!isOpen()) throw new Error('Open the project window before using its Lore chats.')
      const rt = runtime(id)
      await closeChatToolBridges(getCtx(), name, { conversation: id })
      rt.session.restart(fresh)
      rt.lastError = undefined
      save()
      publish()
    },
    post(id, m) {
      if (!records.some(r => r.id === id)) return
      runtime(id).thread.record({ ...m, wksp: name }, true)
    },
    async stop() {
      for (const rt of open.values()) await stopRuntime(rt)
      if (open.size) save()
    }
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
