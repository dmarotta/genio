import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  codexHomeReady, codexHomes, codexLaunch, configureCodexHome, genioCodexHomeDir, GENIO_CODEX_MODEL, parseCodexHomeLogin,
  preflightCodexHome, resetCodexHome, seedCodexHome, setCodexTrust
} from '../src/main/codex-home'
import { fakeSignIn, fakeThread, installFakeCodex } from './helpers/fake-codex-bin'

// Genio's own Codex home, with temp homes and the fake Codex CLI only: never the player's real ~/.codex.
let root: string, genio: string, player: string, warn: Mock<(message: string) => void>
const config = (): string => fs.readFileSync(path.join(genio, 'config.toml'), 'utf8')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-home-'))
  genio = genioCodexHomeDir(root)
  player = path.join(root, 'player-codex')
  fs.mkdirSync(player, { recursive: true })
  vi.stubEnv('CODEX_HOME', player)
  installFakeCodex(path.join(root, 'bin'))
  warn = vi.fn<(message: string) => void>()
  configureCodexHome({ dir: genio, warn })
})
afterEach(() => {
  configureCodexHome(undefined)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("seeding Genio's Codex home", () => {
  it('writes only a minimal config with the default model, and never a credential', () => {
    fs.writeFileSync(path.join(player, 'auth.json'), '{"tokens":"player-only"}')
    fs.writeFileSync(path.join(player, 'config.toml'), 'model = "player-model"\n[mcp_servers.unity_mcp]\ncommand = "x"\n')
    seedCodexHome(genio)
    expect(config()).toContain(`model = "${GENIO_CODEX_MODEL}"`)
    expect(config()).not.toMatch(/mcp_servers|player-model/)
    expect(fs.readdirSync(genio)).toEqual(['config.toml'])
  })

  it("keeps Codex's own additions and never adds a second model key", () => {
    fs.mkdirSync(genio, { recursive: true })
    fs.writeFileSync(path.join(genio, 'config.toml'), '[notice]\nhide_full_access_warning = true\n')
    seedCodexHome(genio)
    seedCodexHome(genio)
    expect(config().match(/^model = /gm)).toHaveLength(1)
    expect(config().indexOf('model =')).toBeLessThan(config().indexOf('[notice]'))
    expect(config()).toContain('hide_full_access_warning = true')
  })
})

describe('worktree trust', () => {
  it('trusts unit folders and drops them again at despawn, leaving every other table alone', () => {
    const unit = path.join(root, 'worktrees', 'world', 'unit')
    seedCodexHome(genio)
    fs.appendFileSync(path.join(genio, 'config.toml'), "\n[projects.'C:\\keep']\ntrust_level = \"trusted\"\n")
    setCodexTrust(genio, [unit], true)
    setCodexTrust(genio, [unit], true)
    expect(config()).toContain(`[projects.'${path.resolve(unit)}']\ntrust_level = "trusted"`)
    expect(config().split(path.resolve(unit)).length).toBe(2)
    setCodexTrust(genio, [unit.toUpperCase()], false)
    expect(config()).not.toContain(path.resolve(unit))
    expect(config()).toContain("[projects.'C:\\keep']")
    expect(config()).toContain(`model = "${GENIO_CODEX_MODEL}"`)
  })

  it('upgrades an untrusted entry Codex wrote', () => {
    const unit = path.join(root, 'unit')
    fs.mkdirSync(genio, { recursive: true })
    fs.writeFileSync(path.join(genio, 'config.toml'), `[projects.'${path.resolve(unit)}']\ntrust_level = "untrusted"\n`)
    setCodexTrust(genio, [unit], true)
    expect(config()).toContain('trust_level = "trusted"')
    expect(config()).not.toContain('untrusted')
  })
})

describe('sign-in state', () => {
  it('reads `codex login status`: ChatGPT is in use, anything else is not', () => {
    expect(parseCodexHomeLogin('Logged in using ChatGPT', 0)).toEqual({ ok: true, state: 'signed-in' })
    expect(parseCodexHomeLogin('Not logged in', 1)).toMatchObject({ ok: false, state: 'signed-out' })
    expect(parseCodexHomeLogin('Logged in using an API key - sk-proj-***abcd', 0)).toMatchObject({ ok: false, state: 'error', reason: expect.stringContaining('API key') })
    expect(parseCodexHomeLogin('', 127)).toMatchObject({ ok: false, missing: true })
    expect(parseCodexHomeLogin('panic', 101)).toMatchObject({ ok: false, state: 'error' })
  })

  it("checks Genio's home, never the player's", async () => {
    fakeSignIn(player)
    expect(await preflightCodexHome(genio)).toMatchObject({ ok: false, state: 'signed-out' })
    fakeSignIn(genio)
    expect(await preflightCodexHome(genio)).toEqual({ ok: true, state: 'signed-in' })
  })
})

describe('preflight and fallback', () => {
  it("falls back to the player's home until signed in, warning once and only for visible launches", async () => {
    fakeSignIn(player)
    expect(await codexLaunch()).toEqual({ env: {}, isolated: false, codexHome: player })
    expect(warn).not.toHaveBeenCalled()
    await codexLaunch({ visible: true })
    await codexLaunch({ visible: true })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/not signed in yet.*Sign in Genio's Codex \(same account\)/s)
    // the player signs in from Accounts: the next launch moves into Genio's home
    fakeSignIn(genio)
    resetCodexHome()
    expect(await codexLaunch({ visible: true })).toEqual({ env: { CODEX_HOME: genio }, isolated: true, codexHome: genio })
  })

  it('notices a sign-in made elsewhere after the recheck interval, and keeps a signed-in answer', async () => {
    configureCodexHome({ dir: genio, warn, recheckMs: 0 })
    expect((await codexHomeReady()).ok).toBe(false)
    fakeSignIn(genio)
    expect((await codexHomeReady()).ok).toBe(true)
    fs.rmSync(path.join(genio, 'fake-login'))
    expect((await codexHomeReady()).ok).toBe(true)
    expect((await codexHomeReady(true)).ok).toBe(false)
  })

  it('an API-key login is never used: the fallback names it', async () => {
    fakeSignIn(genio, 'Logged in using an API key - sk-proj-***abcd')
    expect((await codexLaunch({ visible: true })).isolated).toBe(false)
    expect(warn.mock.calls[0][0]).toContain('API key')
  })

  it('stays quiet when the Codex CLI is missing (the launch itself reports that)', async () => {
    vi.stubEnv('GENIO_CODEX_BIN', '')
    vi.stubEnv('PATH', path.join(root, 'empty'))
    for (const k of ['APPDATA', 'USERPROFILE', 'HOME']) vi.stubEnv(k, root)
    const { clearWhichCache } = await import('../src/main/util')
    clearWhichCache()
    expect((await codexLaunch({ visible: true })).isolated).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('without a configured home everything stays as before', async () => {
    configureCodexHome(undefined)
    expect(await codexLaunch({ visible: true })).toEqual({ env: {}, isolated: false, codexHome: player })
    expect(codexHomes()).toEqual([player])
  })
})

describe('resume follows the thread', () => {
  const cwd = (): string => path.join(root, 'worktrees', 'world', 'unit')

  it("resumes in Genio's home when the thread is there", async () => {
    fakeSignIn(genio)
    fakeThread(genio, 'genio-thread', cwd())
    expect(await codexLaunch({ resume: { cwd: cwd() }, visible: true })).toMatchObject({ isolated: true, codexHome: genio })
  })

  it("a unit from before Genio's home resumes in the player's home, where its thread is", async () => {
    fakeSignIn(genio)
    fakeThread(player, 'legacy-thread', cwd())
    expect(await codexLaunch({ resume: { cwd: cwd() }, visible: true })).toEqual({ env: {}, isolated: false, codexHome: player })
  })

  it('the recorded home wins, including archived threads', async () => {
    fakeSignIn(genio)
    const other = path.join(root, 'other-home')
    const file = fakeThread(other, 'old', cwd())
    fs.mkdirSync(path.join(other, 'archived_sessions'))
    fs.renameSync(file, path.join(other, 'archived_sessions', path.basename(file)))
    expect(await codexLaunch({ resume: { cwd: cwd(), home: other } })).toEqual({ env: { CODEX_HOME: other }, isolated: false, codexHome: other })
    expect(await codexLaunch({ resume: { cwd: cwd(), home: genio } })).toMatchObject({ isolated: true })
  })

  it("a new unit with nothing to resume starts in Genio's home", async () => {
    fakeSignIn(genio)
    expect(await codexLaunch({ resume: { cwd: cwd() } })).toMatchObject({ isolated: true })
  })
})

it("usage and archive scans read Genio's home first, then the player's", () => {
  expect(codexHomes()).toEqual([genio, player])
  vi.stubEnv('CODEX_HOME', genio)
  expect(codexHomes()).toEqual([genio])
})
