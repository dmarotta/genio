import fs from 'node:fs'
import http from 'node:http'
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

import { createMcpGateway, mcpServerEnv, type McpCaller, type McpGateway } from '../src/main/mcp-gateway'
import { readMcpServers, removeMcpServer, saveMcpServer } from '../src/main/mcp-servers'
import { mcpServersFor } from '../src/shared/mcp'

const RELAY = path.join(__dirname, '..', 'resources', 'genio-mcp-relay.mjs')
const SERVER = path.join(__dirname, 'fixtures', 'mcp-env-server.mjs')
const SERVER_SECRET = 'srv-secret-value-0123456789abcdef'
const FAL = 'fal-key-of-the-unit-0000-1111'

let dir: string, worktree: string, gateway: McpGateway
const relays: ChildProcessWithoutNullStreams[] = []
const failures: string[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mcp-gw-'))
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mcp-wt-'))
  failures.length = 0
  gateway = createMcpGateway()
})
afterEach(async () => {
  for (const r of relays.splice(0)) r.kill()
  await gateway.close()
  // A local server the gateway stopped may still hold its cwd for a moment on Windows.
  for (const d of [dir, worktree]) {
    for (let i = 0; ; i++) {
      try { fs.rmSync(d, { recursive: true, force: true }); break } catch (e) {
        if (i > 30) throw e
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }
})

const caller = (o: Partial<McpCaller> = {}): McpCaller => ({
  id: 'u1', project: 'alpha', cwd: worktree, dataDir: dir, logFile: path.join(dir, 'u1', 'mcp-calls.jsonl'),
  onFailure: (t) => failures.push(t), ...o
})
const addLocal = (name = 'envsrv', project?: string, chatOnly?: boolean, id?: string) =>
  saveMcpServer({ id, name, command: process.execPath, args: [SERVER], secrets: [{ name: 'SERVER_TOKEN', value: SERVER_SECRET }], project, chatOnly }, dir, ['alpha', 'beta'])
const logLines = (file = path.join(dir, 'u1', 'mcp-calls.jsonl')): Record<string, unknown>[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/** A relay as a unit's agent starts it: the unit's whole environment (keys included), JSON-RPC on stdio. */
function relay(server: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [RELAY, server], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', FAL_KEY: FAL, UTHANA_API_KEY: 'uthana-unit-key', ...env }, cwd: worktree })
  relays.push(child)
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
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }
  return { child, rpc, init, exited }
}

describe('the gateway with a local server', () => {
  it('lists and calls tools through the relay; the server gets only system variables and its own secret, in the worktree', async () => {
    process.env.GENIO_TEST_PARENT_ONLY = 'main-process-variable'
    addLocal()
    const servers = mcpServersFor(readMcpServers(dir), 'alpha', 'unit')
    const grant = await gateway.grant(caller(), servers)
    expect(grant.env.GENIO_MCP_GATEWAY).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(grant.env.GENIO_MCP_SECRET).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(grant)).not.toContain(SERVER_SECRET)
    const r = relay('envsrv', grant.env)
    await r.init()
    const list = await r.rpc('tools/list')
    expect(list.result?.tools?.map((t) => t.name)).toEqual(['echo', 'env_dump', 'fail'])
    expect((await r.rpc('tools/call', { name: 'echo', arguments: { text: 'private words' } })).result?.content?.[0].text).toBe('ECHO: private words')
    const dump = JSON.parse((await r.rpc('tools/call', { name: 'env_dump', arguments: {} })).result!.content![0].text) as { env: Record<string, string>; cwd: string }
    delete process.env.GENIO_TEST_PARENT_ONLY
    expect(dump.env.SERVER_TOKEN).toBe(SERVER_SECRET)
    for (const k of ['FAL_KEY', 'UTHANA_API_KEY', 'GENIO_MCP_SECRET', 'GENIO_MCP_GATEWAY', 'GENIO_TEST_PARENT_ONLY', 'ELECTRON_RUN_AS_NODE']) expect(dump.env[k], k).toBeUndefined()
    expect(Object.keys(dump.env).every((k) => k === 'SERVER_TOKEN' || mcpServerEnv({}, { [k]: 'x' })[k] === 'x'), Object.keys(dump.env).join(',')).toBe(true)
    expect(fs.realpathSync(dump.cwd)).toBe(fs.realpathSync(worktree))

    const log = logLines()
    expect(log).toEqual([
      expect.objectContaining({ server: 'envsrv', tools: 3 }),
      expect.objectContaining({ server: 'envsrv', tool: 'echo', ok: true }),
      expect.objectContaining({ server: 'envsrv', tool: 'env_dump', ok: true })
    ])
    for (const l of log) expect(typeof l.at).toBe('string')
    const raw = fs.readFileSync(path.join(dir, 'u1', 'mcp-calls.jsonl'), 'utf8')
    expect(raw).not.toContain('private words')
    expect(raw).not.toContain(SERVER_SECRET)
    expect(failures).toEqual([])
  })

  it('logs a failed call and reports it once on the timeline until the tool works again', async () => {
    addLocal()
    const r = relay('envsrv', (await gateway.grant(caller(), readMcpServers(dir))).env)
    await r.init()
    expect((await r.rpc('tools/call', { name: 'fail', arguments: {} })).result?.isError).toBe(true)
    await r.rpc('tools/call', { name: 'fail', arguments: {} })
    expect((await r.rpc('tools/call', { name: 'nope', arguments: {} })).error?.message).toMatch(/not found/i)
    expect(failures).toEqual([
      'MCP server envsrv: fail failed (the tool reported an error).',
      'MCP server envsrv: nope failed (the server returned an error).'
    ])
    expect(logLines().filter((l) => l.tool).map((l) => [l.tool, l.ok])).toEqual([['fail', false], ['fail', false], ['nope', false]])
  })

  it('refuses a wrong secret, a server outside the grant and one scoped to another project', async () => {
    addLocal('envsrv')
    addLocal('beta-only', 'beta')
    const list = readMcpServers(dir)
    const grant = await gateway.grant(caller(), list.filter((s) => s.name === 'envsrv'))
    expect(await relay('envsrv', { ...grant.env, GENIO_MCP_SECRET: 'f'.repeat(64) }).exited).toBe(0)
    expect(await relay('beta-only', grant.env).exited).toBe(0)
    const all = await gateway.grant(caller(), list)
    expect(await relay('beta-only', all.env).exited).toBe(0)
    expect(logLines()).toEqual([])
  })

  it('refuses a Chat only server to a unit, even when its grant names it and the relay asks for it; the chat gets it', async () => {
    addLocal('envsrv')
    addLocal('mail', undefined, true)
    // The unit's caller hands the gateway the whole list, Chat only server included.
    const grant = await gateway.grant(caller(), readMcpServers(dir))
    expect(grant.servers.map((s) => s.name)).toEqual(['envsrv'])
    expect(await relay('mail', grant.env).exited).toBe(0)
    // A unit with no kind set is a unit too.
    expect(await relay('mail', (await gateway.grant(caller({ id: 'u2', kind: 'unit' }), readMcpServers(dir))).env).exited).toBe(0)
    expect(logLines()).toEqual([])

    const chat = await gateway.grant(caller({ id: 'chat:alpha', kind: 'chat', logFile: path.join(dir, 'chat', 'mcp-calls.jsonl') }), readMcpServers(dir))
    expect(chat.servers.map((s) => s.name)).toEqual(['envsrv', 'mail'])
    const r = relay('mail', chat.env)
    await r.init()
    expect((await r.rpc('tools/call', { name: 'echo', arguments: { text: 'inbox' } })).result?.content?.[0].text).toBe('ECHO: inbox')
  })

  it('stops a running unit at once when the player sets its server to Chat only', async () => {
    const [s] = addLocal()
    const grant = await gateway.grant(caller(), readMcpServers(dir))
    const r = relay('envsrv', grant.env)
    await r.init()
    expect((await r.rpc('tools/call', { name: 'echo', arguments: { text: 'x' } })).result?.content?.[0].text).toBe('ECHO: x')
    addLocal('envsrv', undefined, true, s.id)
    const res = await r.rpc('tools/call', { name: 'echo', arguments: { text: 'y' } })
    expect(res.result?.isError).toBe(true)
    expect(res.result?.content?.[0].text).toMatch(/no longer applies to this project or to units/)
    expect(await r.exited).toBe(0)
    expect(await relay('envsrv', grant.env).exited).toBe(0)
  })

  it('stops a removed server at once and closes the relays when the unit stops', async () => {
    const [s] = addLocal()
    const grant = await gateway.grant(caller(), readMcpServers(dir))
    const r = relay('envsrv', grant.env)
    await r.init()
    removeMcpServer(s.id, dir)
    const res = await r.rpc('tools/call', { name: 'echo', arguments: { text: 'x' } })
    expect(res.result?.isError).toBe(true)
    expect(res.result?.content?.[0].text).toMatch(/removed this server/)
    expect(await r.exited).toBe(0)

    addLocal('again')
    const g2 = await gateway.grant(caller(), readMcpServers(dir))
    const r2 = relay('again', g2.env)
    await r2.init()
    g2.revoke()
    expect(await r2.exited).toBe(0)
    expect(await relay('again', g2.env).exited).toBe(0)
  })

  it('reports a server that cannot start', async () => {
    saveMcpServer({ name: 'missing', command: path.join(worktree, 'no-such-program.exe'), args: [], secrets: [] }, dir, [])
    const r = relay('missing', (await gateway.grant(caller(), readMcpServers(dir))).env)
    const res = await r.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(res.error?.message).toMatch(/^missing is unavailable: /)
    expect(failures).toEqual([expect.stringMatching(/^MCP server missing: could not start \(/)])
  })
})

describe('the gateway with a remote server', () => {
  let server: http.Server
  let url = ''
  const seen: { key?: string; protocol?: string }[] = []
  beforeEach(async () => {
    seen.length = 0
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ key: req.headers['x-api-key'] as string | undefined, protocol: req.headers['mcp-protocol-version'] as string | undefined })
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (req.headers['x-api-key'] !== 'remote-secret-header-value') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return }
        const m = JSON.parse(body)
        if (m.id === undefined) { res.writeHead(202); res.end(); return }
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } }
          : m.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'REMOTE-OK' }] }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it('adds the secret header from the store, which the unit never sees', async () => {
    saveMcpServer({ name: 'remote', url, secrets: [{ name: 'X-Api-Key', value: 'remote-secret-header-value' }] }, dir, [])
    const grant = await gateway.grant(caller(), readMcpServers(dir))
    const r = relay('remote', grant.env)
    await r.init()
    expect((await r.rpc('tools/list')).result?.tools?.map((t) => t.name)).toEqual(['lookup'])
    expect((await r.rpc('tools/call', { name: 'lookup', arguments: { q: 'a' } })).result?.content?.[0].text).toBe('REMOTE-OK')
    expect(seen.every((s) => s.key === 'remote-secret-header-value')).toBe(true)
    // After initialize the negotiated version goes with every request.
    expect(seen.at(-1)?.protocol).toBe('2025-06-18')
    expect(logLines().map((l) => l.tool ?? `tools:${l.tools}`)).toEqual(['tools:1', 'lookup'])
  })

  it('tells the unit to stop and ask when the server refuses the credentials', async () => {
    saveMcpServer({ name: 'remote', url, secrets: [{ name: 'X-Api-Key', value: 'wrong-header-value' }] }, dir, [])
    const r = relay('remote', (await gateway.grant(caller(), readMcpServers(dir))).env)
    const init = await r.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(init.error?.message).toContain('needs-decision key=mcp-auth')
    const call = await r.rpc('tools/call', { name: 'lookup', arguments: {} })
    expect(call.result?.isError).toBe(true)
    expect(failures).toEqual(['MCP server remote: lookup failed (the server refused its credentials, HTTP 401).'])
    expect(JSON.stringify([init, call, failures, logLines()])).not.toContain('wrong-header-value')
  })
})

describe('the scrubbed environment', () => {
  it('keeps system variables and the server secrets, nothing else', () => {
    const env = mcpServerEnv({ TOKEN: 't' }, { PATH: 'p', Path: 'p2', FAL_KEY: 'f', UTHANA_API_KEY: 'u', OPENROUTER_API_KEY: 'o', CLAUDE_CONFIG_DIR: 'c', TEMP: 'tmp', BASH_FUNC: '() { x; }' })
    expect(env.TOKEN).toBe('t')
    for (const k of ['FAL_KEY', 'UTHANA_API_KEY', 'OPENROUTER_API_KEY', 'CLAUDE_CONFIG_DIR', 'BASH_FUNC']) expect(env[k]).toBeUndefined()
    expect(env.PATH ?? env.Path).toBeDefined()
  })
})
