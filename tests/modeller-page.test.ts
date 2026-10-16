import { describe, expect, it } from 'vitest'
import type { Task } from '../src/shared/types'
import { squadAttention, squadTone } from '../src/shared/squad-display'
import { primaryAction } from '../src/shared/unit-page'
import { modellerCanvas } from '../src/shared/modeller'

const task = (patch: Partial<Task> = {}): Task => ({
  id: 'u1', kind: 'ship', title: 'Watchtower', project: 'game', wksp: 'main', branchPrefix: 'genio/', baseBranch: 'main', branch: 'genio/u1', worktree: 'C:/w/u1',
  briefPath: 'brief.md', harness: 'claude', mode: 'local-only', state: 'working', createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z',
  inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0, relaunches: 0, ...patch
})

describe('Modeller units on the Squad and the unit page', () => {
  it('are orange at work, distinct from the amber needs-you marker, and turn green or red like any unit', () => {
    expect(squadTone(task({ modeller: true }))).toBe('orange')
    expect(squadTone(task())).toBe('blue')
    expect(squadTone(task({ kind: 'scout', modeller: true }))).toBe('violet')
    expect(squadTone(task({ modeller: true, state: 'failed' }))).toBe('alert')
    expect(squadTone(task({ modeller: true, state: 'merged' }))).toBe('volt')
    const asking = task({ modeller: true, state: 'needs-decision' })
    expect(squadTone(asking)).toBe('orange')
    expect(squadAttention(asking)).toBe(true)
  })

  it('offer exactly what a normal Build offers: steer while working, the question, Merge when ready', () => {
    expect(primaryAction(task({ modeller: true }))).toBe('steer')
    expect(primaryAction(task({ modeller: true, state: 'needs-decision' }), undefined, true)).toBe('question')
    expect(primaryAction(task({ modeller: true, state: 'blocked' }), undefined, true)).toBe('question')
    expect(primaryAction(task({ modeller: true, state: 'ready', readyAt: '2026-10-16T11:00:00.000Z' }))).toBe('merge-local')
    expect(primaryAction(task({ modeller: true, state: 'merged' }))).toBe('none')
    expect(primaryAction(task({ modeller: true, state: 'exited' }))).toBe('respawn')
    for (const state of ['working', 'needs-decision', 'ready', 'merged', 'exited'] as const) {
      const ready = state === 'ready' ? { readyAt: '2026-10-16T11:00:00.000Z' } : {}
      expect(primaryAction(task({ modeller: true, state, ...ready }), undefined, state === 'needs-decision')).toBe(primaryAction(task({ state, ...ready }), undefined, state === 'needs-decision'))
    }
  })

  it('show the 3D view from their start until they land or are despawned', () => {
    expect(modellerCanvas(task({ modeller: true, state: 'spawning' }))).toBe(true)
    expect(modellerCanvas(task({ modeller: true, state: 'exited' }))).toBe(true)
    expect(modellerCanvas(task())).toBe(false)
    expect(modellerCanvas(task({ kind: 'scout', modeller: true }))).toBe(false)
    expect(modellerCanvas(task({ modeller: true, state: 'merged' }))).toBe(false)
    expect(modellerCanvas(task({ modeller: true, state: 'ready', landedAt: '2026-10-16T11:00:00.000Z' }))).toBe(false)
    expect(modellerCanvas(task({ modeller: true, state: 'cleaned' }))).toBe(false)
  })
})
