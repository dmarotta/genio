import { describe, expect, it } from 'vitest'
import type { Task, TaskState, TerminalInfo } from '../src/shared/types'
import { squadState, squadTone } from '../src/shared/squad-display'

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
  it('uses blue Build, purple Recon, green ready/done, red error, yellow attention with WORKING unchanged', () => {
    expect(squadTone(task('working'))).toBe('blue')
    expect(squadTone(task('working', { kind: 'scout' }))).toBe('violet')
    for (const state of ['ready', 'merged', 'done', 'cleaned'] as TaskState[]) expect(squadTone(task(state))).toBe('volt')
    expect(squadTone(task('failed'))).toBe('alert')
    expect(squadTone(task('exited'), term({ alive: false, exitCode: 1 }))).toBe('alert')
    expect(squadTone(task('exited'), term({ alive: false, exitCode: 0 }))).toBe('volt')
    expect(squadTone(task('exited', { stateReason: 'unit process exited (code 0) without a final status' }))).toBe('volt')
    expect(squadTone(task('working'), term({ alive: false, exitCode: 1 }), true)).toBe('alert')
    for (const state of ['blocked', 'needs-decision'] as TaskState[]) {
      expect(squadTone(task(state, { kind: 'scout' }))).toBe('amber')
      expect(squadState(task(state))).toBe('WORKING')
    }
    expect(squadTone(task('working', { kind: 'scout' }), undefined, true)).toBe('amber')
  })
})
