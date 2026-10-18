// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InventoryContext } from '../src/shared/inventory-context'
import type { ChatMessage } from '../src/shared/types'
import { clearDraft, getDraftContext } from '../src/renderer/src/drafts'
const f = vi.hoisted(() => ({ send: vi.fn(), state: { view: 'inventory', snap: { workspaces: [] }, chats: { 'project-chat': [] as ChatMessage[] }, generating: {} as Record<string, string[]> } }))
vi.mock('../src/renderer/src/store', () => ({ PROJECT_WORKSPACE: 'project-chat', PROJECT_WINDOW: 'alpha', useStore: (fn: (s: unknown) => unknown) => fn(f.state) }))
vi.mock('../src/renderer/src/views/Comms', async () => {
  const { useInventoryContext } = await import('../src/renderer/src/components/InventoryContextChips')
  return { ChatPanel: ({ workspace, context }: { workspace: string; context: InventoryContext }) => {
    const c = useInventoryContext(workspace, context)
    return React.createElement('div', null, c.chips, React.createElement('button', { onClick: () => f.send(c.context) }, 'Test send'), React.createElement('button', { onClick: () => c.restore({ world: 'saved', folder: 'Old' }) }, 'Test restore'))
  } }
})
import { GenioPanel } from '../src/renderer/src/components/GenioPanel'
import { openGenioPanel, publishScreenContext } from '../src/renderer/src/lib/screen-context'
let root: Root, host: HTMLDivElement, size: { width: number; height: number }
const inventory = (world = 'alpha', file = 'Assets/tree.png') => ({ world, folder: 'Assets', preview: { path: file, kind: 'image' as const, size: 42, mtimeMs: 1, generated: false }, selection: [{ path: 'Assets/other.png', kind: 'image' as const, size: 1, mtimeMs: 1, generated: false }, { path: file, kind: 'image' as const, size: 42, mtimeMs: 1, generated: false }] })
const render = async (view = f.state.view) => { f.state = { ...f.state, view }; await act(async () => root.render(React.createElement(GenioPanel))) }
const browse = async (c = inventory()) => { await act(async () => publishScreenContext('inventory', c)); await render() }
const button = (label: string): HTMLButtonElement => host.querySelector(`[aria-label="${label}"]`) ?? [...host.querySelectorAll('button')].find(b => b.textContent === label)!
const click = async (label: string) => { await act(async () => button(label).click()) }
const panel = () => host.querySelector('.genio-panel') as HTMLElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  localStorage.clear(); clearDraft('project-chat'); f.send.mockClear()
  f.state = { view: 'inventory', snap: { workspaces: [] }, chats: { 'project-chat': [] }, generating: {} }
  publishScreenContext('inventory', inventory())
  host = document.createElement('div'); document.body.append(host)
  size = { width: 1200, height: 600 }
  Object.defineProperties(host, { clientWidth: { get: () => size.width }, clientHeight: { get: () => size.height } })
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); publishScreenContext('inventory', undefined); publishScreenContext('squad', undefined); vi.restoreAllMocks() })

it('moves the mounted chat into an OS window and returns it with dismissals and live context intact', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentWindow!
  child.document.body.innerHTML = '<div id="root"></div>'
  vi.spyOn(child, 'close').mockImplementation(() => { child.dispatchEvent(new Event('beforeunload')) })
  const open = vi.spyOn(window, 'open').mockReturnValue(child)
  await render(); await click('Remove preview context')
  const mountedChat = host.querySelector('.genio-panel-slot .genio-panel-content')
  await click('Pop out Genio chat')
  expect(open.mock.calls[0][0]).toContain('#genio-chat-panel')
  await act(async () => child.dispatchEvent(new Event('load')))
  expect(child.document.querySelector('.genio-panel-content')).toBe(mountedChat)
  const send = () => [...child.document.querySelectorAll('button')].find(b => b.textContent === 'Test send')!.click()
  await act(async () => send())
  expect(f.send.mock.lastCall?.[0]).not.toHaveProperty('preview')
  await browse(inventory('beta', 'Assets/stone.png'))
  await act(async () => send())
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ world: 'beta', preview: { path: 'Assets/stone.png' }, screen: { id: 'inventory' } })
  await click('Return chat')
  expect(host.querySelector('.genio-panel-slot .genio-panel-content')).toBe(mountedChat)
  expect(child.close).toHaveBeenCalledOnce()
  frame.remove()
})

it('restores chat when the native window closes and reports a denied popup', async () => {
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentWindow!
  child.document.body.innerHTML = '<div id="root"></div>'
  vi.spyOn(child, 'close').mockImplementation(() => {})
  const open = vi.spyOn(window, 'open').mockReturnValue(child)
  await render(); await click('Pop out Genio chat')
  await act(async () => child.dispatchEvent(new Event('load')))
  await act(async () => child.dispatchEvent(new Event('beforeunload')))
  expect(button('Test send')).toBeTruthy()
  open.mockReturnValue(null)
  await click('Pop out Genio chat')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not open')
  frame.remove()
})

it('notices new messages while collapsed, with no counts', async () => {
  await render(); await click('Collapse Genio chat')
  f.state.chats = { 'project-chat': [{ id: 'new', workspace: 'project-chat', role: 'genio', text: 'done', ts: 'now' }] }
  f.state.generating = { 'project-chat': ['gen-1', 'g-2'] }
  await render()
  expect(button('Expand Genio chat').textContent).toContain('New')
  expect(button('Expand Genio chat').textContent).not.toContain('generating')
})

it('shows Inventory picks as removable chips, sends the screen context without a chip and follows screen changes', async () => {
  await render()
  // the screen context is mandatory: no chip, no remove control, only Inventory's picks
  expect([...host.querySelectorAll('.inventory-context-chip')].map(c => c.textContent)).toEqual(['Assets', 'tree.png', '2 selected'])
  expect(host.querySelector('[aria-label="Remove screen context"]')).toBeNull()
  await click('Remove preview context'); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).not.toHaveProperty('preview')
  await click('Collapse Genio chat'); await click('Expand Genio chat'); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).not.toHaveProperty('preview')
  await browse(inventory('beta', 'Assets/stone.png')); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ world: 'beta', preview: { path: 'Assets/stone.png' } })
  await act(async () => publishScreenContext('squad', { facts: [{ label: 'Unit', value: 'Build HUD [t-1]' }] }))
  await render('squad')
  expect(host.querySelector('.genio-panel-grip')?.textContent).toBe(' Genio')
  // a screen-only context renders nothing above the composer, yet still goes with every send
  expect(host.querySelector('.inventory-context')).toBeNull()
  expect(host.querySelector('[aria-label^="Remove "]')).toBeNull()
  await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toEqual({ world: 'alpha', screen: { id: 'squad', label: 'Squad', facts: [{ label: 'Unit', value: 'Build HUD [t-1]' }] } })
})

it('preserves an edited queued snapshot independently of browsing and across panel remounts', async () => {
  await render(); await click('Test restore'); await browse(inventory('beta')); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toEqual({ world: 'saved', folder: 'Old' })
  expect(getDraftContext('project-chat')).toMatchObject({ world: 'saved', folder: 'Old' })
  await act(async () => root.render(null)); await render(); await click('Test send')
  expect(f.send.mock.lastCall?.[0]).toMatchObject({ world: 'saved', folder: 'Old' })
})

it('is hidden on the main Chat screen only, and Ctrl+Space toggles it elsewhere', async () => {
  await render('comms')
  expect(panel().hidden).toBe(true)
  expect(host.querySelector('.genio-panel-content')?.childElementCount ?? 0).toBe(0)
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'Space' })))
  expect(panel().classList.contains('collapsed')).toBe(false)
  for (const view of ['squad', 'quests', 'systems', 'play', 'inventory', 'status']) {
    await render(view)
    expect(panel().hidden, view).toBe(false)
  }
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, code: 'Space' })))
  expect(panel().classList.contains('collapsed')).toBe(true)
  await act(async () => openGenioPanel())
  expect(panel().classList.contains('floating')).toBe(true)
})

it('floats freely with pointer drag and resize, stays on screen when the window shrinks, and remembers the layout per project', async () => {
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
  // Default: bottom-right of the stage.
  expect(panel().style).toMatchObject({ left: '740px', top: '80px', width: '460px', height: '520px' })
  await gesture('Move Genio chat', -500, -50)
  expect(JSON.parse(localStorage.getItem('genio.panel.alpha')!)).toMatchObject({ x: 240, y: 30 })
  // Dropping at the right edge does not snap: it just stays where it is clamped.
  await gesture('Move Genio chat', 5000, 0)
  expect(JSON.parse(localStorage.getItem('genio.panel.alpha')!)).toMatchObject({ x: 740, y: 30 })
  await gesture('Resize Genio chat from top left', -100, -20)
  expect(JSON.parse(localStorage.getItem('genio.panel.alpha')!)).toMatchObject({ x: 640, y: 10, width: 560, height: 540 })
  await gesture('Resize Genio chat', -120, -100)
  expect(JSON.parse(localStorage.getItem('genio.panel.alpha')!)).toMatchObject({ width: 440, height: 440 })
  // A narrow window pulls it back on screen without forgetting the preferred layout.
  size = { width: 380, height: 300 }
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(panel().style).toMatchObject({ left: '0px', top: '0px', width: '380px', height: '300px' })
  expect(JSON.parse(localStorage.getItem('genio.panel.alpha')!)).toMatchObject({ x: 640, width: 440 })
  size = { width: 1200, height: 600 }
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(panel().style).toMatchObject({ left: '640px', top: '10px', width: '440px' })
  await click('Collapse Genio chat')
  await act(async () => root.render(null)); await render()
  expect(panel().classList.contains('collapsed')).toBe(true)
  await click('Expand Genio chat')
  expect(panel().style.width).toBe('440px')
})
