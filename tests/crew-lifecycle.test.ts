import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler() {}, handle: (name: string, fn: any) => handlers.set(name, fn) }, BrowserWindow: {}, dialog: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createToolRegistry } from '../src/main/wksp-tools'
import { registerIpc } from '../src/main/ipc'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { createPermissionBroker } from '../src/main/permissions'
import { pickLoadout } from '../src/main/loadout'
import { defaultSettings } from '../src/main/settings'
import * as git from '../src/main/git'
import { CODEX_UNIT_MODEL, CLAUDE_UNIT_MODEL } from '../src/shared/unit-model-policy'

let root: string, home: Home, ctx: AppCtx, task: Task
let terminal: { id: string; alive: boolean } | undefined
let release: ReturnType<typeof vi.fn<() => void>>
beforeEach(() => {
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-lifecycle-'))
  home = new Home(root); home.ensure()
  const worktree = path.join(root, 'worktrees', 'unit')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(home.taskDir('unit'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'uncommitted.txt'), 'preserve my work')
  fs.writeFileSync(home.briefFile('unit'), '# Existing mission')
  task = { id: 'unit', kind: 'ship', project: 'world', wksp: 'main', state: 'exited', harness: 'test',
    worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 1, automaticRelaunches: 1 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  terminal = undefined
  release = vi.fn()
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, id: 'test', enabled: true, command: 'fake-unit' }
  const hc = { home, crew: undefined as any }
  ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined },
    permissions: createPermissionBroker(() => ctx),
    terminals: { get: (id: string) => terminal?.id === id ? terminal : undefined, lastOutputAt: () => undefined,
      create: vi.fn(() => { terminal = { id: 'new-terminal', alive: true }; return terminal }),
      submit: vi.fn(async () => { if (terminal) terminal.alive = false }), kill: vi.fn(), onData: () => () => {}, onExit: vi.fn() },
    dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release, check: async () => {} })), record: vi.fn() },
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); handlers.clear() })

describe('non-destructive lifecycle recovery', () => {
  it('holds automatic repeats but lets chat and UI deliberately restart without approval text', async () => {
    const crew = ctx.main.crew
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(false)
    const tool = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'control')!
    expect(await tool.invoke({ task: task.id, action: 'relaunch' })).not.toHaveProperty('isError')
    expect(crew.get(task.id)).toMatchObject({ state: 'working', automaticRelaunches: 0, relaunches: 2, branch: task.branch, worktree: task.worktree })
    crew.update(task.id, { automaticRelaunches: 1 })
    registerIpc(() => ctx)
    expect(await handlers.get('genio:controlTask')!({ sender: { id: 1 } }, task.id, 'relaunch')).toMatchObject({ ok: true })
    expect(crew.get(task.id)).toMatchObject({ automaticRelaunches: 0, relaunches: 3 })
    expect(fs.readFileSync(path.join(task.worktree, 'uncommitted.txt'), 'utf8')).toBe('preserve my work')
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('caps Bot recovery at one attempt, even when the automatic launch fails', async () => {
    const crew = ctx.main.crew
    crew.update(task.id, { automaticRelaunches: 0 })
    ctx.terminals.create = vi.fn(() => { throw new Error('terminal launch failed') })
    const tool = createToolRegistry(() => ctx, home, 'bot').find(t => t.name === 'control')!
    expect(await tool.invoke({ task: task.id, action: 'relaunch' })).toMatchObject({ isError: true })
    expect(crew.get(task.id)?.automaticRelaunches).toBe(1)
    expect(await tool.invoke({ task: task.id, action: 'relaunch' })).toMatchObject({ isError: true })
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(ctx.dispatch.reserve).toHaveBeenCalledOnce()
  })

  it('allows repeated deliberate chat relaunches and a fresh automatic retry afterward', async () => {
    const crew = ctx.main.crew
    const tool = createToolRegistry(() => ctx, home, 'ally').find(t => t.name === 'control')!
    for (let i = 0; i < 3; i++) {
      crew.update(task.id, { automaticRelaunches: 1 })
      expect(await tool.invoke({ task: task.id, action: 'relaunch' })).not.toHaveProperty('isError')
      expect(crew.get(task.id)?.automaticRelaunches).toBe(0)
    }
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(true)
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(false)
    expect(crew.get(task.id)?.relaunches).toBe(5)
  })

  it.each([1, undefined])('resets persisted recovery history on app restart (counter %s)', async (attempts) => {
    ctx.main.crew.update(task.id, { automaticRelaunches: attempts, relaunches: 8 })
    const crew = createCrewService(() => ctx, home)
    ctx.main.crew = crew
    await crew.reconcileOnStart()
    expect(crew.get(task.id)).toMatchObject({ state: 'detached', automaticRelaunches: 0, relaunches: 8 })
    expect(JSON.parse(fs.readFileSync(home.tasksFile, 'utf8'))[0].automaticRelaunches).toBe(0)
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(true)
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(false)
  })

  it('resets recovery after completed work, but not just a progress note', () => {
    const crew = ctx.main.crew
    crew.update(task.id, { state: 'working', mode: 'local-only' })
    crew.appendStatus(task.id, 'working: continuing')
    crew.readNewStatus(task.id)
    expect(crew.get(task.id)?.automaticRelaunches).toBe(1)
    crew.appendStatus(task.id, 'done: ready in branch genio/unit')
    crew.readNewStatus(task.id)
    expect(crew.get(task.id)).toMatchObject({ state: 'ready', automaticRelaunches: 0 })
  })

  it('preserves work and resets retry history when deliberate restart fails, and releases phantom capacity', async () => {
    ctx.terminals.create = vi.fn(() => { throw new Error('terminal launch failed') })
    const result = await ctx.main.crew.control(task.id, 'relaunch', 'resume existing work', true)
    expect(result).toEqual({ ok: false, message: 'terminal launch failed' })
    expect(ctx.main.crew.get(task.id)).toMatchObject({ state: 'failed', automaticRelaunches: 0, relaunches: 1, branch: task.branch, worktree: task.worktree })
    expect(ctx.main.crew.capacityUsed('world')).toBe(0)
    expect(fs.readFileSync(path.join(task.worktree, 'uncommitted.txt'), 'utf8')).toBe('preserve my work')
    expect(fs.readFileSync(task.briefPath, 'utf8')).toContain('# Existing mission')
    expect(release).toHaveBeenCalledOnce()
  })

  it('returns UI-safe preparation failures without stopping a still-live unit or losing its slot', async () => {
    terminal = { id: 'old', alive: true }
    ctx.main.crew.update(task.id, { state: 'working', terminalId: 'old', briefPath: path.join(root, 'absent', 'brief.md') })
    const result = await ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    expect(result.ok).toBe(false)
    expect(terminal.alive).toBe(true)
    expect(ctx.terminals.submit).not.toHaveBeenCalled()
    expect(ctx.main.crew.capacityUsed('world')).toBe(1)
    expect(release).toHaveBeenCalledOnce()
  })

  it('serializes concurrent restarts and never bypasses a quota or capacity rejection', async () => {
    let proceed!: () => void
    const pending = new Promise<void>(resolve => { proceed = resolve })
    ctx.dispatch.reserve = vi.fn(async () => { await pending; throw new Error('deferred: quota protection') })
    const first = ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: false, message: expect.stringContaining('already in progress') })
    proceed()
    expect(await first).toEqual({ ok: false, message: 'deferred: quota protection' })
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(ctx.main.crew.get(task.id)?.state).toBe('exited')
  })
})

async function approval() {
  // All preparation before the broker uses resolved promises; no wall-clock waits.
  for (let i = 0; i < 50 && !ctx.permissions.pending().length; i++) await Promise.resolve()
  expect(ctx.permissions.pending()).toHaveLength(1)
  return ctx.permissions.pending()[0]
}

describe('per-launch premium approval', () => {
  it.each([['codex', CODEX_UNIT_MODEL], ['claude', CLAUDE_UNIT_MODEL]])('pins the conservative model on legacy %s respawns', async (harness, model) => {
    ctx.main.crew.update(task.id, { harness, model: undefined })
    expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
    expect(ctx.permissions.pending()).toHaveLength(0)
    expect(ctx.terminals.create).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['--model', model]) }))
    expect(ctx.main.crew.get(task.id)?.model).toBe(model)
  })

  it('fails closed when a builtin adapter cannot pass the selected model', async () => {
    ctx.main.crew.update(task.id, { harness: 'codex' })
    const adapter = ctx.settings.harness('codex')!
    ctx.settings.harness = () => ({ ...adapter, modelArgs: [] })
    expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: false, message: expect.stringContaining('explicit model') })
    expect(ctx.terminals.create).not.toHaveBeenCalled()
  })

  it.each(['claude-fable-5-1', 'gpt-6-astra'])('requires a fresh player decision through both UI and tools for %s', async model => {
    ctx.main.crew.update(task.id, { model, automaticRelaunches: 0 })
    const tool = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'control')!
    registerIpc(() => ctx)
    const viaTool = tool.invoke({ task: task.id, action: 'relaunch', player_words: 'Use this model forever' })
    const first = await approval()
    expect(first.input).toContain(model)
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(ctx.terminals.submit).not.toHaveBeenCalled()
    await handlers.get('genio:resolvePermission')!({}, first.id, true)
    expect(await viaTool).not.toHaveProperty('isError')
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    const viaUI = handlers.get('genio:controlTask')!({}, task.id, 'relaunch')
    const second = await approval()
    expect(second.id).not.toBe(first.id)
    // Approval cannot be replayed and denial leaves the current process intact.
    ctx.permissions.resolve(first.id, true)
    expect(ctx.permissions.pending()).toHaveLength(1)
    expect(terminal?.alive).toBe(true)
    ctx.permissions.resolve(second.id, false)
    expect(await viaUI).toMatchObject({ ok: false, message: expect.stringContaining('denied or expired') })
    expect(terminal?.alive).toBe(true)
    expect(ctx.main.crew.get(task.id)).toMatchObject({ state: 'working', relaunches: 2 })
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('times out automatic recovery without spending its retry or changing the brief', async () => {
    ctx.main.crew.update(task.id, { model: 'astra', automaticRelaunches: 0 })
    const launch = ctx.main.crew.control(task.id, 'relaunch', 'must not be appended')
    await approval()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await launch).toMatchObject({ ok: false })
    expect(ctx.main.crew.get(task.id)).toMatchObject({ state: 'exited', automaticRelaunches: 0 })
    expect(fs.readFileSync(task.briefPath, 'utf8')).toBe('# Existing mission')
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('rechecks quota after consent before recalling a live unit', async () => {
    terminal = { id: 'old', alive: true }
    ctx.main.crew.update(task.id, { model: 'fable', state: 'working', terminalId: 'old' })
    let blocked = false
    ctx.dispatch.reserve = vi.fn(async () => ({ loadout: {} as any, listed: vi.fn(), release,
      check: async () => { if (blocked) throw new Error('deferred: quota protection') } }))
    const launch = ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    const request = await approval()
    blocked = true
    ctx.permissions.resolve(request.id, true)
    expect(await launch).toEqual({ ok: false, message: 'deferred: quota protection' })
    expect(terminal.alive).toBe(true)
    expect(ctx.terminals.submit).not.toHaveBeenCalled()
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('refuses changed loadouts while approval is pending', async () => {
    ctx.main.crew.update(task.id, { model: 'fable' })
    const launch = ctx.main.crew.control(task.id, 'relaunch', undefined, true)
    const request = await approval()
    ctx.main.crew.update(task.id, { model: 'astra' })
    ctx.permissions.resolve(request.id, true)
    expect(await launch).toMatchObject({ ok: false, message: expect.stringContaining('Launch changed') })
    expect(ctx.terminals.create).not.toHaveBeenCalled()
  })

  function world() {
    ctx.projects.get = vi.fn(() => ({ name: 'world', path: task.worktree, defaultBranch: 'main', engine: 'other' }) as any)
    ctx.projects.resolvePosture = vi.fn(() => ({ mode: 'local-only' as const, yolo: true, branchPrefix: 'genio/' }))
    ctx.main.backlog = { get: () => ({ id: 'quest' }), add: () => ({ id: 'quest' }), update: vi.fn(), markInFlight: vi.fn() } as any
    ctx.dispatch.reportWords = () => 400
    ctx.dispatch.usagePercent = () => undefined
  }

  it.each(['explicit', 'default', 'rule', 'table', 'sticky'] as const)('gates %s premium selections on fresh deploy', async source => {
    world()
    const model = 'gpt-6-astra'
    const settings = defaultSettings()
    settings.defaultHarness = 'codex'
    if (source === 'default') settings.defaultWorkerModel = model
    if (source === 'rule') settings.dispatchRules = [{ id: 'r', match: '', candidates: [{ harness: 'codex', model, spendPriority: 0 }] }]
    if (source === 'table') settings.categoryPools = [{ category: 'feature', locked: true, candidates: [{ harness: 'codex', model }] }]
    if (source === 'sticky') {
      ctx.main.crew.update(task.id, { harness: 'codex', model })
      ctx.main.backlog.get = () => ({ id: 'quest', taskId: task.id }) as any
    }
    ctx.dispatch.reserve = vi.fn(async input => ({ loadout: pickLoadout(input, settings, h => h.id === 'codex'),
      listed: vi.fn(), release, check: async () => {} }))
    vi.spyOn(git, 'addWorktree').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    vi.spyOn(git, 'assertIsolated').mockResolvedValue({ ok: true } as any)
    const launched = ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Implement feature', intent: 'Implement feature', category: 'feature', backlogId: 'quest',
      ...(source === 'explicit' ? { harness: 'codex', model } : {}) })
    const rejected = expect(launched).rejects.toThrow(/denied or expired/)
    const request = await approval()
    expect(request.input).toContain(model)
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    ctx.permissions.resolve(request.id, false)
    await rejected
    expect(ctx.main.backlog.markInFlight).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([true, false])('requires new consent for a Recon upgrade (approved=%s)', async allowed => {
    world()
    ctx.main.crew.update(task.id, { kind: 'scout', state: 'done', model: 'fable', automaticRelaunches: 0 })
    vi.spyOn(git, 'currentBranch').mockResolvedValue(task.branch)
    const promoted = ctx.main.crew.promote(task.id, 'Build this')
    const outcome = allowed ? expect(promoted).resolves.toMatchObject({ kind: 'ship' }) : expect(promoted).rejects.toThrow(/denied or expired/)
    const request = await approval()
    expect(request.input).toContain('Build')
    ctx.permissions.resolve(request.id, allowed)
    await outcome
    if (allowed) {
      expect(ctx.terminals.create).toHaveBeenCalledOnce()
      expect(ctx.main.crew.get(task.id)).toMatchObject({ kind: 'ship', relaunches: 2 })
    } else {
      expect(ctx.main.crew.get(task.id)).toMatchObject({ kind: 'scout', state: 'done', relaunches: 1 })
      expect(fs.readFileSync(task.briefPath, 'utf8')).toBe('# Existing mission')
      expect(ctx.terminals.create).not.toHaveBeenCalled()
    }
    expect(release).toHaveBeenCalledOnce()
  })
})
