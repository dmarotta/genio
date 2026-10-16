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
import { createToolRegistry } from '../src/main/wksp-tools'
import { renderBrief } from '../src/main/brief'
import { planView } from '../src/shared/work-plan'
import type { AppCtx, CrewService, HomeCtx } from '../src/main/services'
import type { SpawnRequest } from '../src/shared/api'
import type { StatusEvent, Task } from '../src/shared/types'

let root: string, home: Home, hc: HomeCtx, ctx: AppCtx
let tasks: Task[], spawned: SpawnRequest[], cap: number, refuse: string | undefined, done: Record<string, string>

/**
 * A crew that behaves like the real one where plans depend on it: spawn refuses
 * unlanded dependencies and marks the quest in flight; every state change
 * reaches the quest log and the plans, as crew.update does.
 */
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
      if (refuse) throw new Error(refuse)
      const used = tasks.filter((t) => ['spawning', 'working'].includes(t.state)).length
      if (used >= cap) throw new Error(`deferred: world is at capacity (${used}/${cap} units). The quest stays queued.`)
      const waits = req.backlogId ? hc.backlog.unresolved(req.backlogId) : []
      if (waits.length && !req.force) throw new Error(`Quest ${req.backlogId} waits on ${waits.join(', ')}`)
      const t = { id: `unit-${++n}`, kind: req.kind, title: req.title, project: req.project, wksp: 'main', state: 'spawning', backlogId: req.backlogId,
        branch: `genio/unit-${n}`, baseBranch: 'main', createdAt: new Date().toISOString(), updatedAt: '', inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0, relaunches: 0 } as unknown as Task
      tasks.push(t)
      spawned.push(req)
      crew.update!(t.id, { state: 'working' })
      hc.backlog.markInFlight(req.backlogId!, t.id)
      return t
    }),
    statusEvents: (id: string) => (done[id] ? [{ kind: 'done', text: done[id] } as StatusEvent] : []),
    capacityUsed: () => tasks.filter((t) => ['spawning', 'working'].includes(t.state)).length
  }
  return crew
}

function build(): void {
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
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-plans-'))
  home = new Home(root)
  home.ensure()
  tasks = []; spawned = []; cap = 4; refuse = undefined; done = {}
  build()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const spec = (what: string): string => `Implement ${what} completely, with tests, following the Recon design.`
const step = (key: string, after: string[] = [], extra: Partial<PlanStepInput> = {}): PlanStepInput =>
  ({ key, title: `Step ${key}`, spec: spec(key), after, acceptance: `${key} works and its tests pass`, ...extra })

async function createPlan(steps: PlanStepInput[], extra: { maxParallel?: number; start?: boolean } = {}) {
  const r = await hc.plans.create({ world: 'world', title: 'New Play', intent: 'build the new play screen in three builds', steps, ...extra })
  await hc.plans.idle()
  return r
}
const unitOf = (key: string, planId: string): Task => {
  const s = hc.plans.get(planId)!.steps.find((x) => x.key === key)!
  return tasks.find((t) => t.backlogId === s.questId && t.state !== 'cleaned') ?? tasks.filter((t) => t.backlogId === s.questId).pop()!
}
async function land(key: string, planId: string, extra: Partial<Task> = {}): Promise<Task> {
  const t = unitOf(key, planId)
  done[t.id] = `ready in branch ${t.branch}: ${key} implemented`
  hc.crew.update(t.id, { state: 'ready' })
  hc.crew.update(t.id, { state: 'merged', landedAt: new Date().toISOString(), landedCommit: `${key}0123456789abcdef`, landedFiles: [`src/${key}.ts`, 'src/shared/types.ts'], ...extra })
  await hc.plans.idle()
  return t
}
const states = (planId: string) => Object.fromEntries(hc.plans.view(planId)!.steps.map((s) => [s.key, s.state]))

describe('WorkPlan store and compilation', () => {
  it('files one quest per step whose dependencies mirror after, and refuses bad graphs and duplicate plans', async () => {
    const { plan } = await createPlan([step('core'), step('ui', ['core']), step('docs', ['ui'])], { start: false })
    const quests = plan.steps.map((s) => hc.backlog.get(s.questId)!)
    expect(quests.map((q) => q.dependsOn)).toEqual([[], [plan.steps[0].questId], [plan.steps[1].questId]])
    expect(quests.every((q) => q.planId === plan.id && !q.duplicateOf)).toBe(true)
    expect(plan.state).toBe('paused')
    expect(spawned).toHaveLength(0)
    await expect(hc.plans.create({ world: 'world', title: 'new play', intent: 'again', steps: [step('a')] })).rejects.toThrow(/already paused/)
    await expect(hc.plans.create({ world: 'world', title: 'Loop', intent: 'x', steps: [step('a', ['b']), step('b', ['a'])] })).rejects.toThrow(/cycle/)
    await expect(hc.plans.create({ world: 'world', title: 'Ghost', intent: 'x', steps: [step('a', ['nope'])] })).rejects.toThrow(/unknown step "nope"/)
    await expect(hc.plans.create({ world: 'world', title: 'Thin', intent: 'x', steps: [{ ...step('a'), spec: 'do it' }] })).rejects.toThrow(/complete spec/)
  })

  it('survives a restart: the store reloads and a landing after it still releases the next step', async () => {
    const { plan } = await createPlan([step('core'), step('ui', ['core'])])
    expect(spawned.map((r) => r.title)).toEqual(['Step core'])
    // Genio restarts: every service is rebuilt from disk
    const before = tasks
    build()
    tasks = before
    expect(hc.plans.get(plan.id)).toMatchObject({ state: 'active', steps: [{ key: 'core', taskIds: ['unit-1'] }, { key: 'ui', taskIds: [] }] })
    expect(fs.existsSync(path.join(home.data, 'plans.json'))).toBe(true)
    await land('core', plan.id)
    expect(spawned.map((r) => r.title)).toEqual(['Step core', 'Step ui'])
    expect(hc.plans.get(plan.id)!.steps[0]).toMatchObject({ landedCommit: 'core0123456789abcdef', doneLine: 'ready in branch genio/unit-1: core implemented' })
  })
})

describe('auto-release', () => {
  it('serial chain: each step starts only when the one before it merges, then the plan completes', async () => {
    const { plan, announcement } = await createPlan([step('core'), step('ui', ['core']), step('docs', ['ui'])])
    expect(announcement).toMatch(/serial.*1 Step core → 2 Step ui → 3 Step docs/)
    expect(spawned.map((r) => r.title)).toEqual(['Step core'])
    expect(states(plan.id)).toEqual({ core: 'in-flight', ui: 'waiting', docs: 'waiting' })
    // ready (waiting for its merge) is not merged: nothing starts
    hc.crew.update(unitOf('core', plan.id).id, { state: 'ready' })
    await hc.plans.idle()
    expect(spawned).toHaveLength(1)
    expect(hc.plans.view(plan.id)!.blockers).toContain('step 1 "Step core" waits for its merge')
    await land('core', plan.id)
    expect(spawned.map((r) => r.title)).toEqual(['Step core', 'Step ui'])
    expect(spawned[1]).toMatchObject({ spec: spec('ui'), intent: 'build the new play screen in three builds', backlogId: plan.steps[1].questId })
    await land('ui', plan.id)
    await land('docs', plan.id)
    expect(hc.plans.get(plan.id)).toMatchObject({ state: 'done' })
    expect(hc.wakes.pending().map((w) => w.reason)).toContainEqual(expect.stringMatching(/Plan "New Play" complete/))
  })

  it('parallel branches: both steps after a shared root start together when it merges, within max parallel', async () => {
    const { plan } = await createPlan([step('root'), step('left', ['root']), step('right', ['root']), step('join', ['left', 'right'])], { maxParallel: 2 })
    await land('root', plan.id)
    expect(spawned.map((r) => r.title)).toEqual(['Step root', 'Step left', 'Step right'])
    expect(states(plan.id)).toMatchObject({ left: 'in-flight', right: 'in-flight', join: 'waiting' })
    await land('left', plan.id)
    expect(spawned).toHaveLength(3) // join still waits on right
    await land('right', plan.id)
    expect(spawned.map((r) => r.title).at(-1)).toBe('Step join')
  })

  it('caps a plan at max parallel even when more steps are free', async () => {
    const { plan } = await createPlan([step('a'), step('b'), step('c')], { maxParallel: 2 })
    expect(spawned.map((r) => r.title)).toEqual(['Step a', 'Step b'])
    expect(hc.plans.holds(plan.steps[2].questId)).toMatch(/already runs 2 of 2/)
    await land('a', plan.id)
    expect(spawned.map((r) => r.title)).toEqual(['Step a', 'Step b', 'Step c'])
  })

  it('hands off what landed: commit, done line and changed files of every prerequisite, and its own acceptance', async () => {
    const { plan } = await createPlan([step('core', [], { files: ['src/main/crew.ts'] }), step('ui', ['core'], { files: ['src/renderer/Play.tsx'] }), step('docs', ['ui'])])
    await land('core', plan.id)
    await land('ui', plan.id)
    const note = spawned[2].planContext!
    expect(note).toContain(`Plan: New Play (${plan.id}) · step 3/3 "Step docs"`)
    expect(note).toContain('Acceptance for this step: docs works and its tests pass')
    expect(note).toContain('- Step 1 "Step core": commit core01234567; done: ready in branch genio/unit-1: core implemented')
    expect(note).toContain('  Changed files: src/core.ts, src/shared/types.ts')
    expect(note).toContain('- Step 2 "Step ui": commit ui0123456789')
    expect(note).toContain('Do not redo steps 1, 2: they are merged.')
    // the brief carries it as its own section after the spec
    const brief = renderBrief({ taskId: 't', kind: 'ship', project: 'world', worktree: root, branch: 'b', baseBranch: 'main', intent: 'x', spec: 'y',
      planContext: note, statusFile: 's', inboxDir: 'i', taskDataDir: 'd' })
    expect(brief).toMatch(/## Genio spec\n\ny\n\n## Plan context\n\nPlan: New Play/)
  })
})

describe('pausing', () => {
  it('a discarded step pauses the plan instead of releasing what comes after it, and resume starts it again', async () => {
    const { plan } = await createPlan([step('core'), step('ui', ['core'])])
    const first = unitOf('core', plan.id)
    hc.crew.update(first.id, { state: 'cleaned', discarded: true, stateReason: 'despawned: forced by the player' })
    await hc.plans.idle()
    expect(hc.backlog.get(plan.steps[0].questId)?.state).toBe('blocked')
    expect(states(plan.id)).toEqual({ core: 'discarded', ui: 'waiting' })
    const paused = hc.plans.get(plan.id)!
    expect(paused).toMatchObject({ state: 'paused', pause: { step: 'core' } })
    const choice = hc.decisions.get(paused.pause!.choiceId!)!
    expect(choice).toMatchObject({ options: ['Resume the plan', 'Edit the step first', 'Cancel the plan'], action: { kind: 'plan-paused', plan: plan.id, step: 'core' } })
    expect(spawned).toHaveLength(1)
    // the startup drain and the supervisor listing leave a paused plan's steps alone
    expect(hc.backlog.dispatchable('world')).toEqual([])
    hc.decisions.resolve(choice.id, 'Resume the plan')
    await new Promise((r) => setTimeout(r, 0))
    await hc.plans.idle()
    expect(hc.plans.get(plan.id)!.state).toBe('active')
    expect(spawned.map((r) => r.title)).toEqual(['Step core', 'Step core'])
    expect(unitOf('core', plan.id).id).not.toBe(first.id)
  })

  it('a failed step pauses the plan; cancel drops the steps that have not started', async () => {
    const { plan } = await createPlan([step('core'), step('ui', ['core']), step('docs', ['ui'])])
    hc.crew.update(unitOf('core', plan.id).id, { state: 'failed', stateReason: 'tests red' })
    await hc.plans.idle()
    expect(hc.plans.get(plan.id)).toMatchObject({ state: 'paused', pause: { reason: expect.stringContaining('failed (tests red)') } })
    expect(hc.wakes.pending().map((w) => w.reason)).toContainEqual(expect.stringMatching(/paused: step 1\/3 "Step core" failed/))
    const r = await hc.plans.update(plan.id, { op: 'cancel' })
    expect(r.message).toMatch(/dropped step 2, 3/)
    expect(hc.backlog.get(plan.steps[1].questId)?.state).toBe('dropped')
    expect(hc.plans.get(plan.id)).toMatchObject({ state: 'cancelled' })
    // the pause choice is settled with the plan
    expect(hc.decisions.list(false)).toEqual([])
  })
})

describe('capacity drain', () => {
  it('a step deferred by the cap waits for capacity and starts when a place frees, without a model turn', async () => {
    tasks.push({ id: 'busy', title: 'other work', project: 'world', state: 'working' } as Task)
    cap = 1
    const { plan } = await createPlan([step('core')])
    expect(spawned).toHaveLength(0)
    expect(hc.plans.view(plan.id)!.steps[0]).toMatchObject({ state: 'queued', note: expect.stringMatching(/^waiting for capacity/) })
    // another unit finishing frees the place: the drain reacts to its state change
    hc.crew.update('busy', { state: 'ready' })
    await hc.plans.idle()
    expect(spawned.map((r) => r.title)).toEqual(['Step core'])
    expect(hc.plans.get(plan.id)!.steps[0].lastAttempt).toBeUndefined()
  })

  it('backs off a release that failed for another reason, until the startup drain or a retry', async () => {
    refuse = 'Open the project window before starting units.'
    const { plan } = await createPlan([step('core')])
    expect(hc.plans.get(plan.id)!.steps[0].lastAttempt?.message).toBe(refuse)
    refuse = undefined
    await hc.plans.drain()
    expect(spawned).toHaveLength(0)
  })
})

describe('plan tools', () => {
  it('plan_create, plan_status and plan_update drive the same store', async () => {
    const tools = createToolRegistry(() => ctx, home, 'genio')
    const call = async (name: string, args: unknown): Promise<string> => {
      const r = await tools.find((t) => t.name === name)!.invoke(args)
      if (r.isError) throw new Error((r.content[0] as { text: string }).text)
      return (r.content[0] as { text: string }).text
    }
    const created = JSON.parse(await call('plan_create', { world: 'world', title: 'Plans MVP', intent: 'build the MVP in three builds',
      steps: [step('core'), { ...step('chips', ['core']), kind: 'ship' }] }))
    expect(created).toMatchObject({ state: 'active', steps: [{ key: 'core', index: 1 }, { key: 'chips', index: 2 }] })
    expect(created.announcement).toMatch(/^Plan · Plans MVP \(2 steps, serial\)/)
    const status = JSON.parse(await call('plan_status', { plan_id: created.plan_id }))
    expect(status).toMatchObject({ next: [], running: ['core'], steps: [{ state: 'in-flight' }, { state: 'waiting', waitsOn: ['core'] }] })
    await expect(call('plan_update', { plan_id: created.plan_id, op: 'edit_step', step: 'core', patch: { spec: spec('core again') } })).rejects.toThrow(/in-flight: its brief is fixed/)
    expect(await call('plan_update', { plan_id: created.plan_id, op: 'edit_step', step: 'chips', patch: { acceptance: 'chips render on every row' } })).toMatch(/step "chips" updated/)
    expect(await call('plan_update', { plan_id: created.plan_id, op: 'add_step', new_step: step('rules', ['core']) })).toMatch(/added as step 3\/3/)
    expect(hc.backlog.get(hc.plans.get(created.plan_id)!.steps[2].questId)?.dependsOn).toEqual([created.steps[0].quest_id])
    expect(await call('plan_update', { plan_id: created.plan_id, op: 'pause', reason: 'player away' })).toMatch(/plan paused/)
    expect(JSON.parse(await call('plan_status', {}))).toHaveLength(1)
  })
})

describe('shared selector', () => {
  it('derives step states from quests and units, never from what a unit says', () => {
    const plan = { id: 'p', world: 'w', title: 'T', intent: 'i', state: 'active', autoAdvance: true, maxParallel: 2, createdAt: '', updatedAt: '',
      steps: [
        { key: 'a', index: 1, questId: 'qa', title: 'A', kind: 'ship', spec: '', after: [], files: [], acceptance: '', taskIds: ['ua'] },
        { key: 'b', index: 2, questId: 'qb', title: 'B', kind: 'ship', spec: '', after: ['a'], files: [], acceptance: '', taskIds: [] }
      ] } as never
    const q = (id: string, state: string, taskId?: string) => ({ id, state, taskId, dependsOn: [], title: id } as never)
    const ready = planView(plan, [q('qa', 'in-flight', 'ua'), q('qb', 'queued')], [{ id: 'ua', state: 'ready', stateReason: 'done: all good' } as Task])
    expect(ready.steps.map((s) => s.state)).toEqual(['ready', 'waiting'])
    const merged = planView(plan, [q('qa', 'done', 'ua'), q('qb', 'queued')], [{ id: 'ua', state: 'merged' } as Task])
    expect(merged).toMatchObject({ merged: 1, next: ['b'] })
  })
})
