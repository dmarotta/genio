// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Engine } from '../src/shared/types'

// The store reads its window binding at import: make this a project window for "game".
vi.hoisted(() => window.history.replaceState({}, '', '/?project=game'))
vi.mock('../src/renderer/src/components/PlanMeter', () => ({ RailMeter: () => null }))

import { UNITY_SLOT_ENGINES, supportsUnitySlots } from '../src/shared/play'
import { effectiveEngine } from '../src/shared/engine'
import { RAIL, navItems, viewAvailable, windowRail } from '../src/renderer/src/lib/railmenu'
import { getState, go, handleEvent, playAvailable, setState } from '../src/renderer/src/store'
import { Rail, navFor } from '../src/renderer/src/components/Rail'
import { ENGINE_CASES, engineProject } from './engine-cases'

const ids = (play: boolean, projectWindow = true): string[] => navItems(windowRail(projectWindow, play)).map((n) => n.id)
const withEngine = (engine?: Engine): void => handleEvent({ type: 'projects', projects: engine === undefined ? [] : [engineProject({ engine }, '/game')] })

describe('supportsUnitySlots', () => {
  it('is Unity only today, from one list', () => {
    expect(UNITY_SLOT_ENGINES).toEqual(['unity'])
    expect(supportsUnitySlots('unity')).toBe(true)
    for (const engine of ['other', 'godot', 'unreal', 'web', 'bevy'] as Engine[]) expect(supportsUnitySlots(engine)).toBe(false)
    expect(supportsUnitySlots(undefined)).toBe(false)
  })

  // Same stored entries as the main-process contract in engine-contract.test.ts: Settings shows Unity slots, and the
  // rail shows Play, exactly when PlayService and the player instance accept the project.
  it.each(ENGINE_CASES)('agrees with the main process for $name', ({ stored, slots }) => {
    expect(supportsUnitySlots(effectiveEngine(engineProject(stored, '/game')).engine)).toBe(slots)
    handleEvent({ type: 'projects', projects: [engineProject(stored, '/game')] })
    expect(playAvailable(getState())).toBe(slots)
  })
})

describe('window rail', () => {
  it('offers Play in a project window only when the engine supports it', () => {
    expect(ids(true)).toContain('play')
    expect(ids(false)).not.toContain('play')
    expect(ids(false)).toEqual(navItems(RAIL).map((n) => n.id).filter((id) => id !== 'play'))
    expect(navItems(RAIL).find((n) => n.id === 'play')).toEqual({ id: 'play', label: 'Play', key: '0' })
  })

  it('never offers project screens in the Hub', () => {
    for (const play of [true, false]) {
      expect(ids(play, false)).not.toContain('play')
      expect(ids(play, false)).not.toContain('comms')
      expect(ids(play, false)).not.toContain('inventory')
    }
    expect(viewAvailable('play', false, true)).toBe(false)
    expect(viewAvailable('squad', false, false)).toBe(true)
  })

  it('filters submenus and drops one left empty', () => {
    const menu = { kind: 'menu' as const, id: 'game', label: 'Game', items: [{ id: 'play' as const, label: 'Play', key: '0' }] }
    expect(windowRail(true, false, [menu])).toEqual([])
    expect(windowRail(true, true, [menu])).toEqual([menu])
  })
})

describe('Play availability in a project window', () => {
  let root: Root; let host: HTMLDivElement
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); setState({ view: 'comms' }) })

  it.each([['unity', true], ['other', false], [undefined, false]] as [Engine | undefined, boolean][])('engine %s shows Play in the rail, palette and shortcuts: %s', async (engine, shown) => {
    withEngine(engine)
    expect(playAvailable(getState())).toBe(shown)
    expect(navFor(shown).some((n) => n.id === 'play' && n.key === '0')).toBe(shown)
    await act(async () => root.render(React.createElement(Rail)))
    expect(!!host.querySelector('button[aria-label="Play"]')).toBe(shown)
  })

  it('redirects to the default screen without an error when Play is not offered', () => {
    withEngine('other')
    go('play')
    expect(getState().view).toBe('comms')
    setState({ view: 'play' }) // a stored view, notification or palette target
    expect(getState().view).toBe('comms')
    expect(getState().toasts).toEqual([])
  })

  it('updates live when the engine is detected or changed', async () => {
    withEngine('other')
    await act(async () => root.render(React.createElement(Rail)))
    expect(host.querySelector('button[aria-label="Play"]')).toBeNull()
    await act(async () => withEngine('unity'))
    expect(host.querySelector('button[aria-label="Play"]')).not.toBeNull()
    go('play')
    expect(getState().view).toBe('play')
    await act(async () => withEngine('other'))
    expect(host.querySelector('button[aria-label="Play"]')).toBeNull()
    expect(getState().view).toBe('comms')
  })
})
