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
import { bus } from '../src/main/bus'
import { createDispatchService } from '../src/main/dispatch'
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
import { OPUS } from '../src/shared/usage-mode'

let root: string, home: Home, ctx: AppCtx, task: Task
let terminal: { id: string; alive: boolean } | undefined
let release: ReturnType<typeof vi.fn<() => void>>
/** The player's own chat messages, which verified player_words must quote. */
let said: { id: string; wksp: string; role: 'player'; text: string; ts: string }[] = []
const playerSays = (text: string): void => { said.push({ id: `p-${said.length}`, wksp: 'main', role: 'player', text, ts: new Date().toISOString() }) }
beforeEach(() => {
  said = []
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
  const hc = { home, crew: undefined as any, wksp: { history: () => said } }
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
  it.each(['preparation', 'deferred-before-listing', 'deferred-after-listing', 'terminal'] as const)('real dispatch releases a ready-unit relaunch slot after %s failure', async failure => {
    const adapter = ctx.settings.harness('test')!
    const settings = { ...defaultSettings(), harnesses: [adapter] }
    ctx.settings.get = () => settings
    ctx.settings.availableHarnesses = () => [adapter]
    ctx.dispatch = createDispatchService(() => ctx)
    const reserve = ctx.dispatch.reserve.bind(ctx.dispatch)
    vi.spyOn(ctx.dispatch, 'reserve').mockImplementation(async (...args) => {
      const reservation = await reserve(...args)
      let checks = 0
      return { ...reservation, check: async () => {
        checks++
        if ((failure === 'deferred-before-listing' && checks === 1) || (failure === 'deferred-after-listing' && checks === 2)) throw new Error('deferred: quota protection')
        await reservation.check()
      } }
    })
    if (failure === 'terminal') ctx.terminals.create = vi.fn(() => { throw new Error('terminal failed') })
    for (let i = 0; i < 10; i++) {
      ctx.main.crew.update(task.id, { state: 'ready', terminalId: undefined,
        briefPath: failure === 'preparation' ? path.join(root, 'missing', 'brief.md') : task.briefPath })
      expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: false })
      expect(ctx.dispatch.capacity().used).toBe(0)
      expect(ctx.dispatch.pendingUnits()).toEqual([])
    }
  })

  it.each(['ready', 'merged', 'done', 'failed'] as const)('a deliberate respawn of %s work reports working and occupies one slot even with an old PR', async state => {
    const crew = ctx.main.crew
    const pr = { url: 'https://example.com/pull/1', state: 'MERGED' as const }
    terminal = { id: 'idle-terminal', alive: true }
    crew.update(task.id, { state, pr, terminalId: terminal.id })
    expect(crew.capacityUsed('world')).toBe(0)
    expect(await crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
    expect(crew.get(task.id)).toMatchObject({ state: 'working', terminalId: 'new-terminal', pr })
    expect(crew.capacityUsed('world')).toBe(1)
    expect(release).toHaveBeenCalledOnce()
  })

  it('moves the quest with its unit: every state change reaches the quest log, which closes it on landing', async () => {
    const { createBacklogService } = await import('../src/main/backlog')
    ;(ctx.main as any).backlog = createBacklogService(() => ctx, home)
    ;(ctx as any).ledger = { record: () => undefined }
    const quest = ctx.main.backlog.add({ title: 'Ship it', project: 'world' })
    ctx.main.backlog.markInFlight(quest.id, task.id)
    ctx.main.crew.update(task.id, { backlogId: quest.id })
    ctx.main.crew.update(task.id, { state: 'ready' })
    expect(ctx.main.backlog.get(quest.id)?.state).toBe('in-flight')
    ctx.main.crew.update(task.id, { state: 'failed' })
    expect(ctx.main.backlog.get(quest.id)?.state).toBe('in-flight')
    ctx.main.crew.update(task.id, { state: 'merged', landedAt: '2026-10-13T12:00:00.000Z', pr: { url: 'https://example.com/pull/9' } })
    expect(ctx.main.backlog.get(quest.id)).toMatchObject({ state: 'done', outcome: 'https://example.com/pull/9' })
  })

  it('holds automatic repeats; chat resumes a held unit only on the player\'s own words, the UI Respawn needs none', async () => {
    const crew = ctx.main.crew
    expect((await crew.control(task.id, 'relaunch')).ok).toBe(false)
    const tool = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'control')!
    expect(await tool.invoke({ task: task.id, action: 'relaunch' })).toMatchObject({ isError: true })
    expect(await tool.invoke({ task: task.id, action: 'relaunch', player_words: 'respawn it' })).toMatchObject({ isError: true })
    playerSays('respawn it')
    expect(await tool.invoke({ task: task.id, action: 'relaunch', player_words: 'respawn it' })).not.toHaveProperty('isError')
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
    playerSays('resume the unit')
    for (let i = 0; i < 3; i++) {
      crew.update(task.id, { automaticRelaunches: 1 })
      expect(await tool.invoke({ task: task.id, action: 'relaunch', player_words: 'resume the unit' })).not.toHaveProperty('isError')
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

  it('reconciles a whole roster at startup with one write of tasks.json, every unit updated', async () => {
    const units = Array.from({ length: 30 }, (_, i) => ({ ...task, id: `unit-${i}`, branch: `genio/unit-${i}`, state: i % 2 ? 'working' : 'exited' }) as Task)
    fs.writeFileSync(home.tasksFile, JSON.stringify(units))
    const crew = createCrewService(() => ctx, home)
    ctx.main.crew = crew
    const writes = vi.spyOn(fs, 'renameSync')
    await crew.reconcileOnStart()
    expect(writes.mock.calls.filter(([, to]) => String(to) === home.tasksFile)).toHaveLength(1)
    const saved = JSON.parse(fs.readFileSync(home.tasksFile, 'utf8')) as Task[]
    expect(saved.map(t => t.state)).toEqual(units.map(() => 'detached'))
    expect(crew.list().map(t => t.state)).toEqual(units.map(() => 'detached'))
    // Later updates persist at once again.
    crew.update('unit-0', { stateReason: 'after the pass' })
    expect(JSON.parse(fs.readFileSync(home.tasksFile, 'utf8'))[0].stateReason).toBe('after the pass')
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

  it('reads status lines a unit wrote as PowerShell UTF-16 or ANSI, cut mid-write, next to Genio UTF-8', () => {
    const crew = ctx.main.crew
    crew.update(task.id, { state: 'working', mode: 'local-only' })
    const file = home.statusFile(task.id)
    const wide = (s: string): Buffer => Buffer.from(s, 'utf16le')
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), wide('note: café — 中文 \u{1F389}\r\n')]))
    const second = wide('note: second ✅\r\n')
    // the write stops between a UTF-16 newline and its NUL, then inside the next line
    fs.appendFileSync(file, second.subarray(0, second.length - 1))
    expect(crew.readNewStatus(task.id).map(e => e.text)).toEqual(['café — 中文 \u{1F389}', 'second ✅'])
    fs.appendFileSync(file, second.subarray(second.length - 1))
    fs.appendFileSync(file, wide('note: th'))
    expect(crew.readNewStatus(task.id)).toEqual([])
    fs.appendFileSync(file, wide('ird\r\n'))
    crew.appendStatus(task.id, 'note: Genio’s own UTF-8')
    fs.appendFileSync(file, Buffer.concat([Buffer.from('note: ANSI café ', 'latin1'), Buffer.from([0x96, 0x0d, 0x0a])]))
    expect(crew.readNewStatus(task.id).map(e => e.text)).toEqual(['third', 'Genio’s own UTF-8', 'ANSI café –'])
    expect(crew.statusEvents(task.id).map(e => e.text)).toEqual(['café — 中文 \u{1F389}', 'second ✅', 'third', 'Genio’s own UTF-8', 'ANSI café –'])
  })

  it.each(['missing', 'error'])('completion cannot leave validating behind when Gauntlet preflight has a project %s', async failure => {
    const crew = ctx.main.crew
    if (failure === 'error') vi.spyOn(ctx.projects, 'get').mockImplementation(() => { throw new Error('project lookup failed') })
    crew.update(task.id, { state: 'working', mode: 'no-mistakes' })
    crew.appendStatus(task.id, 'done: committed')
    crew.readNewStatus(task.id)
    await Promise.resolve(); await Promise.resolve()
    expect(crew.get(task.id)).toMatchObject({ state: 'blocked' })
    expect(crew.get(task.id)?.stateReason).toContain(failure === 'error' ? 'project lookup failed' : 'not registered')
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
    ctx.main.backlog = { get: () => ({ id: 'quest' }), add: () => ({ id: 'quest' }), update: vi.fn(), markInFlight: vi.fn(), unresolved: () => [] } as any
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

/** A web project that spawns for real up to the worktree, with a stub quest log. */
function modellerWorld() {
  ctx.projects.get = vi.fn(() => ({ name: 'world', path: task.worktree, defaultBranch: 'main', engine: 'web' }) as any)
  ctx.projects.resolvePosture = vi.fn(() => ({ mode: 'local-only' as const, yolo: false, branchPrefix: 'genio/' }))
  ctx.main.backlog = { get: () => ({ id: 'quest' }), add: vi.fn(() => ({ id: 'quest' })), update: vi.fn(), markInFlight: vi.fn(), unresolved: () => [] } as any
  ctx.dispatch.reportWords = () => 400
  ctx.dispatch.usagePercent = () => undefined
  vi.spyOn(git, 'addWorktree').mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  vi.spyOn(git, 'assertIsolated').mockResolvedValue({ ok: true } as any)
}

describe('Modeller landing', () => {
  it('a Modeller quest spawns a Modeller: the flag and claims on the unit, its rules and delivery in the brief', async () => {
    modellerWorld()
    ctx.main.backlog.get = () => ({ id: 'quest', modeller: true, claims: ['assets/models/tower.glb'] }) as any
    ctx.dispatch.reserve = vi.fn(async input => ({ loadout: pickLoadout(input, defaultSettings(), h => ['claude', 'codex'].includes(h.id)),
      listed: vi.fn(), release, check: async () => {} }))
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Wooden watchtower', intent: 'a low-poly wooden watchtower', backlogId: 'quest' })
    expect(t).toMatchObject({ modeller: true, claims: ['assets/models/tower.glb'], state: 'working', harness: 'claude', model: OPUS })
    const brief = fs.readFileSync(t.briefPath, 'utf8')
    expect(brief).toContain('# Modeller')
    expect(brief).toContain('Modeller delivery')
    expect(brief).toContain('`assets/models/tower.glb`')
    expect(brief).toContain('--target web --fmt glb')
  })

  it('starts a Modeller with the player\'s attachments: copied into its data folder, listed in its brief, GENIO_REFERENCES set', async () => {
    modellerWorld()
    const sketch = path.join(root, 'Desktop', 'sketch.png')
    fs.mkdirSync(path.dirname(sketch), { recursive: true })
    fs.writeFileSync(sketch, 'png')
    const events: unknown[] = []
    const off = bus.onEvent((e) => { if (e.type === 'feature-used') events.push(e) })
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Tower', intent: 'a tower like my sketch', modeller: true,
      attachments: [{ kind: 'file', path: sketch, name: 'sketch.png', bytes: 3, source: sketch, note: 'the silhouette to match' }, { kind: 'text', name: 'size.md', text: '10 m tall', bytes: 9, source: 'inline text' }] })
    off()
    const refs = path.join(home.taskDir(t.id), 'references')
    expect(fs.readFileSync(path.join(refs, 'sketch.png'), 'utf8')).toBe('png')
    // the quest keeps its own copy, so a later unit on the same quest gets them too
    expect(fs.existsSync(path.join(home.data, 'quest-references', 'quest', 'sketch.png'))).toBe(true)
    const brief = fs.readFileSync(t.briefPath, 'utf8')
    expect(brief).toContain('## References')
    expect(brief).toContain('- `sketch.png` (image): the silhouette to match')
    expect(brief).toContain('- `size.md` (text)')
    expect(brief).toContain("Modeller: every step's review names the references")
    expect(ctx.terminals.create).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({ GENIO_REFERENCES: refs.replace(/\\/g, '/') }) }))
    expect(events).toContainEqual({ type: 'feature-used', feature: 'unit-references', id: t.id })
    // a unit without attachments gets neither the section nor the variable
    const plain = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Fix jump', intent: 'fix the jump', backlogId: 'other' })
    expect(fs.readFileSync(plain.briefPath, 'utf8')).not.toContain('## References')
    expect(vi.mocked(ctx.terminals.create).mock.calls.at(-1)![0].env).not.toHaveProperty('GENIO_REFERENCES')
  })

  it('stores the deploy summary on the unit and its quest, carries a quest\'s summary to its unit, and leaves the brief alone', async () => {
    modellerWorld()
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Fix jump', intent: 'fix the jump', summary: '  Fixes the double jump.  ' })
    expect(t.summary).toBe('Fixes the double jump.')
    expect(ctx.main.backlog.add).toHaveBeenLastCalledWith(expect.objectContaining({ notes: 'fix the jump', summary: 'Fixes the double jump.' }))
    expect(fs.readFileSync(t.briefPath, 'utf8')).not.toContain('Fixes the double jump.')
    ctx.main.backlog.get = () => ({ id: 'quest', summary: 'Builds a small wooden tower.' }) as any
    expect((await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Tower', intent: 'a tower', backlogId: 'quest' })).summary).toBe('Builds a small wooden tower.')
    ctx.main.backlog.get = () => ({ id: 'quest' }) as any
    expect((await ctx.main.crew.spawn({ project: 'world', kind: 'scout', title: 'Why slow', intent: 'why is it slow', backlogId: 'quest' })).summary).toBeUndefined()
  })

  it('loadout_preview carries the Modeller default through the tool schema', async () => {
    ctx.settings.get = () => defaultSettings()
    ctx.settings.availableHarnesses = () => BUILTIN_HARNESSES.filter(h => ['claude', 'codex'].includes(h.id))
    ctx.dispatch.signals = () => ({})
    const tool = createToolRegistry(() => ctx, home, 'genio').find(t => t.name === 'loadout_preview')!
    const result = await tool.invoke({ kind: 'ship', world: 'world', title: 'Tower', intent: 'Build a tower', category: 'art', modeller: true })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ harness: 'claude', model: OPUS, effort: 'medium' })
  })

  it('a deploy with the flag files a Modeller quest; a path another Modeller holds defers it', async () => {
    modellerWorld()
    const plain = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Fix jump', intent: 'fix the jump' })
    expect(plain.modeller).toBeUndefined()
    expect(fs.readFileSync(plain.briefPath, 'utf8')).not.toContain('Modeller delivery')
    ctx.main.crew.update(task.id, { modeller: true, state: 'working', claims: ['assets/models/'], title: 'Tower' })
    await expect(ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Second tower', intent: 'another tower', modeller: true, claims: ['Assets/Models/tower.glb'] }))
      .rejects.toThrow(/^deferred: Assets\/Models\/tower\.glb is claimed by Modeller unit/)
    expect(ctx.main.backlog.add).toHaveBeenLastCalledWith(expect.objectContaining({ modeller: true, claims: ['Assets/Models/tower.glb'] }))
    expect(git.addWorktree).toHaveBeenCalledOnce()
    ctx.main.crew.update(task.id, { state: 'merged' })
    expect(await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Second tower', intent: 'another tower', modeller: true, claims: ['Assets/Models/tower.glb'] }))
      .toMatchObject({ modeller: true })
  })

  it('a despawn drops step snapshots and GLBs and keeps renders, scripts and manifests', async () => {
    modellerWorld()
    // the project lives elsewhere: despawn never removes a project's own folder
    ctx.projects.get = vi.fn(() => ({ name: 'world', path: path.dirname(task.worktree), defaultBranch: 'main', engine: 'web' }) as any)
    vi.spyOn(git, 'landedVerdict').mockResolvedValue({ landed: true, via: 'merged', reasons: [] } as any)
    vi.spyOn(git, 'isWorktreeOf').mockResolvedValue(false)
    vi.spyOn(git, 'pruneWorktrees').mockResolvedValue({ code: 0, stdout: '', stderr: '' } as any)
    vi.spyOn(git, 'branchExists').mockResolvedValue(false)
    ;(ctx.main as any).decisions = { list: () => [] }
    ;(ctx.terminals as any).list = () => []
    const step = path.join(home.taskDir('unit'), 'modeller', 'tower', 'steps', 's001')
    fs.mkdirSync(step, { recursive: true })
    for (const f of ['model.blend', 'model.glb', 'view.png', 'script.py']) fs.writeFileSync(path.join(step, f), f)
    fs.writeFileSync(path.join(step, '..', '..', 'manifest.json'), JSON.stringify({ steps: [{ id: 's001', files: { blend: 'steps/s001/model.blend', glb: 'steps/s001/model.glb', view: 'steps/s001/view.png' } }] }))
    ctx.main.crew.update(task.id, { modeller: true, state: 'merged', baseBranch: 'main' })
    expect(await ctx.main.crew.cleanup(task.id)).toMatchObject({ ok: true })
    expect(fs.readdirSync(step).sort()).toEqual(['script.py', 'view.png'])
  })
})

describe('Generator', () => {
  const tools = () => createToolRegistry(() => ctx, home, 'genio')
  const text = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text

  it('a Generator quest spawns a Generator: the flag and claims on the unit, its rules in the brief, no Modeller parts', async () => {
    modellerWorld()
    ctx.main.backlog.get = () => ({ id: 'quest', generator: true, claims: ['Assets/Audio/door.wav'] }) as any
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Door sounds', intent: 'a door creak and a slam', backlogId: 'quest' })
    expect(t).toMatchObject({ generator: true, claims: ['Assets/Audio/door.wav'], state: 'working' })
    expect(t.modeller).toBeUndefined()
    const brief = fs.readFileSync(t.briefPath, 'utf8')
    expect(brief).toContain('# Generator')
    // no default budget: a paid call waits for the player's approval
    expect(brief).toContain('there is no default budget')
    expect(brief).toContain('You start with no spend grant (USD 0).')
    expect(brief).not.toContain('USD 0.50')
    expect(fs.existsSync(path.join(home.taskDir(t.id), 'spend-grant.json'))).toBe(false)
    expect(brief).toContain('`Assets/Audio/door.wav`')
    expect(brief).toContain('--engine web')
    expect(brief).not.toContain('# Modeller')
    expect(brief).not.toContain('Modeller delivery')
  })

  it("records the Deploy dialog's approved budget as the unit's signed grant before it launches", async () => {
    modellerWorld()
    ;(ctx as any).ledger = { record: () => undefined }
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Door sounds', intent: 'a door creak', generator: true, approvedBudget: { usd: 0.5, via: 'dialog' } })
    expect(fs.readFileSync(t.briefPath, 'utf8')).toContain('The player has approved USD 0.50 for you so far: that is your spend grant.')
    const { readGrant } = await import('../resources/unit-skills/genio/lib/spend-grant.mjs')
    const { grantEnv } = await import('../src/main/spend-grants')
    expect(readGrant({ ...grantEnv(home.data, home.taskDir(t.id)), GENIO_TASK_ID: t.id })).toMatchObject({ ok: true, total_usd: 0.5, grants: [{ usd: 0.5, by: 'player', how: 'approved budget in the Deploy dialog' }] })
    expect(fs.readFileSync(home.statusFile(t.id), 'utf8')).toMatch(/note \[key=spend\][^:]*: spend grant from the player: USD 0\.50 \(approved budget in the Deploy dialog\)/)
  })

  it('deploy and quest_add carry the flag on Builds only and never with the Modeller flag', async () => {
    modellerWorld()
    const deploy = tools().find(x => x.name === 'deploy')!
    const r = await deploy.invoke({ kind: 'ship', world: 'world', title: 'Hero art', intent: 'a hero portrait', generator: true, claims: ['Assets/Art/hero.png'] })
    expect(text(r)).toMatch(/^deployed .*: Generator "Hero art"/)
    expect(ctx.main.backlog.add).toHaveBeenLastCalledWith(expect.objectContaining({ generator: true, claims: ['Assets/Art/hero.png'] }))
    expect(ctx.main.crew.list().find(x => x.title === 'Hero art')).toMatchObject({ generator: true, claims: ['Assets/Art/hero.png'] })
    expect(await deploy.invoke({ kind: 'scout', world: 'world', title: 'Look', intent: 'look at audio', generator: true })).toMatchObject({ isError: true })
    expect(text(await deploy.invoke({ kind: 'ship', world: 'world', title: 'Both', intent: 'both kinds', generator: true, modeller: true }))).toMatch(/Modeller or a Generator, not both/)
    await expect(ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Both', intent: 'both kinds', generator: true, modeller: true })).rejects.toThrow(/not both/)

    const { createBacklogService } = await import('../src/main/backlog')
    ;(ctx.main as any).backlog = createBacklogService(() => ctx, home)
    ;(ctx as any).ledger = { record: () => undefined }
    const questAdd = tools().find(x => x.name === 'quest_add')!
    expect(text(await questAdd.invoke({ title: 'Coin pickup sound', world: 'world', generator: true, claims: ['Assets/Audio/coin.wav'] }))).toMatch(/^quest \S+ filed/)
    expect(ctx.main.backlog.list().at(-1)).toMatchObject({ kind: 'ship', generator: true, claims: ['Assets/Audio/coin.wav'] })
    expect(await questAdd.invoke({ title: 'Recon of sounds', world: 'world', kind: 'scout', generator: true })).toMatchObject({ isError: true })
    expect(await questAdd.invoke({ title: 'Both kinds at once', world: 'world', generator: true, modeller: true })).toMatchObject({ isError: true })
    const id = ctx.main.backlog.list().at(-1)!.id
    await tools().find(x => x.name === 'quest_update')!.invoke({ id, modeller: true })
    expect(ctx.main.backlog.get(id)).toMatchObject({ modeller: true, generator: undefined })
  })

  it('a flag in the request replaces the quest\'s other flag', async () => {
    modellerWorld()
    ctx.main.backlog.get = () => ({ id: 'quest', modeller: true, claims: ['Assets/Models/tower.glb'] }) as any
    const t = await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Tower texture', intent: 'a stone texture', backlogId: 'quest', generator: true })
    expect(t).toMatchObject({ generator: true })
    expect(t.modeller).toBeUndefined()
    expect(ctx.main.backlog.update).toHaveBeenCalledWith('quest', expect.objectContaining({ generator: true, modeller: undefined }))
  })

  it('a path another Generator or Modeller holds defers the spawn, in both directions', async () => {
    modellerWorld()
    ctx.main.crew.update(task.id, { generator: true, state: 'working', claims: ['Assets/Audio/'], title: 'Door sounds' })
    await expect(ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'More sounds', intent: 'a coin sound', generator: true, claims: ['Assets/Audio/coin.wav'] }))
      .rejects.toThrow(/^deferred: Assets\/Audio\/coin\.wav is claimed by Generator unit/)
    await expect(ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Speaker model', intent: 'a speaker', modeller: true, claims: ['assets/audio/speaker.glb'] }))
      .rejects.toThrow(/is claimed by Generator unit/)
    const deferred = await tools().find(x => x.name === 'deploy')!.invoke({ kind: 'ship', world: 'world', title: 'More sounds', intent: 'a coin sound', generator: true, claims: ['Assets/Audio/coin.wav'] })
    expect(deferred).not.toHaveProperty('isError')
    expect(text(deferred)).toMatch(/claimed by Generator unit/)
    ctx.main.crew.update(task.id, { generator: undefined, modeller: true, claims: ['Assets/Models/'] })
    await expect(ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Tower skin', intent: 'a texture', generator: true, claims: ['Assets/Models/tower.png'] }))
      .rejects.toThrow(/is claimed by Modeller unit/)
    ctx.main.crew.update(task.id, { state: 'merged' })
    expect(await ctx.main.crew.spawn({ project: 'world', kind: 'ship', title: 'Tower skin', intent: 'a texture', generator: true, claims: ['Assets/Models/tower.png'] }))
      .toMatchObject({ generator: true })
  })

  it('leaves the chat\'s own generate_image as it was: Codex images on the ChatGPT plan, same arguments', async () => {
    const { GENERATE_IMAGE_DESC, generateImageShape } = await import('../src/main/chat-imagegen')
    const tool = tools().find(x => x.name === 'generate_image')!
    expect(tool.description).toBe(GENERATE_IMAGE_DESC)
    expect(GENERATE_IMAGE_DESC).toContain("Generate PNG image(s) with Codex's image_gen on the player's ChatGPT plan")
    expect(Object.keys(generateImageShape).sort()).toEqual(['art_bible', 'asset_type', 'count', 'place', 'player_words', 'prompt', 'refs', 'transparent', 'world'])
    expect(Object.keys(generateImageShape)).not.toContain('generator')
  })
})

describe('every unit kind gets every capability', () => {
  const APP_ROOT = path.resolve(__dirname, '..')

  it('deploys Recon, Build, Modeller and Generator with the same skills in the brief and the launch environment', async () => {
    const { capabilityGaps, UNIT_CAPABILITIES, unitPluginDir } = await import('../src/main/unitskills')
    modellerWorld()
    ;(ctx as any).appRoot = APP_ROOT
    const kinds = {
      recon: { kind: 'scout' as const },
      build: { kind: 'ship' as const },
      modeller: { kind: 'ship' as const, modeller: true },
      generator: { kind: 'ship' as const, generator: true }
    }
    const create = ctx.terminals.create as unknown as ReturnType<typeof vi.fn>
    // Per-unit folders differ by the unit's id only.
    const skillEnv = (env: Record<string, string>, id: string): Record<string, string> =>
      Object.fromEntries(Object.entries(env).filter(([k]) => /^(FAL_KEY|UTHANA_API_KEY|GENIO_(\w+_SKILL|UNITY|SOUND_DATA|MODELLER_DATA|BLENDER_SCRATCH|CODEX_IMAGE_SCRATCH|UTHANA_DATA|HELP_DOCS|SPEND_GRANT|SPEND_KEY))$/.test(k)).map(([k, v]) => [k, v.replaceAll(id, '<id>')]))
    const envs: Record<string, Record<string, string>> = {}
    for (const [name, req] of Object.entries(kinds)) {
      const t = await ctx.main.crew.spawn({ project: 'world', title: `${name} unit`, intent: `a ${name} job`, ...req })
      expect(capabilityGaps(fs.readFileSync(t.briefPath, 'utf8'), unitPluginDir(home.root)), name).toEqual([])
      const env = create.mock.calls.at(-1)![0].env as Record<string, string>
      for (const c of UNIT_CAPABILITIES) expect(env[c.env], `${name} ${c.env}`).toBeTruthy()
      expect(env.GENIO_SOUND_DATA, name).toBe(path.join(home.taskDir(t.id), 'sound').replace(/\\/g, '/'))
      envs[name] = skillEnv(env, t.id)
    }
    expect(Object.keys(envs.build)).toEqual(expect.arrayContaining(['GENIO_SOUND_SKILL', 'GENIO_UNITY', 'GENIO_SPEND_GRANT', 'GENIO_SPEND_KEY', 'GENIO_HELP_DOCS']))
    expect(envs.recon).toEqual(envs.build)
    expect(envs.modeller).toEqual(envs.build)
    expect(envs.generator).toEqual(envs.build)
  })

  it('a Recon upgraded to a Build keeps every capability and the grant the player approved', async () => {
    const { capabilityGaps, unitPluginDir } = await import('../src/main/unitskills')
    const { recordGrant } = await import('../src/main/spend-grants')
    modellerWorld()
    ctx.main.crew.update(task.id, { kind: 'scout', state: 'done', automaticRelaunches: 0 })
    vi.spyOn(git, 'currentBranch').mockResolvedValue(task.branch)
    recordGrant({ dataDir: home.data, taskDir: home.taskDir(task.id), unit: task.id, project: 'world', usd: 0.25, how: 'test' })
    await expect(ctx.main.crew.promote(task.id, 'Build this')).resolves.toMatchObject({ kind: 'ship' })
    const brief = fs.readFileSync(task.briefPath, 'utf8')
    expect(capabilityGaps(brief, unitPluginDir(home.root))).toEqual([])
    expect(brief).toContain('The player has approved USD 0.25 for you so far: that is your spend grant.')
    expect(brief).toContain('- Engine: web (JS/TS).')
  })
})


it('persists the ready signal independently of later notes and restart bookkeeping', () => {
  const crew = ctx.main.crew
  crew.update(task.id, { state: 'ready' })
  const readyAt = crew.get(task.id)!.readyAt
  expect(readyAt).toBeTruthy()
  vi.advanceTimersByTime(60_000)
  crew.update(task.id, { lastStatusAt: new Date().toISOString(), stateReason: 'later note' })
  const restored = createCrewService(() => ctx, home)
  expect(restored.get(task.id)!.readyAt).toBe(readyAt)
  expect(restored.get(task.id)!.updatedAt).not.toBe(readyAt)
})
