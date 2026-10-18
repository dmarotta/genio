import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeEnv, claudeHomeDir, claudeHomeReady, claudeLaunch, claudeProjectName, claudeProjectRoots, claudeTrustFiles, configureClaudeHome,
  hasCwdTranscript, hasSessionTranscript, isolatedEnv, playerClaudeDir, playerClaudeJson, playerSkipsBypassPrompt,
  preflightClaudeHome, seedClaudeHome, setClaudeTrust, UNIT_UNSET_ENV, type ClaudeRunner
} from '../src/main/claude-home'
import { terminalEnv } from '../src/main/terminals'

// Every path lives in a temp dir: the player's Claude folder is a stubbed CLAUDE_CONFIG_DIR, never the real ~/.claude.
let root: string, genio: string, player: string
const status = (over: Record<string, unknown> = {}) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', configDirectory: genio, ...over })
function runner(answer: () => string): ClaudeRunner & { calls: { args: string[]; env: NodeJS.ProcessEnv }[] } {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
  const fn = (async (args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env })
    return { code: 0, stdout: args[0] === '--version' ? '2.1.299 (Claude Code)\n' : answer() }
  }) as ClaudeRunner & { calls: typeof calls }
  fn.calls = calls
  return fn
}
function transcript(dir: string, cwd: string, id = 'session-1'): void {
  const folder = path.join(dir, 'projects', claudeProjectName(cwd))
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), '{}\n')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-claude-home-'))
  genio = claudeHomeDir(root)
  player = path.join(root, 'player-claude')
  fs.mkdirSync(player, { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', player)
})
afterEach(() => {
  configureClaudeHome(undefined)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the isolated environment', () => {
  it("points Claude at Genio's folder and the login at the player's folder", () => {
    expect(isolatedEnv(genio)).toEqual({ CLAUDE_CONFIG_DIR: genio, CLAUDE_SECURESTORAGE_CONFIG_DIR: player })
    expect(isolatedEnv(genio, {})).toEqual({ CLAUDE_CONFIG_DIR: genio, CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(os.homedir(), '.claude') })
    expect(playerClaudeJson()).toBe(path.join(player, '.claude.json'))
    expect(playerClaudeJson({})).toBe(path.join(os.homedir(), '.claude.json'))
  })

  it('strips inherited Claude session markers from a unit terminal, then applies its own env', () => {
    const env = terminalEnv({ unsetEnv: UNIT_UNSET_ENV, env: { CLAUDE_CONFIG_DIR: genio } }, {
      PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_MESSAGING_SOCKET: 's',
      CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'kept', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: player
    })
    expect(env).toMatchObject({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'kept', CLAUDE_CONFIG_DIR: genio, TERM: 'xterm-256color' })
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'ELECTRON_RUN_AS_NODE']) {
      expect(env).not.toHaveProperty(k)
    }
  })
})

describe('seeding', () => {
  it('marks onboarding done, copies only the theme and keeps what Claude wrote', () => {
    fs.writeFileSync(path.join(player, 'settings.json'), JSON.stringify({ theme: 'light', enabledPlugins: { x: true }, skipDangerousModePermissionPrompt: true }))
    fs.writeFileSync(path.join(player, '.credentials.json'), '{"secret":"never copied"}')
    fs.mkdirSync(genio, { recursive: true })
    fs.writeFileSync(path.join(genio, '.claude.json'), JSON.stringify({ userID: 'kept', projects: { 'C:/w': { hasTrustDialogAccepted: true } } }))
    seedClaudeHome(genio, '2.1.299')
    expect(JSON.parse(fs.readFileSync(path.join(genio, '.claude.json'), 'utf8'))).toEqual({
      userID: 'kept', projects: { 'C:/w': { hasTrustDialogAccepted: true } }, hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.299' })
    expect(JSON.parse(fs.readFileSync(path.join(genio, 'settings.json'), 'utf8'))).toEqual({ theme: 'light' })
    expect(fs.readdirSync(genio).sort()).toEqual(['.claude.json', 'settings.json'])
  })

  it('defaults the theme when the player has none', () => {
    seedClaudeHome(genio)
    expect(JSON.parse(fs.readFileSync(path.join(genio, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' })
    expect(JSON.parse(fs.readFileSync(path.join(genio, '.claude.json'), 'utf8'))).toEqual({ hasCompletedOnboarding: true })
  })

  it('writes and removes worktree trust in the given .claude.json only', () => {
    seedClaudeHome(genio)
    const cfg = path.join(genio, '.claude.json')
    const worktree = path.join(root, 'worktrees', 'w', 'unit')
    setClaudeTrust(cfg, [worktree], true)
    const key = path.resolve(worktree).replace(/\\/g, '/')
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).projects[key]).toEqual({ hasTrustDialogAccepted: true })
    expect(fs.existsSync(playerClaudeJson())).toBe(false)
    setClaudeTrust(cfg, [worktree], false)
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).projects[key]).toBeUndefined()
  })

  it("reads the bypass consent from the player's own settings", () => {
    expect(playerSkipsBypassPrompt()).toBe(false)
    fs.writeFileSync(path.join(player, 'settings.json'), JSON.stringify({ skipDangerousModePermissionPrompt: true }))
    expect(playerSkipsBypassPrompt()).toBe(true)
  })
})

describe('preflight', () => {
  it("accepts the player's login seen from Genio's folder", async () => {
    const run = runner(() => status())
    expect(await preflightClaudeHome(genio, run)).toEqual({ ok: true, version: '2.1.299' })
    expect(run.calls.at(-1)).toMatchObject({ args: ['auth', 'status', '--json'], env: { CLAUDE_CONFIG_DIR: genio, CLAUDE_SECURESTORAGE_CONFIG_DIR: player } })
  })

  it.each([
    ['logged out', () => status({ loggedIn: false })],
    ['another config folder', () => status({ configDirectory: player })],
    ['unreadable output', () => 'error: unknown option'],
    ['a crash', () => { throw new Error('spawn failed') }]
  ])('rejects %s', async (_label, answer) => {
    expect((await preflightClaudeHome(genio, runner(answer))).ok).toBe(false)
  })

  it('falls back to the normal home with one visible warning, checked once per start', async () => {
    const warn = vi.fn()
    const run = runner(() => status({ loggedIn: false }))
    configureClaudeHome({ dir: genio, executable: () => process.execPath, warn, runner: run })
    expect(await claudeLaunch()).toMatchObject({ env: {}, isolated: false, configFile: path.join(player, '.claude.json') })
    expect(await claudeEnv()).toEqual({})
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('normal Claude home')
    expect(run.calls.filter(c => c.args[0] === 'auth')).toHaveLength(1)
  })

  it('falls back when the Claude CLI is missing', async () => {
    const warn = vi.fn()
    configureClaudeHome({ dir: genio, executable: () => path.join(root, 'missing', 'claude.exe'), warn, runner: runner(() => status()) })
    expect(await claudeHomeReady()).toMatchObject({ ok: false, reason: expect.stringContaining('not found') })
    expect(await claudeEnv()).toEqual({})
    expect(warn).toHaveBeenCalledOnce()
  })

  it('seeds the home and isolates when the preflight passes', async () => {
    const warn = vi.fn()
    configureClaudeHome({ dir: genio, executable: () => process.execPath, warn, runner: runner(() => status()) })
    expect(await claudeLaunch()).toEqual({ env: isolatedEnv(genio), isolated: true, configDir: genio, configFile: path.join(genio, '.claude.json') })
    expect(JSON.parse(fs.readFileSync(path.join(genio, '.claude.json'), 'utf8'))).toMatchObject({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.299' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('resume', () => {
  const ok = () => configureClaudeHome({ dir: genio, executable: () => process.execPath, warn: vi.fn(), runner: runner(() => status()) })

  it('finds transcripts by cwd and by session id', () => {
    const cwd = path.join(root, 'worktrees', 'w', 'unit')
    expect(hasCwdTranscript(genio, cwd)).toBe(false)
    transcript(genio, cwd, 'abc')
    expect(hasCwdTranscript(genio, cwd)).toBe(true)
    expect(hasCwdTranscript(genio, cwd.toUpperCase())).toBe(true)
    expect(hasSessionTranscript(genio, 'abc')).toBe(true)
    expect(hasSessionTranscript(genio, 'other')).toBe(false)
  })

  it("a unit's --continue stays in Genio's home across relaunches", async () => {
    ok()
    const cwd = path.join(root, 'worktrees', 'w', 'unit')
    expect((await claudeLaunch({ cwd })).isolated).toBe(true) // nothing yet: new work goes to Genio's home
    transcript(genio, cwd)
    expect((await claudeLaunch({ cwd })).env).toEqual(isolatedEnv(genio))
  })

  it("a conversation that exists only in the player's folder resumes there", async () => {
    ok()
    const cwd = path.join(root, 'worktrees', 'w', 'old-unit')
    transcript(player, cwd, 'old-chat')
    expect(await claudeLaunch({ cwd })).toMatchObject({ env: {}, isolated: false, configFile: path.join(player, '.claude.json') })
    expect((await claudeLaunch({ sessionId: 'old-chat' })).env).toEqual({})
    // Once the conversation is in Genio's home, it resumes there.
    transcript(genio, cwd, 'old-chat')
    expect((await claudeLaunch({ cwd })).isolated).toBe(true)
    expect((await claudeLaunch({ sessionId: 'old-chat' })).isolated).toBe(true)
  })

  it("usage reads Genio's home and the player's, and trust cleanup covers both files", () => {
    expect(claudeProjectRoots()).toEqual([path.join(player, 'projects')])
    ok()
    expect(claudeProjectRoots()).toEqual([path.join(genio, 'projects'), path.join(player, 'projects')])
    expect(claudeTrustFiles()).toEqual([path.join(genio, '.claude.json'), path.join(player, '.claude.json')])
  })
})
