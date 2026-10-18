import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler() {}, handle: (name: string, fn: any) => handlers.set(name, fn) }, BrowserWindow: {}, dialog: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/accounts', () => ({ listAccounts: async () => [] }))
vi.mock('../src/main/usage', async original => ({ ...await original<typeof import('../src/main/usage')>(), usageReport: async () => ({ tools: [] }) }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createBacklogService } from '../src/main/backlog'
import { createToolRegistry } from '../src/main/workspace-tools'
import { registerIpc } from '../src/main/ipc'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { ChatMessage } from '../src/shared/types'

let root: string, home: Home, ctx: AppCtx, hc: HomeCtx, said: ChatMessage[], send: ReturnType<typeof vi.fn>
const playerSays = (text: string): void => { said.push({ id: `p-${said.length}`, workspace: 'main', role: 'player', text, ts: new Date().toISOString() } as ChatMessage) }

beforeEach(() => {
  said = []
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-deps-'))
  home = new Home(root); home.ensure()
  send = vi.fn(async () => undefined)
  hc = { home, workspace: { history: () => said, send } } as unknown as HomeCtx
  const world = { name: 'world', path: root, defaultBranch: 'main' }
  ctx = {
    appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({}), harness: () => undefined },
    projects: { get: (n: string) => (n === 'world' ? world : undefined), resolvePosture: () => ({ mode: 'local-only', yolo: false, branchPrefix: 'genio/' }) },
    dispatch: { capacity: () => ({ cap: 8, used: 0 }), quotaWait: () => undefined,
      reserve: vi.fn(async () => { throw new Error('reserve reached') }) },
    ledger: { record: () => undefined }
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
  hc.backlog = createBacklogService(() => ctx, home)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); handlers.clear() })

function chain() {
  const first = hc.backlog.add({ title: 'Unity CLI step 1 wrapper', project: 'world' })
  const second = hc.backlog.add({ title: 'Unity CLI step 2 Gauntlet', project: 'world', dependsOn: [first.id] })
  return { first, second }
}

describe('dependency hardening on every start path', () => {
  it('crew.spawn refuses a quest whose dependency has not landed, unless forced', async () => {
    const { first, second } = chain()
    const req = { kind: 'ship' as const, project: 'world', title: second.title, intent: 'wire the Gauntlet', backlogId: second.id }
    await expect(hc.crew.spawn(req)).rejects.toThrow(`Quest ${second.id} waits on ${first.id} "Unity CLI step 1 wrapper" (queued)`)
    expect(ctx.dispatch.reserve).not.toHaveBeenCalled()
    await expect(hc.crew.spawn({ ...req, force: true })).rejects.toThrow('reserve reached')
    hc.backlog.markDone(first.id, 'landed')
    await expect(hc.crew.spawn(req)).rejects.toThrow('reserve reached')
  })

  it('deploy(quest_id) is refused while it waits, and force is cleared by the approval mode, never by quoted words', async () => {
    const { first, second } = chain()
    let mode = 'ask'
    const ask = vi.fn(async () => false)
    Object.assign(ctx, { settings: { get: () => ({ chatShellMode: mode }), harness: () => undefined }, permissions: { ask } })
    const deploy = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'deploy')!
    const args = { kind: 'ship', world: 'world', title: second.title, intent: 'wire the Gauntlet', quest_id: second.id }
    const refused = await deploy.invoke(args)
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(`waits on ${first.id}`) }] })
    // The player's own words in chat do not answer the prompt; Deny starts nothing.
    playerSays('start step 2 now anyway')
    expect(await deploy.invoke({ ...args, force: true, player_words: 'start step 2 now anyway' })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('denied') }] })
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ tool: 'deploy', input: expect.stringContaining('before the work it waits on lands') }))
    expect(ctx.dispatch.reserve).not.toHaveBeenCalled()
    ask.mockResolvedValueOnce(true)
    expect(await deploy.invoke({ ...args, force: true })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('reserve reached') }] })
    expect(ctx.dispatch.reserve).toHaveBeenCalledOnce()
    mode = 'all'
    expect(await deploy.invoke({ ...args, force: true })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('reserve reached') }] })
    expect(ask).toHaveBeenCalledTimes(2)
    const bot = createToolRegistry(() => ctx, home, 'bot').find(t => t.name === 'deploy')!
    expect(await bot.invoke({ ...args, force: true })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('waits for the player') }] })
  })

  it('the quest page Dispatch button refuses with "waits on", and Dispatch anyway records the player\'s click for one launch', async () => {
    const { second } = chain()
    registerIpc(() => ctx)
    const dispatch = handlers.get('genio:backlogDispatch')!
    expect(await dispatch({ sender: { id: 1 } }, second.id)).toEqual({ ok: false, message: 'This quest waits on "Unity CLI step 1 wrapper": it starts once that lands. Use Dispatch anyway to start it now.' })
    expect(send).not.toHaveBeenCalled()
    expect(await dispatch({ sender: { id: 1 } }, second.id, true)).toMatchObject({ ok: true })
    expect(hc.backlog.get(second.id)?.depsOverride).toMatchObject({ via: 'ui-button' })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('The player chose Dispatch anyway'), 'system')
    // the recorded click lets the deploy through the spawn gate once
    await expect(hc.crew.spawn({ kind: 'ship', project: 'world', title: second.title, intent: 'wire the Gauntlet', backlogId: second.id })).rejects.toThrow('reserve reached')
  })

  it('a quest that is already starting is never launched twice by a second start path', async () => {
    const free = hc.backlog.add({ title: 'free work', project: 'world' })
    let unblock!: () => void
    vi.mocked(ctx.dispatch.reserve).mockImplementationOnce(() => new Promise((_, reject) => { unblock = () => reject(new Error('reserve reached')) }))
    const req = { kind: 'ship' as const, project: 'world', title: free.title, intent: 'do it', backlogId: free.id }
    const first = hc.crew.spawn(req)
    await expect(hc.crew.spawn(req)).rejects.toThrow(`Quest ${free.id} is already starting.`)
    unblock()
    await expect(first).rejects.toThrow('reserve reached')
    await expect(hc.crew.spawn(req)).rejects.toThrow('reserve reached')
  })
})
