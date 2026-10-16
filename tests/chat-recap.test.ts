// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatPanel } from '../src/renderer/src/views/Comms'

const f = vi.hoisted(() => ({ wksp: { name: 'ally', activity: 'ready', queued: 0 } as Record<string, unknown> | undefined, calm: false, recap: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: undefined,
  PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) =>
    select({ snap: { wksps: f.wksp ? [f.wksp] : [], allies: [] }, chats: { ally: [] }, settings: { calm: f.calm } }),
  api: () => ({ recap: f.recap }), op: (_label: string, fn: () => unknown) => fn(),
  loadChat: vi.fn(), toast: vi.fn(), errText: String, saveSettings: vi.fn()
}))
vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))

let host: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  f.wksp = { name: 'ally', activity: 'ready', queued: 0 }; f.calm = false; f.recap.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove() })

const render = () => act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally' })))
const recap = () => [...host.querySelectorAll<HTMLButtonElement>('.composer-hints .quick .link-btn')].find(b => b.textContent === 'Recap')

it('shows a small Recap link under the project chat composer, also in Clean HUD, and sends /recap', async () => {
  f.calm = true
  await render()
  const button = recap()!
  expect(button).toBeTruthy()
  expect(button.disabled).toBe(false)
  expect(host.textContent).not.toContain('Deploy')
  await act(() => button.click())
  expect(f.recap).toHaveBeenCalledOnce()
})

it.each([
  ['a turn is running', { activity: 'thinking' }],
  ['messages are queued', { queued: 1 }],
  ['the chat hit its limit', { limit: { provider: 'claude' } }]
])('disables Recap while %s', async (_case, patch) => {
  f.wksp = { ...f.wksp, ...patch }
  await render()
  expect(recap()!.disabled).toBe(true)
})

it('disables Recap when the chat is unavailable', async () => {
  f.wksp = undefined
  await render()
  expect(recap()!.disabled).toBe(true)
  expect(recap()!.title).toBe('Chat unavailable')
})
