// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, Task } from '../src/shared/types'
import { Roster } from '../src/renderer/src/components/SquadPanel'
import { Squad } from '../src/renderer/src/views/Squad'
import { Quests } from '../src/renderer/src/views/Quests'
import { getState, setState } from '../src/renderer/src/store'

// One color rule on every Squad surface: purple Recon and blue Build at work, green ready,
// red error, and yellow only as the separate "needs you" indicator.
const initial = getState()
let root: Root, host: HTMLDivElement
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, kind: 'ship', state: 'working', project: 'world',
  backlogId: `q-${id}`, createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T10:00:00Z', ...patch } as Task)
const quest = (t: Task): BacklogItem => ({ id: `q-${t.id}`, title: t.id, kind: t.kind, notes: '', state: 'in-flight', taskId: t.id,
  priority: 'normal', dependsOn: [], tags: [], createdAt: t.createdAt, updatedAt: t.updatedAt, project: 'world' })
const tasks = [
  task('recon-working', { kind: 'scout' }),
  task('build-working'),
  task('recon-asks', { kind: 'scout', state: 'needs-decision', createdAt: '2026-10-13T08:00:00Z' }),
  task('build-blocked', { state: 'blocked', createdAt: '2026-10-13T08:00:00Z' }),
  task('build-ready', { state: 'ready', readyAt: '2026-10-13T10:00:00Z', createdAt: '2026-10-13T07:00:00Z' }),
  task('recon-failed', { kind: 'scout', state: 'failed', createdAt: '2026-10-13T06:00:00Z' })
]

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // views poll side panels (plan meter, crew state); they answer nothing here
  Object.assign(window, { genio: { on: () => () => {}, api: new Proxy({}, { get: () => async () => undefined }) } })
  setState({ ...initial, snap: { ...initial.snap, tasks, backlog: tasks.map(quest) } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

const color = (el: Element | null | undefined): string | undefined =>
  el?.getAttribute('style')?.match(/var\(--([a-z-]+)\)/)?.[1]

it('colors the Squad rail by kind and flags attention with a yellow indicator', async () => {
  await act(async () => root.render(React.createElement(Roster)))
  const rows = [...host.querySelectorAll('.roster-active .roster-row')].map((r) => [
    r.querySelector('.roster-title')?.textContent,
    color(r.querySelector('.dot')),
    r.querySelector('.roster-state')?.textContent,
    color(r.querySelector('.roster-state')),
    !!r.querySelector('.needs-you.amber')
  ])
  expect(rows).toEqual([
    ['recon-working', 'violet', 'WORKING', 'violet', false],
    ['build-working', 'blue', 'WORKING', 'blue', false],
    ['recon-asks', 'violet', 'WORKING', 'violet', true],
    ['build-blocked', 'blue', 'WORKING', 'blue', true],
    ['build-ready', 'volt', 'READY TO MERGE', 'volt', false]
  ])
  const done = host.querySelector('.roster-done .roster-row')
  expect([done?.querySelector('.roster-title')?.textContent, color(done?.querySelector('.roster-state'))]).toEqual(['recon-failed', 'alert'])
})

it('snapshots the Squad page card class names', async () => {
  await act(async () => root.render(React.createElement(Squad)))
  const cards = Object.fromEntries([...host.querySelectorAll('.unit-card')].map((c) => [
    c.querySelector('.unit-title')?.textContent,
    [c.className, c.querySelector('.unit-state .chip')?.className, c.querySelector('.unit-state .chip')?.textContent,
      c.querySelector('.needs-you')?.className ?? null]
  ]))
  expect(cards).toMatchInlineSnapshot(`
    {
      "build-blocked": [
        "unit-card panel tone-blue attention",
        "chip blue",
        "WORKING",
        "chip amber needs-you",
      ],
      "build-ready": [
        "unit-card panel tone-volt",
        "chip volt",
        "READY TO MERGE",
        null,
      ],
      "build-working": [
        "unit-card panel tone-blue",
        "chip blue",
        "WORKING",
        null,
      ],
      "recon-asks": [
        "unit-card panel tone-violet recon attention",
        "chip violet",
        "WORKING",
        "chip amber needs-you",
      ],
      "recon-working": [
        "unit-card panel tone-violet recon",
        "chip violet",
        "WORKING",
        null,
      ],
    }
  `)
})

it('colors Quest log In flight cards from the same function', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  const cards = Object.fromEntries([...host.querySelectorAll('.qk-flight')].map((c) => [
    c.querySelector('.quest-title')?.textContent,
    [c.className, color(c), c.querySelector('.qk-state-label')?.textContent, !!c.querySelector('.needs-you.amber')]
  ]))
  expect(cards).toMatchInlineSnapshot(`
    {
      "build-blocked": [
        "quest qk-ticket qk-flight panel attention",
        "blue",
        "WORKING",
        true,
      ],
      "build-ready": [
        "quest qk-ticket qk-flight panel",
        "volt",
        "READY TO MERGE",
        false,
      ],
      "build-working": [
        "quest qk-ticket qk-flight panel",
        "blue",
        "WORKING",
        false,
      ],
      "recon-asks": [
        "quest qk-ticket qk-flight panel attention",
        "violet",
        "WORKING",
        true,
      ],
      "recon-failed": [
        "quest qk-ticket qk-flight panel failed",
        "alert",
        "UNIT FAILED",
        false,
      ],
      "recon-working": [
        "quest qk-ticket qk-flight panel",
        "violet",
        "WORKING",
        false,
      ],
    }
  `)
})
