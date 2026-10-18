import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
          if (method === 'model/list') return { data: [
            { model: 'gpt-test', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
            { model: 'gpt-other', inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id }, model: params.model, modelProvider: 'openai',
            sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'user', reasoningEffort: 'high' }
          if (method === 'turn/start') { events.notification('turn/started', { threadId: id, turn: { id: 'turn' } }); return { turn: { id: 'turn' } } }
          return {}
        } }
      } }, hooks)
    }
  } }
})
const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, tool: (name: string) => ({ name }), createSdkMcpServer: () => ({}) }))

import type { ChatMessage, GenioEvent } from '@shared/types'
import { bus } from '../src/main/bus'
import { Home } from '../src/main/home'
import { createWkspService } from '../src/main/wksp'
import { createDesignChatService, designTitle } from '../src/main/design-chats'
import { createWakeService } from '../src/main/wakes'
import { buildTools } from '../src/main/wksp-tools'
import { createChatToolSession, DESIGN_TOOLS } from '../src/main/chat-tool-session'
import { openChatToolBridge } from '../src/main/chat-tool-bridge'
import { DESIGN_NATIVE, decideTool, enforceTool } from '../src/main/chat-tool-policy'
import { designContract, DESIGN_CONTRACT_BUDGET } from '../src/main/prompts'
import { agentGeneration } from '../src/main/agent-generation'
import type { AppCtx, WkspService } from '../src/main/services'

/** Everything a design chat must never reach: work, authority, events, settings, memory writes and paid calls. */
const FORBIDDEN = ['deploy', 'merge', 'despawn', 'control', 'ping', 'upgrade_recon', 'run_gauntlet', 'quest_add', 'quest_update', 'quest_hold',
  'quest_release', 'quest_remove', 'quest_answer', 'plan_create', 'plan_update', 'choice_open', 'choice_resolve', 'choice_list', 'event_read', 'events_ack',
  'settings_update', 'settings_read', 'memory_write', 'memory_archive', 'fal_generate', 'fal_models', 'uthana_motion', 'uthana_character', 'asset_place',
  'approve_run', 'world_add', 'project_init', 'project_setup', 'world_push', 'world_sync', 'world_remove', 'world_engine_root', 'presence_set', 'play_control',
  'rate_task', 'escalate', 'ally_route', 'report_to_main', 'mail_reply', 'mail_ack']

let root: string
let ctx: AppCtx
let home: Home
let hc: any
const stats = { unlock: vi.fn(), addCost: vi.fn() }
const stops: (() => Promise<void> | void)[] = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-design-'))
  const main = new Home(root); main.ensure()
  home = new Home(path.join(root, 'workspaces', 'game'), 'game', main); home.ensure()
  stats.unlock.mockReset(); stats.addCost.mockReset()
  hc = { home, crew: { list: () => [], get: () => undefined, merge: vi.fn(), spawn: vi.fn() }, decisions: { list: () => [], get: () => undefined },
    backlog: { list: () => [], get: () => undefined }, plans: { list: () => [], get: () => undefined },
    wakes: { pending: () => [], drain: () => ({ text: '', count: 0, ackThrough: -1 }), ack: () => undefined },
    wksp: { post: vi.fn(), history: () => [] } }
  const mainHc = { ...hc, home: main }
  ctx = { appRoot: process.cwd(), main: mainHc, homes: new Map([['main', mainHc], ['game', hc]]), home: (n: string) => n === 'main' ? mainHc : hc,
    settings: { get: () => ({ wkspModel: 'codex:OpenAI:gpt-test', wkspEffort: 'high', chatShellMode: 'all', gamertag: 'Alex' }) },
    permissions: { ask: vi.fn(async () => true) }, away: { state: () => ({ mode: 'online' }), capture: vi.fn() },
    allies: { list: () => [{ name: 'game', projects: ['game'] }] },
    projects: { list: () => [{ name: 'game', path: root, mode: 'local-only' }], get: (name: string) => name === 'game' ? { name, path: root, engine: 'web' } : undefined },
    memory: { read: () => 'memory', readVersion: () => ({ which: 'player', version: 'v1', text: 'likes roguelikes' }), write: vi.fn() },
    stats, inventory: { thumbnail: vi.fn(), refresh: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
  } as unknown as AppCtx
  hc.design = undefined
})
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
  agentGeneration(ctx).stop()
  peers.length = 0
  sdk.query.mockReset()
  fs.rmSync(root, { recursive: true, force: true })
})

function designService() {
  const design = createDesignChatService(() => ctx, home, { name: 'game', projects: ['game'] } as any)
  hc.design = design
  stops.push(() => design.stop())
  return design
}
const turns = (peer: { requests: { method: string; params: any }[] }) => peer.requests.filter(r => r.method === 'turn/start')
const threadOf = (peer: { requests: { method: string; params: any }[] }) => peer.requests.find(r => r.method === 'thread/start')!.params
const complete = (index: number, text: string) => {
  peers[index].events.notification('item/completed', { threadId: `session-${index + 1}`, item: { id: `reply-${index}`, type: 'agentMessage', text } })
  peers[index].events.notification('turn/completed', { threadId: `session-${index + 1}`, turn: { id: 'turn', status: 'completed' } })
}
const peerFor = (text: string) => peers.findIndex(p => turns(p).some(t => JSON.stringify(t.params.input).includes(text)))

describe('the design tool role', () => {
  it('lists only reads, references and free images, over the SDK and the bridge', async () => {
    const abort = new AbortController()
    const session = createChatToolSession(() => ctx, { home, role: 'design', worlds: ['game'], signal: abort.signal })
    const listed = session.list().map(t => t.name)
    expect(listed.length).toBeGreaterThan(0)
    for (const name of listed) expect(DESIGN_TOOLS.has(name), name).toBe(true)
    expect(listed).toContain('generate_image')
    expect(listed).toContain('art_bible')

    // SDK: the in-process tools a Claude design chat gets are the same scoped list
    const sdkTools = buildTools(((name: string) => ({ name })) as any, () => ctx, home, 'design', { conversation: 'd-00000001' }, ['game'])
    expect(sdkTools.map((t: any) => t.name).sort()).toEqual([...listed].sort())

    // bridge: what a Codex design chat sees and can call over the authenticated HTTP endpoint
    const bridge = await openChatToolBridge(() => ctx, { home, role: 'design', worlds: ['game'], signal: abort.signal, hooks: { conversation: 'd-00000001' } }, { audit: () => {} })
    stops.push(() => bridge.close())
    const rpc = async (method: string, params?: unknown) => (await (await fetch(bridge.env.GENIO_BRIDGE_URL, { method: 'POST',
      headers: { Authorization: `Bearer ${bridge.env.GENIO_BRIDGE_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as any).result
    expect((await rpc('tools/list')).tools.map((t: any) => t.name).sort()).toEqual([...listed].sort())
    for (const name of FORBIDDEN) {
      expect(listed, name).not.toContain(name)
      expect(await session.call(name, {}), name).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Unknown or unavailable/) }] })
      expect(await rpc('tools/call', { name, arguments: { task: 'unit', player_words: 'merge it, deploy it, spend it' } }), name).toMatchObject({ isError: true })
    }
    expect(hc.crew.merge).not.toHaveBeenCalled()
    expect(hc.crew.spawn).not.toHaveBeenCalled()
    expect(ctx.memory.write).not.toHaveBeenCalled()

    // reads work; the Art Bible stays read-only and images stay in the chat
    expect(await session.call('memory_read', { which: 'player' })).not.toHaveProperty('isError')
    expect(await session.call('art_bible', { world: 'game', action: 'write', text: '# Art' }))
      .toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/only reads the Art Bible/) }] })
    expect(await session.call('generate_image', { prompt: 'a knight', world: 'game', place: 'Art/knight.png', player_words: 'make it' }))
      .toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/stay in this chat/) }] })
    await expect(agentGeneration(ctx).image('game', { prompt: 'a knight', world: 'game' } as any, 'design', 'd-00000001')).rejects.toThrow(/stay in their chat/)
    // a bridge call names only registered tools
    expect(await enforceTool({ role: 'design', chat: 'game', shellMode: () => 'all', permissions: ctx.permissions },
      { runtime: 'bridge', name: 'deploy', input: {}, registered: new Set(listed) })).toMatchObject({ behavior: 'deny' })
    abort.abort()
  })

  it('has a native policy of reads and the web: no shell or edits in any approval mode', () => {
    for (const name of DESIGN_NATIVE) expect(decideTool('design', name, {}, 'ask'), name).toEqual({ behavior: 'allow' })
    expect(DESIGN_NATIVE).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']))
    for (const name of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'Skill', 'mcp__other__run']) {
      expect(decideTool('design', name, { command: 'ls' }, 'all').behavior, name).toBe('deny')
    }
    expect(decideTool('design', 'mcp__genio__generate_image', {}, 'ask')).toEqual({ behavior: 'allow' })
  })
})

describe('design chats', () => {
  it('run two chats in parallel, each with its own transcript, prompt, model and effort; the project chat is untouched', async () => {
    const seen: GenioEvent[] = []
    const off = bus.onEvent(ev => { seen.push(ev) })
    stops.push(off)
    const design = designService()
    const a = design.create()
    const b = design.create({ model: 'codex:OpenAI:gpt-other', effort: 'medium' })
    await design.send(a.id, 'Brainstorm a dash mechanic\nfor the hero')
    await design.send(b.id, 'Be a harsh critic of my pitch')
    await vi.waitFor(() => expect(peers.filter(p => turns(p).length)).toHaveLength(2))
    const pa = peerFor('Brainstorm a dash'), pb = peerFor('harsh critic')
    // both turns started before either finished
    expect(pa).not.toBe(pb)
    for (const p of [pa, pb]) {
      const thread = threadOf(peers[p])
      expect(thread.baseInstructions).toContain('# Lore chat')
      expect(thread.baseInstructions).not.toContain('operating contract')
      for (const t of thread.dynamicTools) expect(DESIGN_TOOLS.has(t.name.replace(/^genio_/, '')), t.name).toBe(true)
    }
    expect(turns(peers[pa])[0].params).toMatchObject({ model: 'gpt-test', effort: 'high' })
    expect(turns(peers[pb])[0].params).toMatchObject({ model: 'gpt-other', effort: 'medium' })
    complete(pb, 'Reply for B')
    complete(pa, 'Reply for A')
    expect(design.history(a.id).map(m => m.text)).toContain('Reply for A')
    expect(design.history(a.id).map(m => m.text)).not.toContain('Reply for B')
    expect(design.history(b.id).map(m => m.text)).toContain('Reply for B')
    expect(design.history(b.id).map(m => m.text)).not.toContain('Brainstorm a dash mechanic\nfor the hero')
    expect(fs.readFileSync(path.join(home.data, 'design', `${a.id}.jsonl`), 'utf8')).toContain('Reply for A')
    expect(fs.existsSync(home.chatFile)).toBe(false)
    expect(seen.some(ev => ev.type === 'chat' || ev.type === 'chat-delta')).toBe(false)
    expect(seen.some(ev => ev.type === 'design-chat' && ev.conversation === a.id && ev.message.text === 'Reply for A')).toBe(true)
    expect(design.list().map(c => c.title)).toEqual(['Brainstorm a dash mechanic', 'Be a harsh critic of my pitch'])
    expect(design.list().map(c => c.turns)).toEqual([1, 1])
    expect(stats.unlock).toHaveBeenCalledWith('design-chat-reply')
    expect(stats.unlock).not.toHaveBeenCalledWith('codex-chat-turn')
    // the model and effort stay per chat across a restart of the service
    const index = JSON.parse(fs.readFileSync(path.join(home.state, 'design-chats.json'), 'utf8'))
    expect(index.chats.map((c: any) => [c.model, c.effort])).toEqual([['', ''], ['codex:OpenAI:gpt-other', 'medium']])
  })

  it('never receives a wake: events go to the project chat, which keeps working', async () => {
    hc.wakes = createWakeService(() => ctx, home)
    hc.wakes.enqueue({ kind: 'signal', reason: 'unit ready for review', routine: false })
    const project: WkspService = createWkspService(() => ctx, home, { name: 'game', projects: ['game'] } as any)
    stops.push(() => project.stop())
    const design = designService()
    expect('deliverWakes' in design).toBe(false)
    const a = design.create()
    await design.send(a.id, 'What if the hero could rewind time?')
    project.deliverWakes()
    await vi.waitFor(() => expect(peers.filter(p => turns(p).length)).toHaveLength(2))
    const events = peers.findIndex(p => turns(p).some(t => JSON.stringify(t.params.input).includes('[GENIO EVENTS]')))
    expect(threadOf(peers[events]).baseInstructions).toContain('operating contract')
    const pd = peerFor('rewind time')
    expect(pd).not.toBe(events)
    complete(pd, 'Rewind is great for puzzles.')
    complete(events, 'All clear, Alex.')
    expect(hc.wakes.pending()).toEqual([])
    project.deliverWakes()
    await new Promise(r => setTimeout(r, 50))
    expect(turns(peers[pd])).toHaveLength(1)
    expect(JSON.stringify(peers[pd].requests)).not.toContain('GENIO EVENTS')
    expect(design.history(a.id).some(m => m.text.includes('unit ready'))).toBe(false)
    // the project chat's event turn ended with the sentence: it is not a row there, nor in the design chat
    expect(project.history().some(m => m.text.includes('All clear'))).toBe(false)
    expect(design.history(a.id).some(m => m.text.includes('All clear'))).toBe(false)
  })

  it('shows a reply that is the sentence (a design chat has no event turns) and leaves no bubble for an empty message', async () => {
    const design = designService()
    const a = design.create()
    const seen: GenioEvent[] = []
    const off = bus.onEvent(ev => { if (ev.type === 'design-chat') seen.push(ev) })
    stops.push(off)
    await design.send(a.id, 'Anything else to decide?')
    await vi.waitFor(() => expect(peers[0] && turns(peers[0])).toHaveLength(1))
    peers[0].events.notification('item/started', { threadId: 'session-1', item: { id: 'empty', type: 'agentMessage', text: '' } })
    peers[0].events.notification('item/completed', { threadId: 'session-1', item: { id: 'empty', type: 'agentMessage', text: '' } })
    complete(0, 'All clear, Alex.')
    const rows = () => design.history(a.id).filter(m => !m.text.startsWith('Provider changed'))
    await vi.waitFor(() => expect(rows().map(m => [m.role, m.text])).toEqual([['player', 'Anything else to decide?'], ['genio', 'All clear, Alex.']]))
    // one Genio bubble (its streamed and final versions share an id); the empty message never reached the screen
    const drawn = seen.filter(ev => ev.type === 'design-chat' && ev.message.role === 'genio').map(ev => (ev as { message: ChatMessage }).message)
    expect(new Set(drawn.map(m => m.id)).size).toBe(1)
    expect(drawn.every(m => m.text === 'All clear, Alex.')).toBe(true)
  })

  it('hands off within its own chat only on a provider switch', async () => {
    const chat = (id: string, texts: [ChatMessage['role'], string][]) => fs.writeFileSync(path.join(home.data, 'design', `${id}.jsonl`),
      texts.map(([role, text], i) => JSON.stringify({ id: `${id}-${i}`, wksp: 'game', role, text, ts: `2026-10-17T10:0${i}:00.000Z` })).join('\n') + '\n')
    fs.mkdirSync(path.join(home.data, 'design'), { recursive: true })
    chat('d-0000000a', [['player', 'Old design idea: wall jumps'], ['genio', 'Wall jumps fit the pillars']])
    chat('d-0000000b', [['player', 'Other chat about the shop economy']])
    fs.writeFileSync(home.chatFile, JSON.stringify({ id: 'p-1', wksp: 'game', role: 'player', text: 'Secret project plan for the squad', ts: '2026-10-17T09:00:00.000Z' }) + '\n')
    const base = { createdAt: '2026-10-17T10:00:00.000Z', effort: '', costUsd: 0, turns: 1 }
    fs.writeFileSync(path.join(home.state, 'design-chats.json'), JSON.stringify({ chats: [
      { ...base, id: 'd-0000000a', title: 'Wall jumps', model: 'codex:OpenAI:gpt-test', providers: { active: 'claude', ids: { claude: 'claude-session' } } },
      { ...base, id: 'd-0000000b', title: 'Shop', model: '' }] }))
    const design = designService()
    await design.send('d-0000000a', 'Now think about double jumps')
    await vi.waitFor(() => expect(peers[0] && turns(peers[0])).toHaveLength(1))
    const sent = turns(peers[0])[0].params.input[0].text
    expect(sent).toContain('Old design idea: wall jumps')
    expect(sent).toContain('Now think about double jumps')
    expect(sent).not.toContain('Secret project plan')
    expect(sent).not.toContain('shop economy')
    expect(design.history('d-0000000a').some(m => m.text.startsWith('Provider changed: claude to codex'))).toBe(true)
    expect(design.history('d-0000000b').some(m => m.text.startsWith('Provider changed'))).toBe(false)
    expect(fs.readFileSync(home.chatFile, 'utf8')).not.toContain('Provider changed')
  })

  it('keeps tool cards, deletes and refusals inside the design chat', async () => {
    const design = designService()
    const a = design.create()
    design.post(a.id, { id: 'gen-1', wksp: 'game', role: 'genio', text: 'image_gen: completed', ts: new Date().toISOString() })
    expect(design.history(a.id).map(m => m.id)).toContain('gen-1')
    expect(hc.wksp.post).not.toHaveBeenCalled()
    await design.remove(a.id)
    expect(design.list()).toEqual([])
    expect(fs.existsSync(path.join(home.data, 'design', `${a.id}.jsonl`))).toBe(false)
    expect(() => design.history('../chat')).toThrow(/no longer exists/)
    await expect(design.send(a.id, 'hello')).rejects.toThrow(/no longer exists/)
    expect(designTitle('  A very long first message that keeps going well past the sixty character limit for titles\nsecond line'))
      .toBe('A very long first message that keeps going well past the si…')
  })

  it('runs Claude on its own system prompt instead of the claude_code preset, with read and web tools only', async () => {
    let options: any
    sdk.query.mockImplementation(({ options: o }: any) => {
      options = o
      return { close() {}, interrupt: async () => {}, [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } } }
    })
    const design = designService()
    const a = design.create({ model: 'claude-test' })
    await design.send(a.id, 'Help me name the game')
    await vi.waitFor(() => expect(options).toBeDefined())
    expect(typeof options.systemPrompt).toBe('string')
    expect(options.systemPrompt).toContain('# Lore chat')
    expect(options.systemPrompt).toContain('Alex')
    expect(options.model).toBe('claude-test')
    expect(options.tools).toEqual(DESIGN_NATIVE)
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Write', 'Edit', 'Agent']))
    expect(await options.canUseTool('Bash', { command: 'ls' }, {})).toMatchObject({ behavior: 'deny' })
    expect(await options.canUseTool('Write', { file_path: 'x' }, {})).toMatchObject({ behavior: 'deny' })
    expect(await options.canUseTool('WebSearch', { query: 'roguelike pillars' }, {})).toMatchObject({ behavior: 'allow' })
    expect(ctx.permissions.ask).not.toHaveBeenCalled()
  })
})

describe('designContract', () => {
  it('makes a thinking partner that starts no work, within its own budget', () => {
    const text = designContract({ gamertag: 'Alex', project: 'game' }, 'Usage mode: Balanced.')
    expect(text.length).toBeLessThanOrEqual(DESIGN_CONTRACT_BUDGET)
    expect(text).toContain('You are not Genio')
    expect(text).toContain('ask Genio')
    expect(text).toContain('be a harsh critic')
    expect(text).toContain('ask one question at a time')
    expect(text).toContain('Usage mode: Balanced.')
    expect(text).not.toMatch(/operating contract|deploy a unit/i)
  })
})
