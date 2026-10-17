// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/types'

let App: typeof import('../src/renderer/src/App').App
let store: typeof import('../src/renderer/src/store')
let root: Root, host: HTMLDivElement
const project = (name: string): Project => ({ name, path: `C:/${name}`, addedAt: '2026-10-13', engine: 'godot',
  defaultBranch: 'main', mode: 'local-only', yolo: false, branchPrefix: 'genio/', forge: 'none', commands: {}, managed: false })
beforeAll(async () => {
  window.history.replaceState({}, '', '?project=alpha&wksp=ally-alpha')
  vi.resetModules()
  store = await import('../src/renderer/src/store')
  ;({ App } = await import('../src/renderer/src/App'))
}, 120_000)
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  localStorage.clear()
  localStorage.setItem('genio.hub.recent-projects', JSON.stringify(['C:/beta']))
  const api = new Proxy({}, { get: () => async () => undefined })
  Object.assign(window, { genio: { api, on: () => () => {} } })
  const state = store.getState()
  store.setState({ booted: true, connected: true, view: 'systems', answersOpen: false,
    settings: { ...state.settings, fx: false, firstRunDone: true, harnesses: [] } as typeof state.settings,
    snap: { ...state.snap, projects: [project('alpha')] }, toasts: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('adds its own project to the recents the Hub sorts by, since the Hub closes as it opens', async () => {
  await act(async () => root.render(React.createElement(App)))
  expect(JSON.parse(localStorage.getItem('genio.hub.recent-projects')!)).toEqual(['C:/alpha', 'C:/beta'])
})

it('floats pending cards over the screen without changing the layout underneath', async () => {
  const state = store.getState()
  const decisions = [1, 2, 3, 4, 5, 6].map(i => ({ id: `c${i}`, key: 'k', project: 'alpha', wksp: 'ally-alpha', question: `Route ${i}?`, options: ['A'], source: 'genio' as const, urgency: 'normal' as const, createdAt: `2026-10-13T10:0${i}:00Z` }))
  store.setState({ snap: { ...state.snap, decisions } })
  await act(async () => root.render(React.createElement(App)))
  const body = host.querySelector('.app-body')!
  const without = body.outerHTML
  await act(async () => store.setState({ answersOpen: true }))
  const lane = host.querySelector('.answers-float')!
  expect(lane.querySelectorAll('.answer-card')).toHaveLength(3)
  expect(body.contains(lane)).toBe(false)
  expect(body.outerHTML).toBe(without)
  await act(async () => store.setState({ snap: { ...state.snap, decisions: [] } }))
})
