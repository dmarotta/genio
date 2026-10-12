import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Home } from '../src/main/home'
import { createWakeService } from '../src/main/wakes'
import type { AppCtx } from '../src/main/services'

let dir: string
let home: Home
let ctx: AppCtx

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-wakes-'))
  home = new Home(dir)
  home.ensure()
  const decisions = {
    list: () => [{ id: 'ch-abc', taskId: 'fix-jump-1a2b', key: 'art', question: 'Pixel or vector?', source: 'unit' }]
  }
  ctx = { home: () => ({ decisions }) } as unknown as AppCtx
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('event queue', () => {
  it('drains in companion shape and acks after handling', () => {
    const q = createWakeService(() => ctx, home)
    q.enqueue({ kind: 'signal', reason: 'BUILD "jump" reported done', taskId: 'fix-jump-1a2b', lines: ['done: PR https://github.com/x/y/pull/1'] })
    q.enqueue({ kind: 'stale', reason: 'lagging: escalation 1', taskId: 'fix-jump-1a2b', routine: true })
    q.enqueue({ kind: 'heartbeat', reason: 'tick' })

    const d = q.drain()
    expect(d.count).toBe(3)
    expect(d.ackThrough).toBe(3)
    expect(d.text).toContain('EVENTS (3)')
    expect(d.text).toContain('#1 signal: {fix-jump-1a2b} BUILD "jump" reported done')
    expect(d.text).toContain('[routine]')
    expect(d.text).toContain('UNREAD STATUS (1)')
    expect(d.text).toContain('fix-jump-1a2b: done: PR https://github.com/x/y/pull/1')
    expect(d.text).toContain('OPEN CHOICES (1)')
    expect(d.text).toContain('ch-abc task=fix-jump-1a2b key=art')
    expect(d.text).toContain('ACK REQUIRED: through #3')

    // draining again without ack re-presents everything (idempotent re-handling)
    expect(q.drain().count).toBe(3)

    q.ack(2)
    expect(q.pending().map((w) => w.seq)).toEqual([3])
    q.ack(1) // never moves backwards
    expect(q.pending().map((w) => w.seq)).toEqual([3])
  })

  it('recovers seq and ack cursor after restart', () => {
    const q1 = createWakeService(() => ctx, home)
    q1.enqueue({ kind: 'check', reason: 'a' })
    q1.enqueue({ kind: 'check', reason: 'b' })
    q1.ack(1)

    const q2 = createWakeService(() => ctx, home)
    expect(q2.pending().map((w) => w.reason)).toEqual(['b'])
    const w = q2.enqueue({ kind: 'check', reason: 'c' })
    expect(w.seq).toBe(3)
    expect(q2.recent(10)[0].ackedAt).toBeTruthy()
  })

  it('reports an empty queue cleanly', () => {
    const q = createWakeService(() => ctx, home)
    const d = q.drain()
    expect(d.count).toBe(0)
    expect(d.text).toContain('EVENTS (0)')
    expect(d.text).toContain('ACK REQUIRED: none')
  })

  it('compacts acked rows', () => {
    const q = createWakeService(() => ctx, home)
    for (let i = 0; i < 620; i++) q.enqueue({ kind: 'check', reason: `r${i}` })
    q.ack(615)
    const lines = fs.readFileSync(home.wakesFile, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThan(200)
    expect(q.pending()).toHaveLength(5)
    const q2 = createWakeService(() => ctx, home)
    expect(q2.enqueue({ kind: 'check', reason: 'next' }).seq).toBe(621)
  })
})
