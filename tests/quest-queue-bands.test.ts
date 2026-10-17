// @vitest-environment jsdom
/**
 * Queued column: empty priority bands stay hidden, and all four appear as drop
 * targets only while a ticket is being dragged.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BacklogItem } from '../src/shared/types'
import { QueuedColumn } from '../src/renderer/src/views/Quests'

const T0 = '2026-10-13T10:00:00.000Z'
const quest = (id: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({
  id, title: id, kind: 'ship', notes: '', state: 'queued', priority: 'normal', dependsOn: [], tags: [],
  createdAt: T0, updatedAt: T0, project: 'world', ...patch
})

let root: Root, host: HTMLDivElement
const backlogReorder = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { genio: { api: { backlogReorder } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  backlogReorder.mockClear()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

const render = (queue: BacklogItem[]): Promise<void> =>
  act(async () => { root.render(React.createElement(QueuedColumn, { queue, chipsFor: () => [], onOpen: () => undefined })) })
const bands = (): string[] => [...host.querySelectorAll('.qk-band')].map((b) => b.querySelector('.prio-label')!.textContent!)
const fire = (el: Element, type: string): Promise<void> => act(async () => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: '' } })
  el.dispatchEvent(e)
  await new Promise((r) => setTimeout(r, 0))
})

it('shows a single empty state instead of four empty bands', async () => {
  await render([])
  expect(bands()).toEqual([])
  expect(host.textContent).toContain('Nothing queued')
})

it('hides empty priority bands', async () => {
  await render([quest('a', { priority: 'high' })])
  expect(bands()).toEqual(['High'])
  await render([quest('a', { priority: 'critical' }), quest('b'), quest('c', { priority: 'low' }), quest('d', { priority: 'high' })])
  expect(bands()).toEqual(['Critical', 'High', 'Normal', 'Low'])
  expect(host.querySelectorAll('.qk-band.vacant').length).toBe(0)
  expect(host.textContent).not.toContain('Nothing queued')
})

it('shows every band as a drop target mid-drag and hides the empty ones on drop or cancel', async () => {
  await render([quest('a'), quest('b')])
  expect(bands()).toEqual(['Normal'])

  await fire(host.querySelector('.qk-drag')!, 'dragstart')
  expect(bands()).toEqual(['Critical', 'High', 'Normal', 'Low'])
  const empty = [...host.querySelectorAll('.qk-band.vacant')]
  expect(empty.length).toBe(3)
  expect(empty.every((b) => b.textContent!.includes('Drop here'))).toBe(true)

  const critical = host.querySelector('.qk-band.p-critical')!
  await fire(critical, 'dragover')
  expect(critical.classList.contains('drop-end')).toBe(true)
  await fire(critical, 'drop')
  expect(backlogReorder).toHaveBeenCalledWith([{ id: 'a', priority: 'critical', rank: 1 }])
  expect(bands()).toEqual(['Normal'])

  // cancelled drag: dragend without a drop
  await fire(host.querySelector('.qk-drag')!, 'dragstart')
  expect(bands().length).toBe(4)
  await fire(host.querySelector('.qk-drag')!, 'dragend')
  expect(bands()).toEqual(['Normal'])
  expect(backlogReorder).toHaveBeenCalledTimes(1)
})
