import { describe, expect, it } from 'vitest'
import type { Task } from '../src/shared/types'
import { squadAttention, squadTone } from '../src/shared/squad-display'
import { acceptOption, primaryAction } from '../src/shared/unit-page'
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

  it('offer Accept instead of plain steering, and for their own Accept question', () => {
    expect(primaryAction(task({ modeller: true }))).toBe('accept')
    expect(primaryAction(task())).toBe('steer')
    expect(primaryAction(task({ modeller: true, state: 'needs-decision' }), undefined, true, true)).toBe('accept')
    expect(primaryAction(task({ modeller: true, state: 'blocked' }), undefined, true, false)).toBe('question')
    // Once the unit placed the files and is ready, the normal Merge takes over; landed units offer nothing.
    expect(primaryAction(task({ modeller: true, state: 'ready', readyAt: '2026-10-16T11:00:00.000Z' }))).toBe('merge-local')
    expect(primaryAction(task({ modeller: true, state: 'merged' }))).toBe('none')
    expect(primaryAction(task({ modeller: true, state: 'exited' }))).toBe('respawn')
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

  it("find the Accept answer of a unit's question", () => {
    expect(acceptOption({ options: ['Accept step 5', 'Keep steering'] })).toBe('Accept step 5')
    expect(acceptOption({ options: [' accept', 'no'] })).toBe(' accept')
    expect(acceptOption({ options: ['Acceptable?', 'Keep steering'] })).toBeUndefined()
    expect(acceptOption({ options: ['Close the scene', 'Keep it open'] })).toBeUndefined()
    expect(acceptOption(undefined)).toBeUndefined()
  })
})
