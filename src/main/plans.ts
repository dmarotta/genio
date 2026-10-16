/**
 * WorkPlans: a durable plan of named steps (data/plans.json). Each step
 * compiles into an ordinary quest whose dependsOn mirrors the step's `after`,
 * so the quest log's gating, chips and the project-open drain respect the
 * order. The plan owns dispatch: when a step lands, Genio releases the steps
 * that became ready through the normal cap and quota gates (crew.spawn), each
 * with its stored spec and loadout plus a handoff note on what landed before
 * it. A discarded or failed step pauses the plan and opens one choice (resume,
 * edit or cancel). A step never starts before its prerequisites merged, and
 * merge approval is unchanged: a plan simply waits at an unapproved merge.
 *
 * Named WorkPlan because PlanId/PlanStatus already mean provider quota plans.
 */
import path from 'node:path'
import type { BacklogItem, Decision, PlanStep, Task, TaskCategory, TaskKind, WorkPlan } from '@shared/types'
import type { SpawnRequest } from '@shared/api'
import { planStepOf, planView, stepGraphProblems, stepTask, topoOrder, workLanded, type PlanView } from '@shared/work-plan'
import { unitDiscarded, unitFinished } from '@shared/quest-board'
import * as git from './git'
import type { Home } from './home'
import type { AppCtx, HomeCtx, PlanService } from './services'
import { nowIso, readJson, rid, slugify, truncate, writeJson } from './util'

export interface PlanStepInput {
  key: string
  title: string
  kind?: TaskKind
  spec: string
  category?: TaskCategory
  harness?: string
  model?: string
  effort?: string
  after?: string[]
  files?: string[]
  acceptance: string
}

export interface PlanCreateInput {
  world: string
  title: string
  /** the player's own words: every step brief's intent */
  intent: string
  goal?: string
  autoAdvance?: boolean
  maxParallel?: number
  /** release the steps that are ready now (default); false files the plan paused until it is resumed */
  start?: boolean
  steps: PlanStepInput[]
}

export interface PlanCreateResult {
  plan: WorkPlan
  /** what the first drain did: started steps and steps left waiting */
  released: string[]
  /** one line for the main chat to post */
  announcement: string
}

export type PlanStepPatch = Partial<Omit<PlanStepInput, 'key'>>

export type PlanUpdateOp =
  | { op: 'edit_step'; step: string; patch: PlanStepPatch }
  | { op: 'add_step'; step: PlanStepInput }
  | { op: 'remove_step'; step: string }
  | { op: 'reorder'; order: string[] }
  | { op: 'pause'; reason?: string }
  | { op: 'resume' }
  | { op: 'cancel' }
  | { op: 'settings'; autoAdvance?: boolean; maxParallel?: number }

export interface PlanUpdateResult {
  plan: WorkPlan
  message: string
}

export const PLAN_MAX_STEPS = 20
export const PLAN_MAX_PARALLEL = 3
export const PAUSE_OPTIONS = ['Resume the plan', 'Edit the step first', 'Cancel the plan'] as const
/** A release that failed for another reason than capacity or quota waits this long before the drain retries it. */
const RETRY_MS = 5 * 60_000
const CAPACITY = /deferred|capacity|unit cap|quota|plan reset/i

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function createPlanService(getCtx: () => AppCtx, home: Home): PlanService {
  const file = path.join(home.data, 'plans.json')
  let plans: WorkPlan[] | undefined
  let chain: Promise<unknown> = Promise.resolve()
  let drainQueued = false
  /** quest id → earliest retry after a release that failed for a reason other than capacity */
  const retryAt = new Map<string, number>()

  const hc = (): HomeCtx => getCtx().home(home.name)
  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  function load(): WorkPlan[] {
    if (!plans) {
      const raw = readJson<WorkPlan[]>(file, [])
      plans = Array.isArray(raw) ? raw.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.steps)) : []
      for (const p of plans) for (const s of p.steps) {
        s.after = Array.isArray(s.after) ? s.after : []
        s.files = Array.isArray(s.files) ? s.files : []
        s.taskIds = Array.isArray(s.taskIds) ? s.taskIds : []
      }
    }
    return plans
  }

  function save(): void {
    try {
      writeJson(file, load())
    } catch {
      /* in-memory state survives until the next successful write */
    }
  }

  function must(id: string): WorkPlan {
    const p = load().find((x) => x.id === id)
    if (!p) throw new Error(`no plan with id "${id}"`)
    return p
  }

  /** Serialize landings, releases and edits: two drains must never start the same step. */
  function queue<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const tasks = (): Task[] => safe(() => [...getCtx().homes.values()].flatMap((h) => h.crew.list())) ?? []
  const backlog = (): BacklogItem[] => safe(() => hc().backlog.list()) ?? []
  const view = (p: WorkPlan): PlanView => planView(p, backlog(), tasks())
  const stepLabel = (p: WorkPlan, s: PlanStep): string => `step ${s.index}/${p.steps.length} "${s.title}"`

  function wake(reason: string, lines: string[], routine: boolean, taskId?: string): void {
    safe(() => hc().wakes.enqueue({ kind: 'plan', reason, taskId, lines, routine }))
    safe(() => hc().wksp.deliverWakes())
  }

  function ledger(event: string, p: WorkPlan, data?: Record<string, unknown>): void {
    safe(() => getCtx().ledger.record({ home: home.name, event: 'backlog.state', project: p.world, data: { plan: p.id, event, ...data } }))
  }

  // ------------------------------------------------------------- landings

  /** The done line the unit reported for its work. */
  function doneLine(t: Task): string | undefined {
    for (const h of safe(() => [...getCtx().homes.values()]) ?? []) {
      if (!h.crew.get(t.id)) continue
      const done = safe(() => h.crew.statusEvents(t.id).filter((e) => e.kind === 'done').pop())
      return done?.text ? oneLine(done.text) : undefined
    }
    return undefined
  }

  function recordLanding(p: WorkPlan, s: PlanStep, t: Task | undefined): void {
    s.landedAt = t?.landedAt ?? t?.finishedAt ?? nowIso()
    if (t?.landedCommit) s.landedCommit = t.landedCommit
    if (t?.pr?.url) s.landedPr = t.pr.url
    const line = t ? doneLine(t) : undefined
    if (line) s.doneLine = line
    if (t?.landedFiles?.length) s.changedFiles = t.landedFiles
    delete s.lastAttempt
    p.updatedAt = nowIso()
    ledger('plan.step-landed', p, { step: s.key, task: t?.id, commit: s.landedCommit })
  }

  /** Files the landed Build changed, when Genio's merge did not record them (a PR merged outside Genio). */
  async function fillChangedFiles(planId: string, key: string, t: Task): Promise<void> {
    const s = load().find((p) => p.id === planId)?.steps.find((x) => x.key === key)
    if (!s || s.changedFiles?.length || t.kind !== 'ship') return
    const repo = safe(() => getCtx().projects.get(t.project)?.path)
    if (!repo || !t.branch) return
    const files = await git.changedFiles(repo, t.baseBranch, t.branch).catch(() => [])
    if (files.length) {
      s.changedFiles = files
      save()
    }
  }

  /**
   * Catch up with the quest log: landings recorded while Genio was down (the
   * startup reconcile closes their quests without a unit event), and a plan
   * whose every step merged. Returns whether anything changed.
   */
  function settle(p: WorkPlan): boolean {
    if (p.state === 'cancelled' || p.state === 'done') return false
    let changed = false
    const v = view(p)
    const all = tasks()
    for (const sv of v.steps) {
      const s = p.steps.find((x) => x.key === sv.key)!
      if (sv.state === 'merged' && !s.landedAt) {
        recordLanding(p, s, stepTask(s, hc().backlog.get(s.questId), all))
        changed = true
      }
    }
    if (v.total > 0 && v.merged === v.total) {
      p.state = 'done'
      p.doneAt = nowIso()
      delete p.pause
      changed = true
      ledger('plan.done', p)
      wake(`Plan "${p.title}" complete: all ${p.steps.length} steps merged`, p.steps.map((s) => `${s.index}. ${s.title}: ${s.landedCommit?.slice(0, 12) ?? s.landedPr ?? 'landed'}`), true)
    }
    return changed
  }

  // ------------------------------------------------------------- pausing

  function pausePlan(p: WorkPlan, s: PlanStep, t: Task, discarded: boolean): void {
    if (p.state !== 'active' && p.state !== 'paused') return
    if (p.state === 'paused' && p.pause?.step === s.key) return
    const what = discarded ? 'was discarded' : 'failed'
    const reason = `${stepLabel(p, s)} ${what}${t.stateReason ? ` (${truncate(oneLine(t.stateReason), 160)})` : ''}`
    p.state = 'paused'
    const d = safe(() => hc().decisions.open({
      question: `Plan "${p.title}" is paused: ${stepLabel(p, s)} ${what}. Resume, edit the step, or cancel the plan?`,
      options: [...PAUSE_OPTIONS],
      recommendation: discarded ? PAUSE_OPTIONS[1] : PAUSE_OPTIONS[0],
      context: [
        `Unit ${t.id} (${t.state})${t.stateReason ? `: ${truncate(t.stateReason, 300)}` : ''}.`,
        `Resume: the step starts again from its stored spec${discarded ? ' with a new unit' : ' (Genio relaunches or redeploys it)'}, then the plan carries on.`,
        'Edit the step first: Genio rewrites the step spec with you, then resumes.',
        'Cancel the plan: the steps that have not started are dropped; nothing that landed is undone.'
      ].join('\n'),
      project: p.world, key: `plan:${p.id}:${s.key}`, source: 'system', backlogId: s.questId,
      action: { kind: 'plan-paused', plan: p.id, step: s.key }
    }))
    p.pause = { reason, step: s.key, at: nowIso(), ...(d ? { choiceId: d.id } : {}) }
    p.updatedAt = nowIso()
    save()
    ledger('plan.paused', p, { step: s.key, task: t.id, reason })
    wake(`Plan "${p.title}" paused: ${reason}`, [
      `No later step starts until the plan resumes.${d ? ` Choice ${d.id} asks the player: resume, edit the step, or cancel the plan.` : ''}`,
      'Tell the player in one line; act on their answer with plan_update (resume, edit_step then resume, or cancel).'
    ], false, t.id)
  }

  // ------------------------------------------------------------- releases

  /** Every landed step this one builds on, directly or through other steps, in plan order. */
  function ancestors(p: WorkPlan, s: PlanStep): PlanStep[] {
    const seen = new Set<string>()
    const walk = (k: string): void => {
      for (const a of p.steps.find((x) => x.key === k)?.after ?? []) {
        if (seen.has(a)) continue
        seen.add(a)
        walk(a)
      }
    }
    walk(s.key)
    return p.steps.filter((x) => seen.has(x.key)).sort((a, b) => a.index - b.index)
  }

  /** The "Plan context" block of a released step's brief. */
  function handoffNote(p: WorkPlan, s: PlanStep): string {
    const lines = [`Plan: ${p.title} (${p.id}) · ${stepLabel(p, s)}`]
    if (p.goal) lines.push(`Plan goal: ${oneLine(p.goal)}`)
    lines.push(`Acceptance for this step: ${s.acceptance}`)
    const all = tasks()
    const merged = new Set(view(p).steps.filter((v) => v.state === 'merged').map((v) => v.key))
    const landed = ancestors(p, s).filter((a) => a.landedAt || merged.has(a.key))
    if (landed.length) {
      lines.push('', 'Landed before you (already on the base branch: build on it):')
      for (const a of landed) {
        const t = stepTask(a, safe(() => hc().backlog.get(a.questId)), all)
        const commit = a.landedCommit ?? t?.landedCommit
        const pr = a.landedPr ?? t?.pr?.url
        const done = a.doneLine ?? (t ? doneLine(t) : undefined)
        const files = a.changedFiles ?? t?.landedFiles ?? []
        lines.push(`- Step ${a.index} "${a.title}": ${commit ? `commit ${commit.slice(0, 12)}` : pr ? `PR ${pr}` : a.kind === 'scout' ? 'report delivered' : 'landed'}${done ? `; done: ${truncate(done, 300)}` : ''}`)
        if (a.kind === 'scout' && t?.reportPath) lines.push(`  Report: ${t.reportPath.replace(/\\/g, '/')}`)
        if (files.length) lines.push(`  Changed files: ${files.slice(0, 25).join(', ')}${files.length > 25 ? ` (+${files.length - 25} more)` : ''}`)
      }
      lines.push(`Do not redo step${landed.length > 1 ? 's' : ''} ${landed.map((a) => a.index).join(', ')}: ${landed.length > 1 ? 'they are' : 'it is'} merged.`)
    }
    const others = p.steps.filter((x) => x.key !== s.key && !landed.includes(x) && !x.landedAt).sort((a, b) => a.index - b.index)
    if (others.length) lines.push(`Other steps of this plan, not yours (Genio starts each one itself; do not build them): ${others.map((x) => `${x.index} "${x.title}"`).join(', ')}.`)
    if (s.files.length) lines.push(`Files this step is expected to touch, shared with other steps: ${s.files.join(', ')}.`)
    return lines.join('\n')
  }

  function spawnRequest(questId: string): SpawnRequest | undefined {
    const found = planStepOf(load(), questId)
    if (!found) return undefined
    const { plan: p, step: s } = found
    const q = safe(() => hc().backlog.get(questId))
    return {
      kind: s.kind, project: p.world, title: s.title, intent: p.intent, spec: s.spec,
      category: s.category, harness: s.harness, model: s.model, effort: s.effort as SpawnRequest['effort'],
      backlogId: questId, mode: q?.mode, yolo: q?.yolo, wksp: home.name, planContext: handoffNote(p, s)
    }
  }

  async function release(questId: string): Promise<string> {
    const found = planStepOf(load(), questId)
    if (!found) return `quest ${questId}: not a plan step`
    const { plan: p, step: s } = found
    const req = spawnRequest(questId)!
    try {
      const task = await hc().crew.spawn(req)
      if (!s.taskIds.includes(task.id)) s.taskIds.push(task.id)
      delete s.lastAttempt
      retryAt.delete(questId)
      p.updatedAt = nowIso()
      save()
      ledger('plan.step-released', p, { step: s.key, task: task.id })
      wake(`Plan "${p.title}": ${stepLabel(p, s)} started as ${task.id}`, [
        `Released by Genio when its prerequisites merged; the brief carries the step spec and a handoff note.`,
        `Acceptance: ${s.acceptance}`
      ], true, task.id)
      return `${stepLabel(p, s)} started as ${task.id}`
    } catch (e) {
      const raw = oneLine(String((e as Error)?.message ?? e))
      const waiting = CAPACITY.test(raw)
      const message = waiting ? `waiting for ${/quota|plan reset/i.test(raw) ? 'quota' : 'capacity'}: ${truncate(raw, 200)}` : truncate(raw, 300)
      if (!waiting) retryAt.set(questId, Date.now() + RETRY_MS)
      if (s.lastAttempt?.message !== message) {
        s.lastAttempt = { at: nowIso(), message }
        save()
      }
      return `${stepLabel(p, s)} not started: ${message}`
    }
  }

  async function drainOnce(): Promise<string[]> {
    const out: string[] = []
    let dirty = false
    for (const p of load()) if (settle(p)) dirty = true
    if (dirty) save()
    if (!load().some((p) => p.state === 'active' && p.autoAdvance)) return out
    const attempted = new Set<string>()
    const order = (q: BacklogItem): [number, number] => {
      const f = planStepOf(load(), q.id)!
      return [load().indexOf(f.plan), f.step.index]
    }
    for (;;) {
      const now = Date.now()
      // dispatchable applies holds, dates, dependencies, the caps, quota waits and holds() below
      const next = (safe(() => hc().backlog.dispatchable(undefined, attempted)) ?? [])
        .filter((q) => q.planId && planStepOf(load(), q.id) && (retryAt.get(q.id) ?? 0) <= now)
        .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])[0]
      if (!next) break
      attempted.add(next.id)
      out.push(await release(next.id))
    }
    return out
  }

  function scheduleDrain(): void {
    if (drainQueued) return
    drainQueued = true
    void queue(async () => {
      drainQueued = false
      await drainOnce()
    }).catch(() => undefined)
  }

  // ------------------------------------------------------------- graph edits

  function stepFrom(input: PlanStepInput, questId: string, index: number): PlanStep {
    return {
      key: input.key, index, questId, title: oneLine(input.title), kind: input.kind ?? 'ship', spec: input.spec.trim(),
      category: input.category, harness: input.harness, model: input.model, effort: input.effort,
      after: [...new Set(input.after ?? [])], files: input.files ?? [], acceptance: oneLine(input.acceptance), taskIds: []
    }
  }

  function checkStep(input: Pick<PlanStepInput, 'title' | 'spec' | 'acceptance'>, key: string): void {
    if (!input.title?.trim()) throw new Error(`step "${key}" needs a title`)
    if (!input.spec?.trim() || input.spec.trim().length < 20) throw new Error(`step "${key}" needs a complete spec: it is the brief the unit receives`)
    if (!input.acceptance?.trim()) throw new Error(`step "${key}" needs a one-line acceptance check`)
  }

  /** Index steps in topological order (given order among equals) and mirror `after` on each quest. */
  function rewire(p: WorkPlan, order?: string[]): void {
    const byKey = new Map(p.steps.map((s) => [s.key, s]))
    const base = order ?? [...p.steps].sort((a, b) => a.index - b.index).map((s) => s.key)
    const sorted = topoOrder(base.map((k) => byKey.get(k)!))!
    p.steps = sorted.map((k, i) => ({ ...byKey.get(k)!, index: i + 1 }))
    for (const s of p.steps) {
      const deps = s.after.map((a) => byKey.get(a)!.questId)
      const q = safe(() => hc().backlog.get(s.questId))
      if (q && (q.dependsOn.join() !== deps.join() || q.title !== s.title)) safe(() => hc().backlog.update(s.questId, { dependsOn: deps, title: s.title }))
    }
    p.updatedAt = nowIso()
  }

  function questNotes(p: WorkPlan, s: PlanStep): string {
    return `Step ${s.index} of plan "${p.title}" (${p.id}). Acceptance: ${s.acceptance}\nThe step spec lives in the plan (plan_status); deploy starts it from that spec.`
  }

  function fileQuest(p: WorkPlan, s: Omit<PlanStep, 'questId'>, deps: string[]): string {
    return hc().backlog.add({
      title: s.title, project: p.world, kind: s.kind, notes: questNotes(p, { ...s, questId: '' }), dependsOn: deps,
      tags: [`plan:${slugify(p.title, 24)}`], planId: p.id, planStep: s.key
    }).id
  }

  /** A step that has a unit at work or has landed keeps its spec: ping the unit instead. */
  function started(p: WorkPlan, s: PlanStep): string | undefined {
    const state = view(p).steps.find((v) => v.key === s.key)?.state
    return state === 'in-flight' || state === 'ready' || state === 'merged' ? state : undefined
  }

  function resolvePauseChoice(p: WorkPlan, answer: string): void {
    const id = p.pause?.choiceId
    if (!id) return
    const d = safe(() => hc().decisions.get(id))
    if (d && !d.resolvedAt) safe(() => hc().decisions.resolve(id, answer, { relay: false }))
  }

  function resume(p: WorkPlan): string {
    if (p.state === 'cancelled' || p.state === 'done') throw new Error(`plan ${p.id} is ${p.state}`)
    const requeued: string[] = []
    const relaunch: string[] = []
    for (const v of view(p).steps) {
      const s = p.steps.find((x) => x.key === v.key)!
      if (v.state === 'discarded' || v.state === 'blocked') {
        const q = safe(() => hc().backlog.get(s.questId))
        if (q && (q.state === 'blocked' || q.state === 'dropped')) {
          hc().backlog.update(s.questId, { state: 'queued' })
          requeued.push(`${s.index}`)
        } else if (v.taskId) relaunch.push(`${s.index} (${v.taskId})`)
      }
    }
    const pause = p.pause
    p.state = 'active'
    delete p.pause
    p.updatedAt = nowIso()
    save()
    if (pause) resolvePauseChoice({ ...p, pause }, PAUSE_OPTIONS[0])
    ledger('plan.resumed', p)
    scheduleDrain()
    return `plan resumed${requeued.length ? `; step ${requeued.join(', ')} queued again` : ''}${relaunch.length ? `; relaunch or redeploy step ${relaunch.join(', ')} (its unit stopped)` : ''}`
  }

  function cancel(p: WorkPlan): string {
    if (p.state === 'done') throw new Error(`plan ${p.id} is already done`)
    const dropped: number[] = []
    const running: string[] = []
    for (const v of view(p).steps) {
      const s = p.steps.find((x) => x.key === v.key)!
      if (['waiting', 'queued', 'blocked', 'discarded'].includes(v.state)) {
        const q = safe(() => hc().backlog.get(s.questId))
        if (q && q.state !== 'in-flight' && q.state !== 'done' && q.state !== 'dropped') {
          hc().backlog.update(s.questId, { state: 'dropped' })
          dropped.push(s.index)
        }
      } else if (v.state === 'in-flight' || v.state === 'ready') running.push(`${s.index} (${v.taskId ?? 'unit'})`)
    }
    const pause = p.pause
    p.state = 'cancelled'
    delete p.pause
    p.updatedAt = nowIso()
    save()
    if (pause) resolvePauseChoice({ ...p, pause }, PAUSE_OPTIONS[2])
    ledger('plan.cancelled', p)
    return `plan cancelled${dropped.length ? `; dropped step ${dropped.join(', ')}` : ''}${running.length ? `; step ${running.join(', ')} keeps running (recall it with control exit only on the player's word)` : ''}`
  }

  // ------------------------------------------------------------- service

  const svc: PlanService = {
    list: () => load().slice(),
    get: (id) => load().find((p) => p.id === id),

    async create(input) {
      return queue(async () => {
        const ctx = getCtx()
        const world = input.world?.trim()
        if (!world || !ctx.projects.get(world)) throw new Error(`unknown project "${input.world}"`)
        const title = oneLine(input.title ?? '')
        if (title.length < 3) throw new Error('a plan needs a title')
        if (!input.intent?.trim()) throw new Error("a plan needs the player's own words as its intent")
        if (/^\s*(player|captain|boss)\b[,:]/i.test(input.intent)) throw new Error("the intent must be the player's words without a speaker label or direct address")
        const steps = input.steps ?? []
        if (steps.length < 1) throw new Error('a plan needs at least one step')
        if (steps.length > PLAN_MAX_STEPS) throw new Error(`a plan holds at most ${PLAN_MAX_STEPS} steps`)
        const problems = stepGraphProblems(steps)
        if (problems.length) throw new Error(problems.join('; '))
        for (const s of steps) checkStep(s, s.key)
        const same = load().find((p) => p.world === world && (p.state === 'active' || p.state === 'paused') && p.title.toLowerCase() === title.toLowerCase())
        if (same) throw new Error(`plan ${same.id} "${same.title}" is already ${same.state} in ${world}: update it with plan_update instead`)
        const maxParallel = Math.max(1, Math.min(PLAN_MAX_PARALLEL, Math.round(input.maxParallel ?? 2)))
        const ts = nowIso()
        const p: WorkPlan = {
          id: `plan-${slugify(title, 24)}-${rid(2)}`, world, title, intent: input.intent.trim(), goal: input.goal?.trim() || undefined,
          state: input.start === false ? 'paused' : 'active', autoAdvance: input.autoAdvance ?? true, maxParallel,
          steps: [], createdAt: ts, updatedAt: ts,
          ...(input.start === false ? { pause: { reason: 'not started yet: plan_update resume starts it', at: ts } } : {})
        }
        const order = topoOrder(steps)!
        const questOf = new Map<string, string>()
        for (const [i, key] of order.entries()) {
          const inStep = steps.find((s) => s.key === key)!
          const draft = stepFrom(inStep, '', i + 1)
          const questId = fileQuest(p, draft, draft.after.map((a) => questOf.get(a)!))
          questOf.set(key, questId)
          p.steps.push({ ...draft, questId })
        }
        load().push(p)
        save()
        ledger('plan.created', p, { steps: p.steps.length })
        const released = p.state === 'active' ? await drainOnce() : []
        const serial = p.steps.every((s, i) => i === 0 ? s.after.length === 0 : s.after.length === 1 && s.after[0] === p.steps[i - 1].key)
        const chain = p.steps.map((s) => `${s.index} ${s.title}`).join(serial ? ' → ' : ' · ')
        const started = released.filter((r) => / started as /.test(r)).length
        const announcement = `Plan · ${p.title} (${p.steps.length} step${p.steps.length > 1 ? 's' : ''}, ${serial ? 'serial' : `up to ${p.maxParallel} at once`}): ${chain}. ` +
          (p.state === 'paused' ? 'Nothing starts until the plan is resumed.' : `${started ? `${started} step${started > 1 ? 's' : ''} started now; ` : ''}each next step starts when its prerequisites merge. Merges still need your OK.`)
        return { plan: p, released, announcement }
      })
    },

    update(id, op) {
      return queue(async () => {
        const p = must(id)
        let message = ''
        switch (op.op) {
          case 'pause': {
            if (p.state !== 'active') throw new Error(`plan ${p.id} is ${p.state}`)
            p.state = 'paused'
            p.pause = { reason: op.reason?.trim() || 'paused by Genio', at: nowIso() }
            message = 'plan paused: no new step starts until it resumes; running units keep running'
            ledger('plan.paused', p, { reason: p.pause.reason })
            break
          }
          case 'resume':
            return { plan: p, message: resume(p) }
          case 'cancel':
            return { plan: p, message: cancel(p) }
          case 'settings': {
            if (op.autoAdvance !== undefined) p.autoAdvance = op.autoAdvance
            if (op.maxParallel !== undefined) p.maxParallel = Math.max(1, Math.min(PLAN_MAX_PARALLEL, Math.round(op.maxParallel)))
            message = `auto-advance ${p.autoAdvance ? 'on' : 'off'}, at most ${p.maxParallel} step${p.maxParallel > 1 ? 's' : ''} at once`
            break
          }
          case 'edit_step': {
            if (p.state === 'cancelled' || p.state === 'done') throw new Error(`plan ${p.id} is ${p.state}`)
            const s = p.steps.find((x) => x.key === op.step)
            if (!s) throw new Error(`plan ${p.id} has no step "${op.step}"`)
            const st = started(p, s)
            if (st) throw new Error(`step "${s.key}" is ${st}: its brief is fixed; ping its unit instead`)
            const patch = op.patch
            const next: PlanStep = {
              ...s,
              ...(patch.title !== undefined ? { title: oneLine(patch.title) } : {}),
              ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
              ...(patch.spec !== undefined ? { spec: patch.spec.trim() } : {}),
              ...(patch.category !== undefined ? { category: patch.category } : {}),
              ...(patch.harness !== undefined ? { harness: patch.harness || undefined } : {}),
              ...(patch.model !== undefined ? { model: patch.model || undefined } : {}),
              ...(patch.effort !== undefined ? { effort: patch.effort || undefined } : {}),
              ...(patch.after !== undefined ? { after: [...new Set(patch.after)] } : {}),
              ...(patch.files !== undefined ? { files: patch.files } : {}),
              ...(patch.acceptance !== undefined ? { acceptance: oneLine(patch.acceptance) } : {})
            }
            checkStep(next, s.key)
            const problems = stepGraphProblems(p.steps.map((x) => (x.key === s.key ? next : x)))
            if (problems.length) throw new Error(problems.join('; '))
            Object.assign(s, next)
            if (patch.kind !== undefined) safe(() => hc().backlog.update(s.questId, { kind: s.kind }))
            rewire(p)
            safe(() => hc().backlog.update(s.questId, { notes: questNotes(p, s) }))
            message = `step "${s.key}" updated`
            break
          }
          case 'add_step': {
            if (p.state === 'cancelled' || p.state === 'done') throw new Error(`plan ${p.id} is ${p.state}`)
            if (p.steps.length >= PLAN_MAX_STEPS) throw new Error(`a plan holds at most ${PLAN_MAX_STEPS} steps`)
            const input = op.step
            checkStep(input, input.key)
            const problems = stepGraphProblems([...p.steps, { key: input.key, after: input.after }])
            if (problems.length) throw new Error(problems.join('; '))
            const draft = stepFrom(input, '', p.steps.length + 1)
            const questId = fileQuest(p, draft, draft.after.map((a) => p.steps.find((x) => x.key === a)!.questId))
            p.steps.push({ ...draft, questId })
            rewire(p)
            message = `step "${input.key}" added as step ${p.steps.find((x) => x.key === input.key)!.index}/${p.steps.length}`
            break
          }
          case 'remove_step': {
            const s = p.steps.find((x) => x.key === op.step)
            if (!s) throw new Error(`plan ${p.id} has no step "${op.step}"`)
            const st = started(p, s)
            if (st) throw new Error(`step "${s.key}" is ${st}: it cannot be removed`)
            // the steps after it now wait on what it waited on
            for (const x of p.steps) {
              if (!x.after.includes(s.key)) continue
              x.after = [...new Set([...x.after.filter((a) => a !== s.key), ...s.after])]
            }
            p.steps = p.steps.filter((x) => x.key !== s.key)
            safe(() => hc().backlog.update(s.questId, { state: 'dropped', outcome: `removed from plan ${p.id}` }))
            if (p.steps.length) rewire(p)
            message = `step "${s.key}" removed; its quest was dropped`
            break
          }
          case 'reorder': {
            const keys = new Set(p.steps.map((s) => s.key))
            if (op.order.length !== keys.size || !op.order.every((k) => keys.has(k))) throw new Error(`order must list every step key once: ${[...keys].join(', ')}`)
            const placed = new Set<string>()
            for (const k of op.order) {
              const s = p.steps.find((x) => x.key === k)!
              const early = s.after.find((a) => !placed.has(a))
              if (early) throw new Error(`step "${k}" comes after "${early}": edit its after first`)
              placed.add(k)
            }
            rewire(p, op.order)
            message = `steps reordered: ${p.steps.map((s) => s.key).join(', ')}`
            break
          }
        }
        p.updatedAt = nowIso()
        save()
        if (p.state === 'active') scheduleDrain()
        return { plan: p, message }
      })
    },

    view(id) {
      const p = load().find((x) => x.id === id)
      if (!p) return undefined
      if (settle(p)) save()
      return view(p)
    },

    stepOf: (questId) => planStepOf(load(), questId),
    spawnRequest,

    holds(questId) {
      const found = planStepOf(load(), questId)
      if (!found) return undefined
      const p = found.plan
      if (p.state === 'paused') return `plan "${p.title}" is paused${p.pause ? `: ${p.pause.reason}` : ''}`
      if (p.state !== 'active') return `plan "${p.title}" is ${p.state}`
      if (!p.autoAdvance) return `plan "${p.title}" has auto-advance off`
      const running = view(p).running.length
      if (running >= p.maxParallel) return `plan "${p.title}" already runs ${running} of ${p.maxParallel} step${p.maxParallel > 1 ? 's' : ''} at once`
      return undefined
    },

    followUnit(task) {
      const found = task.backlogId ? planStepOf(load(), task.backlogId) : undefined
      if (found) {
        const { plan: p, step: s } = found
        let dirty = false
        if (!s.taskIds.includes(task.id)) {
          s.taskIds.push(task.id)
          dirty = true
        }
        const quest = safe(() => hc().backlog.get(s.questId))
        const current = !quest?.taskId || quest.taskId === task.id
        if (current && !s.landedAt && unitFinished(task) && workLanded(s.kind, task)) {
          recordLanding(p, s, task)
          if (settle(p)) dirty = true
          save()
          dirty = false
          if (!s.changedFiles?.length && task.kind === 'ship') void queue(() => fillChangedFiles(p.id, s.key, task)).catch(() => undefined)
        } else if (current && !s.landedAt && (unitDiscarded(task) || task.state === 'failed')) {
          if (dirty) save()
          dirty = false
          pausePlan(p, s, task, unitDiscarded(task))
        }
        if (dirty) save()
      }
      // a unit that stopped working frees a place: retry the steps waiting for capacity
      if (load().some((p) => p.state === 'active' && p.autoAdvance)) scheduleDrain()
    },

    drain: () => queue(drainOnce),

    async answered(d: Decision, answer: string) {
      if (d.action?.kind !== 'plan-paused') return
      const { plan: id } = d.action
      await queue(() => {
        const p = load().find((x) => x.id === id)
        if (!p || p.state !== 'paused' || p.pause?.choiceId !== d.id) return
        const a = answer.toLowerCase()
        if (/\bcancel|\bstop\b|\bdrop\b|abandon/.test(a)) cancel(p)
        else if (/\bresume|\bretry|continue|keep going|carry on|go on|start again/.test(a) && !/\bedit/.test(a)) resume(p)
        // anything else (edit first, own words) keeps the plan paused for the main chat to follow through
      })
    },

    idle: async () => {
      for (;;) {
        const current = chain
        await current
        if (chain === current && !drainQueued) return
      }
    }
  }
  return svc
}
