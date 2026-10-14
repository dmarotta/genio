// @vitest-environment jsdom
/**
 * Scroll-to-latest guard. jsdom has no layout, so the log gets a small fake one: every message
 * is MSG px tall until "laid out", when it grows to LAID px, the way content-visibility settles
 * off-screen messages after the first scroll. The browser then fires the scroll event of that
 * first scroll against the taller content and the ResizeObserver reports the new size.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'

vi.mock('../src/renderer/src/views/Systems', () => ({ ModelSelect: () => null, EffortSelect: () => null, requestSystemsSection: () => undefined }))

import { ChatPanel } from '../src/renderer/src/views/Comms'
import { getState, handleEvent, setState } from '../src/renderer/src/store'

const WKSP = 'genio'
const VIEWPORT = 600, MSG = 72, LAID = 180
const initial = getState()
let root: Root, host: HTMLDivElement
let height = MSG
const tops = new WeakMap<Element, number>()
const observers = new Set<() => void>()
const genio = (i: number): ChatMessage => ({ id: `m-${i}`, wksp: WKSP, role: 'genio', text: `Reply ${i}`, ts: '2026-10-14T06:00:00Z' })
const player = (i: number): ChatMessage => ({ id: `p-${i}`, wksp: WKSP, role: 'player', text: `Question ${i}`, ts: '2026-10-14T06:00:00Z' })
const transcript = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? player(i) : genio(i)))

const log = (): HTMLDivElement => host.querySelector('.chat-log') as HTMLDivElement
const rows = (el: Element): Element[] => [...(el.querySelector('.chat-log-body')?.children ?? [])]
const contentHeight = (el: Element): number => rows(el).length * height
const maxTop = (el: Element): number => Math.max(0, contentHeight(el) - VIEWPORT)
const atBottom = (): boolean => maxTop(log()) - log().scrollTop < 80
const jump = (): HTMLButtonElement | null => host.querySelector('.chat-jump')

/** Content-visibility settles: messages take their real height, then the browser reports scroll and resize. */
async function settle(): Promise<void> {
  height = LAID
  await act(async () => {
    log().dispatchEvent(new Event('scroll'))
    for (const fire of observers) fire()
  })
}
async function mount(): Promise<void> {
  height = MSG
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(React.createElement(ChatPanel, { wksp: WKSP })) })
}
async function unmount(): Promise<void> {
  await act(async () => root.unmount()); host.remove()
}
/** The player scrolls by hand (wheel), to `top`. */
async function wheelTo(top: number): Promise<void> {
  await act(async () => {
    log().dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
    log().scrollTop = top
    log().dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { cb: () => void; constructor(cb: () => void) { this.cb = cb } observe() { observers.add(this.cb) } disconnect() { observers.delete(this.cb) } }
  })
  const proto = HTMLElement.prototype
  vi.spyOn(proto, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat-log') ? Math.max(VIEWPORT, contentHeight(this)) : 0 })
  vi.spyOn(proto, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('chat-log') ? VIEWPORT : 0 })
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return tops.get(this) ?? 0 },
    set(this: HTMLElement, v: number) { tops.set(this, this.classList.contains('chat-log') ? Math.min(Math.max(0, v), maxTop(this)) : 0) }
  })
  vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const el = this.closest('.chat-log')
    const top = !el || el === this ? 0 : rows(el).indexOf(this) * height - el.scrollTop
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  setState({ ...initial, chats: { [WKSP]: transcript(300) }, chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Dani', calm: false } as never,
    snap: { ...initial.snap, wksps: [{ name: WKSP, displayName: 'Genio', activity: 'idle', costUsd: 0, turns: 0, queued: 0 }] } })
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
  observers.clear()
  setState(initial)
})

it('lands on the latest message of a long transcript once late layout settles', async () => {
  await mount()
  expect(atBottom()).toBe(true)
  await settle()
  expect(log().scrollTop).toBe(maxTop(log()))
  expect(jump()).toBeNull()
  await unmount()
})

it('lands on the latest message when the history arrives after the chat opened', async () => {
  setState({ chats: { [WKSP]: [] } })
  await mount()
  await act(async () => { setState({ chats: { [WKSP]: transcript(320) } }) })
  expect(atBottom()).toBe(true)
  await settle()
  expect(log().scrollTop).toBe(maxTop(log()))
  await unmount()
})

it('lands on the latest message again when returning to the chat, while a reply streams', async () => {
  await mount(); await settle()
  await unmount()
  await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: 'streaming ' }) })
  await mount()
  await settle()
  expect(log().scrollTop).toBe(maxTop(log()))
  for (let i = 0; i < 5; i++) await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: `tok${i} ` }) })
  await act(async () => { handleEvent({ type: 'chat', message: genio(999) }) })
  expect(log().scrollTop).toBe(maxTop(log()))
  await unmount()
})

it('keeps a deliberate scroll-up across leaving and returning, without yanking, and jumps back on request', async () => {
  await mount(); await settle()
  await wheelTo(20 * LAID + 30)
  expect(jump()).not.toBeNull()
  const before = log().scrollTop
  await act(async () => { handleEvent({ type: 'chat', message: genio(1000) }) })
  expect(log().scrollTop).toBe(before)
  await unmount()

  // back on the Chat screen: the same message is at the top, laid out at placeholder height first
  await mount()
  const top = rows(log()).find(r => r.getBoundingClientRect().bottom > 0) as HTMLElement
  expect(top.dataset.msg).toBe(transcript(300)[20].id)
  expect(jump()).not.toBeNull()
  await act(async () => { handleEvent({ type: 'chat', message: genio(1001) }) })
  expect(atBottom()).toBe(false)

  await act(async () => { jump()!.click() })
  expect(log().scrollTop).toBe(maxTop(log()))
  expect(jump()).toBeNull()
  await act(async () => { handleEvent({ type: 'chat', message: genio(1002) }) })
  expect(log().scrollTop).toBe(maxTop(log()))
  await unmount()
})
