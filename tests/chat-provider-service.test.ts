import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const peers = vi.hoisted(() => [] as { events: any; requests: { method: string; params: any }[] }[])
vi.mock('../src/main/codex-chat-driver', async original => {
  const actual = await original<typeof import('../src/main/codex-chat-driver')>()
  return { ...actual, CodexChatDriver: class extends actual.CodexChatDriver {
    constructor(options: any, hooks: any) {
      super({ ...options, wire(events: any) {
        const peer = { events, requests: [] as { method: string; params: any }[] }; peers.push(peer)
        const id = `session-${peers.length}`
        return { close() {}, notify() {}, async request(method: string, params: any) {
          peer.requests.push({ method, params })
          if (method === 'account/read') return { account: { type: 'chatgpt' } }
          if (method === 'config/read') return { config: { features: Object.fromEntries(actual.CODEX_CHAT_DISABLED.map(n => [n, false])) } }
          if (method === 'model/list') return { data: [{ model: 'gpt-test', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id }, model: 'gpt-test', modelProvider: 'openai',
            sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'user', reasoningEffort: 'high' }
          if (method === 'turn/start') { events.notification('turn/started', { threadId: id, turn: { id: 'turn' } }); return { turn: { id: 'turn' } } }
          return {}
        } }
      } }, hooks)
    }
  } }
})
import type { ChatMessage } from '@shared/types'
import { applyChatEvent, splitQueued } from '@shared/chat'
import { bus } from '../src/main/bus'
import { Home } from '../src/main/home'
import { createWkspService } from '../src/main/wksp'
import type { AppCtx } from '../src/main/services'
import { createWakeService } from '../src/main/wakes'
import { claudeLimitsFile, recordClaudeRateLimit } from '../src/main/usage'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); peers.length = 0 })

it('Codex delivers ready/blocked events across restart despite persisted stale 97% Claude usage, acking only success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-wakes-'))
  const home = new Home(root); home.ensure()
  recordClaudeRateLimit(claudeLimitsFile(home.data), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
  const snapshot = JSON.parse(fs.readFileSync(claudeLimitsFile(home.data), 'utf8'))
  snapshot.windows.five_hour.utilizationObservedAt = new Date(Date.now() - 3600_000).toISOString()
  fs.writeFileSync(claudeLimitsFile(home.data), JSON.stringify(snapshot))
  const hc = { home, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] }, wakes: undefined as any }
  const ctx = { appRoot: process.cwd(), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ wkspModel: 'codex:OpenAI:gpt-test', wkspEffort: 'high', chatShellMode: 'ask' }) },
    away: { state: () => ({ mode: 'online' }) }, allies: { list: () => [] }, projects: { list: () => [] },
    stats: { unlock: vi.fn(), addCost: vi.fn() }, inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  hc.wakes = createWakeService(() => ctx, home)
  hc.wakes.enqueue({ kind: 'signal', reason: 'unit ready', routine: false })
  hc.wakes.enqueue({ kind: 'signal', reason: 'unit blocked', routine: false })
  const first = createWkspService(() => ctx, home)
  cleanup.push(async () => { await first.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  first.deliverWakes(); first.deliverWakes()
  await vi.waitFor(() => expect(peers[0]?.requests.filter(r => r.method === 'turn/start')).toHaveLength(1))
  expect(JSON.stringify(peers[0].requests.find(r => r.method === 'turn/start'))).toContain('unit ready')
  expect(hc.wakes.pending()).toHaveLength(2)
  // Crash before success: no acknowledgement and both events survive a new service.
  await first.stop()
  hc.wakes = createWakeService(() => ctx, home)
  const second = createWkspService(() => ctx, home)
  cleanup.unshift(async () => { await second.stop() })
  second.deliverWakes()
  await vi.waitFor(() => expect(peers[1]?.requests.filter(r => r.method === 'turn/start')).toHaveLength(1))
  expect(hc.wakes.pending()).toHaveLength(2)
  peers[1].events.notification('turn/completed', { threadId: 'session-2', turn: { id: 'turn', status: 'completed' } })
  expect(hc.wakes.pending()).toEqual([])
})

it('main and AFK Bot inherit the selected provider/model, retain one transcript and award only successful turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-provider-service-'))
  const home = new Home(root)
  let mode = 'online', wake = false
  const stats = { unlock: vi.fn(), addCost: vi.fn() }
  const hc = { home, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] }, wakes: {
    pending: () => wake ? [{ routine: true }] : [], drain: () => ({ text: 'check fleet', count: 1, ackThrough: 1 }), ack: () => { wake = false }
  } }
  const ctx = { appRoot: process.cwd(), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ wkspModel: 'codex:OpenAI:gpt-test', wkspEffort: 'high', botModel: 'ignored-old-bot-model', chatShellMode: 'ask' }) },
    away: { state: () => ({ mode }), capture: vi.fn() }, allies: { list: () => [] }, projects: { list: () => [] }, stats,
    inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  const service = createWkspService(() => ctx, home)
  cleanup.push(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await service.send('hello')
  await vi.waitFor(() => expect(peers[0]?.requests.some(r => r.method === 'turn/start')).toBe(true))
  expect(stats.unlock).toHaveBeenCalledWith('chat-provider-switch')
  expect(stats.unlock).not.toHaveBeenCalledWith('codex-chat-turn')
  peers[0].events.notification('item/completed', { threadId: 'session-1', item: { id: 'reply', type: 'agentMessage', text: 'hello back' } })
  peers[0].events.notification('turn/completed', { threadId: 'session-1', turn: { id: 'turn', status: 'completed' } })
  expect(stats.unlock).toHaveBeenCalledWith('codex-chat-turn')
  expect(service.history().filter(m => m.text.includes('Provider changed'))).toHaveLength(1)
  expect(service.history().find(m => m.text === 'hello back')).toMatchObject({ provider: 'codex', providerModel: 'gpt-test', providerSession: 'session-1' })
  expect(stats.addCost).not.toHaveBeenCalled()
  mode = 'afk'; wake = true; service.deliverWakes()
  await vi.waitFor(() => expect(peers[1]?.requests.some(r => r.method === 'turn/start')).toBe(true))
  const bot = peers[1].requests.find(r => r.method === 'thread/start')!.params
  expect(bot.model).toBe('gpt-test')
  expect(bot.dynamicTools.map((t: any) => t.name)).toContain('genio_escalate')
  expect(bot.dynamicTools.map((t: any) => t.name)).not.toContain('genio_merge')
  expect(bot.dynamicTools.map((t: any) => t.name)).not.toContain('genio_deploy')
  peers[1].events.notification('turn/completed', { threadId: 'session-2', turn: { id: 'turn', status: 'completed' } })
  expect(service.history().filter(m => m.role === 'genio')).toHaveLength(1)
})

it('Codex shows messages sent mid-turn as queued at once and sends each exactly once, in order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-queue-'))
  const home = new Home(root)
  const hc = { home, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] },
    wakes: { pending: () => [], drain: () => ({ text: '', count: 0, ackThrough: -1 }), ack: () => undefined } }
  const ctx = { appRoot: process.cwd(), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ wkspModel: 'codex:OpenAI:gpt-test', wkspEffort: 'high', chatShellMode: 'ask' }) },
    away: { state: () => ({ mode: 'online' }) }, allies: { list: () => [] }, projects: { list: () => [] },
    stats: { unlock: vi.fn(), addCost: vi.fn() }, inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  let shown: ChatMessage[] = []
  const off = bus.onEvent(ev => { if (ev.type === 'chat') shown = applyChatEvent(shown, ev.message) })
  const service = createWkspService(() => ctx, home)
  cleanup.push(async () => { off(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const turns = () => peers[0]?.requests.filter(r => r.method === 'turn/start') ?? []
  const complete = () => peers[0].events.notification('turn/completed', { threadId: 'session-1', turn: { id: 'turn', status: 'completed' } })
  const sending = service.send('first')
  // already on screen while Codex is still connecting
  expect(splitQueued(shown).queued.map(m => m.text)).toEqual(['first'])
  await sending
  await vi.waitFor(() => expect(turns()).toHaveLength(1))
  expect(splitQueued(shown).queued).toEqual([])
  await service.send('second')
  await service.send('third')
  expect(splitQueued(shown).queued.map(m => m.text)).toEqual(['second', 'third'])
  expect(service.info().queued).toBe(2)
  complete()
  await vi.waitFor(() => expect(turns()).toHaveLength(2))
  expect(turns()[1].params.input[0].text).toBe('second')
  expect(splitQueued(shown).queued.map(m => m.text)).toEqual(['third'])
  complete()
  await vi.waitFor(() => expect(turns()).toHaveLength(3))
  expect(turns()[2].params.input[0].text).toBe('third')
  expect(splitQueued(shown).queued).toEqual([])
  expect(shown.filter(m => m.role === 'player').map(m => m.text)).toEqual(['first', 'second', 'third'])
})

it('stamps what a Codex turn started on its final messages, from the tool calls alone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-actions-'))
  const home = new Home(root)
  let quests = 0
  const hc = { home, crew: { list: () => [] }, decisions: { list: () => [], open: (d: object) => ({ id: 'ch-1', ...d }) },
    backlog: { list: () => [], add: (q: object) => ({ id: `q-${++quests}`, state: 'queued', ...q }) },
    wakes: { pending: () => [], drain: () => ({ text: '', count: 0, ackThrough: -1 }), ack: () => undefined } }
  const ctx = { appRoot: process.cwd(), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ wkspModel: 'codex:OpenAI:gpt-test', wkspEffort: 'high', chatShellMode: 'all' }) },
    away: { state: () => ({ mode: 'online' }) }, allies: { list: () => [] }, projects: { list: () => [] },
    stats: { unlock: vi.fn(), addCost: vi.fn() }, inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  const service = createWkspService(() => ctx, home)
  cleanup.push(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const turns = () => peers[0]?.requests.filter(r => r.method === 'turn/start') ?? []
  const say = (id: string, text: string) => peers[0].events.notification('item/completed', { threadId: 'session-1', item: { id, type: 'agentMessage', text } })
  const complete = () => peers[0].events.notification('turn/completed', { threadId: 'session-1', turn: { id: 'turn', status: 'completed' } })
  const call = (callId: string, tool: string, args: object) =>
    peers[0].events.request('item/tool/call', { threadId: 'session-1', turnId: 'turn', callId, tool, arguments: args })
  await service.send('file the polish work')
  await vi.waitFor(() => expect(turns()).toHaveLength(1))
  say('plan', 'Filing it now.')
  expect(await call('c1', 'genio_quest_add', { title: 'Polish the HUD' })).toMatchObject({ success: true })
  expect(await call('c2', 'genio_choice_open', { question: 'Which art style?', options: ['Pixel', 'Painted'] })).toMatchObject({ success: true })
  say('done', 'Filed the quest and asked about the art style.')
  complete()
  for (const text of ['Filing it now.', 'Filed the quest and asked about the art style.']) {
    expect(service.history().find(m => m.text === text)).toMatchObject({ actions: { quests: ['q-1'], choices: ['ch-1'] } })
  }
  // the next turn starts with an empty record
  await service.send('thanks')
  await vi.waitFor(() => expect(turns()).toHaveLength(2))
  say('reply', 'Any time.')
  complete()
  expect(service.history().find(m => m.text === 'Any time.')?.actions).toBeUndefined()
})

it('leaves the archived main log and session state untouched and cannot start a provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-archive-'))
  const home = new Home(root); home.ensure()
  const archive = JSON.stringify({ id: 'queued', wksp: 'main', role: 'player', text: 'old', ts: '2026-01-01', queue: 'queued' }) + '\n'
  fs.writeFileSync(home.chatFile, archive)
  fs.writeFileSync(home.wkspFile, '{}')
  const ctx = { settings: { get: () => ({}) } } as unknown as AppCtx
  const service = createWkspService(() => ctx, home, undefined, true)
  cleanup.push(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  expect(service.history()[0].queue).toBe('unsent')
  await expect(service.send('new')).rejects.toThrow('archived')
  await expect(service.restart(false)).rejects.toThrow('archived')
  service.say('ignored'); service.deliverWakes(); await service.stop()
  expect(fs.readFileSync(home.chatFile, 'utf8')).toBe(archive)
  expect(fs.readFileSync(home.wkspFile, 'utf8')).toBe('{}')
  expect(peers).toHaveLength(0)
})

it('refuses sends, retries and wake delivery while a project window is closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-closed-chat-'))
  const home = new Home(root); home.ensure()
  const ctx = { settings: { get: () => ({}) } } as unknown as AppCtx
  const service = createWkspService(() => ctx, home, undefined, false, () => false)
  cleanup.push(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  await expect(service.send('do work')).rejects.toThrow('Open the project window')
  await expect(service.restart(false)).rejects.toThrow('Open the project window')
  service.deliverWakes()
  expect(service.history()).toEqual([])
  expect(peers).toHaveLength(0)
})

it('preloads the chat log off the main thread with the same history the first read gives, once', async () => {
  const log = [
    { id: 'p1', wksp: 'main', role: 'player', text: 'hello', ts: '2026-01-01T00:00:00Z' },
    { id: 'g1', wksp: 'main', role: 'genio', text: 'hi', ts: '2026-01-01T00:00:01Z' },
    { id: 'g1', wksp: 'main', role: 'genio', text: 'hi, edited', ts: '2026-01-01T00:00:01Z' },
    { id: 'q1', wksp: 'main', role: 'player', text: 'later', ts: '2026-01-01T00:00:02Z', queue: 'queued' }
  ].map(m => JSON.stringify(m)).join('\n') + '\n{corrupt\n'
  const read = async (preload: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-preload-'))
    const home = new Home(root); home.ensure()
    fs.writeFileSync(home.chatFile, log)
    const ctx = { settings: { get: () => ({}) } } as unknown as AppCtx
    const service = createWkspService(() => ctx, home, undefined, false, () => false)
    cleanup.push(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
    if (preload) { await service.preloadHistory!(); await service.preloadHistory!() }
    return { history: service.history(), file: fs.readFileSync(home.chatFile, 'utf8') }
  }
  const sync = await read(false), preloaded = await read(true)
  expect(preloaded).toEqual(sync)
  expect(preloaded.history.map(m => [m.id, m.text, m.queue])).toEqual([['p1', 'hello', undefined], ['g1', 'hi, edited', undefined], ['q1', 'later', 'unsent']])
  // The stranded message was appended once, not once per preload.
  expect(preloaded.file.split('\n').filter(l => l.includes('"q1"'))).toHaveLength(2)
})