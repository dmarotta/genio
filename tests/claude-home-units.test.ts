import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import { claudeHomeDir, claudeProjectName, configureClaudeHome, UNIT_UNSET_ENV, type ClaudeRunner } from '../src/main/claude-home'
import type { AppCtx, CreateTerminalOpts } from '../src/main/services'
import type { Task } from '../src/shared/types'

// Unit launches (Builds and Recons): env, trust, settings and --continue resume, all in temp folders.
let root: string, genio: string, player: string, home: Home, ctx: AppCtx, task: Task
let launches: CreateTerminalOpts[]
const preflight = (loggedIn = true): ClaudeRunner => async args =>
  ({ code: 0, stdout: args[0] === '--version' ? '2.1.299' : JSON.stringify({ loggedIn, configDirectory: genio }) })
const configure = (loggedIn = true) => configureClaudeHome({ dir: genio, executable: () => process.execPath, warn: () => {}, runner: preflight(loggedIn) })
const trusted = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')).projects ?? {}
const key = (): string => path.resolve(task.worktree).replace(/\\/g, '/')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-claude-units-'))
  genio = claudeHomeDir(root)
  player = path.join(root, 'player-claude')
  fs.mkdirSync(player, { recursive: true })
  fs.writeFileSync(path.join(player, '.claude.json'), JSON.stringify({ projects: {} }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', player)
  home = new Home(root); home.ensure()
  const worktree = path.join(root, 'worktrees', 'world', 'unit')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(home.taskDir('unit'), { recursive: true })
  fs.writeFileSync(home.briefFile('unit'), '# Mission')
  task = { id: 'unit', kind: 'ship', project: 'world', wksp: 'main', state: 'exited', harness: 'claude',
    worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 0, automaticRelaunches: 0 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  launches = []
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'claude')!, command: 'fake-claude' }
  const hc = { home, crew: undefined as any }
  ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined },
    terminals: { get: () => undefined, lastOutputAt: () => undefined,
      create: vi.fn((opts: CreateTerminalOpts) => { launches.push(opts); return { id: `t-${launches.length}`, alive: true } }),
      submit: vi.fn(), kill: vi.fn(), onData: () => () => {}, onExit: vi.fn() },
    dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release: vi.fn(), check: async () => {} })), record: vi.fn() },
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
})
afterEach(() => {
  configureClaudeHome(undefined)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const relaunch = async () => expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })

it("a Claude unit runs in Genio's home with the player's login, Genio's trust and no inherited session markers", async () => {
  configure()
  fs.writeFileSync(path.join(player, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
  await relaunch()
  const launch = launches[0]
  expect(launch.env).toMatchObject({ CLAUDE_CONFIG_DIR: genio, CLAUDE_SECURESTORAGE_CONFIG_DIR: player, GENIO_TASK_ID: 'unit' })
  expect(launch.unsetEnv).toEqual(UNIT_UNSET_ENV)
  expect(trusted(path.join(genio, '.claude.json'))[key()]).toEqual({ hasTrustDialogAccepted: true })
  expect(trusted(path.join(player, '.claude.json'))).toEqual({})
  const settings = JSON.parse(fs.readFileSync(launch.args![launch.args!.indexOf('--settings') + 1], 'utf8'))
  expect(settings).toMatchObject({ skipDangerousModePermissionPrompt: true, hooks: { Stop: expect.any(Array) } })
  expect(launch.args).toContain('--continue')
})

it('passes the bypass consent only when the player already gave it', async () => {
  configure()
  await relaunch()
  const settings = JSON.parse(fs.readFileSync(launches[0].args![launches[0].args!.indexOf('--settings') + 1], 'utf8'))
  expect(settings).not.toHaveProperty('skipDangerousModePermissionPrompt')
})

it('a bypass-mode Unity unit keeps Stop and the blocking PreToolUse hook, with a decoy first on PATH', async () => {
  configure()
  const world = path.join(root, 'world')
  fs.mkdirSync(world)
  ctx.appRoot = fileURLToPath(new URL('..', import.meta.url))
  ctx.projects.get = () => ({ name: 'world', path: world, engine: 'unity', engineRoot: '' } as any)
  ctx.settings.get = () => ({ claudePermissionMode: 'bypass' } as any)
  await relaunch()
  const launch = launches[0]
  expect(launch.args).toContain('--dangerously-skip-permissions')
  const settings = JSON.parse(fs.readFileSync(launch.args![launch.args!.indexOf('--settings') + 1], 'utf8'))
  expect(settings.hooks.Stop).toHaveLength(1)
  expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: expect.stringContaining('Bash|PowerShell|Read|Edit|Write'),
    hooks: [{ type: 'command', command: 'node', args: [expect.stringContaining('unity-guard-hook.mjs')], timeout: 10, onFailure: 'block' }] })
  const bin = launch.env!.PATH.split(path.delimiter)[0]
  expect(fs.existsSync(path.join(bin, 'unity.cmd'))).toBe(true)
  expect(fs.existsSync(path.join(bin, 'genio-unity.cmd'))).toBe(true)
  expect(launch.env!.GENIO_UNITY_CONFIG).toBeDefined()
})

it("a respawn resumes the unit's conversation in Genio's home", async () => {
  configure()
  const folder = path.join(genio, 'projects', claudeProjectName(task.worktree))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 's.jsonl'), '{}\n')
  await relaunch()
  expect(launches[0].env).toMatchObject({ CLAUDE_CONFIG_DIR: genio })
  expect(launches[0].args).toContain('--continue')
})

it("a unit started before Genio's home respawns in the player's home, where its conversation is", async () => {
  configure()
  const folder = path.join(player, 'projects', claudeProjectName(task.worktree))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 's.jsonl'), '{}\n')
  await relaunch()
  expect(launches[0].env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  expect(launches[0].env).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR')
  expect(trusted(path.join(player, '.claude.json'))[key()]).toEqual({ hasTrustDialogAccepted: true })
})

it("falls back to the player's normal home when the preflight fails", async () => {
  configure(false)
  await relaunch()
  expect(launches[0].env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  expect(launches[0].unsetEnv).toEqual(UNIT_UNSET_ENV)
  expect(trusted(path.join(player, '.claude.json'))[key()]).toEqual({ hasTrustDialogAccepted: true })
})

it('non-Claude units get neither the Claude home nor the stripping', async () => {
  configure()
  vi.stubEnv('CODEX_HOME', path.join(root, 'codex'))
  const codex ={ ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, command: 'fake-codex' }
  ctx.settings.harness = () => codex
  ctx.main.crew.update(task.id, { harness: 'codex' })
  await relaunch()
  expect(launches[0].env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  expect(launches[0].unsetEnv).toBeUndefined()
})
