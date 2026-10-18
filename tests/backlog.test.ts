import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import { createBacklogService } from '../src/main/backlog'
import type { AppCtx, BacklogService } from '../src/main/services'
import type { BacklogItem, Task } from '../src/shared/types'

let dir: string
let home: Home
let backlog: BacklogService
let capacity = 0
let used = 0
let units: Record<string, Task> = {}

function makeCtx(): AppCtx {
  const ctx = {
    homes: new Map(),
    projects: { get: (name: string) => (name === 'world' ? { name, capacity } : undefined) },
    ledger: { record: () => undefined },
    home: (n: string) => ctx.homes.get(n)
  } as unknown as AppCtx
  ctx.homes.set('main', {
    home,
    get backlog() {
      return backlog
    },
    crew: { capacityUsed: () => used, get: (id: string) => units[id] }
  } as never)
  return ctx
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-backlog-'))
  home = new Home(dir)
  home.ensure()
  capacity = 0
  used = 0
  units = {}
  const ctx = makeCtx()
  backlog = createBacklogService(() => ctx, home)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('quest log', () => {
  it('respects dependencies', () => {
    const a = backlog.add({ title: 'Add jump buffer', project: 'world' })
    const b = backlog.add({ title: 'Tune coyote time', project: 'world', dependsOn: [a.id] })
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([a.id])
    backlog.markDone(a.id, 'merged')
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([b.id])
  })

  it('treats an unknown dependency as blocking', () => {
    backlog.add({ title: 'Needs ghost', dependsOn: ['does-not-exist'] })
    expect(backlog.dispatchable()).toHaveLength(0)
  })

  it('respects time gates and holds', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const past = new Date(Date.now() - 60_000).toISOString()
    backlog.add({ title: 'Later', notBefore: future })
    const held = backlog.add({ title: 'Held' })
    backlog.hold(held.id, 'which art style?')
    const deferred = backlog.add({ title: 'Deferred' })
    backlog.hold(deferred.id, 'revisit', past)
    const ids = backlog.dispatchable().map((q) => q.id)
    expect(ids).toEqual([deferred.id])
  })

  it('orders by priority', () => {
    const low = backlog.add({ title: 'low one', priority: 'low' })
    const crit = backlog.add({ title: 'crit one', priority: 'critical' })
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([crit.id, low.id])
  })

  it('applies world capacity across live units and picks', () => {
    capacity = 1
    backlog.add({ title: 'one', project: 'world' })
    backlog.add({ title: 'two', project: 'world' })
    expect(backlog.dispatchable()).toHaveLength(1)
    used = 1
    expect(backlog.dispatchable()).toHaveLength(0)
  })

  it('only dispatches build and recon quests', () => {
    backlog.add({ title: 'a choice', kind: 'choice' })
    backlog.add({ title: 'a recon', kind: 'scout' })
    expect(backlog.dispatchable().map((q) => q.kind)).toEqual(['scout'])
  })

  it('buckets holds: blocked, dated, aged, live', () => {
    const dep = backlog.add({ title: 'dep' })
    const blocked = backlog.add({ title: 'blocked', dependsOn: [dep.id] })
    backlog.hold(blocked.id, 'x')
    const dated = backlog.add({ title: 'dated' })
    backlog.hold(dated.id, 'later', new Date(Date.now() + 86_400_000).toISOString())
    const aged = backlog.add({ title: 'aged' })
    backlog.hold(aged.id, 'old')
    backlog.update(aged.id, { hold: { reason: 'old', since: new Date(Date.now() - 15 * 86_400_000).toISOString() } })
    const live = backlog.add({ title: 'live' })
    backlog.hold(live.id, 'now')
    const plain = backlog.add({ title: 'plain' })
    expect(backlog.bucket(backlog.get(blocked.id)!)).toBe('blocked')
    expect(backlog.bucket(backlog.get(dated.id)!)).toBe('dated')
    expect(backlog.bucket(backlog.get(aged.id)!)).toBe('aged')
    expect(backlog.bucket(backlog.get(live.id)!)).toBe('live')
    expect(backlog.bucket(backlog.get(plain.id)!)).toBe('none')
  })

  it('hold is idempotent and answer records exact words', () => {
    const q = backlog.add({ title: 'Pick palette' })
    const h1 = backlog.hold(q.id, 'warm or cold?')
    const since = h1.hold?.since
    backlog.hold(q.id, 'warm or cold?')
    expect(backlog.get(q.id)?.hold?.since).toBe(since)

    const released = backlog.answer(q.id, 'warm, with teal accents', true)
    expect(released.state).toBe('queued')
    expect(released.answer).toBe('warm, with teal accents')
    expect(released.hold).toBeUndefined()

    const c = backlog.add({ title: 'Ship it?', kind: 'choice' })
    backlog.hold(c.id, 'go?')
    const closed = backlog.answer(c.id, 'yes', false)
    expect(closed.state).toBe('done')
    expect(closed.outcome).toContain('yes')
  })

  it('persists and writes the markdown mirror', () => {
    const q = backlog.add({ title: 'Persist me', project: 'world' })
    backlog.markInFlight(q.id, 'persist-me-1234')
    const md = fs.readFileSync(path.join(home.data, 'backlog.md'), 'utf8')
    expect(md).toContain('## In flight')
    expect(md).toContain('## Queued')
    expect(md).not.toContain('## Held')
    expect(md).toContain('## Done')
    expect(md).toContain(q.id)
    const ctx = makeCtx()
    const again = createBacklogService(() => ctx, home)
    expect(again.get(q.id)?.state).toBe('in-flight')
    expect(again.get(q.id)?.taskId).toBe('persist-me-1234')
  })
})

describe('kanban quest log', () => {
  const unit = (id: string, patch: Partial<Task>): Task => ({ id, kind: 'ship', title: id, project: 'world', state: 'working', ...patch } as Task)

  it('dispatches in priority order, then the manual rank, then age', () => {
    const a = backlog.add({ title: 'normal a' })
    const b = backlog.add({ title: 'normal b' })
    const c = backlog.add({ title: 'normal c' })
    const low = backlog.add({ title: 'low one', priority: 'low' })
    const high = backlog.add({ title: 'high one', priority: 'high' })
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([high.id, a.id, b.id, c.id, low.id])
    // drag c to the top of Normal and low into High under the existing one
    backlog.reorder([{ id: c.id, priority: 'normal', rank: 1 }, { id: a.id, priority: 'normal', rank: 2 }, { id: b.id, priority: 'normal', rank: 3 }])
    backlog.reorder([{ id: high.id, priority: 'high', rank: 1 }, { id: low.id, priority: 'high', rank: 2 }])
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([high.id, low.id, c.id, a.id, b.id])
    // a priority change from a label click lands at the end of the new band
    backlog.update(c.id, { priority: 'high' })
    expect(backlog.get(c.id)?.rank).toBeUndefined()
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([high.id, low.id, c.id, a.id, b.id])
    backlog.update(a.id, { priority: 'critical' })
    expect(backlog.dispatchable()[0].id).toBe(a.id)
    // with one slot, dispatch picks the head of the queue
    capacity = 1
    for (const id of [a.id, b.id, c.id, low.id, high.id]) backlog.update(id, { project: 'world' })
    expect(backlog.dispatchable().map((q) => q.id)).toEqual([a.id])
  })

  it('holds are a "waiting for you" flag on a queued quest; legacy held input maps to it', () => {
    const q = backlog.add({ title: 'Pick a palette' })
    expect(backlog.hold(q.id, 'warm or cold?')).toMatchObject({ state: 'queued', hold: { reason: 'warm or cold?' } })
    expect(backlog.dispatchable()).toHaveLength(0)
    const flying = backlog.add({ title: 'Flying' })
    backlog.markInFlight(flying.id, 'unit-1')
    expect(backlog.hold(flying.id, 'needs your call')).toMatchObject({ state: 'in-flight', hold: { reason: 'needs your call' } })
    const legacy = backlog.update(backlog.add({ title: 'Legacy tool call' }).id, { state: 'held' })
    expect(legacy).toMatchObject({ state: 'queued', hold: { reason: 'waiting on the player' } })
    const added = backlog.add({ title: 'Legacy add', state: 'held' })
    expect(added).toMatchObject({ state: 'queued', hold: { reason: 'waiting on the player' } })
    expect(() => backlog.add({ title: 'An umbrella', kind: 'program' })).toThrow(/labels/)
    const released = backlog.update(legacy.id, { kind: 'program', state: 'queued' })
    expect(released.kind).toBe('ship')
    expect(released.hold).toBeUndefined()
  })

  it('migrates stored held and program quests once, archiving programs and keeping their label', () => {
    const ts = '2026-10-01T00:00:00.000Z'
    const rows: BacklogItem[] = [
      { id: 'prog', title: 'Folder-first workspace', kind: 'program', notes: 'the plan notes', state: 'queued', priority: 'normal', dependsOn: [], tags: ['workspace'], createdAt: ts, updatedAt: ts },
      { id: 'step', title: 'Step 1', project: 'world', kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: ['prog'], tags: [], createdAt: ts, updatedAt: ts },
      { id: 'held', title: 'Held one', kind: 'ship', notes: '', state: 'held', priority: 'high', dependsOn: [], tags: [], hold: { reason: 'ask Alex', since: ts }, answer: 'exact words', createdAt: ts, updatedAt: ts }
    ]
    fs.writeFileSync(home.backlogFile, JSON.stringify(rows))
    const ctx = makeCtx()
    const migrated = createBacklogService(() => ctx, home)
    expect(migrated.list().map((q) => q.id)).toEqual(['step', 'held'])
    expect(migrated.get('step')).toMatchObject({ dependsOn: [], tags: ['workspace'] })
    expect(migrated.get('held')).toMatchObject({ state: 'queued', hold: { reason: 'ask Alex' }, answer: 'exact words' })
    expect(migrated.dispatchable().map((q) => q.id)).toEqual(['step'])
    const archive = fs.readFileSync(path.join(home.data, 'done-archive.md'), 'utf8')
    expect(archive).toContain('prog - Folder-first workspace')
    expect(archive).toContain('the plan notes')
    expect(JSON.parse(fs.readFileSync(home.backlogFile, 'utf8')).map((q: BacklogItem) => q.id)).toEqual(['step', 'held'])
  })

  it('a quest follows its unit to Done when it lands, not when it fails, and never closes a re-queued follow-up', () => {
    const q = backlog.add({ title: 'Ship the jump', project: 'world' })
    backlog.markInFlight(q.id, 'u1')
    backlog.followUnit(unit('u1', { backlogId: q.id, state: 'failed' }))
    expect(backlog.get(q.id)?.state).toBe('in-flight')
    backlog.followUnit(unit('u1', { backlogId: q.id, state: 'merged', landedAt: '2026-10-13T12:00:00.000Z', pr: { url: 'https://example.com/pull/4' } }))
    expect(backlog.get(q.id)).toMatchObject({ state: 'done', outcome: 'https://example.com/pull/4' })
    const again = backlog.add({ title: 'Recon the level', project: 'world', kind: 'scout' })
    backlog.markInFlight(again.id, 'u2')
    backlog.update(again.id, { state: 'queued' })
    backlog.followUnit(unit('u2', { backlogId: again.id, kind: 'scout', state: 'cleaned' }))
    expect(backlog.get(again.id)?.state).toBe('queued')
  })

  it('reconciles drifted quests and flags duplicates without deleting them', () => {
    const landed = backlog.add({ title: 'Landed already', project: 'world' })
    backlog.markInFlight(landed.id, 'merged-unit')
    const despawned = backlog.add({ title: 'Despawned', project: 'world' })
    backlog.markInFlight(despawned.id, 'cleaned-unit')
    const live = backlog.add({ title: 'Still flying', project: 'world' })
    backlog.markInFlight(live.id, 'live-unit')
    units = {
      'merged-unit': unit('merged-unit', { state: 'merged', landedAt: '2026-10-13T11:00:00.000Z', mode: 'local-only', branch: 'genio/x' }),
      'cleaned-unit': unit('cleaned-unit', { state: 'cleaned', cleanedAt: '2026-10-13T11:30:00.000Z', stateReason: 'despawned: landed (merged)' }),
      'live-unit': unit('live-unit', { state: 'working' })
    }
    const finished = backlog.add({ title: 'Make menus', project: 'world' })
    backlog.markDone(finished.id, 'shipped')
    const again = backlog.add({ title: 'make menus', project: 'world' })
    expect(again.duplicateOf).toBe(finished.id) // flagged on add
    backlog.update(again.id, { duplicateOf: undefined })
    const fixed = backlog.reconcile()
    expect(fixed).toHaveLength(3)
    expect(backlog.get(landed.id)).toMatchObject({ state: 'done', outcome: 'landed locally from genio/x', doneAt: '2026-10-13T11:00:00.000Z' })
    expect(backlog.get(despawned.id)).toMatchObject({ state: 'done', doneAt: '2026-10-13T11:30:00.000Z' })
    expect(backlog.get(live.id)?.state).toBe('in-flight')
    expect(backlog.get(again.id)).toMatchObject({ state: 'queued', duplicateOf: finished.id })
    expect(backlog.dispatchable().map((q) => q.id)).not.toContain(again.id)
    // the player clears the flag: it is dispatchable and never re-flagged
    backlog.update(again.id, { duplicateOf: '' })
    expect(backlog.reconcile()).toEqual([])
    expect(backlog.dispatchable().map((q) => q.id)).toContain(again.id)
  })
})

describe('done archive', () => {
  it('archives each older done quest once and stops re-reading the archive once all are known', () => {
    const ctx = makeCtx()
    const svc = createBacklogService(() => ctx, home)
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const q = svc.add({ title: `old quest ${i}`, priority: 'normal' } as never)
      svc.update(q.id, { state: 'done', doneAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() } as never)
      ids.push(q.id)
    }
    const file = path.join(home.data, 'done-archive.md')
    const once = (text: string): boolean => ids.slice(0, 10).every(id => text.split(`] ${id} - `).length === 2)
    expect(once(fs.readFileSync(file, 'utf8'))).toBe(true)
    const reads = vi.spyOn(fs, 'readFileSync')
    for (let i = 0; i < 5; i++) svc.update(ids[39], { notes: `edit ${i}` } as never)
    expect(reads.mock.calls.filter(([p]) => String(p) === file)).toHaveLength(0)
    reads.mockRestore()
    expect(once(fs.readFileSync(file, 'utf8'))).toBe(true)
  })
})