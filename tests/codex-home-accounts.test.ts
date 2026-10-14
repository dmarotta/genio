import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { accountActions, GENIO_CODEX, runtimeAccounts, type AccountStatus } from '@shared/api'
import { listAccounts, openAccountSession } from '../src/main/accounts'
import { codexLaunch, configureCodexHome, genioCodexHomeDir } from '../src/main/codex-home'
import { runCodexCli } from '../src/main/codex-archive'
import { routeProjectEvent, terminalProject } from '../src/main/project-windows'
import type { AppCtx, CreateTerminalOpts } from '../src/main/services'
import type { FleetSnapshot, TerminalInfo } from '../src/shared/types'
import { fakeSignIn, installFakeCodex } from './helpers/fake-codex-bin'

// Only the Codex CLI is "installed" (the fake one); every other account row stays inert.
const tools = vi.hoisted(() => ({ codex: '' }))
vi.mock('../src/main/toolchain', () => ({
  toolStatus: async (name: string) => (name === 'codex' ? { name, found: true, path: tools.codex, purpose: 'Codex CLI units', version: 'fake' } : { name, found: false })
}))

let root: string, genio: string, player: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-accounts-'))
  genio = genioCodexHomeDir(root)
  player = path.join(root, 'player-codex')
  vi.stubEnv('CODEX_HOME', player)
  tools.codex = installFakeCodex(path.join(root, 'bin'))
  fakeSignIn(player)
  configureCodexHome({ dir: genio, warn: () => {} })
})
afterEach(() => {
  configureCodexHome(undefined)
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const row = async (): Promise<AccountStatus> => (await listAccounts()).find(a => a.tool === GENIO_CODEX)!

it("shows Genio's Codex as not signed in, with the sign-in action and the fallback warning", async () => {
  const a = await row()
  expect(a).toMatchObject({ label: "Genio's Codex", installed: true, state: 'logged-out', stateLabel: 'not signed in',
    loginLabel: "Sign in Genio's Codex (same account)", logoutLabel: 'Sign out', warning: expect.stringContaining('normal Codex home') })
  expect(accountActions(a)).toEqual({ login: true, logout: false })
  // the player's own Codex login is reported separately and untouched
  expect((await listAccounts()).find(x => x.tool === 'codex')).toMatchObject({ state: 'logged-in' })
})

it('shows the account it is signed in as', async () => {
  fakeSignIn(genio)
  const a = await row()
  expect(a).toMatchObject({ state: 'logged-in', stateLabel: 'signed in', detail: 'ChatGPT · signed in as player@example.com · pro' })
  expect(a.warning).toBeUndefined()
  expect(accountActions(a)).toEqual({ login: false, logout: true })
})

it('shows an error, with both actions, when the home cannot be used', async () => {
  fakeSignIn(genio, 'Logged in using an API key - sk-proj-***abcd')
  const a = await row()
  expect(a).toMatchObject({ state: 'unknown', stateLabel: 'error', warning: expect.stringContaining('API key') })
  expect(a.detail).toBeUndefined()
  expect(accountActions(a)).toEqual({ login: true, logout: true })
})

it("dispatch and the model catalogue count Genio's login for Codex once it is signed in", async () => {
  fs.rmSync(path.join(player, 'fake-login'))
  expect(runtimeAccounts(await listAccounts()).find(a => a.tool === 'codex')?.state).toBe('logged-out')
  fakeSignIn(genio)
  expect(runtimeAccounts(await listAccounts()).find(a => a.tool === 'codex')).toMatchObject({ state: 'logged-in', detail: expect.stringContaining('ChatGPT') })
})

it('the fallback notice opens Settings › Accounts in project windows, and a login there stays in that window', async () => {
  const event = { type: 'navigate' as const, target: { view: 'accounts' as const } }
  const snap = { tasks: [], projects: [{ name: 'world', path: path.join(root, 'world') }] } as unknown as FleetSnapshot
  expect(routeProjectEvent(event, { project: 'world', wksp: 'world' }, snap)).toEqual(event)
  expect(routeProjectEvent(event, undefined, snap)).toEqual(event)
  const launches: CreateTerminalOpts[] = []
  const ctx = { main: { home: { root, data: path.join(root, 'data') } }, settings: { get: () => ({}) },
    terminals: { create: (o: CreateTerminalOpts) => { launches.push(o); return { id: 't1', alive: true } }, onExit: () => {} } } as unknown as AppCtx
  await openAccountSession(ctx, GENIO_CODEX, 'login', path.join(root, 'world'))
  expect(terminalProject({ id: 't1', cwd: launches[0].cwd } as TerminalInfo, snap)).toBe('world')
})

it("the row is absent when Genio has no Codex home", async () => {
  configureCodexHome(undefined)
  expect((await listAccounts()).some(a => a.tool === GENIO_CODEX)).toBe(false)
})

it("sign-in runs `codex login` against Genio's home only, and the next launch moves there", async () => {
  const launches: CreateTerminalOpts[] = []
  const exits: (() => void)[] = []
  const ctx = { main: { home: { root, data: path.join(root, 'data') } }, settings: { get: () => ({}) },
    terminals: { create: (o: CreateTerminalOpts) => { launches.push(o); return { id: 't1', alive: true } }, onExit: (_id: string, cb: () => void) => { exits.push(cb) } }
  } as unknown as AppCtx
  expect((await codexLaunch()).isolated).toBe(false)
  await openAccountSession(ctx, GENIO_CODEX, 'login')
  expect(launches[0]).toMatchObject({ file: tools.codex, args: ['login'], env: { CODEX_HOME: genio } })
  // seeded before the browser flow, with no credential copied from the player's home
  expect(fs.readdirSync(genio)).toEqual(['config.toml'])
  // the player finishes the browser sign-in; the terminal ends
  await runCodexCli(['login'], genio)
  exits[0]()
  expect(await codexLaunch()).toMatchObject({ isolated: true, env: { CODEX_HOME: genio } })
  expect(fs.readFileSync(path.join(player, 'fake-login'), 'utf8')).toBe('Logged in using ChatGPT')
  // sign-out signs out Genio's home only
  await openAccountSession(ctx, GENIO_CODEX, 'logout')
  expect(launches[1]).toMatchObject({ args: ['logout'], env: { CODEX_HOME: genio } })
  await runCodexCli(['logout'], genio)
  exits[exits.length - 1]()
  expect((await codexLaunch()).isolated).toBe(false)
  expect(fs.existsSync(path.join(player, 'fake-login'))).toBe(true)
})
