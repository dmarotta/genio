import { describe, expect, it } from 'vitest'
import { questCounts, recentLoot } from '../src/shared/quest-summary'
import type { BacklogItem, Task } from '../src/shared/types'

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

describe('completion loot', () => {
  it('deduplicates quest and unit completions, preserves landed units after cleanup and excludes failed work', () => {
    const tasks = [
      { id: 'ship', title: 'Build landed', kind: 'ship', state: 'cleaned', landedAt: date, updatedAt: date },
      { id: 'scout', title: 'Scout done', kind: 'scout', state: 'done', updatedAt: '2026-10-12T10:00:00Z' },
      { id: 'failed', title: 'Failed', kind: 'ship', state: 'cleaned', updatedAt: date },
      { id: 'pending', title: 'Ready for review', kind: 'ship', state: 'ready', updatedAt: date }
    ] as Task[]
    const backlog = [quest('duplicate', { state: 'done', taskId: 'ship' }), quest('independent', { state: 'done', doneAt: '2026-10-11T10:00:00Z' }), quest('queued')]
    expect(recentLoot({ tasks, backlog }).map(e => e.title)).toEqual(['Build landed', 'Scout done', 'independent'])
  })
  it('keeps the latest ten completions in descending order without mutating the source', () => {
    const backlog = Array.from({ length: 12 }, (_, i) => quest(`win-${i}`, { state: 'done', doneAt: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z` }))
    expect(recentLoot({ tasks: [], backlog }).map(e => e.title)).toEqual(Array.from({ length: 10 }, (_, i) => `win-${11 - i}`))
    expect(backlog[0].id).toBe('win-0')
  })
})
