/**
 * Opt-in round trip against the real Claude Code and Codex CLIs (docs/mcp-servers.md):
 *   npm run test:e2e -- mcp-gateway
 * A unit's exact MCP flags, its relays and Genio's gateway, with a local stdio test server. The CLIs
 * talk to fake model endpoints in throwaway homes: no account, no login, no model usage, and the
 * player's ~/.claude and ~/.codex are never read or written. Started through Genio's own PTY spawn
 * (resolveSpawn), so the npm .cmd shim quoting is the one units get.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice(4), 'hex').toString('utf8')
  }
}))

import { which } from '../../src/main/util'
import { resolveSpawn, utf8ConsoleSpawn } from '../../src/main/terminals'
import { createMcpGateway, type McpGateway } from '../../src/main/mcp-gateway'
import { readMcpServers, saveMcpServer } from '../../src/main/mcp-servers'
import { claudeUnitMcpConfig, unitMcpLaunch, type McpRelays } from '../../src/main/unit-mcp'
import { fakeAnthropic, fakeResponses, type FakeModel } from '../support/fake-model-endpoints'

const RELAY = path.join(__dirname, '..', '..', 'resources', 'genio-mcp-relay.mjs')
const SERVER = path.join(__dirname, '..', 'fixtures', 'mcp-env-server.mjs')
const SECRET = 'server-only-secret-0123456789'
const UNIT_FAL = 'unit-fal-key-must-not-leak-42'
const claude = which('claude')
const codex = which('codex')

let root: string, data: string, worktree: string, gateway: McpGateway, model: FakeModel | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-e2e-mcp-'))
  data = path.join(root, 'data')
  worktree = path.join(root, 'worktree')
  for (const d of [data, worktree]) fs.mkdirSync(d, { recursive: true })
  gateway = createMcpGateway()
  saveMcpServer({ name: 'envsrv', command: process.execPath, args: [SERVER], secrets: [{ name: 'SERVER_TOKEN', value: SECRET }] }, data, [])
})
afterEach(async () => {
  await model?.close()
  model = undefined
  await gateway.close()
  for (let i = 0; i < 30; i++) {
    try { fs.rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
  }
})

/** The unit's environment: the test's isolated one, no agent or model variables of the caller, and a FAL key the server must not see. */
function unitEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || /^(CLAUDE|ANTHROPIC|CODEX|OPENAI|GENIO_)/i.test(k) || k === 'CLAUDECODE' || k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  return { ...env, FAL_KEY: UNIT_FAL, DISABLE_AUTOUPDATER: '1', NO_COLOR: '1', ...extra }
}

function run(file: string, args: string[], env: Record<string, string>, ms = 150_000): Promise<string> {
  const sp = utf8ConsoleSpawn(resolveSpawn(file, args))
  return new Promise((resolve) => {
    let out = ''
    const p = pty.spawn(sp.file, sp.args, { cwd: worktree, env, cols: 200, rows: 50 })
    const timer = setTimeout(() => { p.kill(); resolve(out) }, ms)
    p.onData((d) => { out += d })
    p.onExit(() => { clearTimeout(timer); resolve(out) })
  })
}

async function relays(): Promise<{ relays: McpRelays; env: Record<string, string> }> {
  const servers = readMcpServers(data)
  const grant = await gateway.grant({ id: 'u1', project: 'p', cwd: worktree, dataDir: data, logFile: path.join(data, 'u1', 'mcp-calls.jsonl') }, servers)
  return { relays: { command: process.execPath, script: RELAY, servers: servers.map((s) => s.name) }, env: grant.env }
}

function checkDump(fake: FakeModel): void {
  const dump = fake.results.map((r) => r.match(/\{"env":[\s\S]*\}/)?.[0]).find(Boolean)
  expect(dump, `tool results: ${fake.results.join(' | ').slice(0, 600)}`).toBeDefined()
  const { env, cwd } = JSON.parse(dump!) as { env: Record<string, string>; cwd: string }
  expect(env.SERVER_TOKEN).toBe(SECRET)
  for (const k of ['FAL_KEY', 'GENIO_MCP_SECRET', 'GENIO_MCP_GATEWAY', 'ANTHROPIC_API_KEY', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) expect(env[k], k).toBeUndefined()
  expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(worktree))
  const log = fs.readFileSync(path.join(data, 'u1', 'mcp-calls.jsonl'), 'utf8')
  expect(log).toMatch(/"tools":3/)
  expect(log).toMatch(/"tool":"env_dump","ok":true/)
  expect(log).not.toContain(SECRET)
}

describe.skipIf(!claude)('a Claude unit through the gateway', () => {
  it('lists and calls the server with --strict-mcp-config, sees no secret and writes no OAuth state', async () => {
    model = await fakeAnthropic(/^mcp__envsrv__env_dump$/)
    const home = path.join(root, 'claude-home')
    fs.mkdirSync(home)
    const { relays: r, env } = await relays()
    const file = path.join(root, 'state', '.mcp-config.json')
    fs.mkdirSync(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify(claudeUnitMcpConfig(r)))
    expect(fs.readFileSync(file, 'utf8')).not.toContain(SECRET)
    const args = [...unitMcpLaunch('claude', { worktree, claudeConfig: file, relays: r }).args, '--dangerously-skip-permissions', '-p', '--model', 'claude-sonnet-5-5', 'Dump the environment.']
    const out = await run(claude!, args, unitEnv({ ...env, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'sk-ant-dummy-e2e', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }))
    expect(model.requests.some((t) => t.includes('mcp__envsrv__env_dump')), out.slice(-800)).toBe(true)
    checkDump(model)
    expect(fs.existsSync(path.join(home, '.credentials.json'))).toBe(false)
  })
})

describe.skipIf(!codex)('a Codex unit through the gateway', () => {
  it('lists and calls the server through -c relay entries, sees no secret and writes no credentials', async () => {
    model = await fakeResponses(/^env_dump$/)
    const home = path.join(root, 'codex-home')
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model = "fake-model"', 'model_provider = "fake"', '[model_providers.fake]', 'name = "fake"',
      `base_url = "${model.url}/v1"`, 'wire_api = "responses"', 'env_key = "FAKE_KEY"',
      // A same-named server in the home config stays off; the relay gets its own key.
      '[mcp_servers.envsrv]', 'url = "http://127.0.0.1:9/never"'
    ].join('\n'))
    const { relays: r, env } = await relays()
    const args = ['exec', '--skip-git-repo-check', ...unitMcpLaunch('codex', { worktree, codexHome: home, relays: r }).args, '--dangerously-bypass-approvals-and-sandbox', '-C', worktree, 'Dump the environment.']
    const out = await run(codex!, args, unitEnv({ ...env, CODEX_HOME: home, FAKE_KEY: 'dummy' }))
    expect(model.requests.some((t) => t.includes('mcp__genio_envsrv/env_dump')), `${out.slice(-1200)}\n${JSON.stringify(model.requests)}`).toBe(true)
    checkDump(model)
    expect(fs.existsSync(path.join(home, '.credentials.json'))).toBe(false)
  })
})
