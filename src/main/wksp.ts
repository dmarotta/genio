import { chatSettings, claudeStatus, globalMode, routineDelay, wakeBatchMs } from './usage-policy'
import { chatUsageLine } from '@shared/usage-mode'
import { SessionCostLedger, SessionQuotaPolicy } from './session-usage'
import { ProviderChatSession, type ProviderSessions } from './provider-chat-session'
import { chatRoute, type ChatProvider, type ChatDriverEvents } from './chat-driver'
import { CodexChatDriver } from './codex-chat-driver'
import { chatHandoff } from './chat-handoff'
import { chatRouteUnavailable, markChatRouteUnavailable } from './model-catalogue'
import { recordCodexChatUsage, recordCodexChatLimits } from './usage'
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
  Options, CanUseTool, PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, WkspInfo } from '@shared/types'
import { inventoryContextBlock, validateInventoryContext, type InventoryContext } from '@shared/inventory-context'
import { prepareInventoryContext } from './inventory-context'
import { bus } from './bus'
import { chatImageDir, loadChatImages, saveChatImages } from './chat-images'
import { attachedIdsNote } from './chat-imagegen'
import type { Home } from './home'
import { buildTools, type ToolRole } from './wksp-tools'
import { openChatToolBridge, closeChatToolBridges } from './chat-tool-bridge'
import { formatNotification } from './notify-format'
import {
  HELP_TEXT, afkPrompt, botContract, eventsPrompt, genioContract, recapPrompt, returnPrompt, savePrompt, sessionStartPrompt,
  statusPrompt
} from './prompts'
import { applyChatEvent, chatControls, compactChat, strandQueued } from '@shared/chat'
import type { AppCtx, WkspService } from './services'
import { claudeLimitsFile, recordClaudeRateLimit, type ClaudeRateLimitInfo } from './usage'
import { appendJsonl, nowIso, readJson, readJsonl, readText, rid, truncate, writeJson } from './util'

import { AgentSession, loadSdk, sessionConfig, inboundMessage, type TurnItem } from './claude-chat-driver'
export { AgentSession, sessionConfig, applyLiveConfig, inboundMessage, sendPlayerChat, userMessage, decideTool, isReadOnlyCommand } from './claude-chat-driver'
export type { SessionConfig, LiveControls, ToolDecision } from './claude-chat-driver'
import { DISALLOWED, enforceTool } from './chat-tool-policy'
const NOOP_RE = /^all clear[,!.]?(\s+[\w .'-]{0,40})?[.!]?$/i

// ------------------------------------------------------------------ service

interface WkspState {
  providers?: ProviderSessions
  botProviders?: ProviderSessions
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
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  let bootDone = false
  let stopped = false

  const settings = (): ReturnType<AppCtx['settings']['get']> => getCtx().settings.get()
  /** the ally record as saved now (its chat controls can change while the base runs) */
  const liveAlly = (): Ally | undefined => (ally ? (safeGet(() => getCtx().allies.list().find((a) => a.name === ally.name && !a.retiredAt)) ?? ally) : undefined)
  const gamertag = (): string => settings().gamertag || 'Player'

  const saveState = (): void => {
    writeJson(home.wkspFile, { providers: genio.state(), botProviders: bot?.state(), sessionId: genio.sessionId, botSessionId: bot?.sessionId, costUsd: info.costUsd, turns: info.turns } satisfies WkspState)
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

  async function buildOptions(role: ToolRole, resume?: string, config?: ReturnType<typeof claudeConfig>): Promise<Options> {
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
    const { model, effort } = config ?? claudeConfig()
    const usage = role === 'bot' ? '' : `\n\n${chatUsageLine(globalMode(s), claudeStatus(ctx.main.home.data))}`
    const opts: Options = {
      // settingSources is deliberately empty: inject the umbrella so skill discovery is not assumed.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: append + usage + (role === 'bot' || !ctx.appRoot ? '' : '\n\nAssets skill directory (resolve the following skill references relative to it): ' + path.join(unitPluginSource(ctx.appRoot), 'skills/assets') + '\n' + readText(path.join(unitPluginSource(ctx.appRoot), 'skills/assets/SKILL.md'))) },
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
    if (role === 'bot') {
      const bridge = await openChatToolBridge(getCtx, { home, role: 'bot', worlds: '*', signal: new AbortController().signal,
        hooks: { escalate: botEscalate } })
      opts.mcpServers = { genio: { command: process.execPath, args: [bridge.entry],
        env: { ...bridge.env, ELECTRON_RUN_AS_NODE: '1' } } }
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

  const selectedProvider = (): ChatProvider => chatRoute(chatControls(settings(), liveAlly()).model).provider
  const driverConfig = () => {
    const s = selectedProvider() === 'claude' ? chatSettings(settings(), getCtx().main.home.data) : settings()
    const controls = chatControls(s, liveAlly())
    return { model: chatRoute(controls.model).model, effort: controls.effort }
  }
  const claudeConfig = () => sessionConfig('genio', { ...settings(), wkspModel: driverConfig().model ?? '', wkspEffort: driverConfig().effort })
  function handoffContext(excludeMessageId?: string): string {
    const ctx = getCtx(), hc = ctx.home(name)
    return chatHandoff({ messages: loadHistory().filter(m => m.id !== excludeMessageId), projects: ctx.projects.list(), tasks: hc.crew.list(),
      decisions: hc.decisions.list(true), permissions: chatControls(settings(), liveAlly()).shellMode })
  }
  function providerChanged(from: ChatProvider, to: ChatProvider): void {
    say(`Provider changed: ${from} to ${to}. Shared a bounded handoff; existing provider sessions are retained.`, 'system')
    safe(() => getCtx().stats.unlock('chat-provider-switch'))
    saveState()
  }
  function createDriver(provider: ChatProvider, role: ToolRole, events: ChatDriverEvents, config: () => { model?: string; effort?: string }) {
    const claudeTurnConfig = () => sessionConfig('genio', { ...settings(), wkspModel: config().model ?? '', wkspEffort: config().effort ?? '' })
    if (provider === 'claude') return new AgentSession(role, resume => buildOptions(role, resume, claudeTurnConfig()),
      { ...events, onRateLimit: rateLimit }, name, claudeTurnConfig, quotaPolicy, costs)
    return new CodexChatDriver({
      wksp: name, cwd: home.root,
      config: () => ({ model: config().model!, effort: config().effort }),
      instructions: () => (role === 'bot' ? botContract(gamertag()) + '\n\n' : '') + genioContract({ gamertag: gamertag(), base: name,
        isAlly: !home.isMain, charter: liveAlly()?.charter, scope: liveAlly()?.scope }) +
        '\nUse only genio_ tools. Native shell, edits, agents and plugins are unavailable. Never replay completed mutations from a handoff.',
      async bridge(signal) {
        const bridge = await openChatToolBridge(getCtx, { home, role: role === 'bot' ? 'bot' : home.isMain ? 'genio' : 'ally',
          worlds: home.isMain ? '*' : liveAlly()?.projects ?? [], signal, hooks: { escalate: botEscalate } })
        let id = 0
        const request = async (method: string, params?: unknown) => {
          const response = await fetch(bridge.env.GENIO_BRIDGE_URL, { method: 'POST', signal,
            headers: { Authorization: `Bearer ${bridge.env.GENIO_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
          if (!response.ok) throw new Error('Genio bridge unavailable; request was not retried')
          const reply = await response.json()
          if (reply.error) throw new Error('Genio bridge request failed')
          return reply.result
        }
        return { list: async () => (await request('tools/list')).tools,
          call: (tool, args) => request('tools/call', { name: tool, arguments: args }), close: bridge.close }
      },
      approvalMode: () => chatControls(settings(), liveAlly()).shellMode,
      approve: text => getCtx().permissions.ask({ wksp: name, tool: 'Codex', input: text }),
      usage: (thread, usage) => recordCodexChatUsage(getCtx().main.home.data, home.root, thread, usage),
      rateLimits: limits => recordCodexChatLimits(getCtx().main.home.data, limits),
      unavailable: reason => markChatRouteUnavailable('codex', reason)
    }, events)
  }

  // ---------------------------------------------------------- sessions

  const quotaPolicy = (): SessionQuotaPolicy => new SessionQuotaPolicy(getCtx().main.home.data)
  const costs = new SessionCostLedger(path.join(home.data, 'usage', 'session-costs.json'))

  // plan limits are per account: every base records into the main base (Systems → Accounts)
  const rateLimit = (rl: ClaudeRateLimitInfo): void => {
    recordClaudeRateLimit(claudeLimitsFile(getCtx().main.home.data), rl)
    quotaPolicy().observe(rl)
  }

  const genio = new ProviderChatSession({
    selection: selectedProvider,
    config: driverConfig,
    create: (provider, events, config) => createDriver(provider, 'genio', events, config),
    persisted: persisted.providers, handoff: handoffContext, switched: providerChanged,
    events: {
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
        if (ok) {
          info.lastError = undefined
          if (genio.currentProvider === 'codex') safe(() => getCtx().stats.unlock('codex-chat-turn'))
          else quotaPolicy().succeeded(name + ':genio')
        }
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
        if (genio.currentProvider === 'claude') {
          quotaPolicy().rejectError(text)
          if (!quotaPolicy().notice(name + ':genio', text)) return
        }
        info.lastError = text
        say(text, 'error')
        bus.publish({ type: 'sfx', sound: 'error' })
      },
    }
  })
  genio.sessionId = persisted.sessionId

  let bot: ProviderChatSession | undefined
  const botFile = `${home.data}/bot.jsonl`
  if (home.isMain) {
    bot = new ProviderChatSession({
      selection: selectedProvider,
    config: driverConfig,
      create: (provider, events, config) => createDriver(provider, 'bot', events, config),
      persisted: persisted.botProviders, handoff: handoffContext, switched: () => {},
      events: {
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
          if (ok && bot?.currentProvider === 'claude') quotaPolicy().succeeded(name + ':bot')
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
          if (bot?.currentProvider === 'claude') {
            quotaPolicy().rejectError(text)
            if (!quotaPolicy().notice(name + ':bot', text)) return
          }
          appendJsonl(botFile, { ts: nowIso(), error: text })
          if (getCtx().away.state().mode === 'afk') safe(() => getCtx().away.capture({ wksp: name, text: `The Bot hit a problem: ${text}`, severity: 'failure', target: { view: 'comms', wksp: name } }))
        },
        onLimit(limit) {
          info.botLimit = limit
          publishInfo()
        }
      }
    })
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
    const unavailable = chatRouteUnavailable(selectedProvider())
    if (unavailable) throw new Error(`${unavailable} Open Accounts and refresh before sending. Your draft has been kept.`)
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
    m.provider = selectedProvider()
    m.providerModel = chatRoute(chatControls(settings(), liveAlly()).model).model
    if (stored.refs.length) m.images = stored.refs
    if (prepared.context) m.context = prepared.context
    const player = origin === 'player'
    // mid-turn: the message waits in the log as queued until the session picks it up
    if (player) m.queue = 'queued'
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
      if (selectedProvider() === 'claude' && !quotaPolicy().canStart(false, Date.now(), false)) return
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
        // routine-only batches wait for the Usage mode's batching window; anything urgent goes now
        const hold = routineDelay(pend, wakeBatchMs(settings()))
        if (hold > 0) {
          clearTimeout(batchTimer)
          batchTimer = setTimeout(() => svc.deliverWakes(), hold + 50)
          return
        }
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
