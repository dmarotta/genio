import { describe, expect, it } from 'vitest'
import type { Task, TaskState, TerminalInfo } from '../src/shared/types'
import {
  DONE_HISTORY, finishedAt, outcomeTone, squadActive, squadAttention, squadBadge, squadOutcome, squadSections, squadState, squadTone, unitClock, unitClockShort, type SquadTone
} from '../src/shared/squad-display'
import { canRespawn, hasOpenPr } from '../src/shared/unit-actions'

const at = '2026-10-13T10:00:00Z'
const task = (state: TaskState, patch: Partial<Task> = {}): Task => ({
  id: state, state, kind: 'ship', title: state, createdAt: '2026-10-13T09:00:00Z', updatedAt: at, ...patch
} as Task)
const term = (patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 'pty', alive: true, ...patch } as TerminalInfo)

describe('Squad display only', () => {
  const states: Record<TaskState, string> = {
    spawning: 'WORKING', working: 'WORKING', paused: 'WORKING', stale: 'WORKING', validating: 'WORKING',
    detached: 'WORKING', blocked: 'WORKING', 'needs-decision': 'WORKING', ready: 'READY TO MERGE',
    merged: 'DONE', done: 'DONE', failed: 'DONE', exited: 'DONE', cleaned: 'DONE'
  }
  it.each(Object.entries(states))('maps %s to %s without changing lifecycle', (internal, expected) => {
    const t = task(internal as TaskState)
    expect(squadState(t)).toBe(expected)
    expect(t.state).toBe(internal)
  })
  it('allows an idle ready CLI and its chrome but rejects resumed work, validation and respawn even with an old PR', () => {
    const t = task('ready', { readyAt: at, pr: { url: 'https://example.com/pr/1' } })
    expect(squadState(t, term({ lastOutputAt: at }))).toBe('READY TO MERGE')
    // a dialog or status-bar repaint after the ready line is not work
    expect(squadState(t, term({ lastOutputAt: '2026-10-13T10:00:01Z' }))).toBe('READY TO MERGE')
    expect(squadState({ ...t, lastOutputAt: '2026-10-13T10:00:02Z' }, term())).toBe('READY TO MERGE')
    expect(squadState({ ...t, resumedAt: '2026-10-13T10:00:02Z' }, term())).toBe('WORKING')
    expect(squadState({ ...t, validation: { state: 'running' } as Task['validation'] })).toBe('WORKING')
    expect(squadState({ ...t, state: 'working' }, term())).toBe('WORKING')
    expect(squadState({ ...t, resumedAt: '2026-10-13T10:00:02Z' }, term({ alive: false, exitCode: 0 }))).toBe('READY TO MERGE')
  })
  it('uses blue Build, purple Recon, green ready/done, red error, and a separate yellow attention indicator', () => {
    expect(squadTone(task('working'))).toBe('blue')
    expect(squadTone(task('working', { kind: 'scout' }))).toBe('violet')
    for (const state of ['ready', 'merged', 'done', 'cleaned'] as TaskState[]) expect(squadTone(task(state))).toBe('volt')
    expect(squadTone(task('failed'))).toBe('alert')
    expect(squadTone(task('exited'), term({ alive: false, exitCode: 1 }))).toBe('alert')
    expect(squadTone(task('exited'), term({ alive: false, exitCode: 0 }))).toBe('volt')
    expect(squadTone(task('exited', { stateReason: 'unit process exited (code 0) without a final status' }))).toBe('volt')
    expect(squadTone(task('working'), term({ alive: false, exitCode: 1 }))).toBe('alert')
    expect(squadAttention(task('working'), term({ alive: false, exitCode: 1 }), true)).toBe(false)
    for (const state of ['blocked', 'needs-decision'] as TaskState[]) {
      expect(squadTone(task(state, { kind: 'scout' }))).toBe('violet')
      expect(squadAttention(task(state, { kind: 'scout' }))).toBe(true)
      expect(squadState(task(state))).toBe('WORKING')
    }
    expect(squadTone(task('working', { kind: 'scout' }))).toBe('violet')
    expect(squadAttention(task('working', { kind: 'scout' }), undefined, true)).toBe(true)
    expect(squadAttention(task('done', { kind: 'scout' }), undefined, true)).toBe(false)
  })

  // state -> [label, color, yellow indicator]; 'kind' is purple for a Recon, blue for a Build. Amber is never a unit's own color.
  const table: Record<TaskState, [string, SquadTone | 'kind', boolean]> = {
    spawning: ['WORKING', 'kind', false], working: ['WORKING', 'kind', false], paused: ['WORKING', 'kind', false],
    stale: ['WORKING', 'kind', false], validating: ['WORKING', 'kind', false], detached: ['WORKING', 'kind', false],
    blocked: ['WORKING', 'kind', true], 'needs-decision': ['WORKING', 'kind', true], ready: ['READY TO MERGE', 'volt', false],
    merged: ['DONE', 'volt', false], done: ['DONE', 'volt', false], cleaned: ['DONE', 'volt', false],
    failed: ['DONE', 'alert', false], exited: ['DONE', 'alert', false]
  }
  for (const kind of ['scout', 'ship'] as const) {
    it.each(Object.entries(table))(`${kind} %s -> %j`, (state, [label, tone, attention]) => {
      const t = task(state as TaskState, { kind })
      expect(squadState(t)).toBe(label)
      expect(squadTone(t)).toBe(tone === 'kind' ? (kind === 'scout' ? 'violet' : 'blue') : tone)
      expect(squadAttention(t)).toBe(attention)
    })
  }
})

describe('Squad list and outcomes', () => {
  const minute = (n: number): string => new Date(Date.parse('2026-10-13T00:00:00Z') + n * 60_000).toISOString()
  it('keeps only active units on the Squad page in their order', () => {
    const done = Array.from({ length: 5 }, (_, i) => task(i % 2 ? 'cleaned' : 'merged', { id: `done-${i}` }))
    const active = [task('working', { id: 'a1' }), task('ready', { id: 'a2' }), task('needs-decision', { id: 'a3' })]
    expect(squadActive([done[4], active[0], done[0], active[1], ...done.slice(1, 4), active[2]]).map(t => t.id)).toEqual(['a1', 'a2', 'a3'])
  })
  it('keeps active rail units in order, then the newest 25 finished units, without changing the input', () => {
    expect(DONE_HISTORY).toBe(25)
    const done = Array.from({ length: DONE_HISTORY + 5 }, (_, i) => task('merged', { id: `done-${i}`, finishedAt: minute(i) }))
    const active = [task('working', { id: 'a1' }), task('ready', { id: 'a2' }), task('needs-decision', { id: 'a3' })]
    const tasks = [done[0], active[0], ...done.slice(1), active[1], active[2]]
    const original = [...tasks]
    const roster = squadSections(tasks)
    expect(roster.active).toEqual(active)
    expect(roster.done).toEqual(done.slice(5).reverse())
    expect(tasks).toEqual(original)
  })
  it('orders every finished outcome by its persisted finish or legacy landing/update time, never despawns', () => {
    const tasks = [
      task('done', { kind: 'scout', finishedAt: minute(1) }),
      task('failed', { finishedAt: minute(4), updatedAt: minute(50) }),
      task('merged', { landedAt: minute(2) }),
      task('exited', { updatedAt: minute(3) }),
      task('cleaned', { outcome: 'merged', finishedAt: minute(99) })
    ]
    expect(squadSections(tasks).done.map(t => t.state)).toEqual(['failed', 'exited', 'merged', 'done'])
    expect(squadSections(tasks, undefined, 2).done.map(t => t.state)).toEqual(['failed', 'exited'])
    expect(squadSections(tasks, undefined, 0).done).toEqual([])
  })
  it('breaks equal finish times by newest deployment and excludes despawns before applying the cap', () => {
    const older = task('merged', { id: 'older', createdAt: minute(1), finishedAt: minute(10) })
    const newer = task('done', { id: 'newer', createdAt: minute(2), finishedAt: minute(10) })
    const cleaned = Array.from({ length: DONE_HISTORY }, (_, i) => task('cleaned', { id: `despawn-${i}`, finishedAt: minute(99) }))
    expect(squadSections([older, ...cleaned, newer], undefined, 1)).toEqual({ active: [], done: [newer] })
  })
  it('reports merged, done, failed and abnormal exits with green or red', () => {
    expect(squadOutcome(task('cleaned', { landedAt: at }))).toBe('merged')
    expect(squadOutcome(task('merged'))).toBe('merged')
    expect(squadOutcome(task('cleaned', { outcome: 'failed' }))).toBe('failed')
    expect(squadOutcome(task('done', { kind: 'scout' }))).toBe('done')
    expect(squadOutcome(task('failed'))).toBe('failed')
    expect(squadOutcome(task('exited'), term({ alive: false, exitCode: 1 }))).toBe('exited abnormally')
    expect(squadOutcome(task('exited', { stateReason: 'unit process exited (code 0) without a final status' }))).toBe('done')
    expect(outcomeTone('merged')).toBe('volt')
    expect(outcomeTone('done')).toBe('volt')
    expect(outcomeTone('failed')).toBe('alert')
    expect(outcomeTone('exited abnormally')).toBe('alert')
    expect(finishedAt(task('cleaned', { finishedAt: minute(1), landedAt: minute(2) }))).toBe(minute(1))
  })
})

describe('Unit badge, clock and lifecycle rules', () => {
  it('shows how a finished unit ended instead of a red DONE', () => {
    expect(squadBadge(task('failed'))).toEqual({ label: 'FAILED', tone: 'alert' })
    expect(squadBadge(task('cleaned', { outcome: 'failed' }))).toEqual({ label: 'FAILED', tone: 'alert' })
    expect(squadBadge(task('cleaned', { landedAt: at }))).toEqual({ label: 'MERGED', tone: 'volt' })
    expect(squadBadge(task('exited'), term({ alive: false, exitCode: 1 }))).toEqual({ label: 'EXITED ABNORMALLY', tone: 'alert' })
    expect(squadBadge(task('done', { kind: 'scout' }))).toEqual({ label: 'DONE', tone: 'volt' })
    expect(squadBadge(task('ready', { readyAt: at }))).toEqual({ label: 'READY TO MERGE', tone: 'volt' })
    expect(squadBadge(task('working'))).toEqual({ label: 'WORKING', tone: 'blue' })
  })
  it('counts working time while active and stops the clock when the unit is ready or finished', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    expect(unitClock(task('working'), undefined, now)).toBe('working 3h 0m 0s')
    expect(unitClock(task('working', { createdAt: '2026-10-13T11:37:10Z' }), undefined, now)).toBe('working 22m 50s')
    expect(unitClock(task('working', { createdAt: '2026-10-13T11:59:30Z' }), undefined, now)).toBe('working 30s')
    expect(unitClock(task('ready', { readyAt: '2026-10-13T09:54:00Z' }), undefined, now)).toBe('took 54m 0s')
    expect(unitClock(task('cleaned', { finishedAt: '2026-10-13T10:05:00Z', cleanedAt: '2026-10-13T11:00:00Z' }), undefined, now)).toBe('took 1h 5m 0s')
    // A merged unit's clock no longer moves.
    const merged = task('merged', { finishedAt: '2026-10-13T09:40:00Z' })
    expect(unitClock(merged, undefined, now)).toBe(unitClock(merged, undefined, now + 3_600_000))
  })
  it('gives the Squad rail the same clock in short form', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    expect(unitClockShort(task('working'), undefined, now)).toBe('3h 0m 0s')
    expect(unitClockShort(task('working', { createdAt: '2026-10-13T11:37:10Z' }), undefined, now)).toBe('22m 50s')
    expect(unitClockShort(task('working', { createdAt: '2026-10-13T11:59:30Z' }), undefined, now)).toBe('30s')
    expect(unitClockShort(task('ready', { readyAt: '2026-10-13T10:05:00Z' }), undefined, now)).toBe('1h 5m 0s')
    const ready = task('ready', { readyAt: '2026-10-13T09:54:00Z' })
    expect(unitClockShort(ready, undefined, now)).toBe(unitClockShort(ready, undefined, now + 3_600_000))
    const done = task('done', { finishedAt: '2026-10-13T09:40:17Z', updatedAt: '2026-10-13T11:00:00Z' })
    expect(unitClockShort(done, undefined, now)).toBe('40m 17s')
    expect(unitClockShort(done, undefined, now + 3_600_000)).toBe('40m 17s')
  })
  it('offers Respawn only where it resumes unfinished work', () => {
    const allowed: Record<TaskState, boolean> = {
      spawning: true, working: true, paused: true, stale: true, detached: true, blocked: true, 'needs-decision': true, failed: true, exited: true,
      validating: false, ready: false, merged: false, done: false, cleaned: false
    }
    for (const [state, ok] of Object.entries(allowed)) expect([state, canRespawn(task(state as TaskState))]).toEqual([state, ok])
  })
  it('flags only a Build whose PR is still open', () => {
    expect(hasOpenPr(task('ready', { pr: { url: 'https://github.com/o/r/pull/1', state: 'OPEN' } }))).toBe(true)
    expect(hasOpenPr(task('ready', { pr: { url: 'https://github.com/o/r/pull/1' } }))).toBe(true)
    expect(hasOpenPr(task('ready', { pr: { url: 'https://github.com/o/r/pull/1', state: 'MERGED' } }))).toBe(false)
    expect(hasOpenPr(task('ready', { pr: { url: 'https://github.com/o/r/pull/1', state: 'CLOSED' } }))).toBe(false)
    expect(hasOpenPr(task('ready'))).toBe(false)
  })
})
