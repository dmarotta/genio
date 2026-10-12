import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Home } from '../src/main/home'
import { createBacklogService } from '../src/main/backlog'
import type { AppCtx, BacklogService } from '../src/main/services'

let dir: string
let home: Home
let backlog: BacklogService
let capacity = 0
let used = 0

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
    crew: { capacityUsed: () => used, get: () => undefined }
  } as never)
  return ctx
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-backlog-'))
  home = new Home(dir)
  home.ensure()
  capacity = 0
  used = 0
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
    expect(md).toContain('## Held')
    expect(md).toContain('## Done')
    expect(md).toContain(q.id)
    const ctx = makeCtx()
    const again = createBacklogService(() => ctx, home)
    expect(again.get(q.id)?.state).toBe('in-flight')
    expect(again.get(q.id)?.taskId).toBe('persist-me-1234')
  })
})
