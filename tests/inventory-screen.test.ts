// @vitest-environment jsdom
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryInfo, InventoryQuery, InventoryState } from '../src/shared/inventory'
vi.mock('../src/renderer/src/views/Comms', () => ({ ChatPanel: () => null }))
const f = vi.hoisted(() => ({ world: 'alpha', open: vi.fn(), close: vi.fn(), list: vi.fn(), info: vi.fn(), go: vi.fn(), on: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ inventoryWorld: f.world, chats: {}, snap: { wksps: [], projects: [{ name: 'alpha', path: 'C:/alpha' }, { name: 'beta', path: 'C:/beta' }] } }),
  api: () => ({ inventoryOpen: f.open, inventoryClose: f.close, inventoryList: f.list, inventoryInfo: f.info, inventoryRefresh: f.open }),
  go: f.go, op: async (_: string, fn: () => unknown) => fn(), errText: String
}))
import { Inventory } from '../src/renderer/src/views/Inventory'
const state = (world: string): InventoryState => ({ world, revision: 1, total: 20000, refreshing: false, watching: true })
const item = (world: string, name = 'stone.psd'): InventoryInfo => ({ path: `Assets/${name}`, folder: 'Assets', name, ext: 'psd', kind: 'image', size: 1024, mtimeMs: 1, tracked: true, lfs: false, vendor: false, generated: false, tags: [], mediaUrl: `genio-media://world/${world}/Assets/${name}` })
let root: Root, host: HTMLDivElement
async function render() { await act(async () => root.render(React.createElement(StrictMode, null, React.createElement(Inventory)))); await act(async () => { await vi.advanceTimersByTimeAsync(250) }) }
async function click(selector: string) { await act(async () => (host.querySelector(selector) as HTMLButtonElement).click()); await act(async () => { await vi.advanceTimersByTimeAsync(250) }) }
beforeEach(() => {
  vi.useFakeTimers(); f.world = 'alpha'; localStorage.clear()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} } })
  f.open.mockImplementation(async world => state(world)); f.close.mockResolvedValue(undefined)
  f.list.mockImplementation(async (world, q: InventoryQuery) => ({ state: state(world), total: 20000, items: q.limit === 1 ? [] : [item(world), item(world, 'wood.psd')], folders: !q.folder ? [{ name: 'Assets', path: 'Assets', count: 20000, vendor: false }] : q.folder === 'Assets' ? [{ name: 'UI', path: 'Assets/UI', count: 2, vendor: false }] : [] }))
  f.info.mockImplementation(async (world, path: string) => item(world, path.split('/').pop()))
  f.on.mockReturnValue(() => undefined); Object.assign(window, { genio: { on: f.on } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

describe('Inventory screen lifecycle', () => {
  it('honours world navigation, serializes StrictMode watchers and bounds list requests', async () => {
    await render()
    expect(host.querySelector('select')?.value).toBe('alpha')
    expect(f.open.mock.calls.map(c => c[0])).toEqual(['alpha', 'alpha'])
    expect(f.close).toHaveBeenCalledWith('alpha')
    expect(f.list.mock.calls.every(c => c[1].limit < 100)).toBe(true)
    await click('.inventory-tile')
    expect(host.querySelector('.inventory-inspector h2')?.textContent).toBe('stone.psd')
    expect(host.textContent).toContain('PSD · preview coming later')
    f.world = 'beta'; await render()
    expect(host.querySelector('select')?.value).toBe('beta')
    expect(host.querySelector('.inventory-inspector h2')).toBeNull()
    const lastClose = f.close.mock.invocationCallOrder.at(-1)!
    expect(f.open.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(lastClose)
    expect(localStorage.getItem('genio.inventory.world')).toBe('beta')
  })
  it('ignores stale inspector responses after selecting another asset', async () => {
    let resolve!: (i: InventoryInfo) => void
    f.info.mockImplementationOnce(() => new Promise<InventoryInfo>(r => { resolve = r }))
    await render(); await click('.inventory-tile')
    await click('.inventory-tile:nth-child(2)')
    await act(async () => resolve(item('alpha')))
    expect(host.querySelector('.inventory-inspector h2')?.textContent).toBe('wood.psd')
    expect(host.querySelector('.inventory-path')?.textContent).toBe('Assets/wood.psd')
  })
  it('can collapse the ancestor of the selected folder and sends filters to both tree and grid', async () => {
    await render(); await click('.inventory-folder-name[title="Assets"]')
    await click('.inventory-folder-name[title="Assets/UI"]')
    await click('[aria-label="Collapse Assets"]')
    expect(host.querySelector('.inventory-folder-name[title="Assets/UI"]')).toBeNull()
    const image = [...host.querySelectorAll('button')].find(b => b.textContent === 'Image')!
    await act(async () => image.click()); await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    const calls = f.list.mock.calls.filter(c => c[1].kinds?.includes('image'))
    expect(calls.some(c => c[1].limit === 1)).toBe(true)
    expect(calls.some(c => c[1].limit > 1)).toBe(true)
    expect(calls.every(c => c[1].scope === 'ours')).toBe(true)
  })
})
