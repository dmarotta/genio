import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice(4), 'hex').toString('utf8')
  }
}))

import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { chatMcpServers, type ChatMcp } from '../src/main/chat-mcp'
import { decideTool, enforceTool } from '../src/main/chat-tool-policy'
import { createMcpGateway, type McpGateway } from '../src/main/mcp-gateway'
import { saveMcpServer, setMcpSignIn } from '../src/main/mcp-servers'
import { settingsPath } from '../src/shared/settings-pages'

const ROOT = path.join(__dirname, '..')
const SERVER = path.join(__dirname, 'fixtures', 'mcp-env-server.mjs')
const SECRET = 'chat-server-secret-0123456789'

let dir: string, cwd: string, gateway: McpGateway
const children: ChildProcessWithoutNullStreams[] = []
const calls: string[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-mcp-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-cwd-'))
  calls.length = 0
  gateway = createMcpGateway()
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await gateway.close()
  for (const d of [dir, cwd]) {
    for (let i = 0; ; i++) {
      try { fs.rmSync(d, { recursive: true, force: true }); break } catch (e) {
        if (i > 30) throw e
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }
})

const opts = (o: Partial<ChatMcp> = {}): ChatMcp => ({
  chat: 'alpha-base', project: 'alpha', cwd, dataDir: dir, logFile: path.join(dir, 'chat', 'mcp-calls.jsonl'),
  command: process.execPath, appRoot: ROOT, gateway, onSuccess: (s, t, chatOnly) => calls.push(`${s}/${t}${chatOnly ? ' (chat only)' : ''}`), ...o
})
const addLocal = (name: string, project?: string, chatOnly?: boolean) =>
  saveMcpServer({ name, command: process.execPath, args: [SERVER], secrets: [{ name: 'SERVER_TOKEN', value: SECRET }], project, chatOnly }, dir, ['alpha', 'beta'])

/** Start an entry exactly as Claude Code starts a stdio MCP server: its command, args and env over the chat's environment. */
function start(entry: McpStdioServerConfig) {
  const child = spawn(entry.command, entry.args ?? [], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', FAL_KEY: 'chat-fal-key', ...entry.env }, cwd })
  children.push(child)
  const waiting = new Map<number, (m: { result?: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean }; error?: { message: string } }) => void>()
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id) })
  const exited = new Promise<number | null>((r) => child.on('exit', r))
  let id = 0
  const rpc = (method: string, params?: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>((resolve) => {
    const n = ++id
    waiting.set(n, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
  const init = async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-chat', version: '1' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return r
  }
  return { rpc, init, exited }
}

describe('the Claude chat gets the player servers through the gateway', () => {
  it('gives one relay entry per server in scope: all projects plus the chat project, no alwaysLoad, no secret', async () => {
    addLocal('everywhere')
    addLocal('alpha-only', 'alpha')
    addLocal('beta-only', 'beta')
    const entries = await chatMcpServers(opts())
    expect(Object.keys(entries)).toEqual(['everywhere', 'alpha-only'])
    const e = entries.everywhere
    expect(e).toMatchObject({ type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'resources', 'genio-mcp-relay.mjs'), 'everywhere'] })
    expect(e.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', GENIO_MCP_GATEWAY: expect.stringMatching(/^127\.0\.0\.1:\d+$/), GENIO_MCP_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/) })
    // Deferred behind tool search: only Genio's own server is always loaded.
    for (const x of Object.values(entries)) expect(x).not.toHaveProperty('alwaysLoad')
    expect(JSON.stringify(entries)).not.toContain(SECRET)
    // A chat with no project gets only the servers for all projects.
    expect(Object.keys(await chatMcpServers(opts({ project: '' })))).toEqual(['everywhere'])
  })

  it('gets a Chat only server like any other and calls it through the gateway', async () => {
    addLocal('everywhere')
    addLocal('mail', undefined, true)
    addLocal('beta-docs', 'beta', true)
    const entries = await chatMcpServers(opts())
    expect(Object.keys(entries)).toEqual(['everywhere', 'mail'])
    const r = start(entries.mail)
    await r.init()
    expect((await r.rpc('tools/call', { name: 'echo', arguments: { text: 'inbox' } })).result?.content?.[0].text).toBe('ECHO: inbox')
    const e = start(entries.everywhere)
    await e.init()
    await e.rpc('tools/call', { name: 'echo', arguments: { text: 'x' } })
    expect(calls).toEqual(['mail/echo (chat only)', 'everywhere/echo'])
  })

  it('gives nothing when the player added no server', async () => {
    expect(await chatMcpServers(opts())).toEqual({})
  })

  it('lists and calls a local server tool, logs it in the chat folder and counts the achievement', async () => {
    addLocal('envsrv')
    const r = start((await chatMcpServers(opts())).envsrv)
    await r.init()
    expect((await r.rpc('tools/list')).result?.tools?.map((t) => t.name)).toEqual(['echo', 'env_dump', 'fail'])
    expect((await r.rpc('tools/call', { name: 'echo', arguments: { text: 'hello' } })).result?.content?.[0].text).toBe('ECHO: hello')
    const dump = JSON.parse((await r.rpc('tools/call', { name: 'env_dump', arguments: {} })).result!.content![0].text) as { env: Record<string, string>; cwd: string }
    expect(dump.env.SERVER_TOKEN).toBe(SECRET)
    expect(dump.env.FAL_KEY).toBeUndefined()
    expect(fs.realpathSync(dump.cwd)).toBe(fs.realpathSync(cwd))
    expect(calls).toEqual(['envsrv/echo', 'envsrv/env_dump'])
    const log = fs.readFileSync(path.join(dir, 'chat', 'mcp-calls.jsonl'), 'utf8')
    expect(log).toMatch(/"tool":"echo","ok":true/)
    expect(log).not.toContain('hello')
  })

  it('revokes the previous query secret when the chat starts a new one', async () => {
    addLocal('envsrv')
    const first = (await chatMcpServers(opts())).envsrv
    const r = start(first)
    await r.init()
    const second = (await chatMcpServers(opts())).envsrv
    expect(second.env!.GENIO_MCP_SECRET).not.toBe(first.env!.GENIO_MCP_SECRET)
    expect(await r.exited).toBe(0)
    expect(await start(first).exited).toBe(0)
  })

  it('tells the player in plain words to sign in again, with no keyed choice and no call to the server', async () => {
    const [s] = saveMcpServer({ name: 'tracker', url: 'http://127.0.0.1:9/mcp', secrets: [] }, dir, [])
    setMcpSignIn(s.id, true, dir)
    const r = start((await chatMcpServers(opts())).tracker)
    const init = await r.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-chat', version: '1' } })
    expect(init.error?.message).toBe(`tracker needs the player to sign in to it again. Do not retry this server; tell the player in plain words to sign in to tracker again in ${settingsPath('harnesses')}.`)
    const call = await r.rpc('tools/call', { name: 'lookup', arguments: {} })
    expect(call.result?.isError).toBe(true)
    expect(call.result?.content?.[0].text).toContain(`tell the player in plain words to sign in to tracker again in ${settingsPath('harnesses')}`)
    expect(call.result?.content?.[0].text).not.toContain('needs-decision')
  })
})

describe('the chat policy for player MCP tools', () => {
  const names = ['mcp__github__list_workflow_runs', 'mcp__sentry__get_remote_config', 'mcp__datadog__monitor_list', 'mcp__linear__create_issue', 'mcp__envsrv__echo']

  it('asks in the Ask modes and runs in YOLO, whatever words the tool name contains', () => {
    for (const n of names) {
      expect(decideTool('genio', n, { a: 1 }, 'ask'), n).toMatchObject({ behavior: 'ask', input: '{"a":1}' })
      expect(decideTool('genio', n, { a: 1 }, 'auto-shell'), n).toMatchObject({ behavior: 'ask' })
      expect(decideTool('genio', n, { a: 1 }, 'all'), n).toEqual({ behavior: 'allow' })
    }
  })

  it('denies them to the Bot in every mode', () => {
    for (const n of names) for (const mode of ['ask', 'auto-shell', 'all'] as const) expect(decideTool('bot', n, {}, mode).behavior, n).toBe('deny')
  })

  it('puts Claude Code\'s own delegation tools under the approval mode, keeps them from the Bot, and Genio tools allowed', () => {
    for (const n of ['Workflow', 'RemoteTrigger', 'Monitor', 'CronCreate', 'TaskCreate', 'ScheduleWakeup', 'ListAgents', 'SendMessage', 'Agent']) {
      expect(decideTool('genio', n, {}, 'ask').behavior, n).toBe('ask')
      expect(decideTool('genio', n, {}, 'all').behavior, n).toBe('allow')
      expect(decideTool('bot', n, {}, 'all').behavior, n).toBe('deny')
    }
    for (const n of ['mcp__genio__deploy', 'mcp__genio__merge', 'mcp__genio__fal_generate']) expect(decideTool('genio', n, {}, 'ask')).toEqual({ behavior: 'allow' })
  })

  it('goes to the player prompt in Ask mode and runs on their yes', async () => {
    const asked: string[] = []
    const policy = (yes: boolean, mode: 'ask' | 'all' = 'ask') => ({ role: 'genio' as const, chat: 'alpha-base', shellMode: () => mode, player: 'Alex',
      permissions: { ask: async (r: { tool: string }) => { asked.push(r.tool); return yes } } as never })
    expect(await enforceTool(policy(true), { runtime: 'claude', name: 'mcp__github__list_workflow_runs', input: {} })).toEqual({ behavior: 'allow' })
    expect(await enforceTool(policy(false), { runtime: 'claude', name: 'mcp__github__list_workflow_runs', input: {} })).toEqual({ behavior: 'deny', message: 'Alex declined mcp__github__list_workflow_runs.' })
    expect(await enforceTool(policy(false, 'all'), { runtime: 'claude', name: 'mcp__github__list_workflow_runs', input: {} })).toEqual({ behavior: 'allow' })
    expect(asked).toEqual(['mcp__github__list_workflow_runs', 'mcp__github__list_workflow_runs'])
  })

  it('never reaches the Codex chat: its native tools stay closed even in YOLO', async () => {
    const policy = { role: 'genio' as const, chat: 'alpha-base', shellMode: () => 'all' as const, permissions: { ask: async () => true } as never }
    expect((await enforceTool(policy, { runtime: 'codex', name: 'mcp__envsrv__echo', input: {} })).behavior).toBe('deny')
  })
})

describe('workspace.ts wiring', () => {
  const workspace = fs.readFileSync(path.join(ROOT, 'src', 'main', 'workspace.ts'), 'utf8')
  it('adds the player servers beside genio for the Claude chat only; the Bot keeps only its bridge', () => {
    expect(workspace).toMatch(/mcpServers: \{ genio: server, \.\.\.\(role === 'bot' \? \{\} : await chatMcpServers\(\{/)
    expect(workspace).toMatch(/if \(role === 'bot'\) \{[\s\S]*?opts\.mcpServers = \{ genio: \{ command: process\.execPath, args: \[bridge\.entry\]/)
    expect(workspace).toMatch(/createSdkMcpServer\(\{ name: 'genio', version: '1\.0\.0', tools: toolDefs, alwaysLoad: true \}\)/)
    expect(workspace).toMatch(/mcpGateway\(\)\.revoke\(chatMcpCaller\(name\)\)/)
  })
  it('counts a Chat only tool in the chat for its own achievement', () => {
    expect(workspace).toMatch(/onSuccess: \(_server, _tool, chatOnly\) => safe\(\(\) => \{\s*getCtx\(\)\.stats\.unlock\('mcp-chat-call'\)\s*if \(chatOnly\) getCtx\(\)\.stats\.unlock\('mcp-chat-only'\)/)
  })
})
