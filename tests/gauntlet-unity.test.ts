import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => (async function* () {
  yield { type: 'result', subtype: 'success', result: '{"verdict":"pass","findings":[]}', total_cost_usd: 0 }
})() }))
vi.mock('../src/main/claude-home', () => ({ claudeEnv: async () => ({}) }))
import { createGauntlet } from '../src/main/gauntlet'
import { runUnityGate } from '../src/main/gauntlet-unity'
import { unityTestCommand, isDefaultUnityTest } from '../src/main/play-editor'
import { Home } from '../src/main/home'
import * as unity from '../src/main/unity-unit'
import * as git from '../src/main/git'
import * as util from '../src/main/util'
import { editorHolders, editorSeatsDir, tryAcquireEditor } from '../resources/unit-skills/genio/lib/unity-editors.mjs'
import { engineProject } from './engine-cases'
import type { Task } from '../src/shared/types'
import type { AppCtx } from '../src/main/services'

const APP = path.resolve('.')
const SCRIPT = path.join(APP, 'resources/unit-skills/genio/skills/unity/scripts/genio-unity.mjs')
const CLI = path.join(APP, 'tests/fixtures/fake-unity-cli.mjs')
let tmp: string, home: Home, world: string, worktree: string, calls: string, config: unity.UnityUnitConfig, task: Task, ctx: AppCtx
const gitCmd = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '0' } }).trim()

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-gauntlet-')))
  // Ally Gauntlets must share the main home's editor semaphore with units.
  const main = new Home(path.join(tmp, 'main')); main.ensure()
  home = new Home(path.join(tmp, 'ally'), 'ally', main); home.ensure()
  world = path.join(tmp, 'world'); worktree = path.join(tmp, 'copy'); calls = path.join(tmp, 'calls.jsonl')
  fs.mkdirSync(path.join(world, 'Game', 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n')
  fs.writeFileSync(path.join(world, '.gitignore'), 'Library/\nTemp/\n')
  gitCmd(world, ['init', '-q', '-b', 'main']); gitCmd(world, ['config', 'user.name', 'Test']); gitCmd(world, ['config', 'user.email', 'test@example.invalid'])
  gitCmd(world, ['add', '.']); gitCmd(world, ['commit', '-qm', 'initial'])
  gitCmd(world, ['worktree', 'add', '-q', worktree, '-b', 'genio/unit'])
  fs.writeFileSync(path.join(worktree, 'change.txt'), 'implemented')
  gitCmd(worktree, ['add', '.']); gitCmd(worktree, ['commit', '-qm', 'change'])
  fs.mkdirSync(path.join(world, 'Game', 'Library', 'Pipeline'), { recursive: true })
  fs.writeFileSync(path.join(world, 'Game', 'Library', 'warm'), 'cache')
  fs.writeFileSync(path.join(world, 'Game', 'Library', 'Pipeline', 'token'), 'main-secret')
  const project = engineProject({ engine: 'unity', engineRoot: 'Game', commands: { test: 'Unity -batchmode -projectPath "Game" -runTests -testPlatform EditMode -logFile -' } }, world)
  config = unity.unityUnitConfig(project, { task: 'unit', worktree, data: main.data, taskDir: home.taskDir('unit'), cli: CLI })!
  fs.mkdirSync(config.editors.dir, { recursive: true }); fs.writeFileSync(path.join(config.editors.dir, 'cap.json'), '{"cap":1}')
  fs.mkdirSync(home.taskDir('unit'), { recursive: true })
  fs.writeFileSync(home.briefFile('unit'), "## Player's intent\nImplement change\n\n## Genio spec\nNone")
  task = { id: 'unit', title: 'Change', kind: 'ship', project: project.name, workspace: 'ally', state: 'validating', worktree,
    branch: 'genio/unit', baseBranch: 'main', briefPath: home.briefFile('unit') } as Task
  const crew = { get: () => task, update: (_id: string, patch: Partial<Task>) => { Object.assign(task, patch); return task },
    send: vi.fn(async () => ({ ok: true, message: 'sent' })), bump: vi.fn(), registerPr: vi.fn(async () => {
      task.state = 'ready'; return { ok: true, message: 'registered' }
    }) }
  const hc = { home, crew, decisions: { openForTask: vi.fn() } }
  ctx = { appRoot: APP, main: { home: main }, home: () => hc, projects: { get: () => project }, settings: { get: () => ({ validationMaxRounds: 3 }) },
    stats: { addCost: vi.fn() }, forge: { available: () => true, createPr: vi.fn(async () => ({ ok: true, url: 'https://example.invalid/pr/1' })) } } as unknown as AppCtx
  vi.spyOn(unity, 'findUnityCli').mockReturnValue(CLI)
  vi.spyOn(git, 'hasRemote').mockResolvedValue(true)
  vi.spyOn(git, 'fetch').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  vi.spyOn(git, 'push').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  vi.stubEnv('FAKE_UNITY_CALLS', calls); vi.stubEnv('FAKE_UNITY_SEATS', editorSeatsDir(main.data))
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

const run = () => createGauntlet(() => ctx, home).run('unit')
const log = (): { argv: string[]; seeded: boolean; credentials: boolean; seats: { owner: string; project: string }[] }[] =>
  fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const testStep = () => task.validation?.steps.find(s => s.name === 'test')

describe('Gauntlet Unity gate', { timeout: 30_000 }, () => {
  it('runs legacy defaults on the wrapper, with a seeded copy and a shared editor seat', async () => {
    expect(await run()).toMatchObject({ ok: true })
    expect(testStep()).toMatchObject({ command: 'genio-unity test --mode EditMode', state: 'passed' })
    expect(testStep()?.output).toContain('2 tests ran, none failed')
    const call = log().find(c => c.argv[0] === 'test')!
    expect(call).toMatchObject({ seeded: true, credentials: false, seats: [{ owner: 'unit:unit', project: path.join(worktree, 'Game') }] })
    expect(call.argv.slice(0, 4)).toEqual(['test', path.join(worktree, 'Game'), '--mode', 'EditMode'])
    expect(editorHolders(config.editors.dir)).toEqual([])
    expect(gitCmd(worktree, ['status', '--porcelain'])).toBe('')
    const recordDir = path.join(home.taskDir('unit'), 'gauntlet', 'unity')
    expect(fs.readdirSync(recordDir).some(n => fs.existsSync(path.join(recordDir, n, 'result.json')))).toBe(true)
    expect(ctx.home('ally').crew.send).not.toHaveBeenCalled()
  })

  it.each([
    ['fail', '8', 'Unity tests failed'],
    ['fail', '0', 'NUnit reports failed tests'],
    ['none', '0', 'No Unity tests ran'],
    ['skipped', '0', 'No Unity tests ran']
  ])('sends test findings for %s with exit %s', async (tests, code, expected) => {
    vi.stubEnv('FAKE_UNITY_TESTS', tests); vi.stubEnv('FAKE_UNITY_TEST_EXIT', code)
    expect(await run()).toMatchObject({ ok: false })
    expect(task).toMatchObject({ state: 'working', validation: { state: 'findings' } })
    expect(testStep()?.state).toBe('failed')
    expect(ctx.home('ally').crew.send).toHaveBeenCalledWith('unit', expect.stringContaining(expected))
    expect(ctx.home('ally').decisions.openForTask).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
    expect(task.validation?.steps.find(s => s.name === 'review')?.state).toBe('skipped')
  })

  it.each(['6', '7', '4'])('routes exit %s to an infrastructure choice without a unit fix round', async code => {
    vi.stubEnv('FAKE_UNITY_TEST_EXIT', code)
    expect(await run()).toMatchObject({ ok: false })
    expect(task).toMatchObject({ state: 'needs-decision', validation: { state: 'failed' } })
    expect(ctx.home('ally').decisions.openForTask).toHaveBeenCalledWith('unit', 'gauntlet', expect.stringContaining('restoring the test environment'), 'validation',
      expect.objectContaining({ context: expect.stringContaining(`Unity test infrastructure failed (exit ${code})`), recommendation: 'Retry the Gauntlet' }))
    expect(ctx.home('ally').crew.send).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  it.each(['missing', 'malformed'])('never passes exit 0 with a %s NUnit report', async scenario => {
    vi.stubEnv('FAKE_UNITY_TESTS', scenario)
    await run()
    expect(task.state).toBe('needs-decision')
    expect(testStep()?.state).toBe('failed')
    expect(git.push).not.toHaveBeenCalled()
  })

  it('a missing editor finishes validation and raises recovery even when no test command was saved', async () => {
    vi.spyOn(unity, 'findUnityCli').mockReturnValue('')
    fs.writeFileSync(path.join(worktree, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 9999.0.1f1\n')
    gitCmd(worktree, ['add', '.']); gitCmd(worktree, ['commit', '-qm', 'require unavailable editor'])
    ctx.projects.get(task.project)!.commands = {}
    await run()
    expect(task).toMatchObject({ state: 'needs-decision', validation: { state: 'failed' } })
    expect(testStep()?.output).toContain('not installed through Hub')
    expect(ctx.home('ally').crew.send).not.toHaveBeenCalled()
  })

  it('waits on a unit-held semaphore seat and never starts an uncounted test editor', async () => {
    const held = tryAcquireEditor(config.editors.dir, { owner: 'unit:other', cap: 1 })!
    try {
      const result = await runUnityGate(config, SCRIPT, home.taskStateFile('unit', '.gate.json'), 1000)
      expect(result).toMatchObject({ code: 20, outcome: 'infra' })
      expect(log().some(c => c.argv[0] === 'test')).toBe(false)
      expect(editorHolders(config.editors.dir).map(h => h.owner)).toEqual(['unit:other'])
    } finally { held.release() }
    expect(await runUnityGate(config, SCRIPT, home.taskStateFile('unit', '.gate.json'), 1000)).toMatchObject({ code: 0, outcome: 'passed' })
    expect(editorHolders(config.editors.dir)).toEqual([])
  }, 30_000)

  it('keeps custom project test commands on their usual shell path', async () => {
    ctx.projects.get(task.project)!.commands.test = 'npm test'
    const shell = vi.spyOn(util, 'runShell').mockResolvedValue({ code: 0, stdout: 'custom tests passed', stderr: '' })
    expect(await run()).toMatchObject({ ok: true })
    expect(shell).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: worktree }))
    expect(log()).toEqual([])
  })

  it.each(['worktree', 'project'])('ends validating when the %s disappears before launch', async missing => {
    if (missing === 'worktree') task.worktree = path.join(tmp, 'gone')
    else vi.spyOn(ctx.projects, 'get').mockReturnValue(undefined)
    const gauntlet = createGauntlet(() => ctx, home)
    expect(await gauntlet.run(task.id)).toMatchObject({ ok: false })
    expect(task.state).toBe('blocked')
    expect(gauntlet.running(task.id)).toBe(false)
  })
})

it('recognizes new managed commands and old generated defaults without requiring an installed editor', () => {
  expect(unityTestCommand('missing/Game')).toBe('genio-unity test --mode EditMode')
  for (const command of [unityTestCommand(''), 'Unity -batchmode -projectPath . -runTests -testPlatform EditMode -logFile -',
    '"C:/Unity/Hub/Editor/6000.0.1f1/Editor/Unity.exe" -batchmode -projectPath "Game" -runTests -testPlatform EditMode -logFile -']) expect(isDefaultUnityTest(command)).toBe(true)
  expect(isDefaultUnityTest('npm test')).toBe(false)
})
