import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
vi.mock('../src/main/claude-usage-probe', () => ({ refreshClaudePlanUsage: async () => undefined, claudeProbeError: () => undefined }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import { codexLaunch, configureCodexHome, genioCodexHomeDir } from '../src/main/codex-home'
import { codexRolloutState } from '../src/main/codex-session'
import { readCodexProbeLimits, refreshCodexPlanUsage } from '../src/main/codex-usage-probe'
import { codexModels } from '../src/main/model-discovery'
import { CodexChatDriver } from '../src/main/codex-chat-driver'
import { generateChatImages, type ChatImageGen } from '../src/main/chat-imagegen'
import { codexImageSkillDir, unitPluginSource } from '../src/main/unitskills'
import { usageReport } from '../src/main/usage'
import * as git from '../src/main/git'
import type { ChatDriverEvents } from '../src/main/chat-driver'
import type { AppCtx, CreateTerminalOpts } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'
import { fakeSignIn, fakeThread, installFakeCodex } from './helpers/fake-codex-bin'
import { FakeAppServer } from './helpers/fake-codex-server'

// Every Codex launch site in Genio's own Codex home: temp homes and the fake Codex CLI only.
let root: string, genio: string, player: string, log: string, warn: Mock<(message: string) => void>
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-sites-'))
  genio = genioCodexHomeDir(root)
  player = path.join(root, 'player-codex')
  fs.mkdirSync(player, { recursive: true })
  log = path.join(root, 'app-server.jsonl')
  vi.stubEnv('CODEX_HOME', player)
  vi.stubEnv('FAKE_CODEX_LOG', log)
  installFakeCodex(path.join(root, 'bin'))
  fakeSignIn(player)
  warn = vi.fn<(message: string) => void>()
  configureCodexHome({ dir: genio, warn })
})
afterEach(() => {
  configureCodexHome(undefined)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const appServerHomes = (): string[] => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).CODEX_HOME)
const config = (): string => fs.readFileSync(path.join(genio, 'config.toml'), 'utf8')

describe('units', () => {
  let home: Home, ctx: AppCtx, task: Task, launches: CreateTerminalOpts[]
  let adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, command: 'fake-unit' }
  beforeEach(() => {
    home = new Home(path.join(root, 'base')); home.ensure()
    const worktree = path.join(home.root, 'worktrees', 'world', 'unit')
    fs.mkdirSync(worktree, { recursive: true })
    fs.mkdirSync(home.taskDir('unit'), { recursive: true })
    fs.writeFileSync(home.briefFile('unit'), '# Mission')
    task = { id: 'unit', kind: 'ship', project: 'world', wksp: 'main', state: 'exited', harness: 'codex', model: CODEX_UNIT_MODEL,
      worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 0, automaticRelaunches: 0 } as Task
    fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
    launches = []
    adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, command: 'fake-unit' }
    const hc = { home, crew: undefined as any, decisions: { list: () => [] } }
    ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
      settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined },
      terminals: { get: () => undefined, list: () => [], lastOutputAt: () => undefined,
        create: vi.fn((opts: CreateTerminalOpts) => { launches.push(opts); return { id: `t-${launches.length}`, alive: true } }),
        submit: vi.fn(async () => {}), kill: vi.fn(), onData: () => () => {}, onExit: vi.fn() },
      dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release: vi.fn(), check: async () => {} })), record: vi.fn() }
    } as unknown as AppCtx
    hc.crew = createCrewService(() => ctx, home)
    vi.spyOn(git, 'repoTop').mockResolvedValue('')
  })
  const relaunch = async () => expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
  const key = (): string => `[projects.'${path.resolve(task.worktree)}']`

  it("a Codex unit runs in Genio's home with its worktree trusted there", async () => {
    fakeSignIn(genio)
    await relaunch()
    expect(launches[0].env).toMatchObject({ CODEX_HOME: genio, GENIO_TASK_ID: 'unit' })
    expect(config()).toContain(`${key()}\ntrust_level = "trusted"`)
    expect(fs.existsSync(path.join(player, 'config.toml'))).toBe(false)
    expect(ctx.main.crew.get(task.id)?.codexHome).toBe(genio)
    expect(warn).not.toHaveBeenCalled()
  })

  it("a respawn resumes the unit's thread by id inside Genio's home", async () => {
    fakeSignIn(genio)
    fakeThread(genio, 'unit-thread', task.worktree)
    await relaunch()
    await relaunch()
    for (const launch of launches) {
      expect(launch.env).toMatchObject({ CODEX_HOME: genio })
      expect(launch.args?.slice(0, 2)).toEqual(['resume', 'unit-thread'])
    }
    expect(ctx.main.crew.get(task.id)).toMatchObject({ codexSessionId: 'unit-thread', codexHome: genio })
  })

  it("despawn drops the trust and archives the thread in Genio's home, never the player's", async () => {
    vi.useFakeTimers()
    fakeSignIn(genio)
    fakeThread(genio, 'unit-thread', task.worktree)
    fakeThread(player, 'player-thread', task.worktree)
    await relaunch()
    // a Recon that has stopped: nothing to land, so despawn goes straight through
    ctx.main.crew.update(task.id, { kind: 'scout', state: 'exited', terminalId: undefined })
    const r = await ctx.main.crew.cleanup(task.id)
    expect(r, r.message).toMatchObject({ ok: true })
    expect(config()).not.toContain(key())
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(async () => expect(await codexRolloutState('unit-thread', genio)).toBe('archived'))
    expect(await codexRolloutState('player-thread', player)).toBe('live')
  })

  it("until Genio's Codex is signed in, units launch in the player's home with one notice", async () => {
    await relaunch()
    await relaunch()
    expect(launches).toHaveLength(2)
    for (const launch of launches) expect(launch.env).not.toHaveProperty('CODEX_HOME')
    expect(ctx.main.crew.get(task.id)?.codexHome).toBe(player)
    expect(warn).toHaveBeenCalledOnce()
    expect(fs.existsSync(path.join(genio, 'config.toml'))).toBe(true)
    expect(config()).not.toContain('[projects.')
  })

  it("a unit started in the player's home keeps resuming there after the sign-in", async () => {
    await relaunch()
    fakeThread(player, 'legacy-thread', task.worktree)
    fakeSignIn(genio)
    await relaunch()
    expect(launches[1].env).not.toHaveProperty('CODEX_HOME')
    expect(launches[1].args?.slice(0, 2)).toEqual(['resume', 'legacy-thread'])
  })

  it('other runtimes get CODEX_HOME for Codex image runs, without the unit notice', async () => {
    fakeSignIn(genio)
    adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'claude')!, command: 'fake-claude' }
    ctx.main.crew.update(task.id, { harness: 'claude', model: undefined })
    await relaunch()
    expect(launches[0].env).toMatchObject({ CODEX_HOME: genio })
    expect(warn).not.toHaveBeenCalled()
  })

  it("a runtime with its own CODEX_HOME keeps it", async () => {
    fakeSignIn(genio)
    const custom = path.join(root, 'custom-home')
    adapter = { ...adapter, env: { CODEX_HOME: custom } }
    await relaunch()
    expect(launches[0].env).toMatchObject({ CODEX_HOME: custom })
    expect(ctx.main.crew.get(task.id)?.codexHome).toBe(custom)
    expect(fs.existsSync(path.join(genio, 'config.toml'))).toBe(false)
  })
})

describe('one-shots', () => {
  it("the usage probe reads the account's plan from Genio's home", async () => {
    fakeSignIn(genio)
    const data = path.join(root, 'data')
    await refreshCodexPlanUsage(data, true)
    expect(appServerHomes()).toEqual([genio])
    expect(readCodexProbeLimits(data)[0]).toMatchObject({ limitId: 'codex', plan: 'pro', windows: [{ minutes: 10080, usedPercent: 7 }] })
  })

  it("the usage probe falls back to the player's home until Genio's is signed in", async () => {
    const data = path.join(root, 'data')
    await refreshCodexPlanUsage(data, true)
    expect(appServerHomes()).toEqual([player])
    expect(readCodexProbeLimits(data)[0]).toMatchObject({ windows: [{ usedPercent: 7 }] })
    expect(warn).not.toHaveBeenCalled()
  })

  it("model discovery reads the catalogue in Genio's home", async () => {
    fakeSignIn(genio)
    expect((await codexModels()).map(m => m.id)).toEqual(['gpt-6.1-sol'])
    expect(appServerHomes()).toEqual([genio])
  })

  it("chat image generation runs in Genio's home", async () => {
    fakeSignIn(genio)
    const appRoot = fileURLToPath(new URL('..', import.meta.url))
    const gen: ChatImageGen = { chatDir: path.join(root, 'data', 'chat-images'), wksp: 'main', post: () => {},
      run: { script: path.join(codexImageSkillDir(unitPluginSource(appRoot)), 'scripts', 'codex-image.mjs'), scratch: path.join(root, 'data', 'codex-image') } }
    const result = await generateChatImages(gen, { prompt: 'a red gem', count: 1, transparent: false, refs: [] })
    expect(result.isError).toBeFalsy()
    expect(fs.existsSync(path.join(genio, 'fake-args.json'))).toBe(true)
    expect(fs.existsSync(path.join(player, 'fake-args.json'))).toBe(false)
  })
})

describe('the Codex chat', () => {
  function chat(sessionId?: string) {
    const server = new FakeAppServer()
    server.model = { ...server.model, model: 'gpt-test' }
    const envs: Record<string, string>[] = []
    const hooks = { onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd: vi.fn(), onSessionId: vi.fn(), onError: vi.fn(), onLimit: vi.fn(), onRequeue: vi.fn() } as ChatDriverEvents
    // The same home wiring as wksp.ts.
    const driver = new CodexChatDriver({ wksp: 'main', cwd: root, config: () => ({ model: 'gpt-test' }), instructions: () => 'contract', approve: async () => false,
      home: async () => { const l = await codexLaunch({ visible: true }); return { env: l.env, codexHome: l.codexHome } },
      handoff: () => 'HANDOFF: recent chat',
      wire: (events, env) => { envs.push(env); server.events = events; return server },
      bridge: async () => ({ list: async () => [], call: async () => ({ content: [] }), close: async () => {} }) }, hooks)
    driver.sessionId = sessionId
    driver.send({ kind: 'player', prompt: 'hello', msgId: 'p1' })
    return { driver, server, envs, done: () => vi.waitFor(() => expect(server.turn).toBe(1)) }
  }

  it("starts in Genio's home and resumes its thread there across restarts", async () => {
    fakeSignIn(genio)
    const first = chat()
    await first.done()
    expect(first.envs).toEqual([{ CODEX_HOME: genio }])
    expect(first.server.sent.some(r => r.method === 'thread/start')).toBe(true)
    first.driver.stop()
    fakeThread(genio, 'thread-1', root)
    const second = chat('thread-1')
    await second.done()
    expect(second.server.sent.find(r => r.method === 'thread/resume')?.params).toMatchObject({ threadId: 'thread-1' })
    expect(second.server.sent.find(r => r.method === 'turn/start')?.params.input[0].text).toBe('hello')
    second.driver.stop()
  })

  it("a chat thread from the player's home is left there: a fresh thread in Genio's home gets the handoff", async () => {
    fakeSignIn(genio)
    fakeThread(player, 'old-chat', root)
    const c = chat('old-chat')
    await c.done()
    expect(c.server.sent.some(r => r.method === 'thread/resume')).toBe(false)
    expect(c.server.sent.find(r => r.method === 'turn/start')?.params.input[0].text).toBe('HANDOFF: recent chat\n\nCurrent request:\nhello')
    expect(await codexRolloutState('old-chat', player)).toBe('live')
    c.driver.stop()
  })

  it("falls back to the player's home with the notice until signed in", async () => {
    const c = chat()
    await c.done()
    expect(c.envs).toEqual([{}])
    expect(warn).toHaveBeenCalledOnce()
    c.driver.stop()
  })
})

it("usage counts Genio's units in Genio's home, archived ones included, and older ones in the player's", async () => {
  const base = path.join(root, 'base')
  const data = path.join(base, 'data')
  fs.mkdirSync(path.join(data, 'usage'), { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'))
  const cwd = path.join(base, 'worktrees', 'world', 'unit')
  const tokens = (input: number) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } }, rate_limits: null } })
  fs.appendFileSync(fakeThread(genio, 'live-unit', cwd), tokens(100) + '\n')
  const archived = fakeThread(genio, 'archived-unit', cwd)
  fs.appendFileSync(archived, tokens(20) + '\n')
  fs.mkdirSync(path.join(genio, 'archived_sessions'))
  fs.renameSync(archived, path.join(genio, 'archived_sessions', path.basename(archived)))
  fs.appendFileSync(fakeThread(player, 'older-unit', cwd), tokens(3) + '\n')
  const home = { root: base, data, wkspFile: path.join(base, 'state', 'wksp.json'), name: 'main' }
  const ctx = { main: { home }, homes: new Map([['main', { home }]]), allies: { list: () => [] }, settings: { get: () => ({}) } } as unknown as AppCtx
  const codex = (await usageReport(ctx)).tools.find(t => t.tool === 'codex')
  expect(codex?.measured?.week).toMatchObject({ input: 123, output: 3 })
})
