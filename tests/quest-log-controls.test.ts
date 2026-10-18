// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BacklogItem } from '../src/shared/types'
import { Quests } from '../src/renderer/src/views/Quests'
import { getState, setState } from '../src/renderer/src/store'

// The Quest log has no add bar and no editors: the chat adds and changes quests. A standalone quest keeps
// Dispatch, Drop and Priority on its card and in its details; a plan step has none of them (they belong to its plan).
const initial = getState()
let root: Root, host: HTMLDivElement
const calls: [string, unknown[]][] = []
const T0 = '2026-10-18T09:00:00.000Z'
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: T0, updatedAt: T0, project: 'world', ...patch
})

beforeEach(() => {
  calls.length = 0
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const api = new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => { if (String(name).startsWith('backlog')) calls.push([String(name), args]); return { ok: true } } })
  Object.assign(window, { genio: { on: () => () => {}, api } })
  setState({ ...initial, snap: { ...initial.snap, tasks: [], backlog: [
    quest('solo', { notes: 'Make it bounce' }),
    quest('held', { hold: { reason: 'Which jump height?', since: T0 } }),
    quest('step', { planId: 'plan-1' })
  ] } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState(initial) })

const card = (title: string): Element =>
  [...host.querySelectorAll('.qk-ticket')].find((c) => c.querySelector('.quest-title')?.textContent === title)!
const buttons = (el: ParentNode): string[] => [...el.querySelectorAll('button')].map((b) => b.textContent!.trim())
const click = (el: Element): Promise<void> => act(async () => { (el as HTMLElement).click() })

it('has no add bar', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  expect(host.querySelector('.quest-add, input')).toBeNull()
})

it('puts Dispatch and Drop on standalone cards only, and disables Dispatch while a quest waits', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  expect(buttons(card('solo'))).toEqual(['Dispatch', 'Drop'])
  expect(buttons(card('step'))).toEqual([])
  const held = card('held').querySelector('button')!
  expect([held.textContent!.trim(), held.disabled, held.title]).toEqual(['Dispatch', true, 'Which jump height?'])

  await click(card('solo').querySelector('button')!)
  await click([...card('solo').querySelectorAll('button')][1])
  expect(calls).toEqual([['backlogDispatch', ['solo', false]], ['backlogUpdate', ['solo', { state: 'dropped' }]]])
  expect(document.querySelector('.modal')).toBeNull()
})

it('shows a standalone quest read-only apart from Priority, Drop and Dispatch', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  await click(card('solo'))
  const modal = document.querySelector('.modal')!
  expect(modal.querySelectorAll('input, textarea').length).toBe(0)
  expect(modal.textContent).toContain('Make it bounce')
  expect(buttons(modal).filter((b) => b !== '×' && b !== '')).toEqual(expect.arrayContaining(['Drop', 'Dispatch']))
  expect(buttons(modal)).not.toContain('Save')
  const select = modal.querySelector('select')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'high')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(calls).toEqual([['backlogUpdate', ['solo', { priority: 'high' }]]])
})

it('shows a plan step with no controls at all', async () => {
  await act(async () => root.render(React.createElement(Quests)))
  await click(card('step'))
  const modal = document.querySelector('.modal')!
  expect(modal.querySelectorAll('input, textarea, select').length).toBe(0)
  expect(buttons(modal)).not.toContain('Drop')
  expect(buttons(modal)).not.toContain('Dispatch')
  expect(modal.querySelector('.prio-label')?.textContent).toBe('Normal')
})
