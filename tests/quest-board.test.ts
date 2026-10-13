import { describe, expect, it } from 'vitest'
import type { BacklogItem, Decision, Task } from '../src/shared/types'
import {
  buildBoard, findDuplicate, migrateLegacyQuests, questColumn, questOrder, queueChips, reorderQueue
} from '../src/shared/quest-board'
import { squadState } from '../src/shared/squad-display'

const T0 = '2026-10-13T10:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString()

const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: T0, updatedAt: T0, project: 'world', ...patch
})
const unit = (id: string, patch: Partial<Task> = {}): Task => ({
  id, kind: 'ship', title: id, project: 'world', wksp: 'main', branchPrefix: 'genio/', baseBranch: 'main', branch: `genio/${id}`,
  worktree: `/wt/${id}`, briefPath: `/b/${id}`, harness: 'claude', state: 'working', createdAt: T0, updatedAt: T0,
  inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0, relaunches: 0, ...patch
} as Task)

describe('column mapping', () => {
  it('maps every quest state and unit outcome to one column', () => {
    expect(questColumn(quest('a'))).toBe('queued')
    expect(questColumn(quest('a', { state: 'blocked' }))).toBe('queued')
    expect(questColumn(quest('a', { state: 'held' as BacklogItem['state'] }))).toBe('queued')
    expect(questColumn(quest('a', { state: 'done' }))).toBe('done')
    expect(questColumn(quest('a', { state: 'dropped' }))).toBe('done')
    const flying = quest('a', { state: 'in-flight', taskId: 'u' })
    for (const state of ['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'stale', 'detached', 'ready'] as const) {
      expect(questColumn(flying, unit('u', { state }))).toBe('in-flight')
    }
    // the drift fix: a landed, delivered or despawned unit puts its in-flight quest in Done
    for (const state of ['merged', 'done', 'cleaned'] as const) expect(questColumn(flying, unit('u', { state }))).toBe('done')
    expect(questColumn(flying, unit('u', { state: 'ready', landedAt: at(5) }))).toBe('done')
    // failed or exited without landing: stays In flight (red) until resolved
    expect(questColumn(flying, unit('u', { state: 'failed' }))).toBe('in-flight')
    expect(questColumn(flying, unit('u', { state: 'exited' }))).toBe('in-flight')
    expect(questColumn(flying)).toBe('in-flight')
    // a re-queued follow-up of landed work is queued, not done
    expect(questColumn(quest('a', { taskId: 'u' }), unit('u', { state: 'merged' }))).toBe('queued')
  })

  it('In flight is exactly the Squad active set plus quests whose unit ended without landing', () => {
    const tasks = [
      unit('build', { backlogId: 'q-build' }),
      unit('recon', { kind: 'scout' }),
      unit('ready', { state: 'ready', backlogId: 'q-ready', readyAt: at(1) }),
      unit('asks', { state: 'needs-decision', backlogId: 'q-asks' }),
      unit('crashed', { state: 'failed', backlogId: 'q-crashed', stateReason: 'boom' }),
      unit('landed', { state: 'merged', landedAt: at(9), backlogId: 'q-landed', pr: { url: 'https://example.com/pull/7', number: 7 } }),
      unit('old', { state: 'cleaned', cleanedAt: at(3) })
    ]
    const backlog = [
      quest('q-build', { state: 'in-flight', taskId: 'build', priority: 'high' }),
      quest('q-ready', { state: 'in-flight', taskId: 'ready' }),
      quest('q-asks', { state: 'in-flight', taskId: 'asks' }),
      quest('q-crashed', { state: 'in-flight', taskId: 'crashed' }),
      quest('q-landed', { state: 'in-flight', taskId: 'landed' }),
      quest('q-next')
    ]
    const decisions = [{ id: 'd', taskId: 'build', question: 'which?' } as Decision]
    const board = buildBoard({ backlog, tasks, decisions })
    const live = tasks.filter((t) => squadState(t) !== 'DONE').map((t) => t.id).sort()
    expect(board.inFlight.filter((c) => c.state !== 'FAILED').map((c) => c.task!.id).sort()).toEqual(live)
    const byUnit = Object.fromEntries(board.inFlight.map((c) => [c.task?.id, c]))
    expect(byUnit.build).toMatchObject({ state: 'WORKING', tone: 'amber', attention: true })
    expect(byUnit.recon).toMatchObject({ state: 'WORKING', tone: 'violet' })
    expect(byUnit.recon.quest).toBeUndefined()
    expect(byUnit.ready).toMatchObject({ state: 'READY TO MERGE', tone: 'volt' })
    expect(byUnit.asks).toMatchObject({ state: 'WORKING', tone: 'amber' })
    expect(byUnit.crashed).toMatchObject({ state: 'FAILED', tone: 'alert' })
    expect(board.inFlight[0].task!.id).toBe('crashed') // errors first
    expect(board.queued.map((q) => q.id)).toEqual(['q-next'])
    expect(board.done.map((d) => [d.key, d.outcome])).toEqual([['quest-q-landed', 'merged'], ['unit-old', 'done']])
  })

  it('Done is a newest-first history of quests and units with outcome, time and duration', () => {
    const tasks = [
      unit('a', { state: 'merged', createdAt: at(0), landedAt: at(40), backlogId: 'qa' }),
      unit('b', { state: 'exited', createdAt: at(10), updatedAt: at(50) }),
      unit('c', { state: 'failed', createdAt: at(5), updatedAt: at(20), backlogId: 'qc' }),
      unit('c2', { state: 'merged', createdAt: at(21), landedAt: at(60), backlogId: 'qc' })
    ]
    const backlog = [
      quest('qa', { state: 'done', taskId: 'a', doneAt: at(41) }),
      quest('qc', { state: 'done', taskId: 'c2', doneAt: at(61) }),
      quest('qd', { state: 'dropped', doneAt: at(30) })
    ]
    const done = buildBoard({ backlog, tasks }).done
    expect(done.map((d) => [d.title, d.outcome])).toEqual([['qc', 'merged'], ['b', 'exited'], ['qa', 'merged'], ['qd', 'dropped'], ['c', 'failed']])
    expect(done.find((d) => d.title === 'qa')).toMatchObject({ startedAt: at(0), at: at(41) })
    expect(done.length).toBe(5) // every entry, no cap: the view paginates
  })
})

describe('ordering, priorities and duplicates', () => {
  it('orders by priority, then manual rank, then age', () => {
    const items = [
      quest('old-normal', { createdAt: at(0) }),
      quest('ranked-normal', { createdAt: at(9), rank: 1 }),
      quest('low', { priority: 'low', createdAt: at(-60) }),
      quest('crit', { priority: 'critical', createdAt: at(30) })
    ]
    expect([...items].sort(questOrder).map((q) => q.id)).toEqual(['crit', 'ranked-normal', 'old-normal', 'low'])
  })

  it('drag and drop ranks the target band and moves across bands', () => {
    const queue = [quest('a', { createdAt: at(1) }), quest('b', { createdAt: at(2) }), quest('c', { createdAt: at(3) }), quest('h', { priority: 'high' })]
    expect(reorderQueue(queue, 'c', 'normal', 'a')).toEqual([
      { id: 'c', priority: 'normal', rank: 1 }, { id: 'a', priority: 'normal', rank: 2 }, { id: 'b', priority: 'normal', rank: 3 }
    ])
    expect(reorderQueue(queue, 'b', 'high')).toEqual([{ id: 'h', priority: 'high', rank: 1 }, { id: 'b', priority: 'high', rank: 2 }])
    const ranked = [quest('a', { rank: 1 }), quest('b', { rank: 2 })]
    expect(reorderQueue(ranked, 'b', 'normal')).toEqual([])
  })

  it('flags same-title quests filed minutes apart, or already finished, but not closed ones', () => {
    const first = quest('first', { title: 'Fix the jump', createdAt: at(0) })
    const second = quest('second', { title: 'fix the  JUMP!', createdAt: at(3) })
    const later = quest('later', { title: 'Fix the jump', createdAt: at(120) })
    expect(findDuplicate(second, [first, second])?.id).toBe('first')
    expect(findDuplicate(first, [first, second])).toBeUndefined()
    expect(findDuplicate(later, [first, later])).toBeUndefined()
    const finished = quest('finished', { title: 'Fix the jump', state: 'done' })
    expect(findDuplicate(later, [finished, later])?.id).toBe('finished')
    expect(findDuplicate({ ...finished, id: 'x' }, [finished])).toBeUndefined()
    expect(findDuplicate(quest('other', { title: 'Fix the jump', project: 'elsewhere' }), [first])).toBeUndefined()
  })
})

describe('queue reasons', () => {
  const ctx = { backlog: [] as BacklogItem[], tasks: [] as Task[], now: Date.parse(at(0)) }
  it('explains why a queued quest is not running', () => {
    const dep = quest('dep', { title: 'Make the level', state: 'in-flight' })
    const backlog = [dep]
    expect(queueChips(quest('q', { dependsOn: ['dep'] }), { ...ctx, backlog })[0]).toMatchObject({ kind: 'depends', label: 'waits on "Make the level"' })
    expect(queueChips(quest('q', { hold: { reason: 'pick a palette', since: T0 } }), ctx)[0]).toMatchObject({ kind: 'waiting', label: 'waiting for you', tone: 'amber' })
    expect(queueChips(quest('q', { hold: { reason: 'later', since: T0, until: at(600) } }), ctx)[0]).toMatchObject({ kind: 'later', date: at(600) })
    expect(queueChips(quest('q', { kind: 'choice' }), ctx)[0]).toMatchObject({ kind: 'waiting' })
    expect(queueChips(quest('q', { duplicateOf: 'dep' }), { ...ctx, backlog })[0]).toMatchObject({ kind: 'duplicate', label: 'duplicate of "Make the level"' })
    expect(queueChips(quest('q'), { ...ctx, global: { cap: 2, used: 2 } })).toEqual([expect.objectContaining({ kind: 'cap', label: 'at unit cap' })])
    const busy = [unit('u1', { terminalId: 't1' })]
    expect(queueChips(quest('q'), { ...ctx, tasks: busy, terminals: { t1: { alive: true } }, worldCaps: { world: 1 } })[0]).toMatchObject({ kind: 'cap' })
    expect(queueChips(quest('q'), ctx)).toEqual([expect.objectContaining({ kind: 'ready', label: 'ready' })])
  })
})

describe('legacy held and program migration', () => {
  it('turns held into queued + waiting and programs into labels with an archive record', () => {
    const items = [
      quest('prog', { kind: 'program', state: 'queued', title: 'Current fixes: land them', notes: 'standing approval' }),
      quest('tagged-prog', { kind: 'program', state: 'done', tags: ['workspace'] }),
      quest('member', { dependsOn: ['prog', 'tagged-prog', 'real-dep'] }),
      quest('held-with-reason', { state: 'held' as BacklogItem['state'], hold: { reason: 'which art style?', since: T0 }, answer: 'my words' }),
      quest('held-bare', { state: 'held' as BacklogItem['state'] })
    ]
    const r = migrateLegacyQuests(items, at(5))
    expect(r.changed).toBe(true)
    expect(r.items.map((i) => i.id)).toEqual(['member', 'held-with-reason', 'held-bare'])
    expect(r.items[0]).toMatchObject({ dependsOn: ['real-dep'], tags: ['current-fixes-land-them', 'workspace'] })
    expect(r.items[1]).toMatchObject({ state: 'queued', hold: { reason: 'which art style?' }, answer: 'my words' })
    expect(r.items[2]).toMatchObject({ state: 'queued', hold: { reason: 'waiting on the player', since: T0 } })
    expect(r.retired).toEqual([
      expect.objectContaining({ id: 'prog', state: 'dropped', notes: 'standing approval', doneAt: at(5) }),
      expect.objectContaining({ id: 'tagged-prog', state: 'done' })
    ])
    expect(migrateLegacyQuests(r.items, at(6)).changed).toBe(false)
  })
})
