// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, Task } from '../src/shared/types'
import { Roster } from '../src/renderer/src/components/SquadPanel'
import { Squad } from '../src/renderer/src/views/Squad'
import { Quests } from '../src/renderer/src/views/Quests'
import { getState, setState } from '../src/renderer/src/store'

// A Generator is magenta at work on every Squad surface, with its own chip; ready, done and errors
// follow the same rules as every unit.
const initial = getState()
let root: Root, host: HTMLDivElement
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, kind: 'ship', state: 'working', project: 'world', generator: true,
  backlogId: `q-${id}`, createdAt: '2026-10-16T09:00:00Z', updatedAt: '2026-10-16T10:00:00Z', ...patch } as Task)
const quest = (t: Task): BacklogItem => ({ id: `q-${t.id}`, title: t.id, kind: t.kind, notes: '', state: 'in-flight', taskId: t.id, generator: t.generator,
  priority: 'normal', dependsOn: [], tags: [], createdAt: t.createdAt, updatedAt: t.updatedAt, project: 'world' })
const tasks = [
  task('gen-working'),
  task('gen-asks', { state: 'needs-decision', createdAt: '2026-10-16T08:00:00Z' }),
  task('gen-ready', { state: 'ready', readyAt: '2026-10-16T10:00:00Z', createdAt: '2026-10-16T07:00:00Z' }),
  task('modeller-working', { generator: undefined, modeller: true }),
  task('build-working', { generator: undefined }),
  task('gen-failed', { state: 'failed', createdAt: '2026-10-16T06:00:00Z' })
]

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { on: () => () => {}, api: new Proxy({}, { get: () => async () => undefined }) } })
  setState({ ...initial, snap: { ...initial.snap, tasks, backlog: tasks.map(quest) } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

const color = (el: Element | null | undefined): string | undefined =>
  el?.getAttribute('style')?.match(/var\(--([a-z-]+)\)/)?.[1]

it('the Squad rail shows a working Generator in magenta and names it Generator', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  const rows = [...host.querySelectorAll('.roster-active .roster-row')].map((r) => [
    r.querySelector('.roster-title')?.textContent, color(r.querySelector('.dot')), r.querySelector('.roster-state')?.textContent,
    r.querySelector('.roster-sub')?.textContent?.split(' · ')[0].trim()
  ])
  expect(rows).toEqual([
    ['gen-working', 'magenta', 'WORKING', 'Generator'],
    ['gen-asks', 'magenta', 'WORKING', 'Generator'],
    ['gen-ready', 'volt', 'READY TO MERGE', 'Generator'],
    ['modeller-working', 'orange', 'WORKING', 'Modeller'],
    ['build-working', 'blue', 'WORKING', 'Build']
  ])
})

it('the Squad page card is magenta with the Generator kind, and keeps its terminal slot (no model view)', async () => {
  await act(async () => root.render(React.createElement(Squad)))
  const cards = Object.fromEntries([...host.querySelectorAll('.unit-card')].map((c) => [
    c.querySelector('.unit-title')?.textContent,
    [c.className, c.querySelector('.unit-kind')?.textContent, c.querySelector('.unit-state .chip')?.className, !!c.querySelector('.modeller-card')]
  ]))
  expect(cards['gen-working']).toEqual(['unit-card panel tone-magenta generator', 'Generator', 'chip magenta', false])
  expect(cards['gen-asks']).toEqual(['unit-card panel tone-magenta generator attention', 'Generator', 'chip magenta', false])
  expect(cards['gen-ready']).toEqual(['unit-card panel tone-volt generator', 'Generator', 'chip volt', false])
  expect(cards['modeller-working'][0]).toBe('unit-card panel tone-orange modeller')
  expect(cards['build-working'][0]).toBe('unit-card panel tone-blue')
})

it('the Quest log colors a Generator in flight magenta and gives it the Generator chip', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  const cards = Object.fromEntries([...host.querySelectorAll('.qk-flight')].map((c) => [
    c.querySelector('.quest-title')?.textContent,
    [color(c), c.querySelector('.qk-state-label')?.textContent, c.querySelector('.quest-meta .chip')?.className, c.querySelector('.quest-meta .chip')?.textContent]
  ]))
  expect(cards['gen-working']).toEqual(['magenta', 'WORKING', 'chip magenta', 'Generator'])
  expect(cards['gen-ready']).toEqual(['volt', 'READY TO MERGE', 'chip magenta', 'Generator'])
  expect(cards['modeller-working']).toEqual(['orange', 'WORKING', 'chip orange', 'Modeller'])
  expect(cards['build-working'][0]).toBe('blue')
})

it('the unit page header carries the magenta Generator chip and keeps the terminal as the main area', async () => {
  setState({ focus: { type: 'task', id: 'gen-working' } })
  await act(async () => root.render(React.createElement(Squad)))
  const chip = host.querySelector('.uh-row > .chip')
  expect([chip?.className, chip?.textContent?.trim()]).toEqual(['chip magenta', 'Generator'])
  expect(chip?.querySelector('svg')).not.toBeNull()
  expect(host.querySelector('.detail-canvas')).toBeNull()
  expect([...host.querySelectorAll('[role=tab]')].map((t) => t.textContent)).not.toContain('Model')
  expect([...host.querySelectorAll('[role=tab]')].map((t) => t.textContent)).not.toContain('Steps')
})
