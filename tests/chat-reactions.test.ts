// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { ChatPanel } from '../src/renderer/src/views/Comms'

const f = vi.hoisted(() => ({ react: vi.fn(), toast: vi.fn(), messages: [] as ChatMessage[] }))
vi.mock('../src/renderer/src/store', () => ({
  PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) => select({ snap: { wksps: [], allies: [] }, chats: { ally: f.messages }, settings: undefined }),
  api: () => ({ reactToMessage: f.react }), loadChat: vi.fn(), toast: f.toast, errText: String
}))
vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))

let host: HTMLDivElement, root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  f.react.mockReset().mockResolvedValue({}); f.toast.mockReset(); f.messages = []
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove() })

const genio = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, wksp: 'ally', role: 'genio', text: `Reply ${id}`, ts: '2026-10-13T12:00:00Z', ...extra })
const render = () => act(() => root.render(React.createElement(ChatPanel, { wksp: 'ally' })))
const within = (id: string) => host.querySelector<HTMLElement>(`[data-msg="${id}"]`)!
const button = (id: string, label: string) => within(id).querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

it('offers like and dislike on finished Genio messages only, as keyboard-reachable toggle buttons', async () => {
  f.messages = [
    genio('g1'),
    { ...genio('g2'), partial: true },
    { id: 'p1', wksp: 'ally', role: 'player', text: 'hello', ts: '2026-10-13T12:00:00Z' },
    { id: 's1', wksp: 'ally', role: 'system', text: 'note', ts: '2026-10-13T12:00:00Z' }
  ]
  await render()
  expect(host.querySelectorAll('[role="group"][aria-label="React to this message"]')).toHaveLength(1)
  const like = button('g1', 'Like')!, dislike = button('g1', 'Dislike')!
  for (const b of [like, dislike]) {
    expect(b.tagName).toBe('BUTTON')
    expect(b.type).toBe('button')
    expect(b.getAttribute('aria-pressed')).toBe('false')
    expect(b.title).toBeTruthy()
    b.focus()
    expect(document.activeElement).toBe(b)
  }
  expect(like.title).toContain('never approves a merge')
  expect(dislike.title).toContain('pauses what this message started')
  await act(async () => like.click())
  expect(f.react).toHaveBeenLastCalledWith('ally', 'g1', 'like')
  await act(async () => dislike.click())
  expect(f.react).toHaveBeenLastCalledWith('ally', 'g1', 'dislike')
})

it('re-clicking the reaction already set removes it; the other one replaces it', async () => {
  f.messages = [genio('g1', { reaction: { kind: 'like', at: '2026-10-13T12:00:01Z' } })]
  await render()
  expect(within('g1').querySelector('.msg-react.set')).not.toBeNull()
  expect(button('g1', 'Remove like')!.getAttribute('aria-pressed')).toBe('true')
  await act(async () => button('g1', 'Remove like')!.click())
  expect(f.react).toHaveBeenLastCalledWith('ally', 'g1', null)
  await act(async () => button('g1', 'Dislike')!.click())
  expect(f.react).toHaveBeenLastCalledWith('ally', 'g1', 'dislike')
})

it('shows what a dislike paused with a one-click undo, and reports a failed reaction', async () => {
  f.messages = [
    genio('g1', { reaction: { kind: 'dislike', at: '2026-10-13T12:00:01Z', pause: 'paused', choice: 'ch-1' }, reactionNote: 'Paused 2 units and 1 quest' }),
    genio('g2', { reaction: { kind: 'dislike', at: '2026-10-13T12:00:01Z', pause: 'grace' } }),
    genio('g3', { reactionNote: 'Resumed 2 units and 1 quest' })
  ]
  await render()
  const note = within('g1').querySelector('.msg-reaction-note')!
  expect(note.getAttribute('role')).toBe('status')
  expect(note.textContent).toContain('Paused 2 units and 1 quest')
  expect(within('g2').querySelector('.msg-reaction-note')?.textContent).toContain('Pausing what this started')
  expect(within('g3').querySelector('.msg-reaction-note')?.textContent).toContain('Resumed 2 units and 1 quest')
  expect(within('g3').querySelector('.msg-reaction-note button')).toBeNull()
  await act(async () => note.querySelector('button')!.click())
  expect(f.react).toHaveBeenLastCalledWith('ally', 'g1', null)
  f.react.mockRejectedValueOnce(new Error('Open a project window to use its chat.'))
  await act(async () => button('g3', 'Like')!.click())
  expect(f.toast).toHaveBeenCalledWith('error', 'Reaction not saved', 'Error: Open a project window to use its chat.')
})
