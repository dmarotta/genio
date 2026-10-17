import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { BUILTIN_HARNESSES, codexTrustDialog } from '../src/main/harness'
import { codexTrustKey, codexUnitFolders, configureCodexHome, genioCodexHomeDir, isCodexUnitFolder, seedCodexHome, setCodexTrust } from '../src/main/codex-home'
import * as git from '../src/main/git'
import { stripAnsi } from '../src/main/util'
import { createActivityMeter } from '../src/shared/unit-activity'
import type { AppCtx, CreateTerminalOpts } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'
import { fakeSignIn, installFakeCodex } from './helpers/fake-codex-bin'
import { readToml, trustOf } from './helpers/toml-check'

// A Codex unit's first run in a moved project (2026-10-17) sat on this dialog
// until someone pressed Enter. Temp homes and the fake Codex CLI only.

/** The dialog as the stalled unit's terminal showed it (codex-cli 0.162.1), "…" marking text left out. */
const SEEN = "Folder access ... Note: You're in a subdirectory of a Git project. Trusting will apply to the repository root: f:\\founders-of-avalon. " +
  "Trust this folder? ... > 1. Trust and continue  2. Quit  enter continue, esc quit"

/** The full dialog drawn the way a TUI does: cursor moves, styles, no newlines. */
const drawn = (root: string, pointer: 1 | 2 = 1): string => [
  '\x1b[2J\x1b[1;1H\x1b[1mFolder access\x1b[0m',
  `\x1b[3;3HNote: You’re in a subdirectory of a Git project. Trusting will apply to the repository root: \x1b[36m${root}\x1b[39m`,
  '\x1b[5;3HTrust this folder? Codex can read, edit, and run files here, subject to your permission settings.',
  '\x1b[6;3HFolder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.',
  `\x1b[8;1H${pointer === 1 ? '\x1b[36m›\x1b[39m' : ' '} 1. Trust and continue`,
  `\x1b[9;1H${pointer === 2 ? '\x1b[36m›\x1b[39m' : ' '} 2. Quit`,
  '\x1b[11;3H\x1b[2menter\x1b[22m continue, \x1b[2mesc\x1b[22m quit'
].join('')

const squash = (s: string): string => stripAnsi(s).replace(/\s+/g, '').toLowerCase()

describe("recognising Codex's folder trust dialog", () => {
  it('reads the folder from the exact text the stalled unit showed', () => {
    expect(codexTrustDialog(squash(SEEN))).toEqual({ folder: 'f:\\founders-of-avalon', onTrust: true })
  })

  it('reads a drawn dialog, and knows where the pointer is', () => {
    expect(codexTrustDialog(squash(drawn('F:\\Founders Of Avalon')))).toEqual({ folder: 'f:\\foundersofavalon', onTrust: true })
    expect(codexTrustDialog(squash(drawn('F:\\x', 2)))).toMatchObject({ onTrust: false })
  })

  it('waits for the options, and ignores ordinary output and the older dialog', () => {
    expect(codexTrustDialog(squash('Folder access\r\nTrust this folder? Codex can read'))).toBeUndefined()
    for (const text of ['Do you trust the contents of this directory?', 'Working (3s • esc to interrupt)', 'trust_level = "trusted"', '› Ask Codex to do anything'])
      expect(codexTrustDialog(squash(text))).toBeUndefined()
  })

  it('is never counted as work', () => {
    const meter = createActivityMeter('codex')
    let at = 0
    for (let i = 0; i < 8; i++) expect(meter.push(stripAnsi(drawn('F:\\x').replace(/\x1b\[\d+;\d+H/g, '\n')), (at += 1_500))).toBe(false)
  })
})

describe.runIf(process.platform === 'win32')('which folders a unit may trust (Windows path forms)', () => {
  const unit = 'F:\\.genio\\a1b2c3\\worktrees\\founders-of-avalon-2\\remove-hover-ui-on-houses-a0c3'
  const folders = [unit, 'F:\\founders-of-avalon']

  it('matches the worktree and the repository root in any spelling Codex or Windows gives them', () => {
    for (const shown of ['f:\\founders-of-avalon', 'F:\\FOUNDERS-OF-AVALON', 'f:/founders-of-avalon', 'f:\\founders-of-avalon\\', '\\\\?\\F:\\founders-of-avalon',
      squash(unit), 'f:/.genio/a1b2c3/worktrees/founders-of-avalon-2/remove-hover-ui-on-houses-a0c3/'])
      expect(isCodexUnitFolder(shown, folders), shown).toBe(true)
    expect(isCodexUnitFolder('~\\worktrees\\w\\u', ['C:\\Users\\p\\worktrees\\w\\u'], 'C:\\Users\\p')).toBe(true)
  })

  it('refuses any other folder, a sibling sharing the prefix, a parent and an empty answer', () => {
    for (const shown of ['f:\\', 'f:\\founders-of-avalon-evil', 'c:\\founders-of-avalon', 'f:\\.genio', 'c:\\users\\p\\downloads\\game', ''])
      expect(isCodexUnitFolder(shown, folders), shown).toBe(false)
  })

  it('keys trust the way Codex matches it: no \\\\?\\ prefix, backslashes, no trailing separator', () => {
    expect(codexTrustKey('\\\\?\\F:\\founders-of-avalon\\')).toBe('F:\\founders-of-avalon')
    expect(codexTrustKey('F:/.genio/k/worktrees/w/u')).toBe('F:\\.genio\\k\\worktrees\\w\\u')
    expect(codexTrustKey('\\\\?\\UNC\\nas\\share\\game')).toBe('\\\\nas\\share\\game')
  })
})

describe('pre-trust in config.toml', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-trust-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = () => path.join(dir, 'config.toml')

  it('writes valid TOML and keeps every existing entry, including ones Codex wrote itself', () => {
    const codexOwn = path.join(dir, 'Codex Own')
    fs.writeFileSync(file(), [
      '# kept', 'model = "gpt-6.1-sol"', 'model_reasoning_effort = "high"', '',
      '[notice]', 'hide_full_access_warning = true', '',
      `[projects.${JSON.stringify(codexOwn)}]`, 'trust_level = "trusted"', '',
      "[projects.'C:\\keep']", 'trust_level = "untrusted"', '',
      '[mcp_servers.x]', 'command = "x"', 'args = ["a", "b"]', ''
    ].join('\n'))
    const unit = path.join(dir, "it's a unit")
    const repo = path.join(dir, 'repo')
    setCodexTrust(dir, [unit, `\\\\?\\${repo}`, codexOwn.toUpperCase(), repo.replace(/\\/g, '/')], true)
    const toml = readToml(fs.readFileSync(file(), 'utf8'))
    expect(trustOf(toml, codexTrustKey(unit))).toBe('trusted')
    expect(trustOf(toml, codexTrustKey(repo))).toBe('trusted')
    expect(trustOf(toml, codexOwn)).toBe('trusted')
    expect(trustOf(toml, 'C:\\keep')).toBe('untrusted')
    expect(toml[JSON.stringify(['notice'])]).toEqual({ [JSON.stringify(['hide_full_access_warning'])]: true })
    expect(toml[JSON.stringify(['mcp_servers', 'x'])]).toMatchObject({ [JSON.stringify(['args'])]: ['a', 'b'] })
    expect(toml['']).toMatchObject({ [JSON.stringify(['model'])]: 'gpt-6.1-sol' })
    expect(fs.readFileSync(file(), 'utf8').split('[projects.').length).toBe(5) // no table twice
    setCodexTrust(dir, [unit], false)
    expect(trustOf(readToml(fs.readFileSync(file(), 'utf8')), codexTrustKey(unit))).toBeUndefined()
  })

  it("seeds a missing file and stays valid", () => {
    seedCodexHome(dir)
    setCodexTrust(dir, [path.join(dir, 'a'), path.join(dir, 'b')], true)
    expect(Object.keys(readToml(fs.readFileSync(file(), 'utf8')))).toHaveLength(3)
  })

  it('trusts the root a worktree links to only when it is the registered project folder', () => {
    const repo = path.join(dir, 'repo')
    const unit = path.join(dir, 'volume', '.genio', 'k', 'worktrees', 'world', 'unit')
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'unit'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'unit', 'commondir'), '../..\n')
    fs.mkdirSync(unit, { recursive: true })
    fs.writeFileSync(path.join(unit, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'unit').replace(/\\/g, '/')}\n`)
    const linked = repo.replace(/^[A-Z]:/, d => d.toLowerCase())
    expect(codexUnitFolders(unit, linked).map(f => f.toLowerCase())).toEqual([unit, repo].map(f => codexTrustKey(f).toLowerCase()))
    // the worktree's link names another repository: only the unit's own folders
    expect(codexUnitFolders(unit, path.join(dir, 'other'))).toEqual([codexTrustKey(unit), codexTrustKey(path.join(dir, 'other'))])
    expect(codexUnitFolders(unit)).toEqual([codexTrustKey(unit)])
  })
})

describe('a Codex unit at launch', () => {
  let root: string, genio: string, player: string, repo: string, home: Home, ctx: AppCtx, task: Task
  let data: ((d: string) => void)[], written: string[], wakes: { enqueue: ReturnType<typeof vi.fn> }, launches: CreateTerminalOpts[]

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-trust-unit-'))
    genio = genioCodexHomeDir(root)
    player = path.join(root, 'player-codex')
    fs.mkdirSync(player, { recursive: true })
    vi.stubEnv('CODEX_HOME', player)
    installFakeCodex(path.join(root, 'bin'))
    fakeSignIn(player)
    configureCodexHome({ dir: genio })
    home = new Home(path.join(root, 'base')); home.ensure()
    repo = path.join(root, 'founders-of-avalon')
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'unit'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'unit', 'commondir'), '../..\n')
    const worktree = path.join(root, 'volume', '.genio', 'k', 'worktrees', 'world', 'unit')
    fs.mkdirSync(worktree, { recursive: true })
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'unit')}\n`)
    fs.mkdirSync(home.taskDir('unit'), { recursive: true })
    fs.writeFileSync(home.briefFile('unit'), '# Mission')
    task = { id: 'unit', kind: 'scout', title: 'Unit', project: 'world', wksp: 'main', state: 'exited', harness: 'codex', model: CODEX_UNIT_MODEL,
      worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 0, automaticRelaunches: 0, inbox: { seq: 0, acked: 0, rings: 0 } } as Task
    fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
    data = []; written = []; launches = []
    wakes = { enqueue: vi.fn() }
    const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, command: 'fake-unit' }
    const hc = { home, crew: undefined as any, wakes, decisions: { list: () => [] } }
    ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
      settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => ({ name: 'world', path: repo }) }, notifier: { sfx: () => {} },
      terminals: { get: () => ({ alive: true }), list: () => [], lastOutputAt: () => undefined, tail: () => 'Folder access\n› 1. Trust and continue',
        create: vi.fn((opts: CreateTerminalOpts) => { launches.push(opts); return { id: 't-1', alive: true } }), submit: vi.fn(async () => true), kill: vi.fn(),
        write: (_id: string, d: string) => { written.push(d) },
        onData: (_id: string, fn: (d: string) => void) => { data.push(fn); return () => { data = data.filter(f => f !== fn) } }, onExit: vi.fn() },
      dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release: vi.fn(), check: async () => {} })), record: vi.fn() }
    } as unknown as AppCtx
    hc.crew = createCrewService(() => ctx, home)
    vi.spyOn(git, 'repoTop').mockResolvedValue('')
  })
  afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
    configureCodexHome(undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const launch = async () => expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
  const emit = (d: string) => { for (const f of data) f(d) }
  const shownRoot = () => repo.replace(/^[A-Z]:/, d => d.toLowerCase())

  it("pre-trusts the worktree and the project's root in Genio's home only", async () => {
    fakeSignIn(genio)
    await launch()
    expect(launches[0].env).toMatchObject({ CODEX_HOME: genio })
    const toml = readToml(fs.readFileSync(path.join(genio, 'config.toml'), 'utf8'))
    expect(trustOf(toml, codexTrustKey(task.worktree))).toBe('trusted')
    expect(trustOf(toml, codexTrustKey(repo))).toBe('trusted')
    expect(fs.existsSync(path.join(player, 'config.toml'))).toBe(false)
  })

  it("answers the dialog for the unit's repository root once per appearance, and never as work", async () => {
    fakeSignIn(genio)
    await launch()
    vi.useFakeTimers()
    emit(drawn(shownRoot()))
    await vi.advanceTimersByTimeAsync(500)
    expect(written).toEqual([]) // keys sent while it still draws are lost
    await vi.advanceTimersByTimeAsync(600)
    expect(written).toEqual(['\r'])
    emit(drawn(shownRoot())) // its lingering redraw is the same appearance
    await vi.advanceTimersByTimeAsync(3_000)
    expect(written).toEqual(['\r'])
    expect(wakes.enqueue).not.toHaveBeenCalled()
  })

  it("starts no unit in the player's home, so there is no dialog to answer there and no player config is written", async () => {
    expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: false })
    expect(launches).toHaveLength(0)
    expect(fs.existsSync(path.join(player, 'config.toml'))).toBe(false)
  })

  it.each([
    ['a foreign folder', () => drawn(path.join(os.tmpdir(), 'downloads', 'game')), /names ".*game", which is not this unit's worktree/],
    ['a sibling of the root', () => drawn(`${shownRoot()}-evil`), /is not this unit's worktree or its project's root/],
    ['the pointer on Quit', () => drawn(shownRoot(), 2), /pointer off "Trust and continue"/]
  ])('leaves %s alone with one clear stale signal', async (_name, dialog, why) => {
    fakeSignIn(genio)
    await launch()
    vi.useFakeTimers()
    emit(dialog())
    await vi.advanceTimersByTimeAsync(1_100)
    emit(dialog())
    await vi.advanceTimersByTimeAsync(20_000)
    emit(dialog())
    await vi.advanceTimersByTimeAsync(1_100)
    expect(written).toEqual([])
    expect(wakes.enqueue).toHaveBeenCalledOnce()
    expect(wakes.enqueue.mock.calls[0][0]).toMatchObject({ kind: 'stale', taskId: 'unit', routine: false,
      reason: expect.stringMatching(why), lines: ['| Folder access', '| › 1. Trust and continue'] })
    expect(wakes.enqueue.mock.calls[0][0].reason).toContain('RECON "Unit" (world)')
  })
})
