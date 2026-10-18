import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createWakeService } from '../src/main/wakes'
import { IDLE_CLOSE_MS, createSupervisor } from '../src/main/supervisor'
import { liveUnits } from '../src/main/usage-policy'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'

let root: string, home: Home, ctx: AppCtx
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-overwatch-'))
  home = new Home(root); home.ensure()
  const task = { id: 'unit', title: 'Fix notifications', kind: 'ship', mode: 'local-only', project: 'world',
    workspace: 'main', state: 'working', terminalId: 'terminal', worktree: root, branch: 'genio/unit',
    updatedAt: new Date().toISOString() } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  const hc = { home, crew: undefined as any, wakes: undefined as any, workspace: { deliverWakes: vi.fn() } }
  ctx = { main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ signalGraceSeconds: 30, usageMode: 'balanced' }) },
    terminals: { get: () => ({ alive: true }), lastOutputAt: () => Date.now() },
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
  hc.wakes = createWakeService(() => ctx, home)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('re-evaluates queued quests and plan releases on quota recovery before the next heartbeat', async () => {
  vi.useFakeTimers()
  const drain = vi.fn(async () => [])
  let held = true
  Object.assign(ctx.main, { backlog: { list: () => [], dispatchable: () => held ? [] : [{ id: 'q', kind: 'ship', title: 'Resume queued work', project: 'world' }] },
    decisions: { list: () => [] }, plans: { drain } })
  ctx.settings.get = () => ({ usageMode: 'balanced', autoDispatchQueued: true }) as any
  const supervisor = createSupervisor(() => ctx, home)
  try {
    supervisor.start()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(ctx.main.wakes.pending().some(w => w.lines.some(line => line.includes('quest q ready')))).toBe(false)
    drain.mockClear()
    held = false
    supervisor.poke(true)
    expect(drain).toHaveBeenCalledOnce()
    expect(ctx.main.wakes.pending().some(w => w.lines.some(line => line.includes('quest q ready')))).toBe(true)
  } finally { supervisor.stop(); vi.useRealTimers() }
})

describe('durable unit status supervision', () => {
  it.each([
    ['done: ready in branch genio/unit', 'ready', 'ship'],
    ['done: report complete', 'done', 'scout'],
    ['failed: verification failed', 'failed', 'ship'],
    ['paused: waiting until 2026-12-01T12:00Z', 'paused', 'ship']
  ] as const)('persists %s before the grace window and survives restart', (line, state, kind) => {
    ctx.main.crew.update('unit', { kind })
    ctx.main.crew.appendStatus('unit', line)
    createSupervisor(() => ctx, home).poke()
    expect(ctx.main.crew.get('unit')?.state).toBe(state)
    expect(ctx.main.wakes.pending()).toMatchObject([{ lines: [line], routine: false }])
    ctx.main.crew = createCrewService(() => ctx, home)
    ctx.main.wakes = createWakeService(() => ctx, home)
    createSupervisor(() => ctx, home).poke()
    expect(ctx.main.wakes.pending()).toHaveLength(1)
    expect(ctx.main.workspace.deliverWakes).toHaveBeenCalledTimes(2)
  })

  it('retains the status cursor when writing the wake fails and retries on the next poll', () => {
    ctx.main.crew.appendStatus('unit', 'done: ready in branch genio/unit')
    vi.spyOn(ctx.main.wakes, 'enqueue').mockImplementationOnce(() => { throw new Error('disk full') })
    const supervisor = createSupervisor(() => ctx, home)
    supervisor.poke()
    expect(ctx.main.crew.get('unit')?.statusOffset ?? 0).toBe(0)
    expect(ctx.main.wakes.pending()).toHaveLength(0)
    supervisor.poke()
    expect(ctx.main.wakes.pending()).toHaveLength(1)
    expect(ctx.main.crew.get('unit')?.state).toBe('ready')
  })

  it('retries delivery without new events after a busy or unavailable chat', () => {
    ctx.main.crew.appendStatus('unit', 'done: ready in branch genio/unit')
    vi.mocked(ctx.main.workspace.deliverWakes).mockImplementationOnce(() => { throw new Error('chat unavailable') })
    const supervisor = createSupervisor(() => ctx, home)
    supervisor.poke()
    supervisor.poke()
    expect(ctx.main.workspace.deliverWakes).toHaveBeenCalledTimes(2)
    expect(ctx.main.wakes.pending()).toHaveLength(1)
  })

  it('releases a local ready branch slot while its terminal remains alive', () => {
    expect(ctx.main.crew.capacityUsed('world')).toBe(1)
    ctx.main.crew.appendStatus('unit', 'done: ready in branch genio/unit')
    createSupervisor(() => ctx, home).poke()
    expect(ctx.main.crew.capacityUsed('world')).toBe(0)
    expect(liveUnits(ctx.homes.values(), () => true)).toBe(0)
  })
})

describe('closing a finished unit\'s idle terminal', () => {
  let kill: ReturnType<typeof vi.fn>, quietFor: number, decisions: { taskId: string }[]
  beforeEach(() => {
    kill = vi.fn(); quietFor = IDLE_CLOSE_MS + 1_000; decisions = []
    Object.assign(ctx.terminals, { kill, lastOutputAt: () => Date.now() - quietFor })
    Object.assign(ctx.main, { decisions: { list: () => decisions } })
  })
  const finish = (kind: Task['kind'], state: Task['state']): void => {
    ctx.main.crew.update('unit', { kind, state, sessionHint: 'session-1' })
    if (kind === 'scout') { fs.mkdirSync(path.dirname(home.reportFile('unit')), { recursive: true }); fs.writeFileSync(home.reportFile('unit'), '# report') }
  }

  it.each([['scout', 'done'], ['ship', 'ready'], ['ship', 'merged']] as const)('closes a %s left %s after the grace period and keeps what a relaunch needs', (kind, state) => {
    finish(kind, state)
    createSupervisor(() => ctx, home).poke()
    expect(kill).toHaveBeenCalledWith('terminal')
    expect(ctx.main.crew.get('unit')).toMatchObject({ state, terminalId: undefined, sessionHint: 'session-1', worktree: root })
  })

  it('waits for the grace period', () => {
    finish('scout', 'done'); quietFor = 30_000
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })

  it('keeps a Recon open until its report exists', () => {
    ctx.main.crew.update('unit', { kind: 'scout', state: 'done' })
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['working', 'paused', 'blocked', 'needs-decision', 'validating', 'stale'] as const)('never closes a %s unit', (state) => {
    finish('ship', state)
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })

  it('never closes while a choice for the unit is open', () => {
    finish('scout', 'done'); decisions = [{ taskId: 'unit' }]
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })

  it('never closes while a ping for the unit is unread', async () => {
    finish('ship', 'ready')
    await ctx.main.crew.send('unit', 'one more thing')
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })

  it('never closes while a wake about the unit is pending', () => {
    finish('ship', 'ready')
    ctx.main.wakes.enqueue({ kind: 'signal', reason: 'done', taskId: 'unit', lines: [], routine: false })
    createSupervisor(() => ctx, home).poke()
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('Modeller claims', () => {
  it('follow the unit\'s models and claim notes; two Modellers on one path raise one choice, on the newer', () => {
    const base = ctx.main.crew.get('unit')!
    fs.writeFileSync(home.tasksFile, JSON.stringify([
      { ...base, id: 'older', title: 'Tower', modeller: true, claims: ['assets/models/tower.glb'], createdAt: '2026-10-16T09:00:00Z' },
      { ...base, title: 'Tower again', modeller: true, createdAt: '2026-10-16T10:00:00Z' }
    ]))
    ctx.main.crew = createCrewService(() => ctx, home)
    fs.mkdirSync(path.join(home.taskDir('unit'), 'modeller', 'tower'), { recursive: true })
    fs.writeFileSync(path.join(home.taskDir('unit'), 'modeller', 'tower', 'manifest.json'), JSON.stringify({ model: 'tower', steps: [] }))
    ctx.main.crew.appendStatus('unit', 'note [key=claim]: Assets/Models/Tower.glb')
    const opened: { taskId: string; key: string }[] = []
    const openForTask = vi.fn((taskId: string, key: string) => { opened.push({ taskId, key }) })
    Object.assign(ctx.main, { decisions: { list: () => opened, openForTask } })
    const supervisor = createSupervisor(() => ctx, home)
    supervisor.poke()
    expect(ctx.main.crew.get('unit')!.claims).toEqual(['.genio/modeller/tower/', 'Assets/Models/Tower.glb'])
    expect(openForTask).toHaveBeenCalledExactlyOnceWith('unit', 'asset-claim-older', expect.stringContaining('are changing the same model'), 'system',
      expect.objectContaining({ options: ['Stop this Modeller', 'Keep both; I pick one at merge'], context: expect.stringContaining('Assets/Models/Tower.glb') }))
    supervisor.poke()
    expect(openForTask).toHaveBeenCalledOnce()
  })

  it('a Generator\'s claim notes meet an older Modeller\'s path: one choice, and the Generator never turns into a Modeller', () => {
    const base = ctx.main.crew.get('unit')!
    fs.writeFileSync(home.tasksFile, JSON.stringify([
      { ...base, id: 'older', title: 'Tower', modeller: true, claims: ['assets/models/'], createdAt: '2026-10-16T09:00:00Z' },
      { ...base, title: 'Tower texture', generator: true, claims: ['Assets/Textures/stone.png'], createdAt: '2026-10-16T10:00:00Z' }
    ]))
    ctx.main.crew = createCrewService(() => ctx, home)
    // a model in its data (it tried the kernel) leaves it a Generator
    fs.mkdirSync(path.join(home.taskDir('unit'), 'modeller', 'tower'), { recursive: true })
    fs.writeFileSync(path.join(home.taskDir('unit'), 'modeller', 'tower', 'manifest.json'), JSON.stringify({ model: 'tower', steps: [] }))
    ctx.main.crew.appendStatus('unit', 'note [key=claim]: Assets/Models/tower.png')
    const openForTask = vi.fn()
    Object.assign(ctx.main, { decisions: { list: () => [], openForTask } })
    createSupervisor(() => ctx, home).poke()
    expect(ctx.main.crew.get('unit')).toMatchObject({ generator: true, claims: ['Assets/Textures/stone.png', '.genio/modeller/tower/', 'Assets/Models/tower.png'] })
    expect(ctx.main.crew.get('unit')!.modeller).toBeUndefined()
    expect(openForTask).toHaveBeenCalledExactlyOnceWith('unit', 'asset-claim-older', expect.stringContaining('are changing the same asset'), 'system',
      expect.objectContaining({ options: ['Stop this Generator', 'Keep both; I pick one at merge'], recommendation: 'Stop this Generator' }))
  })
})
