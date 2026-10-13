import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('event queue', () => {
  it('drains compact changes without repeating signal text or open choices', () => {
    const q = createWakeService(() => ctx, home)
    q.enqueue({ kind: 'signal', reason: 'BUILD "jump" reported done', taskId: 'fix-jump-1a2b', lines: ['done: PR https://github.com/x/y/pull/1'] })
    q.enqueue({ kind: 'stale', reason: 'lagging: escalation 1', taskId: 'fix-jump-1a2b', routine: true })
    q.enqueue({ kind: 'heartbeat', reason: 'tick' })

    const d = q.drain()
    expect(d.count).toBe(3)
    expect(d.ackThrough).toBe(3)
    expect(d.text).toContain('EVENTS (3; 3 pending)')
    expect(d.text).toContain('#1 signal: {fix-jump-1a2b} BUILD "jump" reported done')
    expect(d.text).toContain('[routine]')
    expect(d.text.match(/done: PR https:\/\/github.com\/x\/y\/pull\/1/g)).toHaveLength(1)
    expect(d.text).not.toContain('UNREAD STATUS')
    expect(d.text).not.toContain('Pixel or vector?')
    expect(d.text).toContain('choice_list')
    expect(d.text).toContain('through #3')

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
    expect(d.text).toContain('EVENTS (0; 0 pending)')
    expect(d.text).toContain('ACK REQUIRED: none')
  })

  it('compacts acked rows', () => {
    const q = createWakeService(() => ctx, home)
    for (let i = 0; i < 620; i++) q.enqueue({ kind: 'check', reason: `r${i}` })
    q.ack(615)
    const lines = fs.readFileSync(home.wakesFile, 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThan(200)
    expect(q.pending()).toHaveLength(5)
    expect(() => q.ackEvents([1])).not.toThrow() // already acked and compacted
    const q2 = createWakeService(() => ctx, home)
    expect(q2.enqueue({ kind: 'check', reason: 'next' }).seq).toBe(621)
  })

  it('keeps out-of-order per-event acknowledgements across a failed turn and restart', () => {
    const q = createWakeService(() => ctx, home)
    for (const reason of ['first', 'second', 'third']) q.enqueue({ kind: 'check', reason })
    q.drain()
    q.ackEvents([2])
    const restarted = createWakeService(() => ctx, home)
    expect(restarted.pending().map(w => w.seq)).toEqual([1, 3])
    expect(restarted.get(2)?.ackedAt).toBeTruthy()
    restarted.ackEvents([1])
    expect(createWakeService(() => ctx, home).pending().map(w => w.seq)).toEqual([3])
    restarted.ackEvents([2]) // idempotent
    expect(() => restarted.ackEvents([999])).toThrow('Unknown event')
    expect(restarted.pending().map(w => w.seq)).toEqual([3])
  })

  it('does not acknowledge in memory when durable persistence fails', () => {
    const q = createWakeService(() => ctx, home)
    q.enqueue({ kind: 'check', reason: 'failure' })
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure') })
    expect(() => q.ackEvents([1])).toThrow('disk failure')
    expect(q.pending()).toHaveLength(1)
    expect(createWakeService(() => ctx, home).pending()).toHaveLength(1)
  })

  it('bounds batches, preserves full large events and only acks delivered IDs', () => {
    const q = createWakeService(() => ctx, home)
    const lines = Array.from({ length: 60 }, (_, i) => `error-${i}: https://example.com/${i} ${'detail '.repeat(30)}`)
    q.enqueue({ kind: 'signal', reason: 'failed', taskId: 'unit-id', lines })
    for (let i = 0; i < 80; i++) q.enqueue({ kind: 'check', reason: `result-${i} ${'detail '.repeat(20)}` })
    const d = q.drain()
    expect(d.text.length).toBeLessThanOrEqual(2000)
    expect(d.text).toContain('event_read(seq=1) REQUIRED')
    expect(q.get(1)?.lines).toEqual(lines.map(l => l.trim()))
    q.ack(d.ackThrough)
    expect(q.pending()).toHaveLength(81 - d.count)
    expect(q.drain().text).not.toContain('event_read(seq=1)')
  })
})
