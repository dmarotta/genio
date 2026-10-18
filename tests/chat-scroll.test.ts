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

vi.mock('../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null, requestSystemsSection: () => undefined }))
vi.mock('../src/renderer/src/store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer/src/store')>(),
  PROJECT_WINDOW: 'scroll-fixture', PROJECT_WKSP: 'genio'
}))

import { ChatPanel, Comms } from '../src/renderer/src/views/Comms'
import { GenioPanel } from '../src/renderer/src/components/GenioPanel'
import { getState, handleEvent, setState } from '../src/renderer/src/store'

const WKSP = 'genio'
const VIEWPORT = 600, MSG = 72, LAID = 180
const initial = getState()
let root: Root, host: HTMLDivElement
let mounted = false
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
async function mount(surface?: 'screen' | 'panel'): Promise<void> {
  height = MSG
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  mounted = true
  if (surface === 'panel') setState({ view: 'squad' })
  await act(async () => { root.render(surface === 'panel' ? React.createElement(GenioPanel) : surface === 'screen' ? React.createElement(Comms) : React.createElement(ChatPanel, { wksp: WKSP })) })
}
async function unmount(): Promise<void> {
  await act(async () => root.unmount()); host.remove(); mounted = false
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
  localStorage.clear()
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    // In this fake layout every content change resizes the log's body: the browser reports that to the
    // observer after layout, so the fake reports each DOM change too (settle() reports late layout), and,
    // like the browser, it reports every observed element once when observation starts.
    ResizeObserver: class {
      cb: () => void; mo: MutationObserver
      constructor(cb: () => void) { this.cb = cb; this.mo = new MutationObserver(() => this.cb()) }
      observe(el: Element) { observers.add(this.cb); this.mo.observe(el, { childList: true, subtree: true, characterData: true }); queueMicrotask(() => { if (observers.has(this.cb)) this.cb() }) }
      disconnect() { observers.delete(this.cb); this.mo.disconnect() }
    }
  })
  const proto = HTMLElement.prototype
  Object.defineProperty(proto, 'scrollTo', { configurable: true, value: vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? this.scrollTop
  }) })
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
  setState({ ...initial, chats: { [WKSP]: transcript(300) }, chatLoaded: { [WKSP]: true }, settings: { gamertag: 'Alex', calm: false } as never,
    snap: { ...initial.snap, wksps: [{ name: WKSP, displayName: 'Genio', activity: 'idle', costUsd: 0, turns: 0, queued: 0 }] } })
})
afterEach(async () => {
  if (mounted) {
    // Failed assertions must not leave a mounted log or remembered scroll-up for the next case.
    await act(async () => { log().scrollTop = log().scrollHeight; log().dispatchEvent(new Event('scroll')) })
    await unmount()
  }
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  observers.clear()
  setState(initial)
})

it.each(['screen', 'panel'] as const)('jumps to the latest in the %s host despite recent wheel input and late layout while streaming', async (surface) => {
  await mount(surface)
  await wheelTo(20 * MSG + 30)
  const before = log().scrollTop
  await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: 'streaming ' }) })
  expect(log().scrollTop).toBe(before)
  expect(jump()).not.toBeNull()
  const button = jump()!
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    button.click()
  })
  await settle()
  expect(log().scrollTop).toBe(maxTop(log()))
  expect(jump()).toBeNull()
  await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: 'more tokens ' }) })
  expect(log().scrollTop).toBe(maxTop(log()))
  await unmount()
})

it.each(['screen', 'panel'] as const)('overlays the %s jump on the chat viewport as the scroller\'s sibling, not in its flow', async (surface) => {
  const style = document.createElement('style')
  // Read from disk: vitest blanks CSS imports (even ?raw), and this project has no Node types.
  const { readFileSync } = await import('node:fs' as string) as { readFileSync(file: string, encoding: 'utf8'): string }
  style.textContent = readFileSync('src/renderer/src/styles/app.css', 'utf8')
  document.head.append(style)
  try {
    await mount(surface)
    await wheelTo(20 * MSG)
    const button = jump()!, dock = button.parentElement!, viewport = log().parentElement!
    expect(log().contains(button)).toBe(false)
    expect(viewport.classList.contains('chat-viewport')).toBe(true)
    expect(dock.parentElement).toBe(viewport)
    expect(getComputedStyle(viewport).position).toBe('relative')
    expect(getComputedStyle(dock).position).toBe('absolute')
    expect(getComputedStyle(dock).pointerEvents).toBe('none')
    expect(getComputedStyle(button).pointerEvents).toBe('auto')
  } finally { style.remove() }
})

it.each(['screen', 'panel'] as const)('lets the %s jump animate, then catches the bottom after streaming and repeated layout changes', async (surface) => {
  await mount(surface)
  await wheelTo(20 * MSG)
  // Model a browser smooth scroll: scrollTo returns before any intermediate scroll events.
  const scroll = vi.spyOn(log(), 'scrollTo').mockImplementation(() => {})
  await act(async () => jump()!.click())
  expect(scroll).toHaveBeenCalledWith({ top: log().scrollHeight, behavior: 'smooth' })
  const midway = maxTop(log()) / 2
  await act(async () => { log().scrollTop = midway; log().dispatchEvent(new Event('scroll')) })
  expect(log().scrollTop).toBe(midway)
  await act(async () => { handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: 'arrives during jump ' }) })
  await settle()
  expect(log().scrollTop).toBe(midway)
  // Chromium reports completion against the original (estimated) target, now short of the bottom.
  await act(async () => { log().scrollTop = 300 * MSG - VIEWPORT; log().dispatchEvent(new Event('scrollend')) })
  expect(log().scrollTop).toBe(maxTop(log()))
  expect(jump()).toBeNull()
  height += 30
  await act(async () => {
    log().dispatchEvent(new Event('scroll'))
    for (const fire of observers) fire()
  })
  expect(log().scrollTop).toBe(maxTop(log()))
  expect(jump()).toBeNull()
  await unmount()
})

it.each(['screen', 'panel'] as const)('respects a new manual scroll-up during the %s jump', async (surface) => {
  await mount(surface)
  await wheelTo(20 * MSG)
  vi.spyOn(log(), 'scrollTo').mockImplementation(() => {})
  await act(async () => jump()!.click())
  await wheelTo(10 * MSG)
  const before = log().scrollTop
  await settle()
  await act(async () => {
    log().dispatchEvent(new Event('scrollend'))
    handleEvent({ type: 'chat-delta', wksp: WKSP, id: 'm-stream', text: 'still streaming ' })
  })
  expect(log().scrollTop).toBe(before)
  expect(jump()).not.toBeNull()
  // afterEach returns to the bottom before unmounting so this case does not retain scroll memory.
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
