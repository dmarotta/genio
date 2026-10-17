// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeModels, type CatalogueRoute } from '@shared/model-catalogue'
const f = vi.hoisted(() => ({ catalogue: vi.fn(), change: vi.fn(), accounts: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ modelCatalogue: f.catalogue, featureUsed: async () => {} }) }))
let ModelPicker: typeof import('../src/renderer/src/components/ModelPicker')['ModelPicker']
let host: HTMLDivElement, root: Root
const route = (runtime: CatalogueRoute['runtime'], provider: string, state: CatalogueRoute['state'], ids: string[]): CatalogueRoute => ({ runtime, provider, state, checkedAt: '', lastResult: 'ok', stale: false, models: normalizeModels(runtime, provider, ids.map(id => ({ id }))) })
const render = async (value = 'claude-opus-5-5') => { await act(async () => root.render(React.createElement(ModelPicker, { value, onChange: f.change, onAccounts: f.accounts }))) }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=option]')].find(b => b.textContent?.includes(text))!
const click = async (text: string) => { await act(async () => button(text).click()) }
const open = async () => { await act(async () => host.querySelector('button')!.click()) }
const key = async (key: string) => { await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetModules(); vi.clearAllMocks()
  ;({ ModelPicker } = await import('../src/renderer/src/components/ModelPicker'))
  f.catalogue.mockResolvedValue({ routes: [
    route('gemini', 'Google', 'sign-in-needed', ['gemini-3.5-flash']),
    route('claude', 'Anthropic', 'connected', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6']),
    route('codex', 'OpenAI', 'connected', ['gpt-6.1-sol']),
    route('opencode', 'OpenCode', 'free-no-login', ['opencode/free'])
  ] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('shows one plain list with Default first and subtle provider groups, with only top models', async () => {
  await render(); await open()
  expect(document.querySelector('[role=option]')?.textContent).toBe('Default')
  expect([...document.querySelectorAll('[role=group]')].map(n => n.getAttribute('aria-label'))).toEqual(['Anthropic', 'Google', 'OpenAI', 'OpenCode'])
  expect(document.querySelectorAll('input, [role=alert], [role=status]')).toHaveLength(0)
  expect(button('claude / sonnet 4.6')).toBeUndefined()
  expect(button('claude / opus 5.5').getAttribute('aria-selected')).toBe('true')
})
it('keeps gray rows disabled and inert', async () => {
  await render(); await open()
  for (const [label, reason] of [['gemini / 3.5 flash', 'sign in'], ['opencode / free', 'soon']]) {
    expect(button(label).disabled).toBe(true)
    expect(button(label).textContent).toContain(reason)
    await click(label)
  }
  expect(f.accounts).not.toHaveBeenCalled(); expect(f.change).not.toHaveBeenCalled()
  expect(document.querySelector('[role=listbox]')).not.toBeNull()
})
it('selects models and Default, closing and restoring focus', async () => {
  await render(); await open(); await click('claude / sonnet 5.5')
  expect(f.change).toHaveBeenLastCalledWith('claude-sonnet-5-5')
  expect(document.querySelector('[role=listbox]')).toBeNull()
  expect(document.activeElement).toBe(host.querySelector('button'))
  await open(); await click('Default'); expect(f.change).toHaveBeenLastCalledWith('')
  await render(''); await open(); expect(button('Default').getAttribute('aria-selected')).toBe('true')
  expect(button('claude / opus 5.5').getAttribute('aria-selected')).toBe('false')
})
it('navigates enabled rows with arrows and closes with Escape or outside click', async () => {
  await render(); await open()
  await key('ArrowDown'); expect(document.activeElement).toBe(button('claude / sonnet 5.5'))
  await key('ArrowDown'); expect(document.activeElement).toBe(button('codex / gpt 6.1 sol'))
  await key('ArrowDown'); expect(document.activeElement).toBe(button('Default'))
  await key('ArrowUp'); expect(document.activeElement).toBe(button('codex / gpt 6.1 sol'))
  await key('ArrowUp'); expect(document.activeElement).toBe(button('claude / sonnet 5.5'))
  await key('Enter'); expect(f.change).toHaveBeenLastCalledWith('claude-sonnet-5-5')
  expect(document.querySelector('[role=listbox]')).toBeNull()
  await open()
  await key('Escape'); expect(document.querySelector('[role=listbox]')).toBeNull()
  await open(); await act(async () => document.querySelector('.model-picker-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(document.querySelector('[role=listbox]')).toBeNull()
})
it('falls back quietly when an older main has no catalogue handler', async () => {
  f.catalogue.mockRejectedValue(new Error("No handler registered for 'genio:modelCatalogue'"))
  await render(); await open()
  expect(button('claude / sonnet 5.5').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('No handler')
  await click('claude / sonnet 5.5'); expect(f.change).toHaveBeenCalledWith('claude-sonnet-5-5')
})
it('retains the last list after discovery fails and retries on open', async () => {
  await render(); await open(); await key('Escape')
  f.catalogue.mockRejectedValue(new Error('offline'))
  await open(); expect(button('codex / gpt 6.1 sol')).toBeDefined()
  expect(document.body.textContent).not.toContain('offline')
  expect(f.catalogue.mock.calls.length).toBeGreaterThan(1)
})

it('enables a provider through capabilities without changing picker code', async () => {
  const capabilities = await import('../src/shared/chat-driver-capabilities')
  vi.spyOn(capabilities, 'chatDriverCapabilities').mockReturnValue({ mode: 'driver', guardedTools: true })
  try {
    await render(); await open()
    expect(button('codex / gpt 6.1 sol').disabled).toBe(false)
    await click('codex / gpt 6.1 sol')
    expect(f.change).toHaveBeenCalledWith('codex:OpenAI:gpt-6.1-sol')
    await render('codex:OpenAI:gpt-6.1-sol'); await open()
    expect(button('codex / gpt 6.1 sol').getAttribute('aria-selected')).toBe('true')
  } finally { vi.restoreAllMocks() }
})
it('refreshes after account invalidation and in the background', async () => {
  let receive!: (event: { type: string }) => void
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'genio', { configurable: true, value: { on: (callback: typeof receive) => { receive = callback; return unsubscribe } } })
  vi.useFakeTimers()
  try {
    await render()
    f.catalogue.mockClear()
    await act(async () => receive({ type: 'model-catalogue-invalidated' }))
    expect(f.catalogue).toHaveBeenCalledWith(true)
    f.catalogue.mockClear()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(f.catalogue).toHaveBeenCalledWith(false)
    await act(async () => root.render(null))
    expect(unsubscribe).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers(); Reflect.deleteProperty(window, 'genio') }
})

it('measures its anchor only while the list is open, never on the re-renders of a closed picker', async () => {
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  await render(); await render('claude-sonnet-5-5'); await render()
  expect(rect).not.toHaveBeenCalled()
  await open()
  expect(rect).toHaveBeenCalled()
  rect.mockRestore()
})