// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InventoryContext } from '../src/shared/inventory-context'
import { clearDraft, getDraftContext } from '../src/renderer/src/drafts'
const f = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({ useStore: (fn: (s: unknown) => unknown) => fn({ snap: { wksps: [] }, chats: {} }) }))
vi.mock('../src/renderer/src/views/Comms', async () => {
  const { useInventoryContext } = await import('../src/renderer/src/components/InventoryContextChips')
  return { ChatPanel: ({ wksp, context }: { wksp: string; context: InventoryContext }) => {
    const c = useInventoryContext(wksp, context)
    return React.createElement('div', null, c.chips, React.createElement('button', { onClick: () => f.send(c.context) }, 'Test send'), React.createElement('button', { onClick: () => c.restore({ world: 'saved', folder: 'Old' }) }, 'Test restore'))
  } }
})
import { InventoryChat } from '../src/renderer/src/components/InventoryChat'
let root: Root, host: HTMLDivElement
const context = (world = 'alpha', file = 'Assets/tree.png'): InventoryContext => ({ world, folder: 'Assets', preview: { path: file, kind: 'image', size: 42, mtimeMs: 1, generated: false }, selection: [{ path: 'Assets/other.png', kind: 'image', size: 1, mtimeMs: 1, generated: false }, { path: file, kind: 'image', size: 42, mtimeMs: 1, generated: false }] })
const render = async (c = context()) => { await act(async () => root.render(React.createElement(InventoryChat, { context: c, inspector: React.createElement('div', null, 'Inspector content') }))) }
const button = (label: string): HTMLButtonElement => host.querySelector(`[aria-label="${label}"]`) ?? [...host.querySelectorAll('button')].find(b => b.textContent === label)!
const click = async (label: string) => { await act(async () => button(label).click()) }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  sessionStorage.clear(); clearDraft('main'); f.send.mockClear()
  host = document.createElement('div'); document.body.append(host)
  Object.defineProperties(host, { clientWidth: { value: 1200 }, clientHeight: { value: 600 } })
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('removes chips from sends and keeps dismissals while collapsed; browser changes update live', async () => {
  await render(); await click('Remove preview context'); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).not.toHaveProperty('preview')
  await click('Collapse Genio chat'); await click('Expand Genio chat'); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).not.toHaveProperty('preview')
  await render(context('beta', 'Assets/stone.png')); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ world: 'beta', preview: { path: 'Assets/stone.png' } })
  await click('Remove folder context'); await click('Remove preview context'); await click('Remove selection context'); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toBeUndefined()
})

it('preserves an edited queued snapshot independently of browsing and across panel remounts', async () => {
  await render(); await click('Test restore'); await render(context('beta')); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toEqual({ world: 'saved', folder: 'Old' })
  expect(getDraftContext('main')).toMatchObject({ world: 'saved', folder: 'Old' })
  await act(async () => root.render(null)); await render(); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ world: 'saved', folder: 'Old' })
})

it('moves and resizes with pointer capture, snaps, and remembers the window layout', async () => {
  await render()
  const gesture = async (label: string, dx: number, dy: number) => {
    const el = button(label)
    el.setPointerCapture = vi.fn()
    await act(async () => {
      for (const [type, x, y] of [['pointerdown', 400, 150], ['pointermove', 400 + dx, 150 + dy], ['pointerup', 400 + dx, 150 + dy]] as const) {
        const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
        Object.defineProperty(e, 'pointerId', { value: 1 })
        el.dispatchEvent(e)
      }
    })
  }
  // jsdom has no layout, so give the host its actual test bounds for edge snapping.
  host.getBoundingClientRect = () => ({ right: 1200 } as DOMRect)
  await gesture('Move Genio chat', -100, -50)
  const moved = JSON.parse(sessionStorage.getItem('genio.inventory.chat')!)
  expect(moved).toMatchObject({ x: 260, y: 60 })
  await gesture('Resize Genio chat', -80, -40)
  const resized = JSON.parse(sessionStorage.getItem('genio.inventory.chat')!)
  expect(resized).toMatchObject({ width: 420, height: 390 })
  await click('Snap Genio chat'); expect(host.querySelector('.inventory-chat.snapped')).not.toBeNull()
  await click('Inspector'); expect(host.querySelector('.inventory-chat-content')?.hasAttribute('hidden')).toBe(true)
  await click('Chat'); await click('Collapse Genio chat')
  await act(async () => root.render(null)); await render()
  expect(host.querySelector('.inventory-chat.snapped.collapsed')).not.toBeNull()
  await click('Expand Genio chat'); await click('Float Genio chat')
  expect((host.querySelector('.inventory-chat') as HTMLElement).style.width).toBe('420px')
})
