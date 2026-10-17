// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsagePolicyView } from '../src/shared/usage-mode'
const nav = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../src/renderer/src/lib/settings-nav', () => ({ openSettings: nav.open }))
import { Rail } from '../src/renderer/src/components/Rail'
import { RailMeter } from '../src/renderer/src/components/PlanMeter'
import { handleEvent, setState } from '../src/renderer/src/store'

describe('the sign-in warning on the rail', () => {
  let host: HTMLDivElement
  let root: Root
  const systems = (): HTMLElement => host.querySelector('button[aria-label^="Systems"], button[aria-label^="Settings"]') as HTMLElement

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { genio: { api: { usagePolicy: vi.fn(async () => new Promise(() => {})) } } })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    nav.open.mockClear()
    setState({ signIn: [] })
    await act(async () => root.render(React.createElement(Rail)))
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('shows nothing while Claude and Codex are signed in', () => {
    expect(host.querySelector('.rail-badge.amber')).toBeNull()
    expect(host.textContent).not.toContain('not signed in')
  })

  it('names the tool that needs a sign-in, opens Accounts on click, and clears itself', async () => {
    await act(async () => handleEvent({ type: 'sign-in-needed', tools: ['Codex'] }))
    expect(host.querySelector('.rail-badge.amber')?.textContent).toBe('1')
    expect(host.textContent).toContain('Codex is not signed in')
    expect(host.textContent).not.toContain('Claude is not signed in')
    const label = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.includes('not signed in'))!
    await act(async () => label.click())
    expect(nav.open).toHaveBeenCalledWith('accounts')
    await act(async () => handleEvent({ type: 'sign-in-needed', tools: ['Claude', 'Codex'] }))
    expect(host.textContent).toContain('Claude is not signed in')
    expect(host.textContent).toContain('Codex is not signed in')
    await act(async () => handleEvent({ type: 'sign-in-needed', tools: [] }))
    expect(host.querySelector('.rail-badge.amber')).toBeNull()
    expect(host.textContent).not.toContain('not signed in')
  })
})

describe('the usage popup without Codex', () => {
  it('shows only the plans in the view: no Codex row, no error text, when Codex is not signed in', async () => {
    const now = new Date().toISOString()
    const claude = { plan: 'claude' as const, label: 'Claude', level: 'ok' as const, windows: [], missing: [], headline: { label: '5-hour', state: 'known' as const, usedPercent: 30, leftPercent: 70, observedAt: now } }
    const v = { generatedAt: now, mode: 'balanced', unitCap: 8, meter: [claude] } as unknown as UsagePolicyView
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { genio: { api: { usagePolicy: vi.fn(async () => v) } } })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(React.createElement(RailMeter)))
    const g = host.querySelector('.rail-gauge') as HTMLElement
    await act(async () => g.focus())
    const text = document.querySelector('[role="tooltip"]')!.textContent!
    expect(text).toContain('Claude')
    expect(text).not.toMatch(/Codex|not available|could not/i)
    await act(async () => root.unmount())
    host.remove()
  })
})
