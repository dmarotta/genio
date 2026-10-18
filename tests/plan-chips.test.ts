import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { createBacklogService } from '../src/main/backlog'
import { createDecisionService } from '../src/main/decisions'
import { createWakeService } from '../src/main/wakes'
import { createPlanService, type PlanStepInput } from '../src/main/plans'
import { bus } from '../src/main/bus'
import { projectSnapshot, routeProjectEvent } from '../src/main/project-windows'
import {
  planCanDispatch, planColumn, planProgress, planView, stepStateText, stepTone
} from '../src/shared/work-plan'
import { queueChips } from '../src/shared/quest-board'
import type { AppCtx, CrewService, HomeCtx } from '../src/main/services'
import type { SpawnRequest } from '../src/shared/api'
import type { FleetSnapshot, GenioEvent, Task, WorkPlan } from '../src/shared/types'

let root: string, home: Home, hc: HomeCtx, ctx: AppCtx, tasks: Task[], events: GenioEvent[], off: () => void

/** The crew as plans see it: spawn marks the quest in flight, state changes reach the quest log and the plans. */
function fakeCrew(): Partial<CrewService> {
  let n = 0
  const crew: Partial<CrewService> = {
    list: () => tasks,
    get: (id) => tasks.find((t) => t.id === id),
    update(id, patch) {
      const t = tasks.find((x) => x.id === id)
      if (!t) return undefined
      const prev = t.state
      Object.assign(t, patch)
      if (patch.state && patch.state !== prev) {
        if (t.backlogId) hc.backlog.followUnit(t)
        hc.plans.followUnit(t)
      }
      return t
    },
    spawn: vi.fn(async (req: SpawnRequest) => {
      const t = { id: `unit-${++n}`, kind: req.kind, title: req.title, project: req.project, wksp: 'main', state: 'spawning', backlogId: req.backlogId,
        branch: `genio/unit-${n}`, baseBranch: 'main', createdAt: new Date().toISOString(), updatedAt: '', inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0, relaunches: 0 } as unknown as Task
      tasks.push(t)
      crew.update!(t.id, { state: 'working' })
      hc.backlog.markInFlight(req.backlogId!, t.id)
      return t
    }),
    statusEvents: () => [],
    capacityUsed: () => tasks.filter((t) => ['spawning', 'working'].includes(t.state)).length
  }
  return crew
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-plan-chips-'))
  home = new Home(root)
  home.ensure()
  tasks = []
  hc = { home, wksp: { deliverWakes: vi.fn(), say: vi.fn(), history: () => [] } } as unknown as HomeCtx
  hc.crew = fakeCrew() as CrewService
  hc.backlog = createBacklogService(() => ctx, home)
  hc.decisions = createDecisionService(() => ctx, home)
  hc.wakes = createWakeService(() => ctx, home)
  hc.plans = createPlanService(() => ctx, home)
  ctx = {
    homes: new Map([['main', hc]]), main: hc, home: () => hc,
    projects: { get: (name: string) => (name === 'world' ? { name: 'world', path: root } : undefined) },
    dispatch: { capacity: () => ({ cap: 16, used: 0 }), quotaWait: () => undefined },
    ledger: { record: () => undefined }, settings: { get: () => ({}) }, allies: { list: () => [] }
  } as unknown as AppCtx
  events = []
  off = bus.onEvent((ev) => { if (ev.type === 'plans') events.push(ev) })
})
afterEach(() => {
  off()
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const step = (key: string, after: string[] = []): PlanStepInput =>
  ({ key, title: `Step ${key}`, spec: `Implement ${key} completely, with tests, following the design.`, after, acceptance: `${key} works` })

async function createPlan(): Promise<WorkPlan> {
  const { plan } = await hc.plans.create({ world: 'world', title: 'New Play', intent: 'build the new play screen', steps: [step('copy'), step('life', ['copy']), step('screen', ['life'])] })
  await hc.plans.idle()
  return plan
}

describe('plan card controls', () => {
  it('Pause plan stops releases without opening a choice, tells the main chat once and reaches the windows', async () => {
    const plan = await createPlan()
    events = []
    const r = await hc.plans.update(plan.id, { op: 'pause', by: 'player' })
    expect(r.plan.state).toBe('paused')
    expect(r.plan.pause?.reason).toBe('paused by the player')
    expect(r.plan.pause?.choiceId).toBeUndefined()
    expect(hc.decisions.list(true).filter((d) => d.action?.kind === 'plan-paused')).toHaveLength(0)
    const wakes = hc.wakes.recent(0).filter((w) => w.kind === 'plan' && /The player paused/.test(w.reason))
    expect(wakes).toHaveLength(1)
    const last = events.at(-1) as Extract<GenioEvent, { type: 'plans' }>
    expect(last.plans.find((p) => p.id === plan.id)?.state).toBe('paused')
    // the running step keeps running; the next step does not start when it lands
    const first = tasks[0]
    hc.crew.update(first.id, { state: 'merged', landedAt: new Date().toISOString(), landedCommit: 'abc123' })
    await hc.plans.idle()
    expect(tasks).toHaveLength(1)
  })

  it('Cancel plan drops the steps not started, keeps the running one and resolves an open pause choice', async () => {
    const plan = await createPlan()
    hc.crew.update(tasks[0].id, { state: 'failed', stateReason: 'tests failed' })
    await hc.plans.idle()
    const paused = hc.plans.get(plan.id)!
    expect(paused.state).toBe('paused')
    const choice = hc.decisions.get(paused.pause!.choiceId!)!
    expect(choice.options).toEqual(['Resume the plan', 'Edit the step first', 'Cancel the plan'])
    // a second failure report for the same step does not ask again
    hc.crew.update(tasks[0].id, { state: 'working' })
    hc.crew.update(tasks[0].id, { state: 'failed' })
    await hc.plans.idle()
    expect(hc.decisions.list(true).filter((d) => d.action?.kind === 'plan-paused')).toHaveLength(1)
    const r = await hc.plans.update(plan.id, { op: 'cancel', by: 'player' })
    expect(r.plan.state).toBe('cancelled')
    expect(hc.decisions.get(choice.id)?.resolvedAt).toBeTruthy()
    expect(plan.steps.slice(1).map((s) => hc.backlog.get(s.questId)?.state)).toEqual(['dropped', 'dropped'])
    expect(hc.wakes.recent(0).some((w) => /The player dropped plan "New Play"/.test(w.reason))).toBe(true)
  })
})

describe('step chips (shared selector)', () => {
  it('words each step and the card\'s progress line', async () => {
    const plan = await createPlan()
    const v = planView(hc.plans.get(plan.id)!, hc.backlog.list(), tasks)
    expect(planProgress(v)).toBe('0/3 merged · step 1 Step copy')
    expect(planProgress({ ...v, state: 'done', merged: 3 })).toBe('3/3 merged')
    expect(v.steps.map((s) => stepStateText(s, v.steps))).toEqual(['working', 'waits on step 1', 'waits on step 2'])
    expect(v.steps.map((s) => stepTone(s))).toEqual(['blue', 'mute', 'mute'])
    expect(stepStateText({ state: 'merged', kind: 'scout', waitsOn: [] }, [])).toBe('delivered')
    expect(stepTone({ state: 'discarded', kind: 'ship' })).toBe('alert')
  })

  it('a plan is one card: in flight while a step runs, queued when paused, done when it ends', async () => {
    const plan = await createPlan()
    const view = (): ReturnType<typeof planView> => planView(hc.plans.get(plan.id)!, hc.backlog.list(), tasks)
    expect(planColumn(view())).toBe('in-flight')
    expect(planCanDispatch(view())).toBe(false)
    hc.crew.update(tasks[0].id, { state: 'merged', landedAt: new Date().toISOString(), landedCommit: 'abc123' })
    await hc.plans.idle()
    await hc.plans.update(plan.id, { op: 'pause', by: 'player' })
    hc.crew.update(tasks[1].id, { state: 'merged', landedAt: new Date().toISOString(), landedCommit: 'abd123' })
    expect(planColumn(view())).toBe('queued')
    expect(planCanDispatch(view())).toBe(true)
    await hc.plans.update(plan.id, { op: 'cancel', by: 'player' })
    expect(planColumn(view())).toBe('done')
    expect(planCanDispatch(view())).toBe(false)
  })
  it('a queued step waits on "step N" and shows its paused plan', async () => {
    const plan = await createPlan()
    const second = hc.backlog.get(plan.steps[1].questId)!
    const base = { backlog: hc.backlog.list(), tasks }
    expect(queueChips(second, base).find((c) => c.kind === 'depends')?.label).toBe('waits on "Step copy"')
    expect(queueChips(second, { ...base, plans: [plan] }).find((c) => c.kind === 'depends')?.label).toBe('waits on step 1')
    const paused = (await hc.plans.update(plan.id, { op: 'pause', by: 'player' })).plan
    const chips = queueChips(second, { ...base, plans: [paused] })
    expect(chips[0]).toMatchObject({ kind: 'plan', label: 'plan paused', title: 'paused by the player', tone: 'amber' })
  })
})

describe('plan priority and Dispatch', () => {
  it('defaults to normal, is inherited by every step quest and follows a change', async () => {
    const plan = await createPlan()
    expect(plan.priority).toBe('normal')
    const quests = (): string[] => plan.steps.map((s) => hc.backlog.get(s.questId)!.priority)
    expect(quests()).toEqual(['normal', 'normal', 'normal'])
    const r = await hc.plans.update(plan.id, { op: 'settings', priority: 'high' })
    expect(r.plan.priority).toBe('high')
    expect(quests()).toEqual(['high', 'high', 'high'])
    await expect(hc.plans.update(plan.id, { op: 'settings', priority: 'urgent' as never })).rejects.toThrow(/priority is low/)
    const { plan: critical } = await hc.plans.create({ world: 'world', title: 'Hot fix', intent: 'fix it fast', priority: 'critical', start: false, steps: [step('a')] })
    expect(hc.backlog.get(critical.steps[0].questId)!.priority).toBe('critical')
    expect(hc.plans.view(critical.id)?.priority).toBe('critical')
  })

  it('a saved plan without a priority loads as normal', async () => {
    const plan = await createPlan()
    const file = path.join(home.data, 'plans.json')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WorkPlan>[]
    delete saved[0].priority
    fs.writeFileSync(file, JSON.stringify(saved))
    const fresh = createPlanService(() => ctx, home)
    expect(fresh.get(plan.id)?.priority).toBe('normal')
  })

  it('a critical plan releases its step before a normal plan\'s', async () => {
    const { plan: slow } = await hc.plans.create({ world: 'world', title: 'Slow plan', intent: 'later', start: false, steps: [step('s')] })
    const { plan: fast } = await hc.plans.create({ world: 'world', title: 'Fast plan', intent: 'now', priority: 'critical', start: false, steps: [step('f')] })
    // both resumes are queued before the first drain runs
    await Promise.all([hc.plans.update(slow.id, { op: 'resume' }), hc.plans.update(fast.id, { op: 'resume' })])
    await hc.plans.idle()
    expect(tasks.map((t) => t.backlogId)).toEqual([fast.steps[0].questId, slow.steps[0].questId])
  })

  it('Dispatch resumes a paused plan and starts its ready steps even with auto-advance off', async () => {
    const { plan } = await hc.plans.create({ world: 'world', title: 'Held plan', intent: 'start on my word', start: false, autoAdvance: false, steps: [step('a'), step('b', ['a'])] })
    expect(tasks).toHaveLength(0)
    const r = await hc.plans.update(plan.id, { op: 'dispatch' })
    await hc.plans.idle()
    expect(r.plan.state).toBe('active')
    expect(r.plan.autoAdvance).toBe(true)
    expect(tasks).toHaveLength(1)
    expect(hc.wakes.recent(0).some((w) => /The player dispatched plan "Held plan"/.test(w.reason))).toBe(true)
  })
})

describe('project windows', () => {
  it('see only their own project\'s plans', () => {
    const mine = { id: 'p1', world: 'world' } as WorkPlan
    const theirs = { id: 'p2', world: 'elsewhere' } as WorkPlan
    const binding = { project: 'world', wksp: 'ally' }
    const routed = routeProjectEvent({ type: 'plans', plans: [mine, theirs] }, binding, {} as FleetSnapshot) as Extract<GenioEvent, { type: 'plans' }>
    expect(routed.plans.map((p) => p.id)).toEqual(['p1'])
    const snap = { tasks: [], backlog: [], plans: [mine, theirs], decisions: [], projects: [], wksps: [], allies: [] } as unknown as FleetSnapshot
    expect(projectSnapshot(snap, binding).plans?.map((p) => p.id)).toEqual(['p1'])
    expect(routeProjectEvent({ type: 'plans', plans: [mine, theirs] }, undefined, snap)).toMatchObject({ plans: [mine, theirs] })
  })
})
