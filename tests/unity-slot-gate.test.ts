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
import { handleEvent } from '../src/renderer/src/store'
import { Rail, WINDOW_NAV } from '../src/renderer/src/components/Rail'
import { ENGINE_CASES, engineProject } from './engine-cases'

describe('supportsUnitySlots', () => {
  it('is Unity only today, from one list', () => {
    expect(UNITY_SLOT_ENGINES).toEqual(['unity'])
    expect(supportsUnitySlots('unity')).toBe(true)
    for (const engine of ['other', 'godot', 'unreal', 'web', 'bevy'] as Engine[]) expect(supportsUnitySlots(engine)).toBe(false)
    expect(supportsUnitySlots(undefined)).toBe(false)
  })

  // Same stored entries as the main-process contract in engine-contract.test.ts: Settings shows Unity slots exactly when PlayService accepts the project.
  it.each(ENGINE_CASES)('agrees with the main process for $name', ({ stored, slots }) => {
    expect(supportsUnitySlots(effectiveEngine(engineProject(stored, '/game')).engine)).toBe(slots)
  })
})

describe('window rail', () => {
  it('never offers project screens in the Hub', () => {
    const hub = navItems(windowRail(false)).map((n) => n.id)
    expect(hub).not.toContain('comms')
    expect(hub).not.toContain('inventory')
    expect(viewAvailable('inventory', false)).toBe(false)
    expect(viewAvailable('squad', false)).toBe(true)
    expect(navItems(windowRail(true)).map((n) => n.id)).toEqual(navItems(RAIL).map((n) => n.id))
  })

  it('filters submenus and drops one left empty', () => {
    const menu = { kind: 'menu' as const, id: 'game', label: 'Game', items: [{ id: 'inventory' as const, label: 'Inventory', key: '9' }] }
    expect(windowRail(false, [menu])).toEqual([])
    expect(windowRail(true, [menu])).toEqual([menu])
  })
})

describe('no Play screen', () => {
  let root: Root; let host: HTMLDivElement
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  it.each([['unity'], ['other'], [undefined]] as [Engine | undefined][])('engine %s has no Play entry in the rail, palette or shortcuts', async (engine) => {
    handleEvent({ type: 'projects', projects: engine === undefined ? [] : [engineProject({ engine }, '/game')] })
    expect(navItems(RAIL).some((n) => (n.id as string) === 'play' || n.label === 'Play')).toBe(false)
    expect(WINDOW_NAV.some((n) => n.label === 'Play' || n.key === '0')).toBe(false)
    await act(async () => root.render(React.createElement(Rail)))
    expect(host.querySelector('button[aria-label="Play"]')).toBeNull()
  })
})
