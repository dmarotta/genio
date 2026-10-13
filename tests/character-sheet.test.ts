// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, LedgerRecord } from '../src/shared/types'

const fixture = vi.hoisted(() => ({
  backlog: [] as Partial<BacklogItem>[], tasks: [], go: vi.fn(),
  ledgerTail: vi.fn<() => Promise<LedgerRecord[]>>().mockResolvedValue([]),
  stats: { level: 3, xp: 40, xpNext: 100, shippedToday: 1, shippedTotal: 5, scoutsTotal: 2, streakDays: 7, costTodayUsd: 1.25,
    achievements: [
      { id: 'on-a-roll', name: 'On a Roll', description: 'Play 7 days in a row.', unlockedAt: '2026-10-13' },
      { id: 'locked', name: 'Still to come', description: 'Keep playing.', unlockedAt: undefined }
    ] }
}))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ snap: fixture }), go: fixture.go,
  api: () => ({ ledgerTail: fixture.ledgerTail })
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

it('restores all RPG stats and achievements without task or queue reports', async () => {
  await mount(CharacterSheet)
  for (const label of ['Character Sheet', '40 / 100 XP', 'Shipped today', 'Shipped total', 'Recons', 'Streak', '7d', 'Achievements', 'On a Roll', '1/2', 'Chat/review estimate today', '$1.25', 'Replay log']) expect(host.textContent).toContain(label)
  for (const label of ['Your Move', 'Loot', 'Up Next', 'In Progress', 'Include PRs', 'File report']) expect(host.textContent).not.toContain(label)
  expect(host.querySelector('.achv-tile.got')?.textContent).toContain('On a Roll')
  expect(host.querySelector('.achv-tile.locked')?.textContent).toContain('Keep playing.')
  expect(host.textContent).toContain('Enable the Replay log in Systems')
})

it('restores newest-first replay details and refreshes after fleet updates', async () => {
  const records: LedgerRecord[] = [
    { v: 1, home: 'test', ts: '2026-10-12T10:00:00Z', event: 'project.added', project: 'world' },
    { v: 1, home: 'test', ts: '2026-10-13T10:00:00Z', event: 'task.merged', task: 'quest', data: { xp: 40 } }
  ]
  fixture.ledgerTail.mockResolvedValueOnce(records)
  await mount(CharacterSheet)
  expect(fixture.ledgerTail).toHaveBeenCalledWith(60)
  const rows = host.querySelectorAll('.replay-row')
  expect(rows[0].textContent).toContain('task.mergedquest{"xp":40}')
  expect(rows[1].textContent).toContain('project.addedworld')
  expect(records[0].event).toBe('project.added')
  expect(host.textContent).toContain('Newest first')
  fixture.tasks = [...fixture.tasks]
  await act(async () => root!.render(React.createElement(CharacterSheet)))
  expect(fixture.ledgerTail).toHaveBeenCalledTimes(2)
})

it('keeps the sheet usable when the replay request fails', async () => {
  fixture.ledgerTail.mockRejectedValueOnce(new Error('Unavailable'))
  await mount(CharacterSheet)
  expect(host.textContent).toContain('40 / 100 XP')
  expect(host.querySelectorAll('.replay-row')).toHaveLength(0)
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
