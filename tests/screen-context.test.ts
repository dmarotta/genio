import { describe, expect, it } from 'vitest'
import { chipKey, hasInventoryChips, inventoryContextBlock, MAX_SCREEN_FACTS, validateInventoryContext, visibleContext } from '../src/shared/inventory-context'
import { getScreenContext, listFact, panelVisibleOn, publishScreenContext, screenContextFor } from '../src/renderer/src/lib/screen-context'
import { clampFloatingPanel, PANEL_MIN } from '../src/renderer/src/lib/floating-panel'
import { navItems } from '../src/renderer/src/lib/railmenu'

describe('screen context registry', () => {
  it('keeps one entry per screen and clears it when the screen unpublishes', () => {
    publishScreenContext('squad', { facts: [{ label: 'Unit', value: 'Build HUD' }] })
    publishScreenContext('quests', { facts: [{ label: 'Quest', value: 'Boss fight' }] })
    expect(getScreenContext('squad')?.facts).toEqual([{ label: 'Unit', value: 'Build HUD' }])
    publishScreenContext('squad', undefined)
    expect(getScreenContext('squad')).toBeUndefined()
    expect(getScreenContext('quests')).toBeDefined()
    publishScreenContext('quests', undefined)
  })
  it('builds a default context for screens that publish nothing', () => {
    expect(screenContextFor('systems', 'forest')).toEqual({ world: 'forest', screen: { id: 'systems', label: 'Settings' } })
    expect(screenContextFor('status', 'forest').screen?.label).toBe('Character Sheet')
  })
})

describe('panel visibility', () => {
  it('shows the panel on every screen except the main Chat screen', () => {
    for (const { id } of navItems()) expect(panelVisibleOn(id), id).toBe(id !== 'comms')
  })
})

describe('panel geometry', () => {
  it('pulls a lost panel back inside the stage, shrinking it to fit a narrow window', () => {
    const s = { x: 900, y: 900, width: 700, height: 600, collapsed: false }
    expect(clampFloatingPanel(s, 600, 450)).toMatchObject({ x: 0, y: 0, width: 600, height: 450 })
    expect(clampFloatingPanel({ ...s, x: -300, y: -50 }, 1600, 900)).toMatchObject({ x: 0, y: 0, width: 700, height: 600 })
    expect(clampFloatingPanel({ ...s, x: 1500, y: 800 }, 1600, 900)).toMatchObject({ x: 900, y: 300 })
  })
  it('keeps the minimum size when there is room and floats freely without snapping', () => {
    const s = clampFloatingPanel({ x: 1180, y: 37, width: 10, height: 10, collapsed: false }, 1600, 900)
    expect(s).toMatchObject({ x: 1180, y: 37, width: PANEL_MIN.width, height: PANEL_MIN.height })
  })
})

describe('context serialization', () => {
  it('sends compact, single-line facts with the screen id and drops empty ones', () => {
    const c = screenContextFor('squad', 'forest', { facts: [{ label: 'Unit', value: 'Build\nHUD   now' }, false, { label: 'Empty', value: '  ' }, { label: 'Long', value: 'x'.repeat(500) }] })
    expect(c.screen?.facts?.[0]).toEqual({ label: 'Unit', value: 'Build HUD now' })
    expect(c.screen?.facts).toHaveLength(2)
    expect(c.screen?.facts?.[1].value.length).toBeLessThanOrEqual(300)
    const many = screenContextFor('quests', 'forest', { facts: Array.from({ length: 20 }, (_, i) => ({ label: `F${i}`, value: 'v' })) })
    expect(many.screen?.facts).toHaveLength(MAX_SCREEN_FACTS)
    const block = inventoryContextBlock(validateInventoryContext(c))
    expect(block.startsWith('\n\n[screen: ')).toBe(true)
    expect(JSON.parse(block.slice('\n\n[screen: '.length, -1))).toMatchObject({ world: 'forest', screen: { id: 'squad', label: 'Squad' } })
    expect(block.split('\n').filter(Boolean)).toHaveLength(1)
  })
  it('keeps Inventory chips as one provider of the shared context', () => {
    const c = screenContextFor('inventory', 'genio', { world: 'forest', folder: 'Assets', facts: [{ label: 'Visible', value: listFact(['a.png', 'b.png', 'c.png'], 40, 2) }] })
    expect(c).toMatchObject({ world: 'forest', folder: 'Assets', screen: { id: 'inventory', facts: [{ value: 'a.png, b.png +38' }] } })
    expect(hasInventoryChips(c)).toBe(true)
    expect(hasInventoryChips(screenContextFor('squad', 'forest'))).toBe(false)
  })
  it('always sends the screen context: only Inventory chips can be removed', () => {
    const c = { ...screenContextFor('inventory', 'forest', { facts: [{ label: 'Visible', value: 'a.png' }] }), folder: 'Assets' }
    expect(visibleContext(c, {})?.screen?.facts?.[0].value).toBe('a.png')
    const left = visibleContext(c, { folder: chipKey(c, 'folder') })
    expect(left).not.toHaveProperty('folder')
    expect(left?.screen?.id).toBe('inventory')
  })
  it('rejects malformed screen state at the IPC boundary', () => {
    expect(() => validateInventoryContext({ world: 'forest', screen: { id: 'Bad Id', label: 'x' } })).toThrow()
    expect(() => validateInventoryContext({ world: 'forest', screen: { id: 'squad', label: 'Squad', facts: [{ label: 'a', value: 'line\nbreak' }] } })).toThrow()
    expect(() => validateInventoryContext({ world: 'forest', screen: { id: 'squad', label: 'Squad', facts: Array(9).fill({ label: 'a', value: 'b' }) } })).toThrow()
    expect(validateInventoryContext({ world: 'forest', screen: { id: 'squad', label: 'Squad', extra: 'dropped' } as never }).screen).toEqual({ id: 'squad', label: 'Squad' })
  })
})
