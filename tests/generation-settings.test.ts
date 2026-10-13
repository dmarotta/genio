// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ falWorld: vi.fn(), uthanaWorld: vi.fn(), falWorldConfig: vi.fn(), uthanaWorldConfig: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ api: () => api, errText: String, toast: vi.fn() }))
import { GenerationSettings } from '../src/renderer/src/components/GenerationSettings'
let root: Root
let host: HTMLDivElement
const fal = { world: 'test', engine: 'unity', engineRoot: 'Game', config: { budget: { monthly_usd: 10 }, defaults: { model: { seed: 5 } }, providers: { codex: { enabled: false, custom: 1 }, another: { enabled: true } }, custom: 'keep' } }
const uthana = { world: 'test', folder: 'Game/Assets/Animations', config: { folder: 'Motions', custom: 'keep' } }
beforeEach(() => {
  vi.resetAllMocks()
  api.falWorld.mockResolvedValue(fal)
  api.uthanaWorld.mockResolvedValue(uthana)
  api.falWorldConfig.mockImplementation(async (world, config) => ({ ...fal, world, config }))
  api.uthanaWorldConfig.mockImplementation(async (world, config) => ({ ...uthana, world, config }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function change(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(label), value)
    input(label).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(world = 'test') { await act(async () => root.render(React.createElement(GenerationSettings, { world }))) }
async function save() { await act(async () => host.querySelector<HTMLButtonElement>('button')!.click()) }

it('loads world settings and saves both existing config formats while preserving unrelated fields', async () => {
  await mount()
  expect(input('Monthly budget (USD)').value).toBe('10')
  expect(input('Confirm runs over (USD)').placeholder).toBe('0.25')
  expect(input('Images folder').placeholder).toBe('Game/Assets/Art/Generated')
  expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false)
  await change('Monthly budget (USD)', '')
  await change('Confirm runs over (USD)', '0')
  await change('Images folder', 'Game/Assets/Art')
  await change('Animations folder', 'Game/Assets/Motions')
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
  await save()
  expect(api.falWorldConfig).toHaveBeenCalledWith('test', { ...fal.config,
    budget: { monthly_usd: undefined, confirm_over_usd: 0 }, folders: { image: 'Game/Assets/Art' },
    providers: { ...fal.config.providers, codex: { enabled: true, custom: 1 } }
  })
  expect(api.uthanaWorldConfig).toHaveBeenCalledWith('test', { custom: 'keep', folder: 'Game/Assets/Motions' })
})

it('rejects invalid budgets, supports default confirmation, and reports partial saves for retry', async () => {
  await mount()
  await change('Monthly budget (USD)', '-1')
  expect(host.querySelector('button')!.disabled).toBe(true)
  await save()
  expect(api.falWorldConfig).not.toHaveBeenCalled()
  await change('Monthly budget (USD)', '2')
  api.uthanaWorldConfig.mockRejectedValueOnce(new Error('Folder outside world'))
  await save()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('animation folder could not be saved')
  expect(api.falWorldConfig.mock.calls[0][1].budget.confirm_over_usd).toBeUndefined()
  await change('Animations folder', 'Animations')
  await save()
  expect(host.querySelector('[role="alert"]')).toBeNull()
})

it('does not expose editable defaults after a failed load and retries', async () => {
  api.falWorld.mockRejectedValueOnce(new Error('Unavailable'))
  await mount()
  expect(host.querySelector('input')).toBeNull()
  expect(host.querySelector('button')!.textContent).toBe('Retry settings')
  await save()
  expect(input('Monthly budget (USD)').value).toBe('10')
})

it('ignores a late response from a different world', async () => {
  let resolve!: (value: unknown) => void
  api.falWorld.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
  await mount('old')
  await mount('new')
  await act(async () => resolve({ ...fal, config: { budget: { monthly_usd: 999 } } }))
  expect(input('Monthly budget (USD)').value).toBe('10')
  await save()
  expect(api.falWorldConfig.mock.calls[0][0]).toBe('new')
})
