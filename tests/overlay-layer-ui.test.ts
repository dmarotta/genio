// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '../src/shared/types'
const fixture = vi.hoisted(() => ({ projects: [] as Project[], update: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  useStore: (selector: (s: unknown) => unknown) => selector({ settings: {}, snap: { projects: fixture.projects, tasks: [], allies: [], inbox: [] } }),
  PROJECT_WINDOW: 'Zebra', saveSettings: vi.fn(),
  api: () => ({ projectMetadata: async () => ({}), projectPushStatus: async () => ({ ahead: 0, behind: 0 }), projectUpdate: fixture.update, playPool: async () => ({ cap: 1, slots: [], queue: [] }), playPoolDisk: async () => ({}) }),
  hasView: () => false, go: vi.fn(), openDeploy: vi.fn(),
  op: async (_: string, fn: () => unknown) => fn(), setState: vi.fn(), toast: vi.fn(), errText: String
}))
import { Systems, requestSystemsSection } from '../src/renderer/src/views/Systems'
import { Modal } from '../src/renderer/src/components/ui'
import { LAYER_ROOT_ID, Popover, popoverPosition } from '../src/renderer/src/components/Layer'

const project: Project = { name: 'Zebra', path: 'C:/games/Zebra', engine: 'godot', commands: {}, defaultBranch: 'main', mode: 'local-only', forge: 'none', yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '' }
let root: Root | undefined
let host: HTMLDivElement
async function render(el: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root!.render(el))
}
const layer = () => document.getElementById(LAYER_ROOT_ID)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.clearAllMocks() })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Settings dialogs render over the window, not inside the page card', () => {
  async function openAutoLoot() {
    fixture.projects = [{ ...project }]
    await render(React.createElement(Systems))
    await act(async () => requestSystemsSection('project-delivery'))
    const toggle = document.getElementById('settings-merge-finished-work-automatically')?.querySelector('input') ?? [...host.querySelectorAll('label.field')]
      .find((f) => f.querySelector('.label')?.textContent === 'Merge finished work automatically')!.querySelector('input')!
    toggle.focus()
    await act(async () => toggle.click())
    return toggle
  }

  it('portals the Auto-loot confirm to the layer root with both action buttons', async () => {
    await openAutoLoot()
    const card = host.querySelector('.sys-body.panel')!
    const d = dialog()!
    expect(d).toBeTruthy()
    expect(d.parentElement).toBe(layer())
    expect(layer()!.parentElement).toBe(document.body)
    expect(card.contains(d)).toBe(false)
    expect(host.contains(d)).toBe(false)
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Merge finished work automatically in Zebra?')
    const foot = d.querySelector('.modal-foot')!
    expect([...foot.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Turn on Auto-loot'])
    // Focus moves into the dialog, on the safe choice.
    expect(document.activeElement).toBe(button(d, 'Cancel'))
  })

  it('keeps Tab inside, closes on Esc and returns focus to the toggle; Auto-loot logic is unchanged', async () => {
    const toggle = await openAutoLoot()
    const d = dialog()!
    const confirm = button(d, 'Turn on Auto-loot')!
    confirm.focus()
    await key(confirm, 'Tab')
    expect(document.activeElement).toBe(button(d, 'Close') ?? d.querySelector('[aria-label="Close"]'))
    await key(document.activeElement!, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    await key(confirm, 'Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(fixture.update).not.toHaveBeenCalled()

    await act(async () => toggle.click())
    await act(async () => button(dialog()!, 'Turn on Auto-loot')!.click())
    expect(fixture.update).toHaveBeenCalledExactlyOnceWith('Zebra', { yolo: true })
    expect(dialog()).toBeNull()
  })

  it('closes on a backdrop click but not on a click inside', async () => {
    await openAutoLoot()
    await act(async () => { dialog()!.querySelector('.modal-body')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(dialog()).toBeTruthy()
    await act(async () => { dialog()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(dialog()).toBeNull()
  })
})

describe('Stacked dialogs', () => {
  it('lets only the topmost dialog answer Esc', async () => {
    const outer = vi.fn(), inner = vi.fn()
    function Stack() {
      const [open, setOpen] = useState(false)
      return React.createElement(Modal, { title: 'Outer', onClose: outer, children: [
        React.createElement('button', { key: 'b', onClick: () => setOpen(true) }, 'confirm…'),
        open && React.createElement(Modal, { key: 'm', title: 'Inner', onClose: () => { inner(); setOpen(false) }, children: React.createElement('button', null, 'inside') })
      ] })
    }
    await render(React.createElement(Stack))
    await act(async () => button(document, 'confirm…')!.click())
    expect([...document.querySelectorAll('[role="dialog"]')].map((d) => d.querySelector('.modal-title')!.textContent)).toEqual(['Outer', 'Inner'])
    await key(button(document, 'inside')!, 'Escape')
    expect([inner.mock.calls.length, outer.mock.calls.length]).toEqual([1, 0])
    await key(document.body, 'Escape')
    expect(outer).toHaveBeenCalledOnce()
  })
})

describe('Popovers', () => {
  function Menu({ onClose }: { onClose: (how: string) => void }) {
    const anchor = useRef<HTMLButtonElement>(null)
    return React.createElement('div', { className: 'panel card' },
      React.createElement('button', { ref: anchor }, 'More'),
      React.createElement(Popover, { anchor, placement: 'bottom-end', role: 'menu', className: 'unit-menu', onClose, children: React.createElement('button', { role: 'menuitem' }, 'Recall') }))
  }

  it('render in the layer root, outside the clipping panel, and close on outside clicks and Esc only', async () => {
    const onClose = vi.fn()
    await render(React.createElement(Menu, { onClose }))
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.parentElement).toBe(layer())
    expect(host.querySelector('.panel')!.contains(menu)).toBe(false)
    expect(menu.style.position).toBe('fixed')
    await act(async () => { menu.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { button(host, 'More')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onClose).toHaveBeenLastCalledWith('outside')
    await key(menu.querySelector('button')!, 'Escape')
    expect(onClose).toHaveBeenLastCalledWith('escape')
  })

  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height })
  const view = { width: 880, height: 640 }
  it('sits beside the anchor, flips when the window edge is near, and stays inside the window', () => {
    expect(popoverPosition('bottom-start', box(100, 50, 60, 26), { width: 200, height: 120 }, view)).toMatchObject({ left: 100, top: 82 })
    expect(popoverPosition('bottom-end', box(700, 50, 60, 26), { width: 200, height: 120 }, view)).toMatchObject({ left: 560, top: 82 })
    // No room below: above the anchor.
    expect(popoverPosition('bottom-start', box(100, 560, 60, 26), { width: 200, height: 120 }, view)).toMatchObject({ top: 434 })
    // Right of a rail button, or left of it near the right edge.
    expect(popoverPosition('right-start', box(0, 100, 56, 40), { width: 270, height: 200 }, view, 12)).toMatchObject({ left: 68, top: 100 })
    expect(popoverPosition('right-end', box(800, 500, 56, 40), { width: 270, height: 200 }, view, 12)).toMatchObject({ left: 518, top: 340 })
    // Never off screen, even when wider than the room on either side.
    expect(popoverPosition('bottom-end', box(20, 50, 30, 26), { width: 340, height: 120 }, view).left).toBe(8)
    expect(popoverPosition('bottom-start', box(20, 50, 30, 26), { width: 340, height: 900 }, view)).toMatchObject({ top: 8, maxHeight: 624 })
    // Slash menu: above the composer, across the input box.
    expect(popoverPosition('top-span', box(0, 500, 880, 140), { width: 300, height: 180 }, view, 4, box(28, 560, 824, 50))).toEqual({ left: 28, top: 316, width: 824, maxHeight: 488 })
  })
})
