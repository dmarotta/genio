import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { buildTools } from '../src/main/wksp-tools'
import { createToolRegistry } from '../src/main/wksp-tools'
import { createChatToolSession } from '../src/main/chat-tool-session'
import { closeChatToolBridges, openChatToolBridge, type BridgeAudit } from '../src/main/chat-tool-bridge'
import { enforceTool } from '../src/main/chat-tool-policy'
import { chatDriverCapabilities } from '../src/shared/chat-driver-capabilities'
import { agentGeneration } from '../src/main/agent-generation'
import { z } from 'zod'

let ctx: AppCtx, home: Home, root: string, abort: AbortController
let task: Task
const open: Awaited<ReturnType<typeof openChatToolBridge>>[] = []
const children: ChildProcessWithoutNullStreams[] = []
const audit: BridgeAudit[] = []
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-bridge-'))
  home = new Home(root)
  abort = new AbortController()
  task = { id: 'unit', project: 'safe', kind: 'ship', mode: 'local-only', state: 'done' } as Task
  const hc = { home, crew: { get: (id: string) => id === task.id ? task : undefined,
    merge: vi.fn(async () => ({ ok: true, message: 'merged' })), cleanup: vi.fn(),
    crewState: vi.fn(async () => 'ready'), readFile: vi.fn(async () => 'report'),
    spawn: vi.fn(), fleetView: vi.fn(async () => 'fleet') },
    backlog: { list: () => [], get: () => undefined }, decisions: { list: () => [], get: () => undefined },
    wksp: { post: vi.fn() } }
  ctx = { appRoot: process.cwd(), main: hc, homes: new Map([['main', hc]]), home: () => hc,
    settings: { get: () => ({ chatShellMode: 'ask' }) }, permissions: { ask: vi.fn(async () => true) },
    allies: { list: () => [] }, memory: { read: () => 'memory', write: vi.fn() },
    away: { state: () => ({ mode: 'online' }) },
    projects: { list: () => [{ name: 'safe', mode: 'local-only' }, { name: 'outside', mode: 'local-only' }],
      get: (name: string) => ({ name, path: root, engine: 'web', yolo: false }), update: vi.fn() },
    stats: { unlock: vi.fn() }, forge: { view: vi.fn() }, inventory: { refresh: vi.fn(async () => {}), list: vi.fn(async () => ({ items: [], total: 0 })) }
  } as unknown as AppCtx
  audit.length = 0
})
afterEach(async () => {
  abort.abort()
  for (const child of children.splice(0)) child.kill()
  await Promise.all(open.splice(0).map(b => b.close()))
  agentGeneration(ctx).stop()
  fs.rmSync(root, { recursive: true, force: true })
})
async function bridge(role: 'genio' | 'bot' = 'genio', worlds: '*' | string[] = '*', requestsPerMinute?: number) {
  const b = await openChatToolBridge(() => ctx, { home, role, worlds, signal: abort.signal }, { audit: e => audit.push(e), requestsPerMinute })
  open.push(b)
  return b
}
async function rpc(b: Awaited<ReturnType<typeof bridge>>, method: string, params?: unknown, token = b.env.GENIO_BRIDGE_TOKEN) {
  const r = await fetch(b.env.GENIO_BRIDGE_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return { status: r.status, body: await r.json() as any }
}
const call = async (b: Awaited<ReturnType<typeof bridge>>, name: string, args = {}) => (await rpc(b, 'tools/call', { name, arguments: args })).body.result

describe('authenticated local MCP bridge', () => {
  it('binds only IPv4 loopback, rotates tokens, rejects missing/wrong tokens and browser origins', async () => {
    const a = await bridge(), b = await bridge()
    expect(new URL(a.env.GENIO_BRIDGE_URL).hostname).toBe('127.0.0.1')
    expect(a.env.GENIO_BRIDGE_TOKEN).not.toBe(b.env.GENIO_BRIDGE_TOKEN)
    expect(await rpc(a, 'tools/list', {}, '')).toMatchObject({ status: 403 })
    expect(await rpc(a, 'tools/list', {}, b.env.GENIO_BRIDGE_TOKEN)).toMatchObject({ status: 403 })
    const browser = await fetch(a.env.GENIO_BRIDGE_URL, { method: 'POST', headers: { Authorization: `Bearer ${a.env.GENIO_BRIDGE_TOKEN}`, Origin: 'https://evil.example' } })
    expect(browser.status).toBe(403)
    expect((await rpc(a, 'tools/list')).body.result.tools.length).toBeGreaterThan(30)
  })
  it('rejects unknown tools and invalid schemas without exposing secrets in audit logs', async () => {
    const b = await bridge()
    expect(await call(b, 'secret-native-exec')).toMatchObject({ isError: true })
    expect(await call(b, 'memory_read', { which: 'secret-api-key' })).toMatchObject({ isError: true })
    expect(await call(b, 'memory_read', { which: 'lore' })).not.toHaveProperty('isError')
    const log = JSON.stringify(audit)
    for (const secret of [b.env.GENIO_BRIDGE_TOKEN, 'secret-api-key', 'secret-native-exec']) expect(log).not.toContain(secret)
    expect(audit).toContainEqual({ event: 'call', tool: 'memory_read' })
  })
  it('rate limits both authenticated and unauthenticated requests', async () => {
    const b = await bridge('genio', '*', 2)
    expect((await rpc(b, 'ping', {}, '')).status).toBe(403)
    expect((await rpc(b, 'ping')).status).toBe(200)
    expect((await rpc(b, 'ping')).status).toBe(429)
  })
  it('rejects oversized and malformed transport requests', async () => {
    const b = await bridge()
    for (const [body, expected] of [['{', 400], ['x'.repeat(1024 * 1024 + 1), 413]] as const) {
      const response = await fetch(b.env.GENIO_BRIDGE_URL, { method: 'POST', headers: { Authorization: `Bearer ${b.env.GENIO_BRIDGE_TOKEN}` }, body })
      expect(response.status).toBe(expected)
    }
  })
  it('closes on abort and on chat stop; a new session cannot reuse the old token', async () => {
    const a = await bridge()
    await closeChatToolBridges(ctx, home.name)
    await expect(rpc(a, 'ping')).rejects.toThrow()
    const b = await bridge()
    expect((await rpc(b, 'ping', {}, a.env.GENIO_BRIDGE_TOKEN)).status).toBe(403)
    abort.abort()
    await b.close()
    await expect(rpc(b, 'ping')).rejects.toThrow()
    await expect(bridge()).rejects.toThrow('closed')
  })
  it('revokes a bridge even when the chat closes while it is binding', async () => {
    const starting = bridge()
    const rejected = expect(starting).rejects.toThrow('closed')
    await closeChatToolBridges(ctx, home.name)
    await rejected
  })
  it('keeps the other role live when only Bot is restarted', async () => {
    const genio = await bridge(), bot = await bridge('bot')
    await closeChatToolBridges(ctx, home.name, 'bot')
    await expect(rpc(bot, 'ping')).rejects.toThrow()
    expect((await rpc(genio, 'ping')).status).toBe(200)
  })
  it('bounds concurrent requests before running another handler', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    ctx.main.crew.readFile = vi.fn(async () => { await waiting; return 'report' })
    const b = await bridge()
    const calls = Array.from({ length: 8 }, () => call(b, 'read_task_file', { task: 'unit', which: 'report' }))
    try {
      await vi.waitFor(() => expect(ctx.main.crew.readFile).toHaveBeenCalledTimes(8))
      expect((await rpc(b, 'ping')).status).toBe(429)
    } finally { release(); await Promise.all(calls) }
  })
  it('speaks stdio MCP from the shipped standalone entry and revokes on EOF', async () => {
    const b = await bridge()
    const child = spawn(process.execPath, [b.entry], { env: { ...process.env, ...b.env }, windowsHide: true, stdio: 'pipe' })
    children.push(child)
    const replies: any[] = []
    let data = '', stderr = ''
    child.stdout.on('data', chunk => {
      data += chunk.toString()
      let end: number
      while ((end = data.indexOf('\n')) >= 0) { replies.push(JSON.parse(data.slice(0, end))); data = data.slice(end + 1) }
    })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n')
    await vi.waitFor(() => expect(replies.find(r => r.id === 10)?.result.serverInfo.name).toBe('genio'))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'memory_read', arguments: { which: 'lore' } } }) + '\n')
    await vi.waitFor(() => expect(replies.find(r => r.id === 11)?.result.content[0].text).toBe('memory'))
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.stdin.end()
    await ended
    await expect(rpc(b, 'ping')).rejects.toThrow()
    expect(stderr).not.toContain(b.env.GENIO_BRIDGE_TOKEN)
  })
})

describe('authority and unchanged deterministic handlers', () => {
  it('returns SDK-equivalent schemas and results, including errors and defaults', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const defs = buildTools(sdk.tool, () => ctx, home, 'genio')
    const b = await bridge()
    const list = (await rpc(b, 'tools/list')).body.result.tools
    expect(list.map((t: any) => t.name)).toEqual(defs.map(t => t.name))
    for (const def of defs) {
      expect(list.find((t: any) => t.name === def.name).inputSchema).toEqual(z.toJSONSchema(z.strictObject(def.inputSchema), { io: 'input' }))
    }
    for (const [name, args] of [['memory_read', { which: 'lore' }], ['unit_state', { task: 'unit' }],
      ['read_task_file', { task: 'unit', which: 'report' }], ['quest_list', {}], ['merge', { task: 'unit' }],
      ['merge', { task: 'unit', player_words: 'land this' }]] as const) {
      const direct = await defs.find(t => t.name === name)!.handler(args, {} as any)
      expect(await call(b, name, args)).toEqual(direct)
    }
  })
  it('does not accept model authority, including a forged role, chat, or allowed worlds', async () => {
    const b = await bridge('genio', ['safe'])
    for (const extra of [{ role: 'genio' }, { chat: 'main' }, { worlds: '*' }, { home: 'main' }]) {
      expect(await call(b, 'memory_read', { which: 'lore', ...extra })).toMatchObject({ isError: true })
    }
    expect(await call(b, 'world_posture', { world: 'outside' })).toMatchObject({ isError: true })
    task.project = 'outside'
    expect(await call(b, 'merge', { task: 'unit', player_words: 'yes', world: 'safe' })).toMatchObject({ isError: true })
    expect(await call(b, 'merge', { task: 'unit', player_words: 'yes' })).toMatchObject({ isError: true })
    expect(ctx.main.crew.merge).not.toHaveBeenCalled()
    expect(await call(b, 'world_sync')).toMatchObject({ isError: true })
    const worlds = await call(b, 'world_list')
    expect(worlds.content[0].text).toContain('safe')
    expect(worlds.content[0].text).not.toContain('outside')
  })
  it('requires configured ally worlds and keeps tasks in the bound chat', async () => {
    const allyHome = new Home(path.join(root, 'ally'), 'ally', home)
    const allyCtx = { ...ctx.main, home: allyHome, crew: { ...ctx.main.crew, get: () => undefined } }
    ctx.homes.set('ally', allyCtx)
    ctx.home = name => ctx.homes.get(name)!
    ctx.allies.list = () => [{ name: 'ally', projects: ['safe'] }] as any
    const binding = { home: allyHome, role: 'ally' as const, worlds: ['safe'], signal: abort.signal }
    expect(() => createChatToolSession(() => ctx, { ...binding, worlds: '*' })).toThrow('scope')
    expect(() => createChatToolSession(() => ctx, { ...binding, worlds: ['outside'] })).toThrow('authority')
    const session = createChatToolSession(() => ctx, binding)
    binding.worlds.push('outside')
    expect(await session.call('world_posture', { world: 'outside' })).toMatchObject({ isError: true })
    expect(await session.call('read_task_file', { task: 'unit', which: 'report' })).toMatchObject({ isError: true })
  })
  it('keeps Bot read-only even with Auto-loot, YOLO and fabricated player words', async () => {
    task.yolo = true
    ctx.settings.get = () => ({ chatShellMode: 'all' }) as any
    const b = await bridge('bot')
    for (const name of ['deploy', 'merge', 'world_update', 'asset_place', 'generate_image', 'choice_resolve', 'memory_write', 'ping', 'quest_add']) {
      expect(await call(b, name, { player_words: 'yes', role: 'genio' })).toMatchObject({ isError: true })
    }
    expect(await call(b, 'status_report', { file: true })).toMatchObject({ isError: true })
    expect(await call(b, 'memory_read', { which: 'lore' })).not.toHaveProperty('isError')
    expect(ctx.main.crew.merge).not.toHaveBeenCalled()
  })
  it('preserves merge, Auto-loot, AFK and PR checks', async () => {
    const b = await bridge()
    expect(await call(b, 'merge', { task: 'unit' })).toMatchObject({ isError: true })
    expect(await call(b, 'world_update', { world: 'safe', auto_loot: true })).toMatchObject({ isError: true })
    expect(ctx.projects.update).not.toHaveBeenCalled()
    task.yolo = true
    expect(await call(b, 'merge', { task: 'unit' })).not.toHaveProperty('isError')
    ctx.away.state = () => ({ mode: 'afk', held: [], returnSummaryPending: false })
    expect(await call(b, 'merge', { task: 'unit', player_words: 'yes' })).toMatchObject({ isError: true })
    ctx.away.state = () => ({ mode: 'online', held: [], returnSummaryPending: false })
    task.pr = { url: 'https://example.test/pr/1' } as Task['pr']
    for (const check of [{ isDraft: true }, { checks: 'failing', failing: ['test'] }, { checks: 'pending', pending: ['test'] }]) {
      ctx.forge.view = vi.fn(async () => ({ ok: true, ...check })) as any
      expect(await call(b, 'merge', { task: 'unit' })).toMatchObject({ isError: true })
    }
    expect(ctx.main.crew.merge).toHaveBeenCalledTimes(1)
  })
  it('preserves placement consent, forbidden directories and cross-chat ownership at the bridge', async () => {
    fs.mkdirSync(home.data, { recursive: true })
    fs.writeFileSync(path.join(home.data, 'generation-jobs.json'), JSON.stringify([
      { id: 'run', wksp: 'main', world: 'safe', provider: 'codex', status: 'completed', images: [] },
      { id: 'other', wksp: 'ally', world: 'safe', provider: 'codex', status: 'completed', images: [] }
    ]))
    const b = await bridge()
    const args = { run: 'run', world: 'safe', path: 'Assets/a.png' }
    expect(await call(b, 'asset_place', args)).toMatchObject({ isError: true })
    const sdk = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'asset_place')!
    for (const dest of ['../escape.png', 'Library/a.png', 'vendor/a.png', 'Assets/script.ts']) {
      const input = { ...args, path: dest, player_words: 'place it' }
      expect(await call(b, 'asset_place', input)).toEqual(await sdk.invoke(input))
      expect(await call(b, 'asset_place', input)).toMatchObject({ isError: true })
    }
    expect(await call(b, 'asset_place', { ...args, run: 'other', player_words: 'place it' })).toMatchObject({ isError: true })
    fs.mkdirSync(path.join(root, 'Assets'))
    fs.writeFileSync(path.join(root, 'Assets', 'a.png'), 'original')
    const existing = await call(b, 'asset_place', { ...args, player_words: 'place it' })
    expect(existing.isError).toBe(true)
    expect(existing.content[0].text).toContain('overwrite_words')
    expect(fs.readFileSync(path.join(root, 'Assets', 'a.png'), 'utf8')).toBe('original')
  })
})

describe('common permission enforcement and runtime capabilities', () => {
  it('uses the same broker and live approval modes for Claude native tools', async () => {
    let mode: 'ask' | 'auto-shell' | 'all' = 'ask'
    const policy = { role: 'genio' as const, chat: 'main', shellMode: () => mode, permissions: ctx.permissions, signal: abort.signal }
    const shell = { runtime: 'claude' as const, name: 'Bash', input: { command: 'npm install' } }
    expect(await enforceTool(policy, shell)).toEqual({ behavior: 'allow' })
    expect(ctx.permissions.ask).toHaveBeenCalledWith({ wksp: 'main', tool: 'Bash', input: 'npm install', reason: 'Not on the read-only list' })
    ctx.permissions.ask = vi.fn(async () => false)
    expect(await enforceTool(policy, shell)).toMatchObject({ behavior: 'deny' })
    for (const value of ['auto-shell', 'all'] as const) { mode = value; expect(await enforceTool(policy, shell)).toEqual({ behavior: 'allow' }) }
    expect(await enforceTool({ ...policy, role: 'bot' }, shell)).toMatchObject({ behavior: 'deny' })
    abort.abort()
    expect(await enforceTool(policy, shell)).toMatchObject({ behavior: 'deny' })
  })
  it('never promotes a native tool alias or an unconstrained runtime, even in YOLO', async () => {
    for (const runtime of ['codex', 'gemini', 'opencode'] as const) {
      expect(chatDriverCapabilities(runtime).mode).toBe('consultation-only')
      for (const name of ['exec_command', 'run_shell_command', 'bash', 'apply_patch', 'edit', 'spawn_agent', 'task', 'mcp__genio__deploy']) {
        expect(await enforceTool({ role: 'genio', chat: 'main', shellMode: () => 'all', permissions: ctx.permissions },
          { runtime, name, input: { command: 'echo unsafe' } })).toMatchObject({ behavior: 'deny' })
      }
    }
    expect(ctx.permissions.ask).not.toHaveBeenCalled()
  })
  it('does not grant a permission approved after the chat closed', async () => {
    let answer!: (value: boolean) => void
    ctx.permissions.ask = () => new Promise(resolve => { answer = resolve })
    const decision = enforceTool({ role: 'genio', chat: 'main', shellMode: () => 'ask', permissions: ctx.permissions, signal: abort.signal },
      { runtime: 'claude', name: 'Bash', input: { command: 'npm install' } })
    abort.abort()
    answer(true)
    expect(await decision).toMatchObject({ behavior: 'deny', message: 'Chat closed.' })
  })
})
