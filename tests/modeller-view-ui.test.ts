// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIEWER_APP_URL, type ModelLoaded } from '../src/shared/model-viewer'
import type { ModellerLive } from '../src/shared/modeller'
const f = vi.hoisted(() => ({ live: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ modellerLive: f.live }) }))
import { ModellerView, useModellerLive } from '../src/renderer/src/components/ModellerView'

const BASE = `genio-media://model/${'a'.repeat(32)}/modeller/tower/steps`
const step = (n: number, caption: string) => ({ id: `s00${n}`, n, caption, triangles: 12 * n, warnings: 0, ms: 1500, glb: `${BASE}/s00${n}/model.glb` })
const state = (patch: Partial<ModellerLive> = {}): ModellerLive => ({ model: 'tower', branch: 'main', steps: [step(1, 'Raising four timber legs')], running: null, failure: null, stamp: '1', ...patch })
const model = (diff?: ModelLoaded['diff']): ModelLoaded => ({
  stats: { triangles: 2802, vertices: 1500, meshes: 9, materials: 3, textures: 0, bones: 0, size: [2, 6, 2] }, clips: [], textures: [], missing: [], clayFallback: 0,
  animationOnly: false, loadMs: 20, format: 'GLB', units: 'Metres', upAxis: 'y', unityClips: false, ...(diff ? { diff } : {})
})
let root: Root, host: HTMLDivElement
const text = (): string => host.textContent ?? ''
const frame = (): HTMLIFrameElement => host.querySelector('iframe')!
const render = async (live: ModellerLive): Promise<void> => { await act(async () => root.render(React.createElement(ModellerView, { live }))) }
const fromFrame = async (data: unknown, source: MessageEventSource | null = frame().contentWindow): Promise<void> => {
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source })) })
}
const button = (label: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-16T12:00:00Z') })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

describe('Modeller live view (app side of the sandboxed frame)', () => {
  it('hot swaps each new head step into the same frame, keeping its camera', async () => {
    await render(state())
    expect(frame().getAttribute('src')).toBe(VIEWER_APP_URL)
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts')
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage')
    await fromFrame({ type: 'ready' })
    expect(posted.mock.calls.map(c => c[0])).toEqual([
      { type: 'settings', settings: expect.objectContaining({ turntable: false, wireframe: false, clay: false }) },
      { type: 'open', url: `${BASE}/s001/model.glb`, name: 'tower step 1', requestId: 1, keep: true }
    ])
    await fromFrame({ type: 'ready' })
    expect(posted).toHaveBeenCalledTimes(2)
    await fromFrame({ type: 'loaded', requestId: 1, model: model() })
    expect(text()).toContain('Step 1 · Raising four timber legs')
    expect(text()).toContain('2,802 triangles · 9 parts')
    await render(state({ steps: [step(1, 'Raising four timber legs'), step(2, 'Deck of planks')], stamp: '2' }))
    expect(posted.mock.calls[2][0]).toEqual({ type: 'open', url: `${BASE}/s002/model.glb`, name: 'tower step 2', requestId: 2, keep: true })
    // A late answer for the step before is ignored.
    await fromFrame({ type: 'loaded', requestId: 1, model: model({ added: 9, changed: 0, removed: 0, names: [], swapMs: 1 }) })
    expect(text()).not.toContain('9 added')
    await fromFrame({ type: 'loaded', requestId: 2, model: model({ added: 1, changed: 2, removed: 0, names: ['deck', 'leg_1', 'leg_2', 'leg_3', 'leg_4'], swapMs: 0.3 }) })
    expect(text()).toContain('+1 added · 2 changed · −0 removed: deck, leg_1, leg_2, leg_3…')
  })

  it('shows the running step as a live status, and a failed attempt with its reason', async () => {
    await render(state({ running: { id: 's002', n: 2, caption: 'Deck of planks', startedAt: Date.now() - 12_000 } }))
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Step 2 · Deck of planks…12 s')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(text()).toContain('15 s')
    await render(state({ failure: { id: 's002', n: 2, caption: 'Deck of planks', kind: 'error', error: "NameError: name 'plank' is not defined. The model stays at s001.\n  at line 4" } }))
    expect(host.querySelector('[role="status"]')!.className).toContain('warn')
    expect(text()).toContain('Step 2 failed · Deck of planks')
    expect(text()).toContain("NameError: name 'plank' is not defined. The model stays at s001.")
    expect(text()).not.toContain('at line 4')
    await render(state({ steps: [] }))
    expect(text()).toContain('Waiting for the first step…')
  })

  it('has exactly the wireframe, clay and turntable toggles, sent to the frame and kept for the next unit', async () => {
    await render(state())
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Wireframe', 'Clay', 'Turntable'])
    await act(async () => button('Turntable').click())
    expect(posted.mock.calls.at(-1)![0]).toMatchObject({ type: 'settings', settings: { turntable: true, wireframe: false } })
    expect(button('Turntable').getAttribute('aria-pressed')).toBe('true')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(state())
    expect(button('Turntable').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button('Turntable').click())
  })

  it('polls the unit while it is live and re-renders only when the state changed', async () => {
    f.live.mockResolvedValue(state())
    const seen: (ModellerLive | null)[] = []
    function Probe({ poll }: { poll: boolean }) { seen.push(useModellerLive('u1', poll)); return null }
    await act(async () => root.render(React.createElement(Probe, { poll: true })))
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(f.live).toHaveBeenCalledTimes(4)
    expect(new Set(seen.filter(Boolean)).size).toBe(1)
    f.live.mockResolvedValue(state({ stamp: '2' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(new Set(seen.filter(Boolean)).size).toBe(2)
    await act(async () => root.render(React.createElement(Probe, { poll: false })))
    const calls = f.live.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(f.live.mock.calls.length).toBe(calls)
  })
})
