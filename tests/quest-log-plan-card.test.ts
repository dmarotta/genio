// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem, PlanStep, WorkPlan } from '../src/shared/types'
import { Quests } from '../src/renderer/src/views/Quests'
import { getState, setState } from '../src/renderer/src/store'

// A plan is one card on the Quest log with Dispatch, Drop (one confirmation) and Priority; its step quests are not cards.
const initial = getState()
let root: Root, host: HTMLDivElement
const calls: [string, unknown[]][] = []
const T0 = '2026-10-18T09:00:00.000Z'
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: T0, updatedAt: T0, project: 'world', ...patch
})
const step = (key: string, index: number, after: string[] = []): PlanStep => ({
  key, index, questId: `q-${key}`, title: `Step ${key}`, kind: 'ship', spec: '', after, files: [], acceptance: '', taskIds: []
})
const plan = (patch: Partial<WorkPlan> = {}): WorkPlan => ({
  id: 'plan-1', world: 'world', title: 'New Play', intent: 'x', state: 'paused', autoAdvance: true, maxParallel: 2, priority: 'high',
  steps: [step('a', 1), step('b', 2, ['a'])], createdAt: T0, updatedAt: T0, pause: { reason: 'paused by the player', at: T0 }, ...patch
})

function load(p: WorkPlan, extra: BacklogItem[] = []): void {
  setState({ ...initial, snap: { ...initial.snap, tasks: [], plans: [p], backlog: [
    quest('q-a', { planId: p.id, planStep: 'a', priority: p.priority }),
    quest('q-b', { planId: p.id, planStep: 'b', priority: p.priority, dependsOn: ['q-a'] }),
    quest('solo'), ...extra
  ] } })
}

beforeEach(() => {
  calls.length = 0
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const api = new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => { if (String(name).startsWith('plan')) calls.push([String(name), args]); return { ok: true } } })
  Object.assign(window, { genio: { on: () => () => {}, api } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

const cards = (): Element[] => [...host.querySelectorAll('.qk-ticket')]
const card = (title: string): Element => cards().find((c) => c.querySelector('.quest-title')?.textContent === title)!
const buttons = (el: ParentNode): string[] => [...el.querySelectorAll('button')].map((b) => b.textContent!.trim())
const click = (el: Element): Promise<void> => act(async () => { (el as HTMLElement).click() })

it('shows a plan as one card in its priority band, without its steps', async () => {
  load(plan())
  await act(async () => root.render(React.createElement(Quests)))
  expect(cards().map((c) => c.querySelector('.quest-title')?.textContent)).toEqual(['New Play', 'solo'])
  const c = card('New Play')
  expect(c.textContent).toContain('Plan')
  expect(c.textContent).toContain('0/2 merged · step 1 Step a')
  expect(c.closest('.qk-band')?.classList.contains('p-high')).toBe(true)
  expect(buttons(c)).toEqual(['Dispatch', 'Drop'])
})

it('Dispatch starts the plan; Drop asks once, then cancels it', async () => {
  load(plan())
  await act(async () => root.render(React.createElement(Quests)))
  await click(card('New Play').querySelector('button')!)
  expect(calls).toEqual([['planControl', ['plan-1', 'dispatch']]])
  calls.length = 0
  await click([...card('New Play').querySelectorAll('button')][1])
  expect(calls).toEqual([])
  expect(buttons(card('New Play'))).toContain('Drop the plan')
  await click([...card('New Play').querySelectorAll('button')][1])
  expect(calls).toEqual([['planControl', ['plan-1', 'cancel']]])
})

it('the dialog lists the steps read-only and sets the plan priority', async () => {
  load(plan())
  await act(async () => root.render(React.createElement(Quests)))
  await click(card('New Play'))
  const modal = document.querySelector('.modal')!
  expect([...modal.querySelectorAll('.plan-step')].map((s) => s.querySelector('.plan-title')?.textContent)).toEqual(['Step a', 'Step b'])
  expect(modal.querySelectorAll('input, textarea').length).toBe(0)
  expect(buttons(modal)).toEqual(expect.arrayContaining(['Drop', 'Dispatch']))
  const select = modal.querySelector('select')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'critical')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(calls).toEqual([['planPriority', ['plan-1', 'critical']]])
})

it('a finished plan is one Done card without controls', async () => {
  load(plan({ state: 'done', doneAt: T0, pause: undefined }))
  await act(async () => root.render(React.createElement(Quests)))
  const c = card('New Play')
  expect(c.closest('.col-done')).not.toBeNull()
  expect(buttons(c)).toEqual([])
})
