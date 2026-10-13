// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeModels, type CatalogueRoute } from '@shared/model-catalogue'
const f = vi.hoisted(() => ({ catalogue: vi.fn(), change: vi.fn(), accounts: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ modelCatalogue: f.catalogue, accountUsage: async () => ({ tools: [] }), featureUsed: async () => {} }), errText: String }))
import { ModelPicker } from '../src/renderer/src/components/ModelPicker'
let host: HTMLDivElement, root: Root
const route = (runtime: CatalogueRoute['runtime'], provider: string, state: CatalogueRoute['state'], ids: string[]): CatalogueRoute => ({ runtime, provider, state, checkedAt: '', lastResult: 'ok', stale: false, models: normalizeModels(runtime, provider, ids.map(id => ({ id }))) })
const render = async () => { await act(async () => root.render(React.createElement(ModelPicker, { value: 'claude-opus-5-5', onChange: f.change, onAccounts: f.accounts }))) }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!
const click = async (text: string) => { await act(async () => button(text).click()) }
const open = async () => { await act(async () => host.querySelector('button')!.click()) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear(); vi.clearAllMocks()
  f.catalogue.mockResolvedValue({ routes: [
    route('gemini', 'Google', 'sign-in-needed', ['gemini-3.5-flash']),
    route('claude', 'Anthropic', 'connected', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6']),
    route('codex', 'OpenAI', 'connected', ['gpt-6.1-sol']),
    route('opencode', 'OpenCode', 'free-no-login', ['opencode/free']),
    route('opencode', 'OpenRouter', 'unavailable', [])
  ] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await render(); await open()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('keeps gray account rows actionable and never switches them', async () => {
  const row = button('gemini / 3.5 flash')
  expect(row.disabled).toBe(false)
  expect(row.dataset.unavailable).toBe('true')
  expect(row.title).toBe('gemini-3.5-flash')
  await click('gemini / 3.5 flash')
  expect(f.accounts).toHaveBeenCalledOnce(); expect(f.change).not.toHaveBeenCalled()
  await open(); await click('openrouter / No models discovered')
  expect(f.accounts).toHaveBeenCalledTimes(2)
  await open(); await click('opencode / free')
  expect(f.accounts).toHaveBeenCalledTimes(3); expect(f.change).not.toHaveBeenCalled()
})
it('sorts signed-in models first, guards unsupported drivers and switches Claude', async () => {
  const rows = [...document.querySelectorAll<HTMLButtonElement>('button[title]')].filter(b => b.title)
  expect(rows[0].title).toBe('claude-opus-5-5')
  await click('codex / gpt 6.1 sol')
  expect(document.querySelector('[role=status]')?.textContent).toBe('codex: chat driver coming soon')
  expect(f.change).not.toHaveBeenCalled()
  await click('claude / sonnet 5.5'); expect(f.change).toHaveBeenCalledWith('claude-sonnet-5-5')
})
it('remembers Show all models across close and remount', async () => {
  expect(button('claude / sonnet 4.6')).toBeUndefined()
  await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(button('claude / sonnet 4.6')).toBeDefined()
  expect(localStorage.getItem('genio.models.showAll')).toBe('true')
  await click('Close'); await act(async () => root.render(null)); await render(); await open()
  expect(document.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true)
  expect(button('claude / sonnet 4.6')).toBeDefined()
  await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(button('claude / sonnet 4.6')).toBeUndefined()
})
