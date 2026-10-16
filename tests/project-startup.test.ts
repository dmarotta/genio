import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createBacklogService } from '../src/main/backlog'
import { createDecisionService } from '../src/main/decisions'
import { createWakeService } from '../src/main/wakes'
import { createSupervisor } from '../src/main/supervisor'
import { createPlanService } from '../src/main/plans'
import { ensureProjectBase, startProjectBase, stopProjectBase } from '../src/main/ctx'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { answerChoice, clarifyChoice } from '../src/main/wksp-tools'

let root: string, ctx: AppCtx, home: Home, hc: HomeCtx, cap: number
let terminals: Map<string, { id: string; alive: boolean }>, extra: Task[]
beforeEach(() => {
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-project-start-'))
  const mainHome = new Home(root); mainHome.ensure()
  home = new Home(path.join(root, 'wksps', 'world'), 'world', mainHome); home.ensure()
  cap = 2; terminals = new Map(); extra = []
  hc = { home, wksp: { prepareProjectOpen: vi.fn(), wakeProject: vi.fn(), deliverWakes: vi.fn(), stop: vi.fn() } } as unknown as HomeCtx
  const main = { home: mainHome, wksp: { deliverWakes: vi.fn() } } as unknown as HomeCtx
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, id: 'test', enabled: true, command: 'fake-unit' }
  const ally = { name: 'world', projects: ['world'], scope: 'world', home: home.root }
  const world = { name: 'world', path: root, capacity: 2, gitRepo: true }
  ctx = { appRoot: path.join(root, 'no-bundle'), main, home: (name: string) => name === 'main' ? main : hc,
    homes: new Map([['main', main], ['world', hc]]),
    settings: { get: () => ({ usageMode: 'save' }), harness: () => adapter },
    allies: { list: () => [ally] }, projects: { get: () => world },
    terminals: { get: (id: string) => terminals.get(id), lastOutputAt: () => undefined,
      create: vi.fn(() => { const t = { id: `term-${terminals.size}`, alive: true }; terminals.set(t.id, t); return t }),
      onData: () => () => {}, onExit: vi.fn(), kill: vi.fn(), submit: vi.fn() },
    dispatch: { capacity: () => ({ cap, used: [...terminals.values()].filter(t => t.alive).length }), quotaWait: () => undefined,
      reserve: vi.fn(async () => ({ loadout: {}, check: async () => {}, listed: vi.fn(), release: vi.fn() })), record: vi.fn() }
  } as unknown as AppCtx
  for (const base of [main, hc]) {
    base.crew = createCrewService(() => ctx, base.home)
    base.backlog = createBacklogService(() => ctx, base.home)
    base.decisions = createDecisionService(() => ctx, base.home)
    base.wakes = createWakeService(() => ctx, base.home)
    base.supervisor = createSupervisor(() => ctx, base.home)
    base.plans = createPlanService(() => ctx, base.home)
  }
})
afterEach(() => {
  for (const base of ctx.homes.values()) base.supervisor.stop()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function unit(id: string, state: Task['state'] = 'detached', base = hc): Task {
  const worktree = path.join(root, 'worktrees', id)
  fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(base.home.taskDir(id), { recursive: true })
  fs.writeFileSync(base.home.briefFile(id), '# Mission')
  const task = { id, title: id, project: 'world', wksp: base.home.name, state, mode: 'local-only', harness: 'test',
    worktree, briefPath: base.home.briefFile(id), branch: `genio/${id}`, relaunches: 8, automaticRelaunches: 1,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', inbox: { seq: 0, acked: 0 }, statusOffset: 0 } as Task
  fs.writeFileSync(base.home.tasksFile, JSON.stringify([...base.crew.list(), task]))
  base.crew = createCrewService(() => ctx, base.home)
  return task
}
async function open(): Promise<void> {
  await ensureProjectBase(ctx, 'world')
  await startProjectBase(ctx, 'world', 'world')
}

it('folds structured unit choices and preserves the open obligation during clarification', async () => {
  unit('choices', 'blocked')
  hc.crew.appendStatus('choices', 'needs-decision [key=scene]: May I close my test scene? || {"options":["Close it","Keep it"],"recommendation":"Close it","details":"PID 123; C:/test; check --scene","batch":"checks"}')
  hc.crew.readNewStatus('choices')
  const d = hc.decisions.list()[0]
  expect(d).toMatchObject({ question: 'May I close my test scene?', options: ['Close it', 'Keep it'], recommendation: 'Close it', context: 'PID 123; C:/test; check --scene', batch: 'checks' })
  expect((await clarifyChoice(ctx, d.id, 'Which copy?')).ok).toBe(true)
  expect(hc.crew.openDecisionKeys('choices')).toEqual(['scene'])
  expect(d.resolvedAt).toBeUndefined()
  expect((await answerChoice(ctx, d.id, 'Keep it')).ok).toBe(true)
  expect(d.answer).toBe('Keep it')
  expect(hc.crew.openDecisionKeys('choices')).toEqual([])
  expect(hc.crew.unreadInbox('choices')).toHaveLength(2)
})

describe('project window startup reconciliation', () => {
  it('deliberately relaunches detached units once, preserves their copies, and leaves the automatic retry available', async () => {
    const task = unit('unfinished')
    fs.writeFileSync(path.join(task.worktree, 'dirty.txt'), 'keep')
    await open()
    expect(hc.crew.get(task.id)).toMatchObject({ state: 'working', relaunches: 9, automaticRelaunches: 0, worktree: task.worktree })
    expect(fs.readFileSync(path.join(task.worktree, 'dirty.txt'), 'utf8')).toBe('keep')
    await Promise.all([startProjectBase(ctx, 'world', 'world'), startProjectBase(ctx, 'world', 'world')])
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(hc.wksp.wakeProject).toHaveBeenCalledOnce()
    expect(ctx.dispatch.reserve).toHaveBeenCalledOnce()
  })

  it('respects global and world caps across legacy and project-owned units', async () => {
    unit('legacy', 'detached', ctx.main)
    unit('first'); unit('second')
    cap = 1
    await open()
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(ctx.main.crew.get('legacy')?.state).toBe('working')
    expect(hc.crew.get('first')?.state).toBe('detached')
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining('waiting for capacity'))
  })

  it('replays offline outcomes before relaunching and preserves declared blockers and waits', async () => {
    unit('complete', 'working'); unit('choice', 'working'); unit('wait', 'paused')
    hc.crew.appendStatus('complete', 'done: ready in branch genio/complete')
    hc.crew.appendStatus('choice', 'needs-decision [key=api]: choose the API')
    await open()
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(hc.crew.get('complete')?.state).toBe('ready')
    expect(hc.crew.get('choice')?.state).toBe('needs-decision')
    expect(hc.crew.get('wait')?.state).toBe('paused')
    expect(hc.wakes.pending()).toHaveLength(2)
    expect(hc.wksp.deliverWakes).not.toHaveBeenCalled()
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining('choose the API'))
    hc.supervisor.replayStatus('world')
    expect(hc.wakes.pending()).toHaveLength(2)
  })

  it('respects a smaller world cap and resumes a final unread progress line', async () => {
    cap = 4
    vi.spyOn(ctx.projects, 'get').mockReturnValue({ name: 'world', path: root, capacity: 1, gitRepo: true } as never)
    unit('progress'); unit('overflow')
    hc.crew.appendStatus('progress', 'working: last offline progress')
    await open()
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(hc.crew.get('progress')?.state).toBe('working')
    expect(hc.crew.get('overflow')?.state).toBe('detached')
  })

  it('does not relaunch a completed unit while its replayed PR lookup is in flight', async () => {
    unit('pr-outcome', 'working')
    let finish!: (value: unknown) => void
    ctx.forge = { view: vi.fn(() => new Promise(resolve => { finish = resolve })) } as never
    hc.crew.appendStatus('pr-outcome', 'done: pr=https://github.com/example/project/pull/1')
    await open()
    expect(ctx.terminals.create).not.toHaveBeenCalled()
    expect(hc.crew.get('pr-outcome')?.state).toBe('paused')
    finish({ ok: true, state: 'OPEN' })
    await Promise.resolve(); await Promise.resolve()
    expect(hc.crew.get('pr-outcome')?.state).toBe('ready')
  })

  it('starts eligible queued quests after resuming units, leaving dependencies, holds and overflow queued', async () => {
    unit('resume')
    const done = hc.backlog.add({ id: 'done', title: 'finished dependency', project: 'world', state: 'done' })
    hc.backlog.add({ id: 'other', title: 'other project', project: 'other', priority: 'critical' })
    hc.backlog.add({ id: 'eligible', title: 'accepted work', project: 'world', notes: 'implement the requested change', dependsOn: [done.id] })
    hc.backlog.add({ id: 'overflow', title: 'overflow', project: 'world' })
    hc.backlog.add({ id: 'deps', title: 'blocked by dependency', project: 'world', dependsOn: ['missing'] })
    hc.backlog.add({ id: 'held', title: 'player hold', project: 'world', hold: { reason: 'ask first', since: '2026-01-01' } })
    const originalList = hc.crew.list.bind(hc.crew)
    vi.spyOn(hc.crew, 'list').mockImplementation(() => [...originalList(), ...extra])
    const spawn = vi.spyOn(hc.crew, 'spawn').mockImplementation(async req => {
      const terminal = ctx.terminals.create({} as never)
      const task = { id: `task-${req.backlogId}`, title: req.title, project: req.project, state: 'working', terminalId: terminal.id } as Task
      extra.push(task); hc.backlog.markInFlight(req.backlogId!, task.id); return task
    })
    await open()
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ backlogId: 'eligible', intent: 'implement the requested change' }))
    expect(hc.backlog.get('eligible')?.state).toBe('in-flight')
    expect(hc.backlog.get('overflow')?.state).toBe('queued')
    expect(hc.backlog.get('deps')?.state).toBe('queued')
    // no held state: the quest stays queued, flagged as waiting for the player
    expect(hc.backlog.get('held')?.state).toBe('queued')
    expect(hc.backlog.get('held')?.hold?.reason).toBe('ask first')
    expect(hc.backlog.get('held')?.taskId).toBeUndefined()
  })

  it('reports launch failures without consuming automatic retry or abandoning other unfinished work', async () => {
    unit('fails'); unit('continues')
    vi.mocked(ctx.terminals.create).mockImplementationOnce(() => { throw new Error('launch unavailable') })
    await open()
    expect(hc.crew.get('fails')).toMatchObject({ state: 'failed', automaticRelaunches: 0 })
    expect(hc.crew.get('continues')?.state).toBe('working')
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining('launch unavailable'))
  })

  it('does not let a failed queued launch hide other eligible work behind the batch cap', async () => {
    cap = 1
    hc.backlog.add({ id: 'fails', title: 'first quest', project: 'world', priority: 'high' })
    hc.backlog.add({ id: 'continues', title: 'second quest', project: 'world' })
    const spawn = vi.spyOn(hc.crew, 'spawn').mockImplementation(async req => {
      if (req.backlogId === 'fails') throw new Error('unavailable pinned tool')
      ctx.terminals.create({} as never)
      hc.backlog.markInFlight(req.backlogId!, 'new-task')
      return { id: 'new-task' } as Task
    })
    await open()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(hc.backlog.get('fails')?.state).toBe('queued')
    expect(hc.backlog.get('continues')?.state).toBe('in-flight')
  })

  it('reconciles once again after a project window closes and reopens', async () => {
    await open()
    await stopProjectBase(ctx, 'world', 'world')
    await open()
    expect(hc.wksp.wakeProject).toHaveBeenCalledTimes(2)
  })

  it('never resumes units whose quest is already done or dropped, but still resumes open quests', async () => {
    const quest = (id: string, state?: 'done' | 'dropped') => hc.backlog.add({ id, title: id, project: 'world', ...(state ? { state } : {}) }).id
    const units = { finished: ['exited', 'done'], dropped: ['working', 'dropped'], parked: ['detached', 'dropped'], open: ['detached', undefined] } as const
    for (const [id, [state, q]] of Object.entries(units)) {
      unit(id, state)
      hc.crew.update(id, { backlogId: quest(`q-${id}`, q) })
    }
    hc.backlog.markInFlight('q-open', 'open')
    await open()
    expect(ctx.terminals.create).toHaveBeenCalledOnce()
    expect(hc.crew.get('open')?.state).toBe('working')
    for (const id of ['finished', 'dropped', 'parked']) {
      expect(hc.crew.get(id)).toMatchObject({ state: 'exited', relaunches: 8 })
    }
    expect(hc.crew.get('dropped')?.stateReason).toBe('quest dropped; not resumed after restart')
    expect(hc.backlog.get('q-finished')?.state).toBe('done')
  })

  it('settles the quest of a landed unit whose despawn was deferred', async () => {
    unit('landed-late', 'merged')
    hc.crew.update('landed-late', { backlogId: hc.backlog.add({ id: 'q-landed', title: 'landed', project: 'world' }).id })
    hc.backlog.markInFlight('q-landed', 'landed-late')
    await open()
    expect(hc.backlog.get('q-landed')?.state).toBe('done')
    expect(hc.crew.get('landed-late')?.state).toBe('merged')
    expect(ctx.terminals.create).not.toHaveBeenCalled()
  })

  it('replays the 10-14 restart: only work whose prerequisites landed starts, from its step spec; the rest starts when they merge', async () => {
    cap = 4
    vi.spyOn(ctx.projects, 'get').mockReturnValue({ name: 'world', path: root, capacity: 4, gitRepo: true } as never)
    const spec = (s: string) => `Implement ${s} as the Recon describes, with tests.`
    const steps = (keys: [string, string[]][]) => keys.map(([key, after]) => ({ key, title: key, spec: spec(key), after, acceptance: `${key} passes its tests` }))
    // CLI 1 → {CLI 2, CLI 3}; Fast copies 4 → 5, with 4 also waiting on the slots change (another quest)
    const cli = (await hc.plans.create({ world: 'world', title: 'Unity CLI', intent: 'add the genio-unity CLI', start: false, steps: steps([['cli1', []], ['cli2', ['cli1']], ['cli3', ['cli1']]]) })).plan
    const fc = (await hc.plans.create({ world: 'world', title: 'Fast copies', intent: 'make Unity copies fast', start: false, steps: steps([['fc4', []], ['fc5', ['fc4']]]) })).plan
    const quest = (p: typeof cli, key: string) => p.steps.find(s => s.key === key)!.questId
    hc.backlog.add({ id: 'slots', title: 'Unity slots settings', project: 'world' })
    hc.backlog.markInFlight('slots', 'slots-unit')
    hc.backlog.update(quest(fc, 'fc4'), { dependsOn: ['slots'] })
    // CLI 1 was in flight when Genio went down
    unit('cli1-unit')
    hc.crew.update('cli1-unit', { backlogId: quest(cli, 'cli1') })
    hc.backlog.markInFlight(quest(cli, 'cli1'), 'cli1-unit')
    const originalList = hc.crew.list.bind(hc.crew)
    vi.spyOn(hc.crew, 'list').mockImplementation(() => [...originalList(), ...extra])
    let windowOpen = false
    const spawn = vi.spyOn(hc.crew, 'spawn').mockImplementation(async req => {
      if (!windowOpen) throw new Error('Open the project window before starting units.')
      if (hc.backlog.get(req.backlogId!)?.state === 'in-flight') throw new Error('already in flight')
      if (hc.backlog.unresolved(req.backlogId!).length) throw new Error('waits on its dependencies')
      const terminal = ctx.terminals.create({} as never)
      const task = { id: `task-${req.backlogId}`, title: req.title, project: req.project, state: 'working', terminalId: terminal.id, backlogId: req.backlogId } as Task
      extra.push(task); hc.backlog.markInFlight(req.backlogId!, task.id); return task
    })
    // the slots change landed while Genio was down; the plans' own drain cannot start anything with the window closed
    hc.backlog.markDone('slots', 'landed')
    await hc.plans.update(cli.id, { op: 'resume' })
    await hc.plans.update(fc.id, { op: 'resume' })
    await hc.plans.idle()
    spawn.mockClear()
    windowOpen = true
    await open()
    await hc.plans.idle()
    // the incident started CLI 2, CLI 3, FC 4 and FC 5 in 4 s; now only FC 4 may start
    expect(hc.crew.get('cli1-unit')?.state).toBe('working')
    expect(spawn.mock.calls.map(([r]) => r.title)).toEqual(['fc4'])
    expect(spawn.mock.calls[0][0]).toMatchObject({ spec: spec('fc4'), intent: 'make Unity copies fast', planContext: expect.stringContaining('step 1/2 "fc4"') })
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining(`(plan ${fc.id} step fc4)`))
    // CLI 1 merges: both CLI steps after it start by themselves, with the handoff note
    hc.crew.update('cli1-unit', { state: 'merged', landedAt: new Date().toISOString(), landedCommit: 'f404066aaaaaaaaa' })
    await hc.plans.idle()
    expect(spawn.mock.calls.map(([r]) => r.title)).toEqual(['fc4', 'cli2', 'cli3'])
    expect(spawn.mock.calls[1][0].planContext).toContain('- Step 1 "cli1": commit f404066aaaaa')
    expect(hc.backlog.get(quest(fc, 'fc5'))?.state).toBe('queued')
  })

  it('never restarts a queued quest whose work another quest or unit already delivered (10-13 duplicate Recons)', async () => {
    const delivered = unit('recon-delivered', 'done')
    hc.backlog.add({ id: 'twin', title: 'Why unit status pops', project: 'world', kind: 'scout' })
    hc.backlog.update('twin', { duplicateOf: '' })
    hc.backlog.add({ id: 'orig', title: 'Why unit status pops', project: 'world', kind: 'scout', state: 'done' })
    hc.backlog.add({ id: 'by-unit', title: 'Audit the slot pool', project: 'world', kind: 'scout' })
    hc.crew.update(delivered.id, { title: 'Audit the slot pool', kind: 'scout', createdAt: new Date(Date.now() + 1000).toISOString() })
    const spawn = vi.spyOn(hc.crew, 'spawn')
    await open()
    expect(spawn).not.toHaveBeenCalled()
    expect(hc.backlog.get('twin')).toMatchObject({ state: 'queued', duplicateOf: 'orig' })
    expect(hc.backlog.get('by-unit')?.duplicateOf).toBe('recon-delivered')
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining('Quest twin: not started, already handled by quest orig (done)'))
  })

  it('always wakes an empty project and scopes landed history to the previous visit', async () => {
    const task = unit('landed', 'merged')
    hc.crew.update(task.id, { landedAt: '2026-01-01T10:00:00Z' })
    fs.writeFileSync(path.join(home.state, 'project-open.json'), JSON.stringify({ openedAt: '2026-01-02T10:00:00Z' }))
    await open()
    expect(hc.wksp.prepareProjectOpen).toHaveBeenCalledOnce()
    expect(hc.wksp.wakeProject).toHaveBeenCalledWith(expect.stringContaining('Landed since last visit (0)'))
    expect(ctx.terminals.create).not.toHaveBeenCalled()
  })
})
