// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { CopyMessageButton } from '../src/renderer/src/components/CopyMessageButton'
import { ChatPanel } from '../src/renderer/src/views/Comms'
import { chatKey } from '../src/shared/chat'

const f = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn(), unqueue: vi.fn(), messages: [] as ChatMessage[], key: 'ally' }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: undefined,
  PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) => select({ snap: { wksps: [], allies: [] }, chats: { [f.key]: f.messages }, settings: undefined }),
  api: () => ({ unqueueChat: f.unqueue }), loadChat: vi.fn(), toast: f.toast, errText: String
}))
vi.mock('../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null }))

let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: f.write } })
  f.write.mockReset().mockResolvedValue(undefined); f.toast.mockReset(); f.unqueue.mockReset(); f.messages = []; f.key = 'ally'
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const copy = () => host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!

it('copies exact Markdown and whitespace, confirms success, and resets for another copy', async () => {
  const text = '  **Hello**\n\n```ts\nconst n = 1\n```\n'
  await act(() => root.render(React.createElement(CopyMessageButton, { text })))
  await act(async () => copy().click())
  expect(f.write).toHaveBeenCalledWith(text)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Message copied')
  expect(host.querySelector('[aria-label="Message copied"]')).not.toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(copy()).not.toBeNull()
  await act(async () => copy().click())
  expect(f.write).toHaveBeenCalledTimes(2)
})

it('waits for clipboard success and allows retry after a rejected write', async () => {
  let reject!: (e: Error) => void
  f.write.mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r }))
  await act(() => root.render(React.createElement(CopyMessageButton, { text: 'hello' })))
  await act(() => copy().click())
  expect(copy().disabled).toBe(true)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('')
  await act(async () => reject(new Error('Permission denied')))
  expect(f.toast).toHaveBeenCalledWith('error', 'Message not copied', 'Error: Permission denied')
  expect(copy().disabled).toBe(false)
  await act(async () => copy().click())
  expect(host.querySelector('[aria-label="Message copied"]')).not.toBeNull()
})

it('reports an unavailable clipboard without an unhandled rejection', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  await act(() => root.render(React.createElement(CopyMessageButton, { text: 'hello' })))
  await act(async () => copy().click())
  expect(f.toast).toHaveBeenCalledWith('error', 'Message not copied', expect.any(String))
  expect(copy().disabled).toBe(false)
})

const surfaces = [
  { name: 'project chat', props: { wksp: 'ally' } },
  { name: 'floating panel', props: { wksp: 'ally', surface: 'panel' as const } },
  { name: 'design chat', props: { wksp: 'ally', conversation: 'lore-1' } }
]

it.each(surfaces)('copies each displayed message in the $name without interfering with the queue', async ({ props }) => {
  const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, wksp: 'ally', role, text, ts: '2026-10-13T12:00:00Z' })
  f.key = chatKey(props.wksp, props.conversation)
  f.messages = [
    message('player', 'player', 'Player\nmessage'),
    message('genio', 'genio', '**Assistant**\nreply'),
    message('wake', 'wake', 'Wake\nfull details'),
    message('system', 'system', 'System message'),
    message('error', 'error', 'Error message'),
    { ...message('queued', 'player', 'Queued message'), queue: 'queued' },
    message('empty', 'genio', '')
  ]
  await act(() => root.render(React.createElement(ChatPanel, props)))
  const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-label="Copy message"]')
  expect(buttons).toHaveLength(6)
  expect([...buttons].every(b => b.title === 'Copy')).toBe(true)
  for (const button of buttons) await act(async () => button.click())
  expect(f.write.mock.calls.map(c => c[0])).toEqual(['Player\nmessage', '**Assistant**\nreply', 'Wake\nfull details', 'System message', 'Error message', 'Queued message'])
  expect(f.unqueue).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Cancel queued message"]')).not.toBeNull()
})

it('copies only the request of a message routed from Genio', async () => {
  f.messages = [{ id: 'routed', wksp: 'ally', role: 'system', text: '[FROM GENIO MAIN corr=abc-1]\nBuild this\n\nWhen finished (or blocked), answer with report_to_main details', ts: '2026-10-13T12:00:00Z' }]
  await act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally' })))
  await act(async () => copy().click())
  expect(f.write).toHaveBeenCalledWith('Build this')
})

it('copies a shell result as its command and output', async () => {
  f.messages = [{ id: 'sh', wksp: 'ally', role: 'system', text: '', ts: '2026-10-13T12:00:00Z', shell: { command: 'git status', cwd: '/w', output: 'clean', exitCode: 0, durationMs: 5, truncated: false } }]
  await act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally' })))
  await act(async () => copy().click())
  expect(f.write).toHaveBeenCalledWith('$ git status\nclean')
})
