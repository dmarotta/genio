// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Ally } from '../src/shared/types'

vi.hoisted(() => window.history.replaceState(null, '', '/?project=founders-of-avalon&wksp=founders-of-avalon'))
vi.mock('../src/renderer/src/views/Systems', () => ({
  ModelSelect: ({ title }: { title: string }) => React.createElement('select', { title, 'aria-label': 'Model' }),
  EffortSelect: ({ title }: { title: string }) => React.createElement('select', { title, 'aria-label': 'Effort' })
}))
import { ChatPanel } from '../src/renderer/src/views/Comms'
import { GenioPanel } from '../src/renderer/src/components/GenioPanel'
import { PermissionPrompt } from '../src/renderer/src/components/Overlays'
import { getState, setState } from '../src/renderer/src/store'
import { publishScreenContext } from '../src/renderer/src/lib/screen-context'

const PROJECT = 'founders-of-avalon'
const initial = getState()
let root: Root, host: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  Object.defineProperties(host, { clientWidth: { value: 1200 }, clientHeight: { value: 700 } })
  const ally: Ally = { name: PROJECT, projects: [PROJECT], scope: `All work in ${PROJECT}`, charter: '', home: '/fixture', createdAt: '2026-10-14' }
  setState({ ...initial, view: 'inventory', chatLoaded: { [PROJECT]: true }, settings: { gamertag: 'Dani' } as never,
    snap: { ...initial.snap, allies: [ally], wksps: [{ name: PROJECT, displayName: PROJECT, activity: 'thinking', costUsd: 0, turns: 0, queued: 0 }] },
    chats: { [PROJECT]: [{ id: 'reply', wksp: PROJECT, role: 'genio', text: 'Ready to build.', ts: '2026-10-14T12:00:00Z' }] } })
  publishScreenContext('inventory', { world: PROJECT })
})
afterEach(async () => {
  await act(() => root.unmount()); host.remove(); setState(initial); publishScreenContext('inventory', undefined); vi.restoreAllMocks()
})

it('snapshots the project chat identity, including busy and idle placeholders, independently of saved display names', async () => {
  await act(() => root.render(React.createElement(ChatPanel, { wksp: PROJECT })))
  const receipt = host.querySelector('.msg.genio .msg-meta')!.textContent!
  expect({
    header: host.querySelector('.chat-title')!.textContent,
    indicator: host.querySelector('.working-text')!.textContent,
    messageSpeaker: receipt.split(' · ')[0],
    placeholder: host.querySelector('textarea')!.placeholder,
    recapTooltip: host.querySelector<HTMLButtonElement>('.quick .link-btn')!.title
  }).toMatchInlineSnapshot(`
    {
      "header": "Genio",
      "indicator": "Genio is on it",
      "messageSpeaker": "Genio",
      "placeholder": "Genio is working… you can still send; it queues and is read next.",
      "recapTooltip": "Genio is working",
    }
  `)
  expect(host.querySelector('[aria-label="Model"]')!.getAttribute('title')).toContain('Genio model')
  expect(host.querySelector('[aria-label="Effort"]')!.getAttribute('title')).toContain('Genio effort')
  await act(() => {
    const s = getState()
    setState({ snap: { ...s.snap, wksps: s.snap.wksps.map(m => ({ ...m, activity: 'idle' })) }, chats: { [PROJECT]: [] } })
  })
  expect(host.querySelector('textarea')!.placeholder).toMatchInlineSnapshot(`"Message Genio  ·  it answers you here"`)
  expect(host.querySelector('.chat-empty h2')?.textContent?.trim()).toBe('Genio')
  expect(host.textContent).not.toContain(PROJECT)
})

it('snapshots the floating panel title and preserves the project only in the native pop-out title and context', async () => {
  await act(() => root.render(React.createElement(GenioPanel)))
  expect(host.querySelector('.genio-panel-grip')!.textContent).toMatchInlineSnapshot(`" Genio · Inventory"`)
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentWindow!
  child.document.body.innerHTML = '<div id="root"></div>'
  vi.spyOn(window, 'open').mockReturnValue(child)
  vi.spyOn(child, 'close').mockImplementation(() => {})
  try {
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Pop out Genio chat"]')!.click())
    await act(() => child.dispatchEvent(new Event('load')))
    expect(child.document.title).toBe('Genio - founders-of-avalon (Chat)')
    expect(child.document.querySelector('.popout-bar span')!.textContent).toBe('Genio · Inventory · Always on top')
    expect(child.document.querySelector('.msg.genio .msg-meta')!.textContent!.split(' · ')[0]).toBe('Genio')
    await act(() => [...child.document.querySelectorAll('button')].find(b => b.textContent === 'Return chat')!.click())
  } finally { frame.remove() }
})

it('labels project permission requests as Genio while retaining their routing key', async () => {
  setState({ permissions: [{ id: 'permission', wksp: PROJECT, tool: 'Bash', input: 'npm test', ts: '2026-10-14' }] })
  await act(() => root.render(React.createElement(PermissionPrompt)))
  expect(document.querySelector('.modal-head .label')!.textContent).toBe('Access request · Genio')
  expect(getState().permissions[0].wksp).toBe(PROJECT)
})

it('names Genio in the receipt when a project message has already been picked up', async () => {
  const previous = window.genio
  window.genio = { api: { unqueueChat: vi.fn(async () => null) } } as never
  setState({ chats: { [PROJECT]: [{ id: 'queued', wksp: PROJECT, role: 'player', text: 'Build the castle', queue: 'queued', ts: '2026-10-14T12:00:00Z' }] } })
  try {
    await act(() => root.render(React.createElement(ChatPanel, { wksp: PROJECT })))
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Cancel queued message"]')!.click())
    expect(getState().toasts.at(-1)?.body).toBe('Genio picked that message up before it could be changed.')
  } finally { window.genio = previous }
})
