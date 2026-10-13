// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, FleetStats, LandingDay, Task } from '../src/shared/types'
import { getState, handleEvent, setState } from '../src/renderer/src/store'
import { CharacterSheet } from '../src/renderer/src/views/CharacterSheet'
import { ComingNext } from '../src/renderer/src/components/ComingNext'

const featureUsed = vi.fn().mockResolvedValue(undefined)
const trophyPin = vi.fn().mockResolvedValue({ ok: true, message: '' })
const titleEquip = vi.fn().mockResolvedValue({ ok: true, message: '' })
let root: Root
let host: HTMLDivElement
const initial = getState()
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z', ...patch
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { featureUsed, trophyPin, titleEquip } } })
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

it('shows RPG stats above the achievements grid, with no loot, operational queue or report UI', async () => {
  await mount(CharacterSheet)
  for (const label of ['Character Sheet', '40 / 100 XP', 'Shipped today', 'Shipped total', 'Recons', 'Streak', '7d', 'Achievements', 'On a Roll', '1/2', 'Chat/review estimate today', '$1.25']) expect(host.textContent).toContain(label)
  for (const label of ['Loot', 'Your Move', 'Up Next', 'In Progress', 'Include PRs', 'File report', 'Replay log']) expect(host.textContent).not.toContain(label)
  const rows = [...host.querySelector('.character-sheet')!.children].filter((el) => el.tagName === 'SECTION')
  expect(rows.map((el) => el.className)).toEqual(['panel stats-card ticks', 'panel achv-grid-card ticks'])
  expect(host.querySelector('.achv-tile.got')?.textContent).toContain('On a Roll')
  expect(host.querySelector('.achv-tile.locked')?.textContent).toContain('Keep playing.')
  expect(featureUsed).toHaveBeenCalledExactlyOnceWith('character-sheet')
})

it('updates XP and achievements from live events, ignoring completions, without refetching a report', async () => {
  await mount(CharacterSheet)
  await act(async () => {
    handleEvent({ type: 'backlog', items: [quest('First win', { state: 'done', doneAt: '2026-10-12T10:00:00Z' })] })
    handleEvent({ type: 'task', task: { id: 'recon', title: 'Map explored', kind: 'scout', state: 'done', updatedAt: '2026-10-13T10:00:00Z' } as Task })
    const s = getState().snap.stats
    handleEvent({ type: 'stats', stats: { ...s, xp: 80, achievements: s.achievements.map((a) => ({ ...a, unlockedAt: a.unlockedAt ?? '2026-10-13' })) } })
  })
  expect(host.textContent).not.toContain('Map explored')
  expect(host.textContent).not.toContain('First win')
  expect(host.textContent).toContain('80 / 100 XP')
  expect(host.textContent).toContain('2/2')
  expect(host.querySelectorAll('.achv-tile.got')).toHaveLength(2)
  expect(featureUsed).toHaveBeenCalledTimes(1)
})

it('keeps the sheet usable if recording the first visit fails', async () => {
  featureUsed.mockRejectedValueOnce(new Error('Unavailable'))
  await mount(CharacterSheet)
  expect(host.textContent).toContain('40 / 100 XP')
})

const days = (states: LandingDay['state'][]): LandingDay[] =>
  states.map((state, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, builds: 0, recons: 0, state }))
const withStats = (patch: Partial<FleetStats>): void => {
  const s = getState()
  setState({ snap: { ...s.snap, stats: { ...s.snap.stats, ...patch } } })
}

it('shows the playstyle title on the level line with its evidence, and equips earned titles', async () => {
  withStats({ playstyle: {
    current: 'warden', shown: 'warden', why: '13 of last 20 landings were fixes, tests, reviews or CI (65%)', samples: 20,
    counts: { builder: 4, scout: 3, artificer: 0, warden: 13 }, earned: [{ id: 'builder', at: '2026-10-01' }, { id: 'warden', at: '2026-10-12' }]
  } })
  await mount(CharacterSheet)
  const line = host.querySelector('.lv-line')!
  expect(line.textContent).toContain('Level')
  expect(line.textContent).toContain('Warden')
  const select = line.querySelector('select')!
  expect(select.getAttribute('aria-label')).toBe('Playstyle title')
  expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toContain('13 of last 20 landings')
  expect([...select.options].map((o) => o.value)).toEqual(['', 'builder', 'warden'])
  await act(async () => { select.value = 'builder'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(titleEquip).toHaveBeenCalledWith('builder')
})

it('shows an Adventurer without a picker until a title is earned', async () => {
  await mount(CharacterSheet)
  expect(host.querySelector('.lv-line')?.textContent).toContain('Adventurer')
  expect(host.querySelector('.lv-line select')).toBeNull()
})

it('draws 8 weeks of landings in the stats row with unknown days and keyboard tooltips', async () => {
  const landings = days([...Array(10).fill('unknown'), ...Array(41).fill('recorded'), ...Array(5).fill('future')])
  landings[50] = { ...landings[50], builds: 2, recons: 1 }
  withStats({ landings })
  await mount(CharacterSheet)
  const stats = host.querySelector('.stats-card')!
  expect(stats.querySelector('.landings .label')?.textContent).toBe('Landings')
  expect(stats.textContent).toContain('Recorded activity')
  expect(stats.textContent).toContain('3 in 8 wk')
  const cells = [...stats.querySelectorAll<HTMLElement>('.landings-grid [role="gridcell"][aria-label]')]
  expect(cells).toHaveLength(51)
  expect(stats.querySelectorAll('.lc.unknown[aria-label$="Not recorded"]')).toHaveLength(10)
  expect(stats.querySelectorAll('.landings-grid .lc.l0')).toHaveLength(40)
  expect(stats.querySelectorAll('.landings-grid .lc.l3')).toHaveLength(1)
  const today = stats.querySelector<HTMLElement>('.lc.today')!
  expect(today.tabIndex).toBe(0)
  expect(today.getAttribute('aria-label')).toMatch(/2 builds landed, 1 recon completed$/)
  await act(async () => today.focus())
  const tip = document.querySelector('.landings-tip')!
  expect(tip.textContent).toContain('2 builds landed')
  expect(tip.textContent).toContain('1 recon completed')
  await act(async () => today.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/No landings$/)
  expect(document.querySelector('.landings-tip')?.textContent).toContain('No landings recorded')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.landings-tip')).toBeNull()
  const rows = [...host.querySelector('.character-sheet')!.children].filter((el) => el.tagName === 'SECTION')
  expect(rows).toHaveLength(2)
})

it('shows pinned trophies first with earned dates and pins or unpins from the tile', async () => {
  const got = (id: string, name: string, at: string) => ({ id, feature: 'status', name, description: name, unlockedAt: at })
  withStats({
    achievements: [got('a', 'Alpha', '2026-10-01T12:00:00Z'), got('b', 'Bravo', '2026-10-02T12:00:00Z'), got('c', 'Charlie', '2026-10-03T12:00:00Z'), got('d', 'Delta', '2026-10-04T12:00:00Z'), { id: 'e', feature: 'status', name: 'Echo', description: 'Locked' }],
    pins: ['c', 'a', 'b']
  })
  await mount(CharacterSheet)
  const tiles = [...host.querySelectorAll('.achv-tile')]
  expect(tiles.map((t) => t.querySelector('.achv-tname')?.textContent)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta', 'Echo'])
  expect(tiles[0].className).toContain('pinned')
  expect(tiles[0].querySelector('.achv-tdesc')?.textContent).toMatch(/^Earned /)
  expect(host.textContent).toContain('3/3 pinned')
  expect(tiles[4].querySelector('.achv-pin')).toBeNull()
  const deltaPin = tiles[3].querySelector<HTMLButtonElement>('.achv-pin')!
  expect(deltaPin.disabled).toBe(true)
  const charliePin = tiles[0].querySelector<HTMLButtonElement>('.achv-pin')!
  expect(charliePin.getAttribute('aria-pressed')).toBe('true')
  expect(charliePin.getAttribute('aria-label')).toBe('Pin Charlie')
  await act(async () => charliePin.click())
  expect(trophyPin).toHaveBeenCalledWith('c', false)
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
