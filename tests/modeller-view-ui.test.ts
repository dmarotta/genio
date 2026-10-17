// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VIEWER_APP_URL, type ModelLoaded } from '../src/shared/model-viewer'
import type { ModellerLive } from '../src/shared/modeller'
import type { GenioEvent } from '../src/shared/types'
const f = vi.hoisted(() => ({ live: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ api: () => ({ modellerLive: f.live }) }))
import { ModellerView, useModellerLive } from '../src/renderer/src/components/ModellerView'

const BASE = `genio-media://model/${'a'.repeat(32)}/modeller/tower/steps`
const step = (n: number, caption: string) => ({ id: `s00${n}`, n, caption, triangles: 12 * n, parts: n, ms: 1500, at: 0, glb: `${BASE}/s00${n}/model.glb`, view: `${BASE}/s00${n}/view.png` })
const state = (patch: Partial<ModellerLive> = {}): ModellerLive => ({ model: 'tower', branch: 'main', steps: [step(1, 'Raising four timber legs')], checks: [], running: null, failure: null, next: null, stamp: '1', ...patch })
const model = (diff?: ModelLoaded['diff']): ModelLoaded => ({
  stats: { triangles: 2802, vertices: 1500, meshes: 9, materials: 3, textures: 0, bones: 0, size: [2, 6, 2] }, clips: [], textures: [], missing: [], clayFallback: 0,
  animationOnly: false, loadMs: 20, format: 'GLB', units: 'Metres', upAxis: 'y', unityClips: false, ...(diff ? { diff } : {})
})
let root: Root, host: HTMLDivElement
const text = (): string => host.textContent ?? ''
const frame = (): HTMLIFrameElement => host.querySelector('iframe')!
const render = async (live: ModellerLive | null): Promise<void> => { await act(async () => root.render(React.createElement(ModellerView, { live }))) }
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
    await render(state({ steps: [step(1, 'Raising four timber legs'), step(2, 'Deck of planks')], stamp: '2' }))
    expect(posted.mock.calls[2][0]).toEqual({ type: 'open', url: `${BASE}/s002/model.glb`, name: 'tower step 2', requestId: 2, keep: true })
    await fromFrame({ type: 'loaded', requestId: 2, model: model({ added: 1, changed: 2, removed: 0, names: ['deck', 'leg_1', 'leg_2', 'leg_3', 'leg_4'], swapMs: 0.3 }) })
    // The changed parts glow in the frame; no text about them, no triangle or part counts, no branch.
    expect(text()).not.toMatch(/added|changed|removed|deck, leg_1|triangles|parts|branch/)
    expect(host.querySelectorAll('.modeller-view-note')).toHaveLength(0)
    // A load failure still says why the scene is empty.
    await fromFrame({ type: 'failed', requestId: 2, code: 'unreadable', reason: 'The model could not be read.' })
    expect(host.querySelector('.modeller-view-note.warn')!.textContent).toBe('The model could not be read.')
  })

  it('shows the running step as a live status, and a failed attempt without technical detail', async () => {
    await render(state({ running: { id: 's002', n: 2, caption: 'Deck of planks', startedAt: Date.now() - 12_000 } }))
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Step 2 · Deck of planks…12 s')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(text()).toContain('15 s')
    await render(state({ failure: { id: 's002', n: 2, caption: 'Deck of planks', kind: 'error' } }))
    expect(host.querySelector('[role="status"]')!.className).toContain('warn')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('Step 2 failed · Deck of planks')
    expect(host.querySelectorAll('.modeller-view-note')).toHaveLength(0)
    await render(state({ steps: [] }))
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('shows an empty scene before the unit started a model, then the first step in the same frame', async () => {
    await render(null as unknown as ModellerLive)
    const empty = frame()
    expect(empty.getAttribute('src')).toBe(VIEWER_APP_URL)
    expect(empty.getAttribute('title')).toBe('Live 3D view')
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(host.querySelectorAll('.modeller-view-note')).toHaveLength(0)
    const posted = vi.spyOn(empty.contentWindow!, 'postMessage')
    await fromFrame({ type: 'ready' })
    expect(posted.mock.calls.map(c => c[0].type)).toEqual(['settings'])
    await render(state())
    expect(frame()).toBe(empty)
    expect(posted.mock.calls.at(-1)![0]).toEqual({ type: 'open', url: `${BASE}/s001/model.glb`, name: 'tower step 1', requestId: 1, keep: true })
    expect(text()).toContain('Step 1 · Raising four timber legs')
  })

  it('has exactly one toggle, Wireframe, sent to the frame and kept for the next unit', async () => {
    await render(state())
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage')
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Wireframe'])
    await act(async () => button('Wireframe').click())
    expect(posted.mock.calls.at(-1)![0]).toMatchObject({ type: 'settings', settings: { wireframe: true, clay: false, turntable: false } })
    expect(button('Wireframe').getAttribute('aria-pressed')).toBe('true')
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(state())
    expect(button('Wireframe').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button('Wireframe').click())
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

  it('takes the state main pushes at once, for its own unit only, and keeps polling as the fallback', async () => {
    const listeners = new Set<(e: GenioEvent) => void>()
    Object.assign(window, { genio: { on: (fn: (e: GenioEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn) } } })
    const emit = async (e: GenioEvent) => { await act(async () => { for (const fn of listeners) fn(e) }) }
    try {
      f.live.mockResolvedValue(state())
      const seen: (ModellerLive | null)[] = []
      function Probe({ poll }: { poll: boolean }) { seen.push(useModellerLive('u1', poll)); return null }
      await act(async () => root.render(React.createElement(Probe, { poll: true })))
      expect(seen.at(-1)?.steps).toHaveLength(1)
      const pushed = state({ steps: [step(1, 'Raising four timber legs'), step(2, 'Deck of planks')], stamp: '2' })
      await emit({ type: 'modeller-live', taskId: 'other', live: state({ stamp: 'x' }) })
      expect(seen.at(-1)?.stamp).toBe('1')
      // no waiting for the next poll
      await emit({ type: 'modeller-live', taskId: 'u1', live: pushed })
      expect(seen.at(-1)).toBe(pushed)
      await emit({ type: 'modeller-live', taskId: 'u1', live: { ...pushed } })
      expect(seen.at(-1)).toBe(pushed)
      // the poll still runs: a missed push shows within a second
      f.live.mockResolvedValue(state({ stamp: '3', steps: [step(1, 'a'), step(2, 'b'), step(3, 'Pitched roof')] }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(seen.at(-1)?.stamp).toBe('3')
      await act(async () => root.render(React.createElement(Probe, { poll: false })))
      expect(listeners.size).toBe(0)
    } finally { delete (window as { genio?: unknown }).genio }
  })

  it('says what the unit is doing while no step runs: before the first step, between steps and at a new step', async () => {
    const started = Date.now() - (6 * 60 + 38) * 1000
    const working = { status: 'Planning the mech: legs, torso, arms', since: started }
    const caption = (): string => host.querySelector('[role="status"]')?.textContent ?? ''
    const renderWith = async (live: ModellerLive | null, activity: typeof working | null) => { await act(async () => root.render(React.createElement(ModellerView, { live, activity }))) }
    // before the unit started a model, and before its first step: its status line and the time since it started
    await renderWith(null, working)
    expect(caption()).toBe('Planning the mech: legs, torso, arms6 min 38 s')
    await renderWith(state({ steps: [] }), { status: '', since: Date.now() - 5000 })
    expect(caption()).toBe('Working5 s')
    // the first script exists: its caption
    await renderWith(state({ steps: [], next: { caption: 'Blocking out the main mass', at: Date.now() } }), working)
    expect(caption()).toBe('Next: Blocking out the main mass6 min 38 s')
    // between steps: the last caption and the time since it landed
    const landed = { ...step(1, 'Blocking out the main mass'), at: Date.now() - 34_000 }
    await renderWith(state({ steps: [landed] }), working)
    expect(caption()).toBe('Step 1 · Blocking out the main massworking on the next step· 34 s')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(caption()).toContain('working on the next step· 36 s')
    // its script appears: the next caption, before Blender runs it
    await renderWith(state({ steps: [landed], next: { caption: 'Adding the legs', at: Date.now() } }), working)
    expect(caption()).toBe('Step 1 · Blocking out the main massnext: Adding the legs· 36 s')
    // the new step runs, then lands
    await renderWith(state({ steps: [landed], running: { id: 's002', n: 2, caption: 'Adding the legs', startedAt: Date.now() - 1000 } }), working)
    expect(caption()).toBe('Step 2 · Adding the legs…1 s')
    await renderWith(state({ steps: [landed, { ...step(2, 'Adding the legs'), at: Date.now() }] }), working)
    expect(caption()).toBe('Step 2 · Adding the legsworking on the next step· 0 s')
    // a unit that is not working shows no activity
    await renderWith(state({ steps: [landed] }), null)
    expect(caption()).toBe('Step 1 · Blocking out the main mass')
    await renderWith(null, null)
    expect(host.querySelector('[role="status"]')).toBeNull()
    // text only: no new buttons
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Wireframe'])
  })

  it('shows a sign of life beside the caption only while the unit works', async () => {
    const working = { status: 'Planning the tower', since: Date.now() - 5000 }
    const landed = { ...step(1, 'Raising four timber legs'), at: Date.now() - 3000 }
    const status = (): HTMLElement | null => host.querySelector('[role="status"]')
    const live = (): Element | null => status()?.querySelector('.modeller-view-live') ?? null
    const renderWith = async (l: ModellerLive | null, activity: typeof working | null) => { await act(async () => root.render(React.createElement(ModellerView, { live: l, activity }))) }
    // before the first step, between steps, and while a step runs
    for (const [l, a] of [[null, working], [state({ steps: [landed] }), working], [state({ running: { id: 's002', n: 2, caption: 'Deck', startedAt: Date.now() } }), null]] as const) {
      await renderWith(l, a)
      expect(live()).not.toBeNull()
      expect(live()!.getAttribute('aria-hidden')).toBe('true')
      expect(status()!.className).toContain('working')
      // the dot comes first, then the text and the clock, on one line
      expect(status()!.firstElementChild).toBe(live())
    }
    await renderWith(null, working)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(status()!.textContent).toBe('Planning the tower7 s')
    // ready (no activity), failed, and no live data: no indicator
    await renderWith(state({ steps: [landed] }), null)
    expect(live()).toBeNull()
    expect(status()!.className).not.toContain('working')
    await renderWith(state({ steps: [landed], failure: { id: 's002', n: 2, caption: 'Deck', kind: 'error' } }), working)
    expect(live()).toBeNull()
    await renderWith(null, null)
    expect(status()).toBeNull()
  })

  it('places the caption as one line at the bottom centre, with a still dot under reduced motion', async () => {
    const { readFileSync } = await import('node:fs' as string) as { readFileSync(file: string, encoding: 'utf8'): string }
    const css = readFileSync('src/renderer/src/styles/modeller-view.css', 'utf8')
    const rule = (selector: string, src = css): string => src.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.:]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    const caption = rule('.modeller-view-caption')
    expect(caption).toMatch(/bottom:\s*12px/)
    expect(caption).not.toMatch(/\btop:/)
    expect(caption).toMatch(/left:\s*50%/)
    expect(caption).toMatch(/translateX\(-50%\)/)
    expect(caption).toMatch(/max-width:\s*calc\(100% - 24px\)/)
    expect(caption).toMatch(/white-space:\s*nowrap/)
    expect(caption).toMatch(/font-size:\s*14\.5px/)
    expect(caption).toMatch(/font-weight:\s*500/)
    expect(rule('.modeller-view-text')).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule('.modeller-view-live')).toMatch(/animation:\s*modeller-live-dot/)
    expect(rule('.modeller-view-live')).toMatch(/var\(--orange\)/)
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(rule('.modeller-view-live', reduced)).toMatch(/animation:\s*none/)
    expect(rule('.modeller-view-live::after', reduced)).toMatch(/display:\s*none/)
  })
})
