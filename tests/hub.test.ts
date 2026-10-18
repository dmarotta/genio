// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { App, preloadScreens } from '../src/renderer/src/App'
import { getState, setState } from '../src/renderer/src/store'
import type { Project } from '../src/shared/types'

let root: Root, host: HTMLDivElement
const open = vi.fn(), pick = vi.fn(), add = vi.fn(), remove = vi.fn()
const project = (name: string): Project => ({ name, path: `C:/${name}`, addedAt: '2026-10-13', engine: 'godot',
  defaultBranch: 'main', mode: 'local-only', yolo: false, branchPrefix: 'genio/', forge: 'none', commands: {}, managed: false })
// Screens load on first use; load them up front so renders are synchronous.
beforeAll(async () => { await preloadScreens() })
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  vi.clearAllMocks()
  open.mockResolvedValue(undefined)
  pick.mockResolvedValue('C:/picked')
  add.mockResolvedValue(project('added'))
  Object.assign(window, { genio: { api: { projectOpen: open, pickDirectory: pick, projectAdd: add, projectRemove: remove, projectMetadata: async () => ({}) } } })
  const state = getState()
  setState({ booted: true, connected: true, view: 'worlds', settings: { ...state.settings, fx: false, firstRunDone: false, harnesses: [] } as typeof state.settings,
    snap: { ...state.snap, projects: [project('alpha'), project('beta')] }, toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
const render = async () => { await act(async () => root.render(React.createElement(App))) }
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text))!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

it('shows only project selection even on first run and ignores work shortcuts', async () => {
  await render()
  expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['File', ' Settings', ' Open folder…', ' Clone', 'alphaC:/alpha', '', 'betaC:/beta', ''])
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))
  })
  expect(host.querySelector('h1')?.textContent).toBe('Choose a project')
  expect(document.querySelector('.rail, .palette, .onboard, .presence, .hud-stats')).toBeNull()
})

it('has Settings with only the global pages, from its gear button and Ctrl+,', async () => {
  await render()
  await click('Settings')
  expect(getState().view).toBe('systems')
  expect([...host.querySelectorAll('.sys-group')].map(g => g.textContent)).toEqual(['All projects', 'Advanced'])
  expect(host.querySelector('.sys-link.on')?.textContent).toBe('General')
  expect(host.querySelector('.sys-in-project')).toBeNull()
  expect(host.querySelector('h1')?.textContent).not.toBe('Choose a project')
  await click('Projects')
  expect(host.querySelector('h1')?.textContent).toBe('Choose a project')
  // Ctrl+, reopens the last page; a project page asked for in the Hub falls back to General.
  localStorage.setItem('genio.settings.last', 'units')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true })) })
  expect(host.querySelector('.sys-link.on')?.textContent).toBe('Units')
  const nav = await import('../src/renderer/src/lib/settings-nav')
  await act(async () => nav.openSettings('project-delivery'))
  expect(host.querySelector('.sys-link.on')?.textContent).toBe('General')
  expect(host.textContent).not.toContain('Delivery')
})

it('removes a project from its quiet Hub item with a plain confirmation, through the guarded service', async () => {
  remove.mockResolvedValue({ ok: true })
  await render()
  const item = host.querySelector<HTMLButtonElement>('button[aria-label="Remove alpha from Genio"]')!
  expect(item.textContent).toBe('')
  await act(async () => item.click())
  const dialog = document.querySelector('.modal')!
  expect(dialog.querySelector('.modal-title')?.textContent).toBe('Remove alpha from the list?')
  expect(dialog.querySelector('.modal-body')).toBeNull()
  expect([...dialog.querySelectorAll('.modal-foot button')].map(b => b.textContent?.trim())).toEqual(['Cancel', 'Remove'])
  const confirm = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Remove')!
  expect(confirm.disabled).toBe(false)
  await act(async () => confirm.click())
  expect(remove).toHaveBeenCalledWith('alpha', false)
  expect(open).not.toHaveBeenCalled()
})

it('shows the service refusal as an error toast when a project cannot be removed', async () => {
  remove.mockResolvedValue({ ok: false, message: 'alpha has live units' })
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove alpha from Genio"]')!.click())
  const confirm = [...document.querySelectorAll('.modal button')].find(b => b.textContent?.trim() === 'Remove') as HTMLButtonElement
  await act(async () => confirm.click())
  expect(getState().toasts).toEqual([expect.objectContaining({ level: 'error', title: 'Remove project', body: 'alpha has live units' })])
})

it('offers to delete only a clone Genio made, off by default', async () => {
  remove.mockResolvedValue({ ok: true })
  const state = getState()
  setState({ snap: { ...state.snap, projects: [{ ...project('alpha'), managed: true }] } })
  await render()
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove alpha from Genio"]')!.click())
  const dialog = document.querySelector('.modal')!
  expect(dialog.querySelector('.confirm-body')?.textContent).toBe("Also delete Genio's clone from disk")
  const toggle = dialog.querySelector<HTMLInputElement>('.confirm-body input[type="checkbox"]')!
  expect(toggle.checked).toBe(false)
  await act(async () => toggle.click())
  const confirm = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Remove')!
  await act(async () => confirm.click())
  expect(remove).toHaveBeenCalledWith('alpha', true)
})

it('opens selected projects and restores their order on the next Hub mount', async () => {
  await render(); await click('beta')
  expect(open).toHaveBeenCalledWith('C:/beta')
  await act(async () => root.unmount())
  root = createRoot(host)
  await render()
  expect(host.querySelector('.hub-project strong')?.textContent).toBe('beta')
})

it('opens a picked folder and does nothing when the picker is cancelled', async () => {
  await render(); await click('Open folder')
  expect(open).toHaveBeenCalledWith('C:/picked')
  pick.mockResolvedValueOnce(undefined)
  await click('Open folder')
  expect(open).toHaveBeenCalledTimes(1)
})

it('has no New project: an empty folder is opened like any other', async () => {
  await render()
  expect(host.textContent).not.toContain('New project')
  setState({ snap: { ...getState().snap, projects: [] } })
  await render()
  expect(host.textContent).toContain('No recent projects. Open a folder, even an empty one.')
})
it('clones from the Hub with only a repository URL and opens the registered project', async () => {
  await render(); await click('Clone')
  const source = document.querySelector('.modal input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, 'owner/repository')
    source.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelectorAll('.modal input')).toHaveLength(1)
  expect([...document.querySelectorAll('.modal-foot button')].map(b => b.textContent?.trim())).toEqual(['Cancel', 'Clone'])
  const confirm = [...document.querySelectorAll('.modal-foot button')].find(button => button.textContent?.trim() === 'Clone') as HTMLButtonElement
  await act(async () => confirm.click())
  expect(add).toHaveBeenCalledWith({ source: 'owner/repository' })
  expect(open).toHaveBeenCalledWith('C:/added')
})

it('keeps project search in the Hub', async () => {
  await render()
  const search = host.querySelector('input[aria-label="Search projects"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'beta')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...host.querySelectorAll('.hub-project strong')].map(node => node.textContent)).toEqual(['beta'])
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...host.querySelectorAll('.hub-project strong')].map(node => node.textContent)).toEqual(['alpha', 'beta'])
})

it('keeps failed opens out of recents and leaves the selection usable', async () => {
  open.mockRejectedValueOnce(new Error('Folder unavailable'))
  await render(); await click('beta')
  expect(document.body.textContent).toContain('Folder unavailable')
  expect(localStorage.getItem('genio.hub.recent-projects')).toBeNull()
  expect((host.querySelector('.hub-project') as HTMLButtonElement).disabled).toBe(false)
})


it('shows no choices, counts or history from any project, even with choices pending', async () => {
  const state = getState()
  const now = new Date().toISOString()
  setState({ answersOpen: true, answerHistory: 'answered', snap: { ...state.snap, decisions: [
    { id: 'choice', key: 'k', project: 'beta', wksp: 'beta', question: 'Which route?', options: ['A'], source: 'genio', urgency: 'normal', createdAt: now },
    { id: 'answered', key: 'k', project: 'beta', wksp: 'beta', question: 'Old choice?', answer: 'Yes', resolvedAt: now, options: [], source: 'genio', urgency: 'normal', createdAt: now }
  ] } })
  await render()
  expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['File', ' Settings', ' Open folder…', ' Clone', 'alphaC:/alpha', '', 'betaC:/beta', ''])
  expect(document.querySelector('.answers-float, .answer-card, .chip')).toBeNull()
  expect(document.body.textContent).not.toMatch(/Which route\?|Old choice\?|waiting|Pending answers/)
  await act(async () => setState({ snap: { ...state.snap, decisions: [] }, answerHistory: undefined }))
})
