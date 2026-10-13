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
import { Home } from '../src/main/home'
import { createWkspService } from '../src/main/wksp'
import type { AppCtx } from '../src/main/services'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); peers.length = 0 })

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
