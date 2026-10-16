// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ally, ChatMessage, WkspInfo } from '../src/shared/types'
import type { SendNowResult } from '../src/shared/chat'

vi.hoisted(() => window.history.replaceState(null, '', '/?project=forest&wksp=forest'))
vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/ComingNext', () => ({ ComingNext: () => null }))
import { ChatPanel } from '../src/renderer/src/views/Comms'
import { GenioPanel } from '../src/renderer/src/components/GenioPanel'
import { getState, setState } from '../src/renderer/src/store'
import { setDraft } from '../src/renderer/src/drafts'
import { publishScreenContext } from '../src/renderer/src/lib/screen-context'

const WKSP = 'forest'
const initial = getState()
const api = { sendChat: vi.fn(async () => {}), steerChat: vi.fn(async () => {}), sendQueuedNow: vi.fn(async (): Promise<SendNowResult> => ({ ok: true })), unqueueChat: vi.fn(async () => null) }
let root: Root, host: HTMLDivElement, previous: typeof window.genio
const queued: ChatMessage = { id: 'q1', wksp: WKSP, role: 'player', text: 'then the moat', queue: 'queued', ts: '2026-10-16T12:00:00Z' }

function show(info: Partial<WkspInfo>, messages: ChatMessage[] = [queued]): void {
  const ally: Ally = { name: WKSP, projects: [WKSP], scope: '', charter: '', home: '/fixture', createdAt: '2026-10-16' }
  setState({ ...initial, view: 'inventory', chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Dani' } as never,
    snap: { ...initial.snap, allies: [ally], wksps: [{ name: WKSP, displayName: 'Genio', activity: 'thinking', costUsd: 0, turns: 0, queued: 1, ...info }] },
    chats: { [WKSP]: messages } })
}
const steerButton = () => [...host.querySelectorAll<HTMLButtonElement>('.composer button')].find(b => b.textContent?.includes('Steer'))
const sendButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!
const textarea = () => host.querySelector('textarea')!
const keys = () => host.querySelector('.composer-keys')!.textContent
const type = (value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value)
  textarea().dispatchEvent(new Event('input', { bubbles: true }))
}
const press = (init: KeyboardEventInit) => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  localStorage.clear()
  previous = window.genio
  window.genio = { api } as never
  for (const f of Object.values(api)) f.mockClear()
  api.sendQueuedNow.mockResolvedValue({ ok: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  publishScreenContext('inventory', { world: WKSP })
})
afterEach(async () => {
  await act(() => root.unmount()); host.remove(); setState(initial); setDraft(WKSP, '')
  publishScreenContext('inventory', undefined); window.genio = previous; vi.restoreAllMocks()
})

describe('the composer while Genio is busy', () => {
  it('shows Steer next to Send and the Ctrl+Enter hint only while a turn can be steered', async () => {
    show({ steerable: true })
    setDraft(WKSP, 'use stone')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(steerButton()).toBeDefined()
    expect(steerButton()!.nextElementSibling).toBe(sendButton())
    expect(keys()).toContain('Ctrl+Enter steer')
    expect(textarea().placeholder).toBe('Genio is working… Send queues it for next; Steer reads it now.')
    // the turn ended: the button and hint go with it
    await act(() => { const s = getState(); setState({ snap: { ...s.snap, wksps: s.snap.wksps.map(m => ({ ...m, activity: 'idle', steerable: false })) } }) })
    expect(steerButton()).toBeUndefined()
    expect(keys()).not.toContain('steer')
    // an event turn or the Bot's away turn: the session says whether steering applies, not the activity
    await act(() => { const s = getState(); setState({ snap: { ...s.snap, wksps: s.snap.wksps.map(m => ({ ...m, activity: 'tool', steerable: false })) } }) })
    expect(steerButton()).toBeUndefined()
  })

  it('Steer sends the draft once as a steering message, even on a double click', async () => {
    show({ steerable: true })
    setDraft(WKSP, 'use stone')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await act(async () => { steerButton()!.click(); steerButton()!.click() })
    expect(api.steerChat).toHaveBeenCalledTimes(1)
    expect(api.steerChat).toHaveBeenCalledWith(WKSP, 'use stone', undefined, undefined)
    expect(api.sendChat).not.toHaveBeenCalled()
    expect(textarea().value).toBe('')
  })

  it('Enter queues without interrupting; Ctrl+Enter steers', async () => {
    show({ steerable: true })
    setDraft(WKSP, 'later please')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await act(async () => { press({}) })
    expect(api.sendChat).toHaveBeenCalledWith(WKSP, 'later please', undefined, undefined)
    expect(api.steerChat).not.toHaveBeenCalled()
    await act(async () => type('now please'))
    await act(async () => { press({ ctrlKey: true }) })
    expect(api.steerChat).toHaveBeenCalledWith(WKSP, 'now please', undefined, undefined)
    expect(api.sendChat).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Enter with nothing to steer is a plain send', async () => {
    show({ activity: 'idle', steerable: false, queued: 0 }, [])
    setDraft(WKSP, 'hello')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    await act(async () => { press({ ctrlKey: true }) })
    expect(api.sendChat).toHaveBeenCalledWith(WKSP, 'hello', undefined, undefined)
    expect(api.steerChat).not.toHaveBeenCalled()
  })

  it('a queued message offers Send now beside edit and remove', async () => {
    show({ steerable: true })
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    const now = host.querySelector<HTMLButtonElement>('[aria-label="Send queued message now"]')!
    expect(now.textContent).toBe(' Send now')
    expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Cancel queued message"]')).not.toBeNull()
    await act(async () => now.click())
    expect(api.sendQueuedNow).toHaveBeenCalledWith(WKSP, 'q1')
    // steering right away: the turn stops, no toast needed
    expect(getState().toasts).toEqual([])
  })

  it('Send now always tells the player what happened: what it waits for, or why it cannot', async () => {
    show({ steerable: true })
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    const now = host.querySelector<HTMLButtonElement>('[aria-label="Send queued message now"]')!
    api.sendQueuedNow.mockResolvedValueOnce({ ok: true, note: 'Genio stops as soon as deploy finishes, then reads it first.' })
    await act(async () => now.click())
    expect(getState().toasts.at(-1)).toMatchObject({ title: 'Steering', body: 'Genio stops as soon as deploy finishes, then reads it first.' })
    api.sendQueuedNow.mockResolvedValueOnce({ ok: false, reason: 'Genio picked that message up already.' })
    await act(async () => now.click())
    expect(getState().toasts.at(-1)).toMatchObject({ title: 'Not sent now', body: 'Genio picked that message up already.' })
  })

  it('a steering message says so in place of Queued, without a second Send now', async () => {
    show({ steerable: true }, [{ ...queued, steering: true }])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(host.querySelector('.msg-queue')!.textContent).toBe('Steering · ')
    expect(host.querySelector('[aria-label="Send queued message now"]')).toBeNull()
    expect(host.querySelector('[aria-label="Edit queued message"]')).not.toBeNull()
  })

  it('an unsent message (after a restart) has no Send now', async () => {
    show({ activity: 'idle', steerable: false }, [{ ...queued, queue: 'unsent' }])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(host.querySelector('[aria-label="Send queued message now"]')).toBeNull()
  })

  it('the floating Genio panel offers the same Steer and Send now', async () => {
    show({ steerable: true })
    setDraft(WKSP, 'from the panel')
    await act(() => root.render(React.createElement(GenioPanel)))
    expect(host.querySelector('.genio-panel .chat-panel')).not.toBeNull()
    expect(steerButton()).toBeDefined()
    expect(host.querySelector('[aria-label="Send queued message now"]')).not.toBeNull()
    await act(async () => steerButton()!.click())
    // the panel's screen context travels with a steering message as with any other
    expect(api.steerChat).toHaveBeenCalledWith(WKSP, 'from the panel', undefined, expect.objectContaining({ world: WKSP, screen: expect.objectContaining({ id: 'inventory' }) }))
  })
})

describe("the composer's screen context", () => {
  it('goes with every message but renders nothing: no chip, no remove control, no empty strip', async () => {
    show({ activity: 'idle', steerable: false, queued: 0 }, [])
    const context = { world: WKSP, screen: { id: 'squad', label: 'Squad', facts: [{ label: 'Unit', value: 'Model a low poly racing car [model-a-low-poly-1]' }] } }
    setDraft(WKSP, 'make it green')
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP, context })))
    const composer = host.querySelector('.composer')!
    expect(composer.querySelector('.inventory-context')).toBeNull()
    expect(composer.textContent).not.toContain('Squad')
    expect(host.querySelector('[aria-label="Remove screen context"]')).toBeNull()
    // nothing sits above the input box
    expect(composer.firstElementChild?.classList.contains('composer-box')).toBe(true)
    await act(async () => { press({}) })
    expect(api.sendChat).toHaveBeenCalledWith(WKSP, 'make it green', undefined, context)
  })

  it('still shows the screen context on a sent message', async () => {
    const context = { world: WKSP, screen: { id: 'squad', label: 'Squad', facts: [{ label: 'Unit', value: 'Build HUD [t-1]' }] } }
    show({ activity: 'idle', steerable: false, queued: 0 }, [{ id: 'p1', wksp: WKSP, role: 'player', text: 'hi', ts: '2026-10-16T12:00:00Z', context }])
    await act(() => root.render(React.createElement(ChatPanel, { wksp: WKSP })))
    expect(host.querySelector('.chat-log .inventory-context-chip')?.textContent).toBe('Squad · Build HUD [t-1]')
  })
})