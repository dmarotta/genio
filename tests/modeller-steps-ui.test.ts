// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModellerLive } from '../src/shared/modeller'
import { ModellerCardView, ModellerSteps } from '../src/renderer/src/components/ModellerSteps'

const BASE = `genio-media://model/${'a'.repeat(32)}/modeller/tower/steps`
const step = (n: number, caption: string) => ({ id: `s00${n}`, n, caption, triangles: 100 * n, parts: n, ms: 1500, at: 0, glb: `${BASE}/s00${n}/model.glb`, view: `${BASE}/s00${n}/view.png` })
const state = (patch: Partial<ModellerLive> = {}): ModellerLive => ({
  model: 'tower', branch: 'main', checks: [], running: null, failure: null, next: null, stamp: '1',
  steps: [step(1, 'Legs'), step(2, 'Deck'), step(3, 'Roof')], ...patch
})
let root: Root, host: HTMLDivElement
const text = (): string => host.textContent ?? ''
const render = async (el: React.ReactElement): Promise<void> => { await act(async () => root.render(el)) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('Modeller Steps tab', () => {
  it('is a plain list of steps, newest first, each with its render, caption and triangles', async () => {
    await render(React.createElement(ModellerSteps, { live: state() }))
    const imgs = [...host.querySelectorAll('.ms-step img')].map(i => i.getAttribute('src'))
    expect(imgs).toEqual([`${BASE}/s003/view.png`, `${BASE}/s002/view.png`, `${BASE}/s001/view.png`])
    expect([...host.querySelectorAll('.ms-title')].map(e => e.textContent)).toEqual(['3 · Roof', '2 · Deck', '1 · Legs'])
    expect(host.querySelector('.ms-step.current .ms-title')!.textContent).toBe('3 · Roof')
    expect([...host.querySelectorAll('.ms-meta')].map(e => e.textContent)).toEqual(['300 triangles', '200 triangles', '100 triangles'])
  })

  it('has no buttons, no branch name, no warnings and no checks', async () => {
    await render(React.createElement(ModellerSteps, { live: state({ branch: 'from-s001', checks: ['Over budget: 2802 triangles, budget 2000.'] }) }))
    expect(host.querySelectorAll('button, select, [role="dialog"]')).toHaveLength(0)
    expect(text()).not.toMatch(/branch|from-s001|warning|Revert|Checks|Over budget/i)
  })

  it('shows the step Blender runs at the top, and an empty state before the first step', async () => {
    await render(React.createElement(ModellerSteps, { live: state({ running: { id: 's004', n: 4, caption: 'Railing', startedAt: 0 } }) }))
    expect(host.querySelector('.ms-step.running .ms-title')!.textContent).toBe('4 · Railing')
    expect(host.querySelectorAll('.ms-step')).toHaveLength(4)
    expect(text()).not.toContain('running in Blender')
    await render(React.createElement(ModellerSteps, { live: state({ steps: [] }) }))
    expect(text()).toBe('No steps yet.')
  })
})
describe('Modeller Squad card', () => {
  it('shows the latest render with what the unit is doing now', async () => {
    await render(React.createElement(ModellerCardView, { live: state() }))
    expect(host.querySelector('img')!.getAttribute('src')).toBe(`${BASE}/s003/view.png`)
    expect(text()).toBe('Step 3 · Roof')
    await render(React.createElement(ModellerCardView, { live: state({ running: { id: 's004', n: 4, caption: 'Railing', startedAt: 0 } }) }))
    expect(text()).toBe('Step 4 · Railing…')
    await render(React.createElement(ModellerCardView, { live: state({ steps: [], failure: { id: 's001', n: 1, caption: 'Legs', kind: 'error' } }) }))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.modeller-card-caption')!.className).toContain('warn')
  })

  it('is an empty frame before the unit started a model', async () => {
    await render(React.createElement(ModellerCardView, { live: null }))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.modeller-card-empty')!.textContent).toBe('')
    expect(text()).toBe('No steps yet')
  })
})
