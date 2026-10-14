// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { WindowList } from '../src/shared/api'

// The store reads the window's project from its URL when first imported.
window.history.replaceState(null, '', '/?project=one&wksp=ally-one')
let FileMenu: typeof import('../src/renderer/src/components/FileMenu').FileMenu
beforeAll(async () => { ({ FileMenu } = await import('../src/renderer/src/components/FileMenu')) })

let root: Root, host: HTMLDivElement
const api = { projectOpen: vi.fn(), pickDirectory: vi.fn(), windowList: vi.fn(), windowOpenHub: vi.fn(), windowClose: vi.fn(), appQuit: vi.fn() }
const list: WindowList = {
  projects: [{ name: 'one', path: 'C:/one', addedAt: '2026-10-01' }, { name: 'alpha', path: 'C:/alpha', addedAt: '2026-09-01' }, { name: 'beta', path: 'C:/beta', addedAt: '2026-08-01' }],
  windows: [{ project: 'one', current: true }, { project: null, current: false }, { project: 'beta', current: false }]
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  localStorage.setItem('genio.hub.recent-projects', JSON.stringify(['C:/beta', 'C:/alpha']))
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(undefined)
  api.pickDirectory.mockResolvedValue('C:/picked')
  api.windowList.mockResolvedValue(list)
  Object.assign(window, { genio: { api } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(React.createElement(FileMenu)))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

const fileButton = () => host.querySelector('.file-menu-btn') as HTMLButtonElement
const items = () => [...host.querySelectorAll('[aria-label="File"] > [role="menuitem"]')].map(b => b.textContent)
const subItems = () => [...host.querySelectorAll('.file-submenu [role="menuitem"]')] as HTMLButtonElement[]
const item = (text: string) => [...host.querySelectorAll('[role="menuitem"]')].find(b => b.textContent?.startsWith(text)) as HTMLButtonElement
const press = async (key: string, target: Element = document.activeElement!, init: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })

it('shows the File entries with their shortcuts, the recent projects and the open window count', async () => {
  await act(async () => fileButton().click())
  expect(api.windowList).toHaveBeenCalledOnce()
  expect(items()).toEqual(['Open project…Ctrl O', 'Open recent', 'New window / HubCtrl N', 'Open windows3', 'Close windowCtrl W', 'Exit GenioCtrl Q'])
  await act(async () => item('Open recent').click())
  expect(subItems().map(b => b.textContent)).toEqual(['betaOpen', 'alpha'])
  await act(async () => item('alpha').click())
  expect(api.projectOpen).toHaveBeenCalledExactlyOnceWith('C:/alpha')
  expect(JSON.parse(localStorage.getItem('genio.hub.recent-projects')!)).toEqual(['C:/alpha', 'C:/beta'])
  expect(host.querySelector('[role="menu"]')).toBeNull()
})

it('opens a picked folder through projectOpen and opens nothing when the picker is cancelled', async () => {
  await act(async () => fileButton().click())
  await act(async () => item('Open project').click())
  expect(api.pickDirectory).toHaveBeenCalledOnce()
  expect(api.projectOpen).toHaveBeenCalledExactlyOnceWith('C:/picked')
  api.pickDirectory.mockResolvedValueOnce(null)
  await act(async () => fileButton().click())
  await act(async () => item('Open project').click())
  expect(api.projectOpen).toHaveBeenCalledOnce()
})

it('keeps a failed open out of the recent projects', async () => {
  api.projectOpen.mockRejectedValueOnce(new Error('Folder unavailable'))
  await act(async () => fileButton().click())
  await act(async () => item('Open recent').click())
  await act(async () => item('alpha').click())
  expect(JSON.parse(localStorage.getItem('genio.hub.recent-projects')!)).toEqual(['C:/beta', 'C:/alpha'])
})

it('is fully keyboard driven, including submenus', async () => {
  fileButton().focus()
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toBe('Open project…Ctrl O')
  await press('ArrowDown'); await press('ArrowDown'); await press('ArrowDown')
  expect(document.activeElement?.textContent).toBe('Open windows3')
  await press('ArrowRight')
  expect(subItems().map(b => b.textContent)).toEqual(['oneThis window', 'Hub', 'beta'])
  expect(document.activeElement).toBe(subItems()[0])
  await press('ArrowLeft')
  expect(subItems()).toEqual([])
  expect(document.activeElement?.textContent).toBe('Open windows3')
  await press('Enter')
  await press('ArrowDown')
  await press('Enter')
  expect(api.windowOpenHub).toHaveBeenCalledOnce()
  expect(host.querySelector('[role="menu"]')).toBeNull()
  fileButton().focus()
  await press('ArrowDown'); await press('End')
  expect(document.activeElement?.textContent).toBe('Exit GenioCtrl Q')
  await press('Escape')
  expect(host.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(fileButton())
  expect(api.appQuit).not.toHaveBeenCalled()
})

it('runs Close window and Exit Genio from the menu and from their window-local accelerators', async () => {
  await act(async () => fileButton().click())
  await act(async () => item('Close window').click())
  expect(api.windowClose).toHaveBeenCalledOnce()
  await act(async () => fileButton().click())
  await act(async () => item('Exit Genio').click())
  expect(api.appQuit).toHaveBeenCalledOnce()
  for (const [key, fn] of [['w', api.windowClose], ['q', api.appQuit], ['n', api.windowOpenHub], ['o', api.pickDirectory]] as const) {
    await press(key, window as unknown as Element, { ctrlKey: true })
    expect(fn).toHaveBeenCalledTimes(key === 'n' || key === 'o' ? 1 : 2)
  }
  // A field or terminal that already handled the key keeps it.
  const field = document.createElement('input')
  field.addEventListener('keydown', e => e.preventDefault())
  host.append(field)
  await press('w', field, { ctrlKey: true })
  expect(api.windowClose).toHaveBeenCalledTimes(2)
})
