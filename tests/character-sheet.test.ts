// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  backlog: [] as Partial<BacklogItem>[], go: vi.fn(),
  stats: { level: 3, xp: 40, xpNext: 100, shippedToday: 1, shippedTotal: 5, scoutsTotal: 2, streakDays: 7,
    achievements: [{ id: 'on-a-roll', name: 'On a Roll', description: 'Play 7 days in a row.', unlockedAt: '2026-10-13' }] }
}))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ snap: fixture }), go: fixture.go
}))
import { CharacterSheet } from '../src/renderer/src/views/CharacterSheet'
import { ComingNext } from '../src/renderer/src/components/ComingNext'

let root: Root | undefined
let host: HTMLDivElement
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
async function mount(component: React.ComponentType) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(React.createElement(component)))
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined; document.body.innerHTML = ''; vi.clearAllMocks()
})

it('shows RPG progress and achievements without operational reports, costs or replay', async () => {
  await mount(CharacterSheet)
  for (const label of ['Character Sheet', '40 / 100 XP', 'Streak', 'Achievements', 'On a Roll']) expect(host.textContent).toContain(label)
  for (const label of ['Your Move', 'Up Next', 'In Progress', 'Include PRs', 'File report', 'Refresh', 'Replay log', 'Chat/review']) expect(host.textContent).not.toContain(label)
})

it('counts the queued board column and opens Quests, including an empty queue', async () => {
  fixture.backlog = [
    { state: 'queued' }, { state: 'blocked' }, { state: 'queued', hold: { reason: 'Wait', since: '2026-10-13' } },
    { state: 'held' }, { state: 'in-flight' }, { state: 'done' }, { state: 'dropped' }
  ]
  await mount(ComingNext)
  expect(host.textContent).toBe('2 coming next')
  await act(async () => host.querySelector('button')!.click())
  expect(fixture.go).toHaveBeenCalledWith('quests')
  fixture.backlog = []
  await act(async () => root!.render(React.createElement(ComingNext)))
  expect(host.textContent).toBe('0 coming next')
})
