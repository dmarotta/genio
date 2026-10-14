import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeHomeDir, claudeProjectName, configureClaudeHome, isolatedEnv, type ClaudeRunner } from '../src/main/claude-home'
import { Home } from '../src/main/home'
import { createWkspService } from '../src/main/wksp'
import { createWakeService } from '../src/main/wakes'
import { defaultSettings } from '../src/main/settings'
import { probeClaudePlanUsage } from '../src/main/claude-usage-probe'
import { claudeModels } from '../src/main/model-discovery'
import { reviewOptions } from '../src/main/gauntlet'
import type { AppCtx, WkspService } from '../src/main/services'

// Every Claude launch site outside units: the chat, the usage probe, model discovery and the Gauntlet review.
const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query, tool: (name: string) => ({ name }), createSdkMcpServer: () => ({}) }))

let root: string, genio: string, player: string
const inheritedSecureStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
let services: WkspService[] = []
const preflight = (loggedIn = true): ClaudeRunner => async args =>
  ({ code: 0, stdout: args[0] === '--version' ? '2.1.299' : JSON.stringify({ loggedIn, configDirectory: genio }) })
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-claude-sites-'))
  genio = claudeHomeDir(root)
  player = path.join(root, 'player-claude')
  fs.mkdirSync(player, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', player)
  sdk.query.mockReset()
  sdk.query.mockImplementation(({ prompt }) => {
    if (typeof prompt !== 'string') void (async () => { for await (const _ of prompt) { /* drain */ } })()
    return { close: () => {}, interrupt: async () => {}, supportedModels: async () => [{ value: 'default' }],
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({}),
      [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } } }
  })
  configureClaudeHome({ dir: genio, executable: () => process.execPath, warn: () => {}, runner: preflight() })
})
afterEach(async () => {
  for (const service of services) await service.stop()
  services = []
  configureClaudeHome(undefined)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const envOf = (call = 0) => sdk.query.mock.calls[call][0].options.env as Record<string, string>

it("the usage probe runs in Genio's home: same account, no trace in the player's folder", async () => {
  await probeClaudePlanUsage(root)
  expect(envOf()).toMatchObject(isolatedEnv(genio))
  expect(sdk.query.mock.calls[0][0].options).toMatchObject({ persistSession: false })
})

it("model discovery runs in Genio's home and persists no session", async () => {
  await claudeModels()
  expect(envOf()).toMatchObject(isolatedEnv(genio))
  expect(sdk.query.mock.calls[0][0].options).toMatchObject({ persistSession: false, settingSources: [] })
})

it("the Gauntlet reviewer runs in Genio's home", async () => {
  const options = await reviewOptions(root, { reviewModel: 'claude-sonnet-5-5' }, () => {})
  expect(options.env).toMatchObject(isolatedEnv(genio))
  expect(options).toMatchObject({ persistSession: false, tools: ['Read', 'Grep', 'Glob'], cwd: root })
})

it("one-shots fall back to the player's normal home when the preflight fails", async () => {
  configureClaudeHome({ dir: genio, executable: () => process.execPath, warn: () => {}, runner: preflight(false) })
  await claudeModels()
  expect(envOf().CLAUDE_CONFIG_DIR).toBe(player)
  expect(envOf().CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(inheritedSecureStorage)
})

function chat(sessionId?: string) {
  const main = new Home(root); main.ensure()
  if (sessionId) fs.writeFileSync(main.wkspFile, JSON.stringify({ sessionId }))
  const ctx = { appRoot: process.cwd(), settings: { get: () => defaultSettings() },
    main: { home: main }, away: { state: () => ({ mode: 'online' }) },
    allies: { list: () => [] }, projects: { list: () => [], get: () => undefined }, stats: { unlock: vi.fn(), addCost: vi.fn() },
    inventory: { thumbnail: vi.fn() }, memory: { read: () => '' }, permissions: { ask: vi.fn(async () => true) }
  } as unknown as AppCtx
  const wakes = createWakeService(() => ctx, main)
  const hc = { home: main, wakes, crew: { list: () => [] }, decisions: { list: () => [] }, backlog: { list: () => [] } }
  ctx.home = () => hc as any; ctx.homes = new Map([['main', hc as any]])
  const service = createWkspService(() => ctx, main)
  services.push(service)
  wakes.enqueue({ kind: 'signal', reason: 'unit is ready', routine: false })
  service.deliverWakes()
  return vi.waitFor(() => expect(sdk.query).toHaveBeenCalled())
}

it("the main chat starts in Genio's home", async () => {
  await chat()
  expect(envOf()).toMatchObject({ ...isolatedEnv(genio), CLAUDE_AGENT_SDK_CLIENT_APP: 'genio/0.1.0' })
})

it("the main chat resumes its session inside Genio's home across restarts", async () => {
  const folder = path.join(genio, 'projects', claudeProjectName(root))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'chat-1.jsonl'), '{}\n')
  await chat('chat-1')
  expect(sdk.query.mock.calls[0][0].options).toMatchObject({ resume: 'chat-1' })
  expect(envOf()).toMatchObject(isolatedEnv(genio))
})

it("a chat session from before Genio's home resumes where it lives", async () => {
  const folder = path.join(player, 'projects', claudeProjectName(root))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'legacy-chat.jsonl'), '{}\n')
  await chat('legacy-chat')
  expect(sdk.query.mock.calls[0][0].options).toMatchObject({ resume: 'legacy-chat' })
  expect(envOf().CLAUDE_CONFIG_DIR).toBe(player)
  expect(envOf().CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(inheritedSecureStorage)
})
