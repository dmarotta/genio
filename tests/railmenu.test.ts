import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RAIL, menuKey, navItems, windowRail } from '../src/renderer/src/lib/railmenu'

describe('rail entries', () => {
  it('replaces Asset Generation with Inventory and removes generation commands', () => {
    const top = RAIL.map((e) => e.item.id)
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
      comms: '1', squad: '2', quests: '3', design: '7', status: '5', systems: '8', inventory: '9', 'art-bible': '6', play: '0'
    })
  })

  it('puts Design (Ctrl+7) after Quests, in every project window and never in the Hub', () => {
    const ids = navItems().map((i) => i.id)
    expect(ids.indexOf('design')).toBe(ids.indexOf('quests') + 1)
    expect(navItems().find((i) => i.id === 'design')).toEqual({ id: 'design', label: 'Design', key: '7' })
    for (const play of [true, false]) {
      expect(navItems(windowRail(true, play)).map((i) => i.id)).toContain('design')
      expect(navItems(windowRail(false, play)).map((i) => i.id)).not.toContain('design')
    }
  })

  it('puts Art Bible right after Inventory, in every project window and never in the Hub', () => {
    const ids = navItems().map((i) => i.id)
    expect(ids.indexOf('art-bible')).toBe(ids.indexOf('inventory') + 1)
    expect(navItems().find((i) => i.id === 'art-bible')?.label).toBe('Art Bible')
    for (const play of [true, false]) {
      expect(navItems(windowRail(true, play)).map((i) => i.id)).toContain('art-bible')
      expect(navItems(windowRail(false, play)).map((i) => i.id)).not.toContain('art-bible')
    }
  })

  it('has no Lore entry: memory lives in Settings → Memory', () => {
    expect(navItems().map((i) => i.id as string)).not.toContain('lore')
    expect(navItems().some((i) => /\blore\b/i.test(i.label))).toBe(false)
    expect(existsSync('src/renderer/src/views/Lore.tsx')).toBe(false)
    expect(readFileSync('src/renderer/src/App.tsx', 'utf8')).not.toMatch(/\blore\b/i)
  })
})

describe('rail icons', () => {
  const rail = readFileSync('src/renderer/src/components/Rail.tsx', 'utf8')

  it('uses game-metaphor glyphs: id card, backpack, gear', () => {
    expect(rail).toMatch(/status: IdCard,/)
    expect(rail).toMatch(/inventory: Backpack\b/)
    expect(rail).toMatch(/'art-bible': Palette\b/)
    expect(rail).toMatch(/systems: Settings,/)
  })

  it('uses no gauge, chip or folder glyph', () => {
    expect(rail).not.toMatch(/\b(Gauge|Cpu|FolderOpen)\b/)
  })
})

describe('menu keyboard (the File menu)', () => {
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
