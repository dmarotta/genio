/**
 * Opt-in round trip of the Claude chat with a player MCP server (docs/mcp-servers.md):
 *   npm run test:e2e -- mcp-chat
 * The chat's own shape (wksp.ts buildOptions): an Agent SDK query with settingSources [], Genio's in-process
 * `genio` server always loaded, the player's server as a relay entry from chatMcpServers, and canUseTool through
 * Genio's chat policy. Tool search is forced on, as Anthropic's API has it, and the model is a fake endpoint in a
 * throwaway Claude home: no account, no login, no model usage, and the player's ~/.claude is never read or written.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice(4), 'hex').toString('utf8')
  }
}))

import { createSdkMcpServer, query, tool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { chatMcpServers } from '../../src/main/chat-mcp'
import { DISALLOWED, enforceTool } from '../../src/main/chat-tool-policy'
import { createMcpGateway, type McpGateway } from '../../src/main/mcp-gateway'
import { saveMcpServer } from '../../src/main/mcp-servers'
import { fakeAnthropic, type FakeModel } from '../support/fake-model-endpoints'

const ROOT = path.join(__dirname, '..', '..')
const SERVER = path.join(__dirname, '..', 'fixtures', 'mcp-env-server.mjs')

let root: string, data: string, cwd: string, home: string, gateway: McpGateway, model: FakeModel | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-e2e-chat-mcp-'))
  data = path.join(root, 'data')
  cwd = path.join(root, 'project')
  home = path.join(root, 'claude-home')
  for (const d of [data, cwd, home]) fs.mkdirSync(d, { recursive: true })
  gateway = createMcpGateway()
  saveMcpServer({ name: 'envsrv', command: process.execPath, args: [SERVER], secrets: [{ name: 'SERVER_TOKEN', value: 'chat-e2e-secret' }] }, data, [])
})
afterEach(async () => {
  await model?.close()
  model = undefined
  await gateway.close()
  for (let i = 0; i < 30; i++) {
    try { fs.rmSync(root, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
  }
})

/** The chat's environment: no agent or model variables of the caller, a throwaway home, the fake model, tool search on. */
function chatEnv(url: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || /^(CLAUDE|ANTHROPIC|GENIO_)/i.test(k) || k === 'CLAUDECODE' || k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  return { ...env, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-dummy-e2e',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'true', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' }
}

async function chat(mode: 'ask' | 'all'): Promise<{ seen: string[]; asked: string[]; end: string }> {
  model = await fakeAnthropic(/^mcp__envsrv__echo$/, 'select:mcp__envsrv__echo')
  const seen: string[] = [], asked: string[] = []
  const genio = createSdkMcpServer({ name: 'genio', version: '1.0.0', alwaysLoad: true,
    tools: [tool('status_report', 'Genio test tool', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))] })
  const player = await chatMcpServers({ chat: 'e2e', project: 'p', cwd, dataDir: data, logFile: path.join(data, 'chat', 'mcp-calls.jsonl'), command: process.execPath, appRoot: ROOT, gateway })
  const q = query({
    prompt: 'Use the echo tool once.',
    options: {
      cwd, settingSources: [], permissionMode: 'default', model: 'claude-sonnet-5-5', disallowedTools: DISALLOWED,
      mcpServers: { genio, ...player },
      canUseTool: async (name, input): Promise<PermissionResult> => {
        seen.push(name)
        const d = await enforceTool({ role: 'genio', chat: 'e2e', shellMode: () => mode, player: 'Player',
          permissions: { ask: async (r: { tool: string }) => { asked.push(r.tool); return true } } as never }, { runtime: 'claude', name, input })
        return d.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : d
      },
      env: chatEnv(model.url)
    }
  })
  let end = ''
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') end += `mcp: ${JSON.stringify(m.mcp_servers)}; `
    if (m.type === 'result') { end += JSON.stringify(m).slice(0, 600); break }
  }
  return { seen, asked, end }
}

describe('the Claude chat with a player MCP server', () => {
  it('Ask mode: the player tool is deferred behind tool search, Genio stays loaded; asked, then called through the gateway', async () => {
    const { seen, asked, end } = await chat('ask')
    expect(seen, `${end}\n${JSON.stringify(model!.requests)}`).toContain('mcp__envsrv__echo')
    expect(asked).toEqual(['mcp__envsrv__echo'])
    expect(model!.results.some((r) => r.includes('ECHO:')), model!.results.join(' | ')).toBe(true)
    // Deferred: the first request offers Genio's tool and ToolSearch, not the player's; once loaded it carries defer_loading.
    expect(model!.requests[0]).toEqual(expect.arrayContaining(['ToolSearch', 'mcp__genio__status_report']))
    expect(model!.requests[0]).not.toContain('mcp__envsrv__echo')
    const defs = model!.tools.flat() as { name?: string; defer_loading?: boolean }[]
    const echo = defs.filter((t) => t.name === 'mcp__envsrv__echo')
    const status = defs.filter((t) => t.name === 'mcp__genio__status_report')
    expect(echo.length, JSON.stringify(model!.requests)).toBeGreaterThan(0)
    expect(echo.every((t) => t.defer_loading === true)).toBe(true)
    expect(status.length).toBeGreaterThan(0)
    expect(status.every((t) => !t.defer_loading)).toBe(true)
    expect(fs.readFileSync(path.join(data, 'chat', 'mcp-calls.jsonl'), 'utf8')).toMatch(/"tool":"echo","ok":true/)
    expect(fs.existsSync(path.join(home, '.credentials.json'))).toBe(false)
  })

  it('YOLO: the player tool runs without asking', async () => {
    const { seen, asked, end } = await chat('all')
    expect(seen, `${end}\n${JSON.stringify(model!.requests)}`).toContain('mcp__envsrv__echo')
    expect(asked).toEqual([])
    expect(model!.results.some((r) => r.includes('ECHO:'))).toBe(true)
  })
})
