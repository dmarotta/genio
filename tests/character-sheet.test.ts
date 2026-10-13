// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, Task } from '../src/shared/types'
import { getState, handleEvent, setState } from '../src/renderer/src/store'
import { CharacterSheet } from '../src/renderer/src/views/CharacterSheet'
import { ComingNext } from '../src/renderer/src/components/ComingNext'

const featureUsed = vi.fn().mockResolvedValue(undefined)
let root: Root
let host: HTMLDivElement
const initial = getState()
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z', ...patch
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { featureUsed } } })
  setState({ ...initial, snap: { ...initial.snap, stats: {
    ...initial.snap.stats, level: 3, xp: 40, xpNext: 100, shippedToday: 1, shippedTotal: 5,
    scoutsTotal: 2, streakDays: 7, costTodayUsd: 1.25,
    achievements: [
      { id: 'on-a-roll', feature: 'status', name: 'On a Roll', description: 'Play 7 days in a row.', unlockedAt: '2026-10-13' },
      { id: 'locked', feature: 'status', name: 'Still to come', description: 'Keep playing.' }
    ]
  } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.clearAllMocks()
})
async function mount(component: React.ComponentType) {
  await act(async () => root.render(React.createElement(component)))
}

it('shows RPG stats, locked hints and loot, with no operational queue or report UI', async () => {
  await mount(CharacterSheet)
  for (const label of ['Character Sheet', '40 / 100 XP', 'Shipped today', 'Shipped total', 'Recons', 'Streak', '7d', 'Achievements', 'On a Roll', '1/2', 'Chat/review estimate today', '$1.25', 'Loot']) expect(host.textContent).toContain(label)
  for (const label of ['Your Move', 'Up Next', 'In Progress', 'Include PRs', 'File report', 'Replay log']) expect(host.textContent).not.toContain(label)
  expect(host.querySelector('.achv-tile.got')?.textContent).toContain('On a Roll')
  expect(host.querySelector('.achv-tile.locked')?.textContent).toContain('Keep playing.')
  expect(host.textContent).toContain('No loot yet')
  expect(featureUsed).toHaveBeenCalledExactlyOnceWith('character-sheet')
})

it('updates loot and XP from real quest, task and stats events without refetching a report', async () => {
  await mount(CharacterSheet)
  await act(async () => {
    handleEvent({ type: 'backlog', items: [quest('First win', { state: 'done', doneAt: '2026-10-12T10:00:00Z' })] })
    handleEvent({ type: 'task', task: { id: 'recon', title: 'Map explored', kind: 'scout', state: 'done', updatedAt: '2026-10-13T10:00:00Z' } as Task })
    handleEvent({ type: 'stats', stats: { ...getState().snap.stats, xp: 80 } })
  })
  const rows = host.querySelectorAll('.sec-line')
  expect(rows[0].textContent).toContain('Map explored')
  expect(rows[0].textContent).toContain('Recon report delivered')
  expect(rows[1].textContent).toContain('First win')
  expect(host.textContent).toContain('80 / 100 XP')
  expect(featureUsed).toHaveBeenCalledTimes(1)
})

it('keeps the sheet usable if recording the first visit fails', async () => {
  featureUsed.mockRejectedValueOnce(new Error('Unavailable'))
  await mount(CharacterSheet)
  expect(host.textContent).toContain('40 / 100 XP')
})

it('updates the coming-next link from quest events and opens the unchanged board', async () => {
  await mount(ComingNext)
  expect(host.textContent).toBe('0 coming next')
  await act(async () => handleEvent({ type: 'backlog', items: [
    quest('queued'), quest('blocked', { state: 'blocked' }),
    quest('held', { state: 'held' }), quest('running', { state: 'in-flight' }),
    quest('done', { state: 'done' }), quest('dropped', { state: 'dropped' })
  ] }))
  expect(host.textContent).toBe('2 coming next')
  await act(async () => host.querySelector('button')!.click())
  expect(getState().view).toBe('quests')
  await act(async () => handleEvent({ type: 'backlog', items: [] }))
  expect(host.textContent).toBe('0 coming next')
})
