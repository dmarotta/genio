import { describe, expect, it } from 'vitest'
import { RAIL, entryActive, initialIndex, menuKey, navItems, opensMenu } from '../src/renderer/src/lib/railmenu'

const MENU = { kind: 'menu' as const, id: 'test', label: 'Test menu', items: [{ id: 'inventory' as const, label: 'Inventory', key: '9' }, { id: 'worlds' as const, label: 'Worlds', key: '6' }] }

describe('rail entries', () => {
  it('replaces Asset Generation with Inventory and removes generation commands', () => {
    const top = RAIL.map((e) => (e.kind === 'view' ? e.item.id : e.id))
    expect(top).not.toContain('fal')
    expect(top).not.toContain('animation')
    expect(top).toContain('inventory')
    expect(top).not.toContain('assets')
    expect(top).not.toContain('worlds')
    expect(navItems().map((i) => i.id)).not.toContain('fal')
    expect(navItems().map((i) => i.id)).not.toContain('animation')
    expect(navItems().find(i => i.key === '0')?.id).toBe('play')
  })

  it('keeps every screen and its shortcut reachable for the palette', () => {
    const keys = Object.fromEntries(navItems().map((n) => [n.id, n.key]))
    expect(keys).toEqual({
      comms: '1', squad: '2', quests: '3', status: '5', lore: '7', systems: '8', inventory: '9', play: '0'
    })
  })
})

describe('active state', () => {
  it('lights a submenu button while one of its screens is open', () => {
    expect(entryActive(MENU, 'inventory')).toBe(true)
    expect(entryActive(MENU, 'worlds')).toBe(true)
    expect(entryActive(MENU, 'comms')).toBe(false)
  })

  it('lights a plain button only for its own screen', () => {
    const comms = RAIL[0]
    expect(entryActive(comms, 'comms')).toBe(true)
    expect(entryActive(comms, 'inventory')).toBe(false)
  })

  it('opens the submenu on the current screen, else the first item', () => {
    expect(initialIndex(MENU.items, 'worlds')).toBe(1)
    expect(initialIndex(MENU.items, 'inventory')).toBe(0)
    expect(initialIndex(MENU.items, 'squad')).toBe(0)
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
