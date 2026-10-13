// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { ChatPanel } from '../src/renderer/src/views/Comms'

const f = vi.hoisted(() => ({ messages: [] as ChatMessage[], calm: true, activity: 'ready' }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) =>
    select({ snap: { wksps: [{ name: 'ally', activity: f.activity }], allies: [] }, chats: { ally: f.messages }, settings: { calm: f.calm } }),
  api: () => ({}), loadChat: vi.fn(), toast: vi.fn(), errText: String, saveSettings: vi.fn()
}))
vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))

let host: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  f.messages = []; f.calm = true; f.activity = 'ready'
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove() })

const tool = { id: 't1', name: 'Bash', input: '{"command":"ls"}', result: 'ok' }
const genio = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, wksp: 'ally', role: 'genio', text, ts: '2026-10-13T22:05:00Z', ...extra })
const headers = () => [...host.querySelectorAll('.msg.genio:not(.working) .msg-meta')].map(e => e.textContent)
const render = () => act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally' })))

it('drops tool-only turns entirely in Clean HUD, header and timestamp included', async () => {
  f.messages = [
    genio('a', 'Starting the build.'),
    genio('b', '', { tools: [tool] }),
    genio('c', '  ', { tools: [tool, { ...tool, id: 't2' }] }),
    genio('d', '', { partial: true }),
    { id: 'w', wksp: 'ally', role: 'wake', text: 'unit pinged', ts: '2026-10-13T22:05:00Z' },
    genio('e', 'Done.', { tools: [tool] })
  ]
  await render()
  expect(host.querySelectorAll('.msg.genio:not(.working)')).toHaveLength(2)
  expect(headers()).toHaveLength(2)
  expect(host.querySelector('.msg-wake')).toBeNull()
  expect(host.querySelector('.tool-traces')).toBeNull()
  expect(host.textContent).toContain('Starting the build.')
  expect(host.textContent).toContain('Done.')
})

it('keeps the header on mixed text-and-tool turns and on image-only turns', async () => {
  f.messages = [
    genio('mixed', 'Ran the tests.', { tools: [tool] }),
    genio('img', '', { images: [{ file: 'a.png', mime: 'image/png' } as never] })
  ]
  await render()
  expect(headers()).toHaveLength(2)
  expect(host.querySelector('.tool-traces')).toBeNull()
})

it('keeps the activity indicator while hidden tool turns stream', async () => {
  f.activity = 'tool'
  f.messages = [genio('a', 'On it.'), genio('b', '', { tools: [tool], partial: true })]
  await render()
  expect(headers()).toHaveLength(1)
  expect(host.querySelector('.msg.genio.working')).not.toBeNull()
})

it('shows tool-only turns with their header when Clean HUD is off', async () => {
  f.calm = false
  f.messages = [genio('a', 'Starting.'), genio('b', '', { tools: [tool] })]
  await render()
  expect(headers()).toHaveLength(2)
  expect(host.querySelectorAll('.tool-traces')).toHaveLength(1)
})
