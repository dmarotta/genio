import { ASSISTANT_NAME } from '@shared/assistant'
import { chatSettings, claudeStatus, globalMode, routineDelay, wakeBatchMs } from './usage-policy'
import { chatUsageLine } from '@shared/usage-mode'
import { SessionCostLedger, SessionQuotaPolicy } from './session-usage'
import { ProviderChatSession, type ProviderSessions } from './provider-chat-session'
import { chatRoute, type ChatProvider, type ChatDriverEvents } from './chat-driver'
import { CodexChatDriver } from './codex-chat-driver'
import { chatHandoff } from './chat-handoff'
import { chatRouteUnavailable, markChatRouteUnavailable } from './model-catalogue'
import { recordCodexChatUsage, recordCodexChatLimits } from './usage'
import { refreshClaudePlanUsage } from './claude-usage-probe'
import { claudeLaunch } from './claude-home'
import { codexLaunch } from './codex-home'
import { settingsPath } from '@shared/settings-pages'
/**
 * Genio agent sessions (companion's primary harness session, in-process).
 *
 * Each base has one WkspService. It owns:
 *   - the Genio session: a Claude Agent SDK query() in streaming-input mode,
 *     started lazily so an idle base spends zero tokens;
 *   - the project Bot session: Genio's away supervisor that handles
 *     events while the player is DND/AFK and escalates what they must see.
 * Overwatch supplies compact batches. Per-event tool acknowledgements survive
 * failed turns; successful completion also acknowledges the delivered batch.
 */
import path from 'node:path'
import type {
  Options, CanUseTool, PermissionResult
} from '@anthropic-ai/claude-agent-sdk'
import type { Ally, ChatMessage, WkspInfo, MessageActions, ShellRun } from '@shared/types'
import { SHELL_CONTEXT_RUNS, shellContextBlock, shellSummary } from '@shared/terminal-pane'
import { hasInventoryChips, inventoryContextBlock, validateInventoryContext, type InventoryContext } from '@shared/inventory-context'
import type { ChatImageInput } from '@shared/chat-images'
import { prepareInventoryContext } from './inventory-context'
import { bus } from './bus'
import { chatImageDir, saveChatImages } from './chat-images'
import { attachedIdsNote } from './chat-imagegen'
import { createChatThread, type ShownMessage } from './chat-thread'
import { noteStandingWords } from './standing-approvals'
import type { Home } from './home'
import { buildTools, type ToolHooks, type ToolRole } from './wksp-tools'
import { openChatToolBridge, openCodexBridge, closeChatToolBridges } from './chat-tool-bridge'
import { formatNotification } from './notify-format'
import {
  HELP_TEXT, afkPrompt, customContract, eventsPrompt, recapPrompt, returnPrompt, savePrompt, sessionStartPrompt,
  statusPrompt, projectOpenPrompt
} from './prompts'
import { chatControls } from '@shared/chat'
import type { AppCtx, WkspService } from './services'
import { claudeLimitsFile, recordClaudeRateLimit, type ClaudeRateLimitInfo } from './usage'
import { appendJsonl, nowIso, readJson, rid, writeJson } from './util'

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

export function createWkspService(getCtx: () => AppCtx, home: Home, ally?: Ally, readOnly = false, isOpen: () => boolean = () => true): WkspService {
  const name = home.name
  const persisted = readJson<WkspState>(home.wkspFile, {})
  const info: WkspInfo = {
    name,
    displayName: ASSISTANT_NAME,
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
  let eventsBackoffUntil = 0
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  let bootDone = false
  let stopped = false
  let projectOpening = false
  let projectRecap: string | undefined
  let projectReady: Promise<void> | undefined
  let finishProjectOpen: (() => void) | undefined

  const settings = (): ReturnType<AppCtx['settings']['get']> => getCtx().settings.get()
  /** the ally record as saved now (its chat controls can change while the base runs) */
  const liveAlly = (): Ally | undefined => (ally ? (safeGet(() => getCtx().allies.list().find((a) => a.name === ally.name && !a.retiredAt)) ?? ally) : undefined)
  const gamertag = (): string => settings().gamertag || 'Player'
  const chatCwd = (): string => {
    const world = liveAlly()?.projects[0]
    return (world && getCtx().projects.get(world)?.path) || home.root
  }

  const saveState = (): void => {
    if (readOnly) return
    writeJson(home.wkspFile, { providers: genio.state(), botProviders: bot?.state(), sessionId: genio.sessionId, botSessionId: bot?.sessionId, costUsd: info.costUsd, turns: info.turns } satisfies WkspState)
  }
  const publishInfo = (): void => {
    info.queued = genio.queued + (bot?.queued ?? 0) + preparing.size
    info.steerable = canSteer()
    info.sessionId = genio.sessionId
    bus.publish({ type: 'wksp', wksp: { ...info } })
  }

  const archived = 'The main chat is archived. Open the Genio project to continue.'
  const thread = createChatThread({
    wksp: name, file: home.chatFile, imageDir: chatImageDir(home.data), readOnly, reader: ASSISTANT_NAME,
    session: () => genio,
    publish: m => bus.publish({ type: 'chat', message: m }),
    changed: () => publishInfo(),
    canSteer: () => canSteer(),
    steerNote: () => steerNote(),
    route: () => ({ provider: selectedProvider(), model: chatRoute(chatControls(settings(), liveAlly()).model).model }),
    // "keep merging everything" / "stop merging": a standing merge approval starts or ends once the session reads it
    sent: m => {
      try {
        const receipt = noteStandingWords(getCtx(), home, m)
        if (receipt) say(receipt, 'system')
      } catch { /* never blocks the message */ }
    },
    refused: () => (readOnly ? archived : undefined)
  })
  const loadHistory = thread.load
  const record = thread.record
  const say = thread.say

  /**
   * What the visible Genio turn in progress started, from its tool calls (deploy, control, quests, merge,
   * choices, settings). Every final message of the turn carries it, so a reaction covers exactly that.
   */
  let turnActions: MessageActions = {}
  const recordAction = (kind: keyof MessageActions, id: string): void => {
    const ids = turnActions[kind] ?? []
    if (!ids.includes(id)) turnActions = { ...turnActions, [kind]: [...ids, id] }
  }
  const hasActions = (): boolean => Object.values(turnActions).some(v => v?.length)

  /** the context line the turn after an interrupted one starts with */
  let interruptedNote: string | undefined

  /** The player's '!' runs since their last message: read, labelled as their own shell output, with the next one. */
  let shellRuns: ShellRun[] = []

  const { preparing, steerIds, waiting, markSent, delivered, strandWaiting } = thread

  // ---------------------------------------------------------- options

  async function buildOptions(role: ToolRole, resume?: string, config?: ReturnType<typeof claudeConfig>): Promise<Options> {
    const ctx = getCtx()
    const sdk = await loadSdk()
    const s = settings()
    const toolDefs = buildTools(sdk.tool, getCtx, home, role, toolHooks(role), home.isMain || role === 'bot' ? undefined : liveAlly()?.projects ?? [])
    const server = sdk.createSdkMcpServer({ name: 'genio', version: '1.0.0', tools: toolDefs, alwaysLoad: true })
    const worlds = ctx.projects.list().filter(p => liveAlly()?.projects.includes(p.name)).map((p) => p.path)
    const { model, effort } = config ?? claudeConfig()
    const usage = role === 'bot' ? '' : `\n\n${chatUsageLine(globalMode(s), claudeStatus(ctx.main.home.data))}`
    const opts: Options = {
      // Load only the bounded rules. Skills, charter and versioned memory are tools.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: customContract({ gamertag: gamertag(), base: name, isAlly: !home.isMain }, role === 'bot', usage) },
      cwd: chatCwd(),
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
      // Genio's own Claude home; a resumed conversation stays in the home that holds it.
      env: { ...process.env, ...(await claudeLaunch(resume ? { sessionId: resume } : undefined)).env,
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_AGENT_SDK_CLIENT_APP: 'genio/0.1.0' }
    }
    if (role === 'bot') {
      opts.tools = [] // All Bot tools, for either provider, go through the guarded bridge.
      const bridge = await openChatToolBridge(getCtx, { home, role: 'bot', worlds: home.isMain ? '*' : liveAlly()?.projects ?? [], signal: new AbortController().signal,
        hooks: toolHooks('bot') })
      opts.mcpServers = { genio: { command: process.execPath, args: [bridge.entry],
        env: { ...bridge.env, ELECTRON_RUN_AS_NODE: '1' } } }
    }
    if (s.claudePath?.trim()) opts.pathToClaudeCodeExecutable = s.claudePath.trim()
    return opts
  }

  /** The Bot's turns are off-screen: only the visible chat records what its turn started. */
  function toolHooks(role: ToolRole): ToolHooks {
    return { escalate: botEscalate, ...(role === 'bot' ? {} : { action: recordAction }) }
  }

  function makePolicy(role: ToolRole): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      // a turn the player is steering away from starts nothing new; what already runs finishes
      if (role !== 'bot' && thread.steering) return { behavior: 'deny', message: `${gamertag()} interrupted this turn with a new message. Do not start anything else; stop here.` }
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
    return chatHandoff({ messages: loadHistory().filter(m => m.id !== excludeMessageId), projects: ctx.projects.list().filter(p => home.isMain || liveAlly()?.projects.includes(p.name)), tasks: hc.crew.list(),
      decisions: hc.decisions.list(true), permissions: chatControls(settings(), liveAlly()).shellMode })
  }
  function providerChanged(from: ChatProvider, to: ChatProvider): void {
    void closeChatToolBridges(getCtx(), name, 'genio')
    say(`Provider changed: ${from} to ${to}. Shared a bounded handoff; existing provider sessions are retained.`, 'system')
    safe(() => getCtx().stats.unlock('chat-provider-switch'))
    saveState()
  }
  function createDriver(provider: ChatProvider, role: ToolRole, events: ChatDriverEvents, config: () => { model?: string; effort?: string }) {
    const preparedEvents: ChatDriverEvents = { ...events, onStart(item) {
      // Drivers may retain a failed/limited turn for an explicit retry. Refresh
      // its event body at submission so durable per-event acks also apply there.
      if (item.kind === 'events' && (item.ackThrough !== undefined || item.prompt.includes('[GENIO PROJECT OPEN]'))) {
        const drain = getCtx().home(name).wakes.drain()
        const opening = item.prompt.indexOf('[GENIO PROJECT OPEN]')
        const boot = item.prompt.indexOf('[GENIO SESSION START]')
        const marker = opening >= 0 ? opening : boot >= 0 ? boot : item.prompt.indexOf('[GENIO EVENTS]')
        const handoff = marker >= 0 ? item.prompt.slice(0, marker) : ''
        item.prompt = handoff + (opening >= 0 ? projectOpenPrompt(gamertag(), projectRecap ?? '', drain.text)
          : boot >= 0 ? `${sessionStartPrompt(gamertag())}\n\n${drain.text}` : eventsPrompt(drain.text))
        item.ackThrough = drain.count ? drain.ackThrough : undefined
      }
      events.onStart?.(item)
    } }
    const claudeTurnConfig = () => sessionConfig('genio', { ...settings(), wkspModel: config().model ?? '', wkspEffort: config().effort ?? '' })
    if (provider === 'claude') return new AgentSession(role, resume => buildOptions(role, resume, claudeTurnConfig()),
      { ...preparedEvents, onRateLimit: rateLimit }, name, claudeTurnConfig, quotaPolicy, costs)
    return new CodexChatDriver({
      wksp: name, cwd: chatCwd(),
      // Genio's own Codex home keeps the chat thread out of the player's Codex app.
      home: async () => {
        const launch = await codexLaunch()
        return { env: launch.env, codexHome: launch.codexHome }
      },
      handoff: () => handoffContext(),
      config: () => ({ model: config().model!, effort: config().effort }),
      instructions: () => customContract({ gamertag: gamertag(), base: name, isAlly: !home.isMain }, role === 'bot',
        `${chatUsageLine(globalMode(settings()))}\nUse only genio_ tools. Native shell, edits, agents and plugins are unavailable. Never replay completed mutations from a handoff.`),
      bridge: signal => openCodexBridge(getCtx, { home, role: role === 'bot' ? 'bot' : home.isMain ? 'genio' : 'ally',
        worlds: home.isMain ? '*' : liveAlly()?.projects ?? [], signal, hooks: toolHooks(role) }),
      approvalMode: () => chatControls(settings(), liveAlly()).shellMode,
      approve: text => getCtx().permissions.ask({ wksp: name, tool: 'Codex', input: text }),
      usage: (thread, usage) => recordCodexChatUsage(getCtx().main.home.data, home.root, thread, usage),
      rateLimits: limits => recordCodexChatLimits(getCtx().main.home.data, limits),
      unavailable: reason => markChatRouteUnavailable('codex', reason)
    }, preparedEvents)
  }

  // ---------------------------------------------------------- sessions

  const quotaPolicy = (): SessionQuotaPolicy => new SessionQuotaPolicy(getCtx().main.home.data)
  const quotaHold = (provider: ChatProvider, item: TurnItem): WkspInfo['limit'] =>
    provider === 'claude' && !quotaPolicy().canStartTurn(item.kind, Date.now(), false) ? quotaPolicy().limitState() : undefined
  const costs = new SessionCostLedger(path.join(home.data, 'usage', 'session-costs.json'))

  // plan limits are per account: every base records into the main base (Settings → Accounts & keys)
  const rateLimit = (rl: ClaudeRateLimitInfo): void => {
    recordClaudeRateLimit(claudeLimitsFile(getCtx().main.home.data), rl)
    quotaPolicy().observe(rl)
  }

  const genio = new ProviderChatSession({
    hold: quotaHold,
    selection: selectedProvider,
    config: driverConfig,
    create: (provider, events, config) => createDriver(provider, 'genio', events, config),
    persisted: persisted.providers, handoff: handoffContext, switched: providerChanged,
    events: {
      onStart(item) {
        turnActions = {}
        // after an interruption Genio re-checks reality instead of assuming the cut turn finished
        if (interruptedNote) { item.prompt = `${interruptedNote}\n\n${item.prompt}`; interruptedNote = undefined }
        delivered(item)
      },
      onRequeue: thread.requeued,
      onLimit(limit) {
        info.limit = limit
        info.lastError = undefined
        publishInfo()
      },
      onMessage(m, final) {
        let msg = m
        if (final && msg.text && NOOP_RE.test(msg.text.trim()) && !(msg.tools ?? []).length) msg = { ...msg, role: 'system' }
        // every tool of the turn has run by the time its messages are final
        if (final && msg.role === 'genio' && hasActions()) msg = { ...msg, actions: turnActions }
        // a reaction the player already gave survives a late rewrite of the same message
        const shown = loadHistory().find(x => x.id === msg.id)
        if (shown?.reaction && !msg.reaction) msg = { ...msg, reaction: shown.reaction, ...(shown.reactionNote ? { reactionNote: shown.reactionNote } : {}) }
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
        const interrupted = !!thread.steering && !ok
        thread.steering = undefined
        if (interrupted) {
          const started = startedText(turnActions)
          say(`Interrupted by your message.${started ? ` It had started: ${started}.` : ''}`, 'system')
          interruptedNote = `[GENIO NOTE] Your previous turn was interrupted by ${gamertag()}; it had started: ${started || 'no actions'}; verify state (unit_state, quests) before continuing.`
          safe(() => getCtx().stats.unlock('chat-steer'))
        }
        if (ok) {
          info.lastError = undefined
          if (item?.prompt.includes('[GENIO PROJECT OPEN]') && lastText && !NOOP_RE.test(lastText.trim())) safe(() => getCtx().stats.unlock('project-welcome'))
          if (genio.currentProvider === 'codex') safe(() => getCtx().stats.unlock('codex-chat-turn'))
          else quotaPolicy().succeeded(name + ':genio')
        }
        info.turns++
        info.costUsd += cost
        if (cost > 0) safe(() => getCtx().stats.addCost(cost))
        saveState()
        if (item?.kind === 'events' && item.ackThrough !== undefined) {
          if (ok) safe(() => getCtx().home(name).wakes.ack(item.ackThrough!))
          // an interrupted batch stays pending (per-event acks hold) and is delivered again after the player's turn
          else if (!interrupted) eventsBackoffUntil = Date.now() + 60_000
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
  if (!readOnly) {
    bot = new ProviderChatSession({
      hold: quotaHold,
      selection: selectedProvider,
    config: driverConfig,
      create: (provider, events, config) => createDriver(provider, 'bot', events, config),
      persisted: persisted.botProviders, handoff: handoffContext,
      switched: () => { void closeChatToolBridges(getCtx(), name, 'bot') },
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
    if (readOnly || !isOpen() || stopped || bootDone) return
    bootDone = true
    if (!needsSessionStart()) return
    let drain = { text: '', ackThrough: -1, count: 0 }
    try {
      drain = getCtx().home(name).wakes.drain()
    } catch {
      /* no events */
    }
    const toBot = getCtx().away.state().mode === 'afk' && bot
    const target = toBot ? bot! : genio
    target.enqueue({
      kind: drain.count ? 'events' : 'system',
      prompt: `${sessionStartPrompt(gamertag())}${drain.count ? `\n\n${drain.text}` : ''}`,
      ackThrough: drain.count ? drain.ackThrough : undefined
    })
    publishInfo()
  }, 7000)

  // ---------------------------------------------------------- slash commands

  /** `shown` is the command as already shown queued: answered at once it turns sent, as a turn it waits like any message. */
  async function slash(text: string, shown: ChatMessage): Promise<boolean> {
    const m = text.trim().match(/^\/(\w+)\b\s*(.*)$/s)
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const rest = m[2].trim()
    const ctx = getCtx()
    const player = (): void => markSent(shown.id)
    const turn = (prompt: string): void => {
      preparing.delete(shown.id)
      if (waiting(shown.id)) enqueueTurn({ kind: 'player', prompt, msgId: shown.id })
      publishInfo()
    }
    switch (cmd) {
      case 'help':
        player()
        say(HELP_TEXT, 'system')
        return true
      case 'recap':
        turn(recapPrompt(gamertag()))
        return true
      case 'status': {
        const file = /\bfile\b/i.test(rest)
        const prs = /include\s+prs?\b/i.test(rest)
        turn(statusPrompt(gamertag(), file, prs))
        return true
      }
      case 'save':
        safe(() => ctx.stats.award('save'))
        turn(savePrompt(gamertag(), !home.isMain))
        return true
      case 'afk':
        await ctx.away.set('afk')
        turn(afkPrompt(gamertag(), rest))
        return true
      case 'dnd':
      case 'quiet': {
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
        const mode = ctx.away.state().mode
        if (mode === 'afk') {
          const brief = ctx.away.takeReturnBrief()
          await ctx.away.set('online')
          turn(returnPrompt(gamertag(), brief))
        } else {
          player()
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

  /** The Bot's away turn is not the player's chat: it is never steered. */
  function botAway(): boolean {
    return !!bot?.busy && safeGet(() => getCtx().away.state().mode) === 'afk'
  }
  /** A visible Genio turn is running (player, greeting or event turn) and the player can steer it. */
  function canSteer(): boolean {
    return !readOnly && genio.busy && !info.limit && !botAway()
  }
  const enqueueTurn = thread.enqueue
  /** Why a steering message just queued is not read at once; undefined when the turn stops now (or none runs). */
  function steerNote(): string | undefined {
    const tool = genio.yieldWait()
    if (tool) return `${ASSISTANT_NAME} stops as soon as ${tool} finishes (a running action is never cut in half), then reads it first.`
    if (info.limit) return `${ASSISTANT_NAME} cannot take a turn right now (see the limit notice); it is read first when the chat resumes.`
    if (genio.busy && !canSteer()) return 'This turn cannot be steered; it is read first when the turn ends.'
    return undefined
  }

  const checkSend = (): void => {
    if (readOnly) throw new Error(archived)
    if (!isOpen()) throw new Error('Open the project window before using its chat.')
    const unavailable = chatRouteUnavailable(selectedProvider())
    if (unavailable) throw new Error(`${unavailable} Open ${settingsPath('accounts')} and refresh before sending. Your draft has been kept.`)
  }

  type Shown = ShownMessage
  const showQueued = thread.showQueued

  const performSend = async (text: string, origin: 'player' | 'system' | 'genio', images: ChatImageInput[], context: InventoryContext | undefined, shown?: Shown): Promise<void> => {
    if (!isOpen()) {
      if (shown) return // closing: stop() shows it as not sent
      throw new Error('Open the project window before using its chat.')
    }
    stopped = false
    bootDone = true
    const trimmed = text.trim()
    // taken back for an edit or cancelled while it waited for its turn
    if (shown && !waiting(shown.m.id)) return
    try {
      if (shown && !images.length && trimmed.startsWith('/') && (await slash(trimmed, shown.m))) return
    } catch (e) {
      if (shown) markSent(shown.m.id)
      say(`Command failed: ${(e as Error).message}`, 'error')
      return
    }
    const ctx = getCtx()
    const prepared = await prepareInventoryContext(context, images, (world, asset) => ctx.inventory.thumbnail(world, asset),
      () => loadHistory().filter(m => m.ts >= contextSessionStart))
    if (shown && !waiting(shown.m.id)) return
    // a shown message stored its pasted images already; only the automatic preview is new
    const early = shown?.send.length ?? 0
    const added = saveChatImages(chatImageDir(home.data), prepared.images.slice(early))
    const stored = { refs: [...(shown?.m.images ?? []), ...added.refs], send: [...(shown?.send ?? []), ...added.send] }
    if (prepared.context?.thumbnail?.status === 'attached') prepared.context.thumbnail.image = stored.refs.at(-1)
    const m: ChatMessage = shown ? { ...loadHistory().find((x) => x.id === shown.m.id)! } : inboundMessage(name, trimmed, origin)
    // only real conversation needs a handoff; messages still waiting (this one included) and '!' result blocks are not part of it
    let prompt = !genio.sessionId && loadHistory().some((x) => !x.queue && !x.shell) ?`${handoffContext()}\n\nCurrent request:\n${trimmed}` : trimmed
    // companion: the first ordinary player message after AFK ends it with a return brief
    if (origin === 'player' && ctx.away.state().mode === 'afk') {
      const brief = ctx.away.takeReturnBrief()
      await ctx.away.set('online')
      prompt = `${returnPrompt(gamertag(), brief)}\n\nThen handle ${gamertag()}'s new message:\n${trimmed || '(see the attached image)'}`
      if (shown && !waiting(shown.m.id)) return
    }
    m.provider = selectedProvider()
    m.providerModel = chatRoute(chatControls(settings(), liveAlly()).model).model
    if (stored.refs.length) m.images = stored.refs
    if (prepared.context) m.context = prepared.context
    const player = origin === 'player'
    if (player && shellRuns.length) {
      prompt = `${shellContextBlock(shellRuns)}\n\n${prompt}`
      shellRuns = []
    }
    // mid-turn: the message waits in the log as queued until the session picks it up
    if (player) m.queue = 'queued'
    if (shown) preparing.delete(m.id)
    record(m, true)
    if (!shown) bus.publish({ type: 'sfx', sound: 'send' })
    // the ids let Genio pass pasted images to generate_image as refs
    prompt += inventoryContextBlock(m.context) + attachedIdsNote(stored.refs)
    enqueueTurn({ kind: player ? 'player' : 'system', prompt, images: stored.send.length ? stored.send : undefined, msgId: player ? m.id : undefined })
    if (hasInventoryChips(m.context)) safe(() => ctx.stats.unlock('inventory-chat'))
    if (m.context?.screen) safe(() => ctx.stats.unlock('genio-panel-context'))
    publishInfo()
  }
  const submit = (text: string, origin: 'player' | 'system' | 'genio', images: ChatImageInput[], context: InventoryContext | undefined, steer: boolean): Promise<void> => {
    let shown: Shown | undefined
    let snapshot: InventoryContext | undefined
    try {
      checkSend()
      if (!text.trim() && !images.length) return Promise.resolve()
      // Thumbnail decoding may be slow: retain click order and freeze the visible chips now.
      snapshot = context && validateInventoryContext(context)
      // slash commands with images are just text for Genio
      if (origin === 'player') shown = showQueued(text.trim(), images, snapshot)
      // decided on submit: steering while the Bot plays is just a message
      if (shown && steer && !botAway()) steerIds.add(shown.m.id)
    } catch (e) {
      return Promise.reject(e)
    }
    return thread.serial(shown, async () => {
      if (projectOpening) {
        await projectReady
        if (stopped || !isOpen()) {
          if (shown) return // stop() shows it as not sent
          throw new Error('The project window closed before the message could be sent.')
        }
      }
      return performSend(text, origin, images, snapshot, shown)
    })
  }

  const svc: WkspService = {
    info: () => ({ ...info, queued: genio.queued + (bot?.queued ?? 0) + preparing.size, steerable: canSteer() }),
    history(limit = 200) {
      const h = loadHistory()
      return h.slice(-limit)
    },
    preloadHistory: thread.preload,
    send: (text, origin = 'player', images = [], context) => submit(text, origin, images, context, false),
    steer: (text, images = [], context) => submit(text, 'player', images, context, true),
    sendNow: thread.sendNow,
    unqueue: thread.unqueue,
    deliverWakes() {
      if (readOnly || !isOpen() || stopped || projectOpening) return
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
        // A genuine failed provider request has its own durable backoff, separate
        // from plan percentages. Keep the batch pending and make the hold visible.
        const policy = quotaPolicy()
        if (selectedProvider() === 'claude' && !policy.canStartTurn('events', Date.now(), false)) {
          const reason = `Claude rejected a request; ${pend.length} pending event${pend.length === 1 ? '' : 's'} will be delivered after recovery. Refreshing account usage automatically.`
          if (info.limit?.reason !== reason) { info.limit = { ...policy.limitState(), reason }; publishInfo() }
          if (policy.notice(name + ':wakes', '429 wake delivery')) say(reason, 'system')
          void refreshClaudePlanUsage(ctx.main.home.data, chatCwd(), settings().claudePath?.trim() || undefined)
            .then(() => { if (policy.canStartTurn('events', Date.now(), false)) svc.deliverWakes() })
          return
        }
        // routine-only batches wait for the Usage mode's batching window; anything urgent goes now
        const hold = routineDelay(pend, wakeBatchMs(settings()))
        if (hold > 0) {
          clearTimeout(batchTimer)
          batchTimer = setTimeout(() => svc.deliverWakes(), hold + 50)
          return
        }
        const mode = ctx.away.state().mode
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
    prepareProjectOpen() {
      if (readOnly) return
      projectOpening = true
      projectReady ??= new Promise<void>(resolve => { finishProjectOpen = resolve })
      bootDone = true
      if (stopped) { genio.restart(false); bot?.restart(false) }
      stopped = false
      clearTimeout(batchTimer)
    },
    wakeProject(recap) {
      if (readOnly || !isOpen() || stopped || !projectOpening) return
      projectRecap = recap
      const drain = getCtx().home(name).wakes.drain()
      // Always the visible Genio session. Presence still governs later events.
      genio.enqueue({ kind: 'events', prompt: projectOpenPrompt(gamertag(), recap, drain.text),
        ackThrough: drain.count ? drain.ackThrough : undefined })
      projectOpening = false
      finishProjectOpen?.()
      projectReady = undefined
      finishProjectOpen = undefined
      publishInfo()
    },
    async interrupt() {
      await genio.interrupt()
      await bot?.interrupt()
    },
    async restart(fresh, role = 'genio') {
      if (readOnly) throw new Error('The main chat is archived.')
      if (!isOpen()) throw new Error('Open the project window before using its chat.')
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
      finishProjectOpen?.()
      projectReady = undefined
      finishProjectOpen = undefined
      await closeChatToolBridges(getCtx(), name)
      genio.stop()
      bot?.stop()
      strandWaiting()
      info.activity = 'offline'
      saveState()
    },
    say,
    post: record,
    shellRan(run) {
      const m: ChatMessage = { id: `sh-${rid(6)}`, wksp: name, role: 'system', text: shellSummary(run), ts: nowIso(), shell: run }
      record(m, true)
      if (!readOnly) shellRuns = [...shellRuns, run].slice(-SHELL_CONTEXT_RUNS)
      return m
    }
  }
  return svc
}

const STARTED_LABELS: Record<keyof MessageActions, string> = { units: 'units', quests: 'quests', merges: 'merges', choices: 'choices', settings: 'settings' }

/** What an interrupted turn had started, for its transcript note and the next turn's context ('' for nothing). */
export function startedText(actions: MessageActions): string {
  return (Object.keys(STARTED_LABELS) as (keyof MessageActions)[])
    .filter(k => actions[k]?.length).map(k => `${STARTED_LABELS[k]} ${actions[k]!.join(', ')}`).join('; ')
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

