// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, FleetStats, LandingDay, Task } from '../src/shared/types'
import { getState, handleEvent, setState } from '../src/renderer/src/store'
import { CharacterSheet } from '../src/renderer/src/views/CharacterSheet'
import { TITLE_CAP } from '../src/shared/level-titles'

const featureUsed = vi.fn().mockResolvedValue(undefined)
const trophyPin = vi.fn().mockResolvedValue({ ok: true, message: '' })
let root: Root
let host: HTMLDivElement
const initial = getState()
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: '2026-10-13T10:00:00Z', updatedAt: '2026-10-13T10:00:00Z', ...patch
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { featureUsed, trophyPin } } })
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
  for (const label of ['Character Sheet', '40 / 100 XP', 'Shipped total', 'Recons', 'Streak', '7d', 'Achievements', 'On a Roll', '1/2']) expect(host.textContent).toContain(label)
  // no cost estimate, no "today" tile the landings map already shows, no kicker restating the screen
  for (const label of ['Loot', 'Your Move', 'Up Next', 'In Progress', 'Include PRs', 'File report', 'Replay log', 'Shipped today', 'estimate', '$1.25', 'Level, XP']) expect(host.textContent).not.toContain(label)
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

it("shows the level's title on the level line and one quiet line for the next title, with nothing to choose", async () => {
  withStats({ level: 13, xp: 12421, xpNext: 12761 })
  await mount(CharacterSheet)
  const meta = host.querySelector('.lv-meta')!
  expect(meta.querySelector('.lv-line')?.textContent).toBe('LevelAce Mk II')
  expect(meta.querySelector('.lv-next')?.textContent).toBe('Next: Ace Mk III at level 14')
  expect(host.querySelectorAll('.lv-next')).toHaveLength(1)
  expect(host.querySelector('.stats-card')?.querySelectorAll('select, button')).toHaveLength(0)
  expect(host.textContent).not.toMatch(/playstyle|equip/i)
  expect(host.textContent).toContain('12421 / 12761 XP')
})

it('shows no teaser at the last title, which stays past it', async () => {
  withStats({ level: TITLE_CAP + 3 })
  await mount(CharacterSheet)
  expect(host.querySelector('.lv-line')?.textContent).toContain('Living Legend')
  expect(host.querySelector('.lv-next')).toBeNull()
})

it('draws 8 weeks of landings in the stats row with unknown days and keyboard tooltips', async () => {
  const landings = days([...Array(10).fill('unknown'), ...Array(41).fill('recorded'), ...Array(5).fill('future')])
  landings[50] = { ...landings[50], builds: 2, recons: 1 }
  withStats({ landings })
  await mount(CharacterSheet)
  const stats = host.querySelector('.stats-card')!
  expect(stats.querySelector('.landings .label')?.textContent).toBe('Landings')
  // the map only: no total, no subtitle, no legend
  expect(stats.textContent).not.toMatch(/Recorded activity|in 8 wk|Less|More|Not recorded/)
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
  // a pinned tile reads like any earned one: its date
  expect(tiles[0].querySelector('.achv-tdesc')?.textContent).not.toMatch(/Earned/)
  expect(host.textContent).not.toContain('pinned')
  expect(tiles[4].querySelector('.achv-pin')).toBeNull()
  const deltaPin = tiles[3].querySelector<HTMLButtonElement>('.achv-pin')!
  expect(deltaPin.disabled).toBe(true)
  const charliePin = tiles[0].querySelector<HTMLButtonElement>('.achv-pin')!
  expect(charliePin.getAttribute('aria-pressed')).toBe('true')
  expect(charliePin.getAttribute('aria-label')).toBe('Pin Charlie')
  await act(async () => charliePin.click())
  expect(trophyPin).toHaveBeenCalledWith('c', false)
})

it('shows an earned retired trophy without counting retired ones toward the total', async () => {
  withStats({ achievements: [
    { id: 'a', feature: 'status', name: 'Alpha', description: 'First landing', unlockedAt: '2026-10-01T12:00:00Z' },
    { id: 'b', feature: 'status', name: 'Bravo', description: 'Second landing' },
    { id: 'play-snapshot', feature: 'play', name: 'In the Frame', description: 'Capture a game snapshot.', unlockedAt: '2026-09-01T12:00:00Z', retired: true }
  ] })
  await mount(CharacterSheet)
  expect(host.querySelector('.achv-count')?.textContent).toContain('1/2')
  const tiles = [...host.querySelectorAll<HTMLElement>('.achv-tile')]
  expect(tiles.map((t) => t.className.includes('got'))).toEqual([true, false, true])
  await act(async () => tiles[2].focus())
  expect(document.querySelector('.achv-tip')?.textContent).toContain('Earned')
  expect(document.querySelector('.achv-tip')?.textContent).not.toContain('retired')
})

it('keeps compact tiles to an inline icon and two lines, with the full hint in a hover or focus tip', async () => {
  const hint = 'Land a build, a recon and an art pass on the same day while keeping a seven-day streak alive.'
  withStats({ achievements: [
    { id: 'a', feature: 'status', name: 'Alpha', description: 'First landing', unlockedAt: '2026-10-01T12:00:00Z' },
    { id: 'b', feature: 'status', name: 'Long road', description: hint }
  ] })
  await mount(CharacterSheet)
  const tiles = [...host.querySelectorAll<HTMLElement>('.achv-grid [role="listitem"]')]
  expect(tiles.map((t) => [...t.children].map((c) => c.className))).toEqual([['achv-pin', 'achv-ico', 'achv-tname', 'achv-tdesc'], ['achv-ico', 'achv-tname', 'achv-tdesc']])
  expect(tiles.map((t) => t.tabIndex)).toEqual([0, -1])
  expect(tiles[1].querySelector('.achv-tdesc')?.textContent).toBe(hint)
  await act(async () => tiles[0].focus())
  expect(document.querySelector('.achv-tip')?.textContent).toContain('First landing')
  await act(async () => tiles[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  expect(document.activeElement).toBe(tiles[1])
  expect(tiles[1].tabIndex).toBe(0)
  const tip = document.querySelector('.achv-tip')!
  expect(tip.textContent).toContain(hint)
  expect(tip.textContent).toContain('Locked')
  await act(async () => tiles[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.achv-tip')).toBeNull()
  await act(async () => tiles[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  expect(document.querySelector('.achv-tip')?.textContent).toContain(hint)
})
