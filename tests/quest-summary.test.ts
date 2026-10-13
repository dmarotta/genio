import { describe, expect, it } from 'vitest'
import { questCounts } from '../src/shared/quest-summary'
import type { BacklogItem } from '../src/shared/types'

const date = '2026-10-13T10:00:00Z'
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: date, updatedAt: date, ...patch
})

describe('quest count', () => {
  it('counts queued and blocked plans, plus expired dated holds; excludes manual holds and completions', () => {
    const items = [quest('queued'), quest('deps', { state: 'blocked', dependsOn: ['queued'] }),
      quest('manual', { state: 'held', hold: { reason: 'Needs answer', since: date } }),
      quest('future', { state: 'held', hold: { reason: 'Later', since: date, until: '2026-10-14T10:00:00Z' } }),
      quest('released', { state: 'held', hold: { reason: 'Ready now', since: date, until: date } }),
      quest('running', { state: 'in-flight' }), quest('done', { state: 'done' }), quest('dropped', { state: 'dropped' })]
    expect(questCounts(items, Date.parse(date))).toEqual({ comingNext: 3, running: 1, planned: 5 })
    expect(items[4].state).toBe('held')
    expect(questCounts([], Date.parse(date))).toEqual({ comingNext: 0, running: 0, planned: 0 })
  })
})
