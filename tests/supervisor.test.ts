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
    wksp: 'main', state: 'working', terminalId: 'terminal', worktree: root, branch: 'genio/unit',
    updatedAt: new Date().toISOString() } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  const hc = { home, crew: undefined as any, wakes: undefined as any, wksp: { deliverWakes: vi.fn() } }
  ctx = { main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({ signalGraceSeconds: 30, usageMode: 'balanced' }) },
    terminals: { get: () => ({ alive: true }), lastOutputAt: () => Date.now() },
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
  hc.wakes = createWakeService(() => ctx, home)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

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
    expect(ctx.main.wksp.deliverWakes).toHaveBeenCalledTimes(2)
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
    vi.mocked(ctx.main.wksp.deliverWakes).mockImplementationOnce(() => { throw new Error('chat unavailable') })
    const supervisor = createSupervisor(() => ctx, home)
    supervisor.poke()
    supervisor.poke()
    expect(ctx.main.wksp.deliverWakes).toHaveBeenCalledTimes(2)
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
