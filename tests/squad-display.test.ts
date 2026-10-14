import { describe, expect, it } from 'vitest'
import type { Task, TaskState, TerminalInfo } from '../src/shared/types'
import {
  DONE_HISTORY, finishedAt, outcomeTone, squadAttention, squadOutcome, squadSections, squadState, squadTone, type SquadTone
} from '../src/shared/squad-display'

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
  it('allows an idle ready CLI but rejects new live output, validation and respawn even with an old PR', () => {
    const t = task('ready', { readyAt: at, pr: { url: 'https://example.com/pr/1' } })
    expect(squadState(t, term({ lastOutputAt: at }))).toBe('READY TO MERGE')
    expect(squadState(t, term({ lastOutputAt: '2026-10-13T10:00:01Z' }))).toBe('WORKING')
    expect(squadState({ ...t, lastStatusAt: '2026-10-13T10:00:03Z', lastOutputAt: '2026-10-13T10:00:02Z' }, term())).toBe('WORKING')
    expect(squadState({ ...t, validation: { state: 'running' } as Task['validation'] })).toBe('WORKING')
    expect(squadState({ ...t, state: 'working' }, term())).toBe('WORKING')
    expect(squadState({ ...t, lastOutputAt: '2026-10-13T10:00:02Z' }, term({ alive: false, exitCode: 0 }))).toBe('READY TO MERGE')
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

describe('Squad done history', () => {
  const minute = (n: number): string => new Date(Date.parse('2026-10-13T00:00:00Z') + n * 60_000).toISOString()
  it('pins active units first in their order, then the 25 newest finished units newest first', () => {
    const done = Array.from({ length: 30 }, (_, i) => task(i % 3 ? 'cleaned' : 'merged', { id: `done-${i}`, finishedAt: minute(i) }))
    const active = [task('working', { id: 'a1' }), task('ready', { id: 'a2' }), task('needs-decision', { id: 'a3' })]
    const { active: top, done: history } = squadSections([done[4], active[0], ...done.slice(10), active[1], ...done.slice(0, 4), active[2], ...done.slice(5, 10)])
    expect(top.map(t => t.id)).toEqual(['a1', 'a2', 'a3'])
    expect(history).toHaveLength(DONE_HISTORY)
    expect(DONE_HISTORY).toBe(25)
    expect(history.map(t => t.id)).toEqual(Array.from({ length: 25 }, (_, i) => `done-${29 - i}`))
  })
  it('sinks older entries as new ones finish and uses legacy timestamps without a recorded finish', () => {
    const legacy = [
      task('cleaned', { id: 'landed', landedAt: minute(5), cleanedAt: minute(50), updatedAt: minute(50) }),
      task('cleaned', { id: 'despawned', cleanedAt: minute(10), updatedAt: minute(60) }),
      task('failed', { id: 'failed', updatedAt: minute(20) })
    ]
    expect(squadSections(legacy).done.map(t => t.id)).toEqual(['failed', 'despawned', 'landed'])
    const fresh = Array.from({ length: 25 }, (_, i) => task('done', { id: `new-${i}`, finishedAt: minute(100 + i) }))
    const { done } = squadSections([...legacy, ...fresh])
    expect(done[0].id).toBe('new-24')
    expect(done.map(t => t.id)).not.toContain('landed')
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
