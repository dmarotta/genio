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
import type { ChatMessage, GenioEvent } from '@shared/types'
import { bus } from '../src/main/bus'
import { Home } from '../src/main/home'
import { createWorkspaceService } from '../src/main/workspace'
import type { AppCtx } from '../src/main/services'
import { createWakeService } from '../src/main/wakes'

const NOOP = 'All clear, Alex.'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); peers.length = 0 })

function setup(mode = 'online', wakes?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-quiet-codex-'))
  const home = new Home(root); home.ensure()
  const hc = { home, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] }, wakes: wakes as any }
  const state = { mode }
  const stats = { unlock: vi.fn(), addCost: vi.fn() }
  const ctx = { appRoot: process.cwd(), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ gamertag: 'Alex', voice: true, workspaceModel: 'codex:OpenAI:gpt-test', workspaceEffort: 'high', chatShellMode: 'ask' }) },
    away: { state: () => state, capture: vi.fn() }, allies: { list: () => [] }, projects: { list: () => [] },
    stats, inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  hc.wakes ??= createWakeService(() => ctx, home)
  const service = createWorkspaceService(() => ctx, home)
  const seen: GenioEvent[] = []
  const off = bus.onEvent((ev: GenioEvent) => { if (ev.type === 'sfx' || ev.type === 'speak' || ev.type === 'chat' || ev.type === 'chat-delta') seen.push(ev) })
  cleanup.push(async () => { off(); await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  // the first Codex turn of a base notes the provider change; it is not what these tests look at
  const drawn = () => seen.filter(ev => (ev.type === 'chat' && !ev.message.text.startsWith('Provider changed')) || ev.type === 'chat-delta')
  const rows = () => service.history().filter(m => !m.text.startsWith('Provider changed'))
  const sounds = () => seen.flatMap(ev => ev.type === 'sfx' ? [ev.sound] : ev.type === 'speak' ? [`speak:${ev.text}`] : [])
  return { home, hc, service, state, drawn, rows, sounds, wakes: hc.wakes as ReturnType<typeof createWakeService> }
}
const turns = (i: number) => peers[i]?.requests.filter(r => r.method === 'turn/start') ?? []
const note = (i: number, method: string, params: object) => peers[i].events.notification(method, { threadId: `session-${i + 1}`, ...params })
const speak = (i: number, id: string, text: string, chunks = [text]) => {
  note(i, 'item/started', { item: { id, type: 'agentMessage', text: '' } })
  for (const delta of chunks) note(i, 'item/agentMessage/delta', { itemId: id, delta })
  note(i, 'item/completed', { item: { id, type: 'agentMessage', text } })
}
const finish = (i: number) => note(i, 'turn/completed', { turn: { id: 'turn', status: 'completed' } })

it('Codex: an event turn that ends with the sentence, an empty message or nothing leaves no bubble, and the batch is still acknowledged', async () => {
  const c = setup()
  for (const [n, say] of [
    (i: number) => speak(i, 'r', NOOP, ['All', ' clear', ', Alex.']),
    (i: number) => speak(i, 'r', ''),
    (i: number) => speak(i, 'r', '"all clear, alex!"'),
    () => undefined
  ].entries()) {
    c.wakes.enqueue({ kind: 'signal', reason: `unit ${n} finished`, routine: false })
    c.service.deliverWakes()
    await vi.waitFor(() => expect(turns(0)).toHaveLength(n + 1))
    say(0)
    finish(0)
    await vi.waitFor(() => expect(c.wakes.pending()).toEqual([]))
    await vi.waitFor(() => expect(c.service.info().activity).toBe('idle'))
  }
  expect(c.drawn()).toEqual([])
  expect(c.rows().filter(m => m.role !== 'player')).toEqual([])
  expect(c.sounds()).toEqual([])
  expect(c.service.info().lastError).toBeUndefined()
  expect(c.service.info().turns).toBe(4)
})

it('Codex: a real reply on an event turn is shown with sound and voice; a message that starts like the sentence is shown in full', async () => {
  const c = setup()
  c.wakes.enqueue({ kind: 'signal', reason: 'unit ready', routine: false })
  c.service.deliverWakes()
  await vi.waitFor(() => expect(turns(0)).toHaveLength(1))
  speak(0, 'r1', `${NOOP} Unit 3 is ready.`, ['All clear', ', Alex.', ' Unit 3 is ready.'])
  speak(0, 'r2', 'Done.')
  finish(0)
  await vi.waitFor(() => expect(c.rows().map(m => m.text)).toEqual([`${NOOP} Unit 3 is ready.`, 'Done.']))
  const streamed = c.drawn().filter(ev => ev.type === 'chat-delta') as Extract<GenioEvent, { type: 'chat-delta' }>[]
  expect(streamed.map(ev => ev.text).join('')).toBe(`${NOOP} Unit 3 is ready.Done.`)
  expect(c.sounds()).toEqual(['blip', 'speak:Done.'])
})

it('Codex: a player turn answered with the sentence shows it, and an empty message in it leaves no bubble', async () => {
  const c = setup()
  await c.service.send('anything new?')
  await vi.waitFor(() => expect(turns(0)).toHaveLength(1))
  speak(0, 'empty', '')
  speak(0, 'r', NOOP)
  finish(0)
  await vi.waitFor(() => expect(c.rows().map(m => [m.role, m.text])).toEqual([['player', 'anything new?'], ['genio', NOOP]]))
})

it('the AFK Bot keeps no row for its sentence or empty turns and logs a real report', async () => {
  let wake = false
  const wakes = { pending: () => wake ? [{ routine: true }] : [], drain: () => ({ text: 'check fleet', count: 1, ackThrough: 1 }), ack: () => { wake = false } }
  const c = setup('afk', wakes)
  const botLog = () => fs.existsSync(path.join(c.home.data, 'bot.jsonl')) ? fs.readFileSync(path.join(c.home.data, 'bot.jsonl'), 'utf8') : ''
  const botTurn = async (n: number, say: () => void) => {
    wake = true; c.service.deliverWakes()
    await vi.waitFor(() => expect(turns(0)).toHaveLength(n))
    say(); finish(0)
    await vi.waitFor(() => expect(wake).toBe(false))
    await vi.waitFor(() => expect(c.service.info().queued).toBe(0))
  }
  await botTurn(1, () => speak(0, 'b1', 'All clear.'))
  await botTurn(2, () => speak(0, 'b2', NOOP))
  await botTurn(3, () => speak(0, 'b3', ''))
  expect(botLog()).toBe('')
  await botTurn(4, () => speak(0, 'b4', 'Unit 3 stopped responding; relaunched it.'))
  expect(botLog()).toContain('Unit 3 stopped responding')
  expect(botLog()).not.toMatch(/all clear/i)
  expect(c.drawn()).toEqual([])
  expect(c.rows()).toEqual([])
})

it('Codex: a queued player message is read after an event turn that said nothing', async () => {
  const c = setup()
  c.wakes.enqueue({ kind: 'signal', reason: 'unit ready', routine: false })
  c.service.deliverWakes()
  await vi.waitFor(() => expect(turns(0)).toHaveLength(1))
  await c.service.send('hello during events')
  expect(c.rows().find(m => m.text === 'hello during events')?.queue).toBe('queued')
  speak(0, 'r', NOOP)
  finish(0)
  await vi.waitFor(() => expect(turns(0)).toHaveLength(2))
  expect(JSON.stringify(turns(0)[1].params.input)).toContain('hello during events')
  const kept: ChatMessage | undefined = c.rows().find(m => m.text === 'hello during events')
  expect(kept?.queue).toBeUndefined()
  expect(c.rows().filter(m => m.role === 'genio')).toEqual([])
})
