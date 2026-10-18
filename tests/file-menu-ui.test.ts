// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { WindowList } from '../src/shared/api'

let FileMenu: typeof import('../src/renderer/src/components/FileMenu').FileMenu
let Toasts: typeof import('../src/renderer/src/components/Overlays').Toasts
let store: typeof import('../src/renderer/src/store')
beforeAll(async () => {
  ;({ FileMenu } = await import('../src/renderer/src/components/FileMenu'))
  ;({ Toasts } = await import('../src/renderer/src/components/Overlays'))
  store = await import('../src/renderer/src/store')
})

let root: Root, host: HTMLDivElement
const api = { projectOpen: vi.fn(), windowList: vi.fn(), windowOpenHub: vi.fn(), windowClose: vi.fn() }
const list: WindowList = {
  projects: [{ name: 'one', path: 'C:/one', addedAt: '2026-10-01' }, { name: 'alpha', path: 'C:/alpha', addedAt: '2026-09-01' }, { name: 'beta', path: 'C:/beta', addedAt: '2026-08-01' }],
  windows: [{ project: 'one', current: true }, { project: null, current: false }, { project: 'beta', current: false }]
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  localStorage.setItem('genio.hub.recent-projects', JSON.stringify(['C:/beta', 'C:/alpha']))
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue(undefined)
  api.windowList.mockResolvedValue(list)
  Object.assign(window, { genio: { api } })
  store.setState({ toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(FileMenu), React.createElement(Toasts))))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

const fileButton = () => host.querySelector('.file-menu-btn') as HTMLButtonElement
const items = () => [...document.querySelectorAll('[aria-label="File"] > [role="menuitem"]')].map(b => b.textContent)
const subItems = () => [...document.querySelectorAll('.file-submenu [role="menuitem"]')] as HTMLButtonElement[]
const item = (text: string) => [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent?.startsWith(text)) as HTMLButtonElement
const press = async (key: string, target: Element = document.activeElement!, init: KeyboardEventInit = {}) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })

it.each(['/', '/?project=one&workspace=ally-one'])('shows exactly three entries in window %s and opens or focuses recent projects', async url => {
  window.history.replaceState(null, '', url)
  await act(async () => fileButton().click())
  expect(api.windowList).toHaveBeenCalledOnce()
  expect(items()).toEqual(['HubCtrl N', 'Open Recent', 'Exit'])
  await act(async () => item('Open Recent').click())
  expect(subItems().map(b => b.textContent)).toEqual(['betaOpen', 'alpha', 'oneOpen'])
  await act(async () => item('beta').click())
  expect(api.projectOpen).toHaveBeenCalledExactlyOnceWith('C:/beta')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => fileButton().click())
  await act(async () => item('Open Recent').click())
  await act(async () => item('alpha').click())
  expect(api.projectOpen).toHaveBeenLastCalledWith('C:/alpha')
  expect(JSON.parse(localStorage.getItem('genio.hub.recent-projects')!)).toEqual(['C:/alpha', 'C:/beta'])
})

it('keeps a failed project open out of recent history', async () => {
  api.projectOpen.mockRejectedValueOnce(new Error('Folder unavailable'))
  await act(async () => fileButton().click())
  await act(async () => item('Open Recent').click())
  await act(async () => item('alpha').click())
  expect(JSON.parse(localStorage.getItem('genio.hub.recent-projects')!)).toEqual(['C:/beta', 'C:/alpha'])
})

it('opens the Hub and shows a readable toast on failure', async () => {
  await act(async () => fileButton().click())
  await act(async () => item('Hub').click())
  expect(api.windowOpenHub).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  api.windowOpenHub.mockRejectedValueOnce(new Error("Error invoking remote method 'genio:windowOpenHub': Error: Hub page unavailable"))
  await act(async () => fileButton().click())
  await act(async () => item('Hub').click())
  expect(document.querySelector('.toast.t-error .toast-title')?.textContent).toBe('Open Hub')
  expect(document.querySelector('.toast-body')?.textContent).toBe('Hub page unavailable')
})

it('shows a Hub failure from Ctrl+N and closes the File menu', async () => {
  api.windowOpenHub.mockRejectedValueOnce(new Error('Hub window manager is unavailable'))
  await act(async () => fileButton().click())
  await press('n', window as unknown as Element, { ctrlKey: true })
  expect(api.windowOpenHub).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('.toast-body')?.textContent).toBe('Hub window manager is unavailable')
})

it('supports keyboard navigation through Open Recent and back to Exit', async () => {
  fileButton().focus()
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toBe('HubCtrl N')
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toBe('Open Recent')
  await press('ArrowRight')
  expect(document.activeElement).toBe(subItems()[0])
  await press('ArrowLeft')
  expect(subItems()).toEqual([])
  expect(document.activeElement?.textContent).toBe('Open Recent')
  await press('Enter'); await press('ArrowDown'); await press('Enter')
  expect(api.projectOpen).toHaveBeenCalledExactlyOnceWith('C:/alpha')
  fileButton().focus()
  await press('ArrowDown'); await press('End')
  expect(document.activeElement?.textContent).toBe('Exit')
  await press('Escape')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(fileButton())
  expect(api.windowClose).not.toHaveBeenCalled()
})

it('Exit closes only its caller and only Hub has an accelerator', async () => {
  await act(async () => fileButton().click())
  await act(async () => item('Exit').click())
  expect(api.windowClose).toHaveBeenCalledOnce()
  for (const key of ['w', 'q', 'o']) await press(key, window as unknown as Element, { ctrlKey: true })
  expect(api.windowClose).toHaveBeenCalledOnce()
  expect(api.projectOpen).not.toHaveBeenCalled()
  expect(api.windowOpenHub).not.toHaveBeenCalled()
  await press('n', window as unknown as Element, { ctrlKey: true })
  expect(api.windowOpenHub).toHaveBeenCalledOnce()
  const field = document.createElement('input')
  field.addEventListener('keydown', e => e.preventDefault())
  host.append(field)
  await press('n', field, { ctrlKey: true })
  expect(api.windowOpenHub).toHaveBeenCalledOnce()
})
