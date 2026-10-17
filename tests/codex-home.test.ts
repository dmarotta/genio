import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexNeedsSignIn, codexEnv, codexHomeReady, codexHomes, codexLaunch, codexSignedOut, configureCodexHome, genioCodexHomeDir, GENIO_CODEX_MODEL,
  parseCodexHomeLogin, preflightCodexHome, resetCodexHome, seedCodexHome, setCodexTrust
} from '../src/main/codex-home'
import { fakeSignIn, fakeThread, installFakeCodex } from './helpers/fake-codex-bin'

// Genio's own Codex home, with temp homes and the fake Codex CLI only: never the player's real ~/.codex.
let root: string, genio: string, player: string
const config = (): string => fs.readFileSync(path.join(genio, 'config.toml'), 'utf8')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-home-'))
  genio = genioCodexHomeDir(root)
  player = path.join(root, 'player-codex')
  fs.mkdirSync(player, { recursive: true })
  vi.stubEnv('CODEX_HOME', player)
  installFakeCodex(path.join(root, 'bin'))
  configureCodexHome({ dir: genio })
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

/** Every file under a folder, relative, to prove a home was neither read into nor written. */
const tree = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []

describe('needs sign-in: Codex runs only in a signed-in Genio home', () => {
  const needsSignIn = (): Promise<unknown> => expect(codexLaunch()).rejects.toThrow(CodexNeedsSignIn)

  it("refuses every launch until Genio's own home is signed in, whatever the player's own login is", async () => {
    fakeSignIn(player)
    await needsSignIn()
    await needsSignIn()
    expect(codexSignedOut()).toBe(true)
    // the player's home is untouched: no config, no thread, nothing but the login the test made
    expect(tree(player)).toEqual(['fake-login'])
    // the player signs in from Accounts: the next launch moves into Genio's home
    fakeSignIn(genio)
    resetCodexHome()
    expect(await codexLaunch()).toEqual({ env: { CODEX_HOME: genio }, isolated: true, codexHome: genio })
    expect(codexSignedOut()).toBe(false)
  })

  it('a dummy API-key login in the player home changes nothing: still needs sign-in, nothing written there', async () => {
    fakeSignIn(player, 'Logged in using an API key - sk-dummy-***abcd')
    await needsSignIn()
    expect(tree(player)).toEqual(['fake-login'])
    expect(fs.readFileSync(path.join(player, 'fake-login'), 'utf8')).toContain('API key')
  })

  it('an API-key login in Genio\'s own home is not signed in either', async () => {
    fakeSignIn(genio, 'Logged in using an API key - sk-proj-***abcd')
    await needsSignIn()
    expect((await codexHomeReady()).reason).toContain('API key')
    expect(codexSignedOut()).toBe(true)
  })

  it('checks once: the answer stands (no repeated probes) until a sign-in resets it or a fresh check is asked', async () => {
    const cli = vi.fn(async () => ({ code: 1, stdout: 'Not logged in', stderr: '' }))
    configureCodexHome({ dir: genio, cli })
    await needsSignIn()
    await needsSignIn()
    await codexHomeReady()
    expect(cli).toHaveBeenCalledOnce()
    await codexHomeReady(true)
    expect(cli).toHaveBeenCalledTimes(2)
    resetCodexHome()
    await needsSignIn()
    expect(cli).toHaveBeenCalledTimes(3)
  })

  it('keeps a signed-in answer for this start, and a fresh check notices a lost sign-in', async () => {
    fakeSignIn(genio)
    expect((await codexHomeReady()).ok).toBe(true)
    fs.rmSync(path.join(genio, 'fake-login'))
    expect((await codexHomeReady()).ok).toBe(true)
    expect((await codexHomeReady(true)).ok).toBe(false)
    expect(codexSignedOut()).toBe(true)
  })

  it('a missing Codex CLI is not "needs sign-in" (nothing to sign in to), and still starts nothing', async () => {
    vi.stubEnv('GENIO_CODEX_BIN', '')
    vi.stubEnv('PATH', path.join(root, 'empty'))
    for (const k of ['APPDATA', 'USERPROFILE', 'HOME']) vi.stubEnv(k, root)
    const { clearWhichCache } = await import('../src/main/util')
    clearWhichCache()
    await expect(codexLaunch()).rejects.toThrow('Codex CLI was not found')
    expect(codexSignedOut()).toBe(false)
  })

  it('without a configured home everything stays as before', async () => {
    configureCodexHome(undefined)
    expect(await codexLaunch()).toEqual({ env: {}, isolated: false, codexHome: player })
    expect(codexHomes()).toEqual([player])
  })

  it("no launch path reads or writes the player's home while Genio's is unsigned, resume included", async () => {
    const cwd = path.join(root, 'worktrees', 'world', 'unit')
    fakeThread(player, 'legacy-thread', cwd)
    const before = tree(player)
    const mtime = fs.statSync(path.join(player, 'sessions')).mtimeMs
    for (const o of [{}, { resume: { cwd } }, { resume: { cwd, home: player } }]) await expect(codexLaunch(o)).rejects.toThrow(CodexNeedsSignIn)
    await expect(codexEnv()).rejects.toThrow(CodexNeedsSignIn)
    expect(tree(player)).toEqual(before)
    expect(fs.statSync(path.join(player, 'sessions')).mtimeMs).toBe(mtime)
    // only Genio's own home was seeded (config.toml, no credential)
    expect(tree(genio)).toEqual(['config.toml'])
  })
})

describe('resume follows the thread', () => {
  const cwd = (): string => path.join(root, 'worktrees', 'world', 'unit')

  it("resumes in Genio's home when the thread is there", async () => {
    fakeSignIn(genio)
    fakeThread(genio, 'genio-thread', cwd())
    expect(await codexLaunch({ resume: { cwd: cwd() } })).toMatchObject({ isolated: true, codexHome: genio })
  })

  it("a unit from before Genio's home resumes in the player's home, where its thread is, once Genio's home is signed in", async () => {
    fakeSignIn(genio)
    fakeThread(player, 'legacy-thread', cwd())
    expect(await codexLaunch({ resume: { cwd: cwd() } })).toEqual({ env: {}, isolated: false, codexHome: player })
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
