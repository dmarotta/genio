// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/renderer/src/App'
import { getState, setState } from '../src/renderer/src/store'
import type { Project } from '../src/shared/types'

let root: Root, host: HTMLDivElement
const open = vi.fn(), pick = vi.fn(), create = vi.fn(), add = vi.fn(), sync = vi.fn()
const project = (name: string): Project => ({ name, path: `C:/${name}`, addedAt: '2026-10-13', engine: 'godot',
  defaultBranch: 'main', mode: 'local-only', yolo: false, branchPrefix: 'genio/', forge: 'none', commands: {}, managed: false })
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  vi.clearAllMocks()
  open.mockResolvedValue(undefined)
  pick.mockResolvedValue('C:/picked')
  create.mockResolvedValue(project('created'))
  add.mockResolvedValue(project('added'))
  Object.assign(window, { genio: { api: { projectOpen: open, pickDirectory: pick, projectCreate: create, projectAdd: add, projectSync: sync, projectMetadata: async () => ({}) } } })
  const state = getState()
  setState({ booted: true, connected: true, view: 'worlds', settings: { ...state.settings, fx: false, firstRunDone: false } as typeof state.settings,
    snap: { ...state.snap, projects: [project('alpha'), project('beta')] }, toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })
const render = async () => { await act(async () => root.render(React.createElement(App))) }
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

it('shows only project selection even on first run and ignores work shortcuts', async () => {
  await render()
  expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual([' Open folder…', ' Add project', ' New project', ' Sync all', 'alphaC:/alphaGodot', 'betaC:/betaGodot'])
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))
    setState({ view: 'systems' })
  })
  expect(host.querySelector('h1')?.textContent).toBe('Choose a project')
  expect(host.querySelector('.rail, .palette, .onboard, .presence, .hud-stats')).toBeNull()
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

it('creates a project and opens its project window', async () => {
  await render(); await click('New project')
  const name = host.querySelector('.modal input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'created')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Create')
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'created', createRemote: false }))
  expect(open).toHaveBeenCalledWith('C:/created')
})

it('adds a repository from the Hub and opens the registered project', async () => {
  await render(); await click('Add project')
  const source = host.querySelector('.modal input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(source, 'owner/repository')
    source.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const confirm = [...host.querySelectorAll('.modal button')].find(button => button.textContent?.includes('Add project')) as HTMLButtonElement
  await act(async () => confirm.click())
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ source: 'owner/repository', mode: undefined }))
  expect(open).toHaveBeenCalledWith('C:/added')
})

it('preserves project search, sorting and sync-all in the Hub', async () => {
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
    const sort = host.querySelector('select[aria-label="Sort projects"]') as HTMLSelectElement
    sort.value = 'name'; sort.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect([...host.querySelectorAll('.hub-project strong')].map(node => node.textContent)).toEqual(['alpha', 'beta'])
  await click('Sync all')
  expect(sync).toHaveBeenCalledWith()
})

it('keeps failed opens out of recents and leaves the selection usable', async () => {
  open.mockRejectedValueOnce(new Error('Folder unavailable'))
  await render(); await click('beta')
  expect(host.textContent).toContain('Folder unavailable')
  expect(localStorage.getItem('genio.hub.recent-projects')).toBeNull()
  expect((host.querySelector('.hub-project') as HTMLButtonElement).disabled).toBe(false)
})


it('shows waiting counts for closed projects while keeping their persisted choices accessible', async () => {
  const state = getState()
  setState({ answersOpen: false, snap: { ...state.snap, decisions: [{ id: 'choice', key: 'k', project: 'beta', wksp: 'beta', question: 'Which route?', options: [], source: 'genio', urgency: 'normal', createdAt: new Date().toISOString() }] } })
  await render()
  expect(host.querySelectorAll('.hub-project')[1]?.textContent).toContain('1 choices waiting')
  await click('Pending answers and history')
  expect(host.textContent).toContain('Which route?')
  expect(open).not.toHaveBeenCalled()
  await act(async () => setState({ snap: { ...state.snap, decisions: [] }, answersOpen: true }))
})


it('opens history from the Hub even when all choices are already answered', async () => {
  const state = getState()
  setState({ answersOpen: true, answerHistory: undefined, snap: { ...state.snap, decisions: [{ id: 'answered', key: 'k', project: 'beta', wksp: 'beta', question: 'Old choice?', answer: 'Yes', resolvedAt: new Date().toISOString(), options: [], source: 'genio', urgency: 'normal', createdAt: new Date().toISOString() }] } })
  await render()
  expect(host.textContent).not.toContain('Old choice?')
  await click('Pending answers and history')
  expect(host.textContent).toContain('Old choice?')
  await act(async () => setState({ snap: { ...state.snap, decisions: [] }, answerHistory: undefined, answersOpen: true }))
})


it('refreshes a closed project waiting count as its deferred choice becomes due', async () => {
  vi.useFakeTimers()
  const state = getState()
  setState({ answersOpen: false, answerHistory: undefined, snap: { ...state.snap, decisions: [{ id: 'later', key: 'k', project: 'beta', wksp: 'beta', question: 'Deferred route?', until: new Date(Date.now() + 10_000).toISOString(), options: [], source: 'genio', urgency: 'normal', createdAt: new Date().toISOString() }] } })
  await render()
  expect(host.querySelectorAll('.hub-project')[1]?.textContent).not.toContain('choices waiting')
  await act(async () => vi.advanceTimersByTime(30_000))
  expect(host.querySelectorAll('.hub-project')[1]?.textContent).toContain('1 choices waiting')
  await act(async () => setState({ snap: { ...state.snap, decisions: [] }, answersOpen: true }))
})
