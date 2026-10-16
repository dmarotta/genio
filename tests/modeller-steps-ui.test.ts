// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModellerLive } from '../src/shared/modeller'
import type { Task } from '../src/shared/types'
const f = vi.hoisted(() => ({ act: vi.fn(), toast: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  api: () => ({ modellerAct: f.act }),
  op: async (label: string, fn: () => Promise<unknown>) => { const r = await fn(); f.toast(label, r); return r }
}))
vi.mock('../src/renderer/src/components/ui', () => ({
  Confirm: ({ title, body, confirmLabel, onConfirm, onClose }: { title: string; body: React.ReactNode; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void }) =>
    React.createElement('div', { role: 'dialog', 'aria-label': title }, body,
      React.createElement('button', { onClick: async () => { await onConfirm(); onClose() } }, confirmLabel),
      React.createElement('button', { onClick: onClose }, 'Cancel'))
}))
import { ModellerCardView, ModellerSteps } from '../src/renderer/src/components/ModellerSteps'

const BASE = `genio-media://model/${'a'.repeat(32)}/modeller/tower/steps`
const step = (n: number, caption: string, warnings = 0) => ({ id: `s00${n}`, n, caption, triangles: 100 * n, parts: n, warnings, ms: 1500, glb: `${BASE}/s00${n}/model.glb`, view: `${BASE}/s00${n}/view.png` })
const state = (patch: Partial<ModellerLive> = {}): ModellerLive => ({
  model: 'tower', branch: 'main', branches: ['main'], checks: [], running: null, failure: null, stamp: '1',
  steps: [step(1, 'Legs'), step(2, 'Deck', 1), step(3, 'Roof')], ...patch
})
const unit = { id: 'u1', state: 'working' } as Task
let root: Root, host: HTMLDivElement
const text = (): string => host.textContent ?? ''
const button = (label: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!
const render = async (el: React.ReactElement): Promise<void> => { await act(async () => root.render(el)) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  f.act.mockResolvedValue({ ok: true, message: 'done' })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks() })

describe('Modeller Steps tab', () => {
  it('shows the branch as a thumbnail strip, newest first, with the head marked current', async () => {
    await render(React.createElement(ModellerSteps, { t: unit, live: state() }))
    const imgs = [...host.querySelectorAll('.ms-step img')].map(i => i.getAttribute('src'))
    expect(imgs).toEqual([`${BASE}/s003/view.png`, `${BASE}/s002/view.png`, `${BASE}/s001/view.png`])
    expect([...host.querySelectorAll('.ms-title')].map(e => e.textContent)).toEqual(['3 · Roof', '2 · Deck', '1 · Legs'])
    expect(host.querySelector('.ms-step.current .ms-title')!.textContent).toBe('3 · Roof')
    expect(text()).toContain('200 triangles · 2 parts · 1 warning')
    expect(button('Revert to 3')).toBeUndefined()
    expect(text()).toContain('branch main')
  })

  it('reverts after a confirm that says what leaves the branch, and branches at once', async () => {
    await render(React.createElement(ModellerSteps, { t: unit, live: state() }))
    await act(async () => button('Revert to 1').click())
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('2 later steps leave branch main')
    expect(f.act).not.toHaveBeenCalled()
    await act(async () => (host.querySelector('[role="dialog"] button') as HTMLButtonElement).click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(f.act).toHaveBeenCalledWith('u1', { op: 'revert', model: 'tower', step: 's001' })
    await act(async () => button('Branch from 2').click())
    expect(f.act).toHaveBeenLastCalledWith('u1', { op: 'branch', model: 'tower', step: 's002' })
  })

  it('switches branch, and locks every change while a step runs or after despawn', async () => {
    await render(React.createElement(ModellerSteps, { t: unit, live: state({ branches: ['main', 'from-s001'] }) }))
    const select = host.querySelector('select')!
    await act(async () => { select.value = 'from-s001'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(f.act).toHaveBeenCalledWith('u1', { op: 'switch', model: 'tower', branch: 'from-s001' })
    await render(React.createElement(ModellerSteps, { t: unit, live: state({ running: { id: 's004', n: 4, caption: 'Railing', startedAt: 0 } }) }))
    expect(text()).toContain('4 · Railing')
    expect(button('Branch from 2').disabled).toBe(true)
    expect(button('Branch from 2').title).toBe('Wait for step 4 to finish.')
    await render(React.createElement(ModellerSteps, { t: { ...unit, state: 'cleaned' } as Task, live: state() }))
    expect(button('Revert to 1').disabled).toBe(true)
  })

  it("lists the head step's checks as information only", async () => {
    await render(React.createElement(ModellerSteps, { t: unit, live: state() }))
    expect(text()).toContain('Checks on step 3 · information onlyNothing to report.')
    await render(React.createElement(ModellerSteps, { t: unit, live: state({ checks: ['Over budget: 2802 triangles, budget 2000.'] }) }))
    expect([...host.querySelectorAll('.ms-checks li')].map(l => l.textContent)).toEqual(['Over budget: 2802 triangles, budget 2000.'])
  })
})

describe('Modeller Squad card', () => {
  it('shows the latest render with what the unit is doing now', async () => {
    await render(React.createElement(ModellerCardView, { live: state() }))
    expect(host.querySelector('img')!.getAttribute('src')).toBe(`${BASE}/s003/view.png`)
    expect(text()).toBe('Step 3 · Roof')
    await render(React.createElement(ModellerCardView, { live: state({ running: { id: 's004', n: 4, caption: 'Railing', startedAt: 0 } }) }))
    expect(text()).toBe('Step 4 · Railing…')
    await render(React.createElement(ModellerCardView, { live: state({ steps: [], failure: { id: 's001', n: 1, caption: 'Legs', kind: 'error', error: 'x' } }) }))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.modeller-card-caption')!.className).toContain('warn')
  })
})
