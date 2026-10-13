import { describe, expect, it } from 'vitest'
import { ASSET_GEN, RAIL, entryActive, initialIndex, menuKey, navItems, opensMenu } from '../src/renderer/src/lib/railmenu'

describe('rail entries', () => {
  it('replaces Asset Generation with Inventory while retaining palette generation commands', () => {
    const top = RAIL.map((e) => (e.kind === 'view' ? e.item.id : e.id))
    expect(top).not.toContain('fal')
    expect(top).not.toContain('animation')
    expect(top).toContain('inventory')
    expect(top).not.toContain('assets')
    expect(ASSET_GEN.label).toBe('Asset Generation')
    expect(ASSET_GEN.items.map((i) => [i.id, i.label])).toEqual([
      ['fal', 'FAL.ai'],
      ['animation', 'Uthana (3D Rigging & Animation)']
    ])
  })

  it('keeps every screen and its shortcut reachable for the palette', () => {
    const keys = Object.fromEntries(navItems().map((n) => [n.id, n.key]))
    expect(keys).toEqual({
      comms: '1', squad: '2', quests: '3', move: '4', status: '5', worlds: '6', lore: '7', systems: '8', inventory: '9', fal: '', animation: '0'
    })
  })
})

describe('active state', () => {
  it('lights the Asset Generation button while either of its screens is open', () => {
    expect(entryActive(ASSET_GEN, 'fal')).toBe(true)
    expect(entryActive(ASSET_GEN, 'animation')).toBe(true)
    expect(entryActive(ASSET_GEN, 'comms')).toBe(false)
  })

  it('lights a plain button only for its own screen', () => {
    const comms = RAIL[0]
    expect(entryActive(comms, 'comms')).toBe(true)
    expect(entryActive(comms, 'fal')).toBe(false)
  })

  it('opens the submenu on the current screen, else the first item', () => {
    expect(initialIndex(ASSET_GEN.items, 'animation')).toBe(1)
    expect(initialIndex(ASSET_GEN.items, 'fal')).toBe(0)
    expect(initialIndex(ASSET_GEN.items, 'squad')).toBe(0)
  })
})

describe('submenu keyboard', () => {
  it('opens from the button with arrow keys', () => {
    expect(opensMenu('ArrowDown')).toBe(true)
    expect(opensMenu('ArrowRight')).toBe(true)
    expect(opensMenu('a')).toBe(false)
  })

  it('moves the highlight with wraparound, Home and End', () => {
    expect(menuKey('ArrowDown', 0, 2)).toEqual({ type: 'move', index: 1 })
    expect(menuKey('ArrowDown', 1, 2)).toEqual({ type: 'move', index: 0 })
    expect(menuKey('ArrowUp', 0, 2)).toEqual({ type: 'move', index: 1 })
    expect(menuKey('Home', 1, 2)).toEqual({ type: 'move', index: 0 })
    expect(menuKey('End', 0, 2)).toEqual({ type: 'move', index: 1 })
  })

  it('picks the highlighted item on Enter or Space', () => {
    expect(menuKey('Enter', 1, 2)).toEqual({ type: 'pick', index: 1 })
    expect(menuKey(' ', 0, 2)).toEqual({ type: 'pick', index: 0 })
  })

  it('closes on Esc, Tab or ArrowLeft and ignores other keys', () => {
    for (const k of ['Escape', 'Tab', 'ArrowLeft']) expect(menuKey(k, 0, 2)).toEqual({ type: 'close' })
    expect(menuKey('x', 0, 2)).toBeNull()
  })
})
