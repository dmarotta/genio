// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PlanStatus, UsagePolicyView } from '../src/shared/usage-mode'

const f = vi.hoisted(() => ({ enabled: true, view: null as UsagePolicyView | null, project: '', limit: undefined as unknown }))
vi.mock('../src/renderer/src/store', () => ({
  get PROJECT_WINDOW() { return f.project }, PROJECT_WKSP: 'ally',
  useStore: (select: (s: unknown) => unknown) => select({
    snap: { wksps: [{ name: 'ally', activity: 'ready', limit: f.limit }], allies: [] },
    terminals: {}, chats: { ally: [] }, settings: { quotaProtection: f.enabled }
  }),
  api: () => ({}), loadChat: vi.fn(), toast: vi.fn(), errText: String, saveSettings: vi.fn(), go: vi.fn()
}))
vi.mock('../src/renderer/src/components/ModelSelect', () => ({ ModelSelect: () => null, EffortSelect: () => null }))
vi.mock('../src/renderer/src/components/PlanMeter', () => ({ useUsagePolicy: () => f.view }))

import { ChatPanel } from '../src/renderer/src/views/Comms'
import { go } from '../src/renderer/src/store'
import { takePendingSection } from '../src/renderer/src/lib/settings-nav'

let host: HTMLDivElement, root: Root, serial = 0
const plan = (level: PlanStatus['level'], provider: PlanStatus['plan'] = 'claude'): PlanStatus => ({ plan: provider, level, known: true })
const view = (...plans: PlanStatus[]): UsagePolicyView => ({ quotaProtection: true, plans, heldLaunches: [] }) as unknown as UsagePolicyView
const render = (both = false) => act(() => root.render(React.createElement(React.Fragment, null,
  React.createElement(ChatPanel, { wksp: 'ally', surface: 'screen' }),
  both && React.createElement(ChatPanel, { wksp: 'ally', surface: 'panel' }))))
const notices = () => host.querySelectorAll('[data-quota-protection]')
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  f.project = `island-${serial++}`; f.enabled = true; f.view = null; f.limit = undefined
  localStorage.clear(); vi.clearAllMocks(); takePendingSection()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('shows one boxed warning above the content in both chat surfaces only while protection acts, including both plans and waiting launches', async () => {
  await render(true)
  expect(notices()).toHaveLength(0)
  f.view = view(plan('ok')); await render(true)
  expect(notices()).toHaveLength(0)
  f.view = view(plan('warm'), plan('hot', 'codex'))
  f.view.heldLaunches = [{ project: f.project, title: 'Build the castle', plan: 'codex' }, { project: 'elsewhere', title: 'Other work', plan: 'codex' }]
  await render(true)
  expect(notices()).toHaveLength(2)
  for (const notice of notices()) {
    expect(notice.className).toBe('chat-limit quota-protection')
    expect(notice.parentElement?.firstElementChild).toBe(notice)
    expect(notice.closest('.chat-viewport')).toBeNull()
    expect(notice.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(notice.querySelector('.btn.amber')?.textContent).toBe('Settings')
    expect(notice.textContent).toContain('Claude is at 70%+ used, so Genio runs one Claude unit at a time.')
    expect(notice.textContent).toContain('Codex is at 85%+ used: new Codex units wait.')
    expect(notice.textContent).toContain('Build the castle')
    expect(notice.textContent).not.toContain('Other work')
    expect(notice.querySelectorAll('button')).toHaveLength(2) // Settings and the requested dismiss control
  }
  f.view = view(plan('ok')); await render(true)
  expect(notices()).toHaveLength(0)
})

it('reserves clearance for choice cards and toasts as the warning resizes or moves, and releases it when protection stops', async () => {
  let bottom = 140
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.hasAttribute('data-quota-protection') ? { width: 400, height: 80, bottom } : { width: 0, height: 0, bottom: 0 }) as DOMRect
  })
  f.view = view(plan('warm')); await render()
  const clearance = () => document.documentElement.style.getPropertyValue('--quota-notice-bottom')
  expect(clearance()).toBe('150px')
  bottom = 190
  window.dispatchEvent(new Event('resize'))
  expect(clearance()).toBe('200px')
  f.view = view(plan('ok')); await render()
  expect(clearance()).toBe('')
})

it('shares dismissal across surfaces and remounts, returning only when a plan worsens', async () => {
  f.view = view(plan('warm')); await render(true)
  await act(() => (notices()[0].querySelector('[aria-label="Dismiss quota protection warning"]') as HTMLButtonElement).click())
  expect(notices()).toHaveLength(0)
  expect(localStorage.getItem(`genio.quota-dismissed.${f.project}.claude`)).toBe('1')
  await act(() => root.render(null)); await render(true)
  expect(notices()).toHaveLength(0)
  f.view = view(plan('ok')); await render(true)
  f.view = view(plan('warm')); await render(true)
  expect(notices()).toHaveLength(0)
  f.view = view(plan('hot')); await render(true)
  expect(notices()).toHaveLength(2)
  await act(() => (notices()[0].querySelector('[aria-label="Dismiss quota protection warning"]') as HTMLButtonElement).click())
  f.view = view(plan('out')); await render(true)
  expect(notices()[0].textContent).toContain('95%+ used')
})

it('opens Usage & limits at the protection switch', async () => {
  f.view = view(plan('hot')); await render()
  await act(() => (notices()[0].querySelector('button') as HTMLButtonElement).click())
  expect(go).toHaveBeenCalledWith('systems')
  expect(takePendingSection()).toEqual({ page: 'usage', anchor: 'setting-quota-protection' })
})

it('switching off hides a hot warning immediately and preserves the provider limit line', async () => {
  f.view = view(plan('out')); await render()
  expect(notices()).toHaveLength(1)
  f.enabled = false
  f.limit = { reason: 'Claude limit reached', restartRequired: false }
  await render()
  expect(notices()).toHaveLength(0)
  expect(host.textContent).toContain('Claude limit reached')
  expect(host.textContent).toContain('Retry now')
})
