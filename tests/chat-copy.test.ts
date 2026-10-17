// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { CopyMessageButton } from '../src/renderer/src/components/CopyMessageButton'
import { ChatPanel } from '../src/renderer/src/views/Comms'
import { clock } from '../src/renderer/src/lib/format'

const f = vi.hoisted(() => ({ write: vi.fn(), toast: vi.fn(), unqueue: vi.fn(), messages: [] as ChatMessage[] }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WINDOW: undefined,
  PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) => select({ snap: { wksps: [], allies: [] }, chats: { ally: f.messages }, settings: undefined }),
  api: () => ({ unqueueChat: f.unqueue }), loadChat: vi.fn(), toast: f.toast, errText: String
}))
vi.mock('../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))

let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: f.write } })
  f.write.mockReset().mockResolvedValue(undefined); f.toast.mockReset(); f.unqueue.mockReset(); f.messages = []
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

it.each(['screen', 'panel'] as const)('copies each displayed message on %s without cost labels or interfering with the queue', async (surface) => {
  const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({ id, wksp: 'ally', role, text, ts: '2026-10-13T12:00:00Z', costUsd: 0.123 })
  f.messages = [
    message('player', 'player', 'Player\nmessage'),
    message('genio', 'genio', '**Assistant**\nreply'),
    message('wake', 'wake', 'Wake\nfull details'),
    message('system', 'system', 'System message'),
    message('error', 'error', 'Error message'),
    message('routed', 'system', '[FROM GENIO MAIN corr=abc-1]\nBuild this\n\nWhen finished (or blocked), answer with report_to_main details'),
    { ...message('queued', 'player', 'Queued message'), queue: 'queued' },
    message('empty', 'genio', '')
  ]
  await act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally', surface })))
  expect(host.textContent).not.toContain('$')
  expect(host.querySelector('[data-msg="genio"] .msg-meta')?.textContent?.trim()).toBe(`Genio · ${clock(f.messages[1].ts)}`)
  expect(f.messages.every(m => m.costUsd === 0.123)).toBe(true)
  const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-label="Copy message"]')
  expect(buttons).toHaveLength(7)
  for (const button of buttons) await act(async () => button.click())
  expect(f.write.mock.calls.map(c => c[0])).toEqual(['Player\nmessage', '**Assistant**\nreply', 'Wake\nfull details', 'System message', 'Error message', 'Build this', 'Queued message'])
  expect(f.unqueue).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="Cancel queued message"]')).not.toBeNull()
})
