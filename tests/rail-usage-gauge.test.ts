// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeterRow, UsagePolicyView } from '../src/shared/usage-mode'
import { RailMeter, gaugeLine, gaugeTone } from '../src/renderer/src/components/PlanMeter'

const now = new Date().toISOString()
const soon = new Date(Date.now() + 3 * 3600_000).toISOString()

const row = (plan: 'claude' | 'codex', used: number | undefined, extra: Partial<MeterRow> = {}): MeterRow => {
  const level = used === undefined ? 'ok' : used >= 95 ? 'out' : used >= 85 ? 'hot' : used >= 70 ? 'warm' : 'ok'
  const headline = used === undefined ? undefined : { label: '5-hour', state: 'known' as const, usedPercent: used, leftPercent: 100 - used, resetsAt: soon, observedAt: now }
  return { plan, label: plan === 'claude' ? 'Claude' : 'Codex', source: `reported by ${plan === 'claude' ? 'Claude Code' : 'Codex'}`, level, headline, windows: headline ? [headline] : [], missing: [], ...extra }
}

const view = (meter: MeterRow[]): UsagePolicyView => ({
  generatedAt: now, mode: 'balanced', chat: { model: 'claude-sonnet-5-5', effort: 'medium', pinnedModel: false, pinnedEffort: false },
  bot: { model: 'x', pinned: false }, units: { defaultHarness: 'codex' }, unitCap: 8, liveUnits: 2, worlds: [], plans: [], meter,
  notices: [], waiting: [], cheap: { allowed: true, why: '' }
})

describe('gauge tone', () => {
  it('maps used percent to green, amber and red and takes the worst provider', () => {
    expect(gaugeTone([gaugeLine(row('claude', 40)), gaugeLine(row('codex', 10))])).toBe('ok')
    expect(gaugeTone([gaugeLine(row('claude', 72)), gaugeLine(row('codex', 10))])).toBe('warm')
    expect(gaugeTone([gaugeLine(row('claude', 72)), gaugeLine(row('codex', 90))])).toBe('hot')
    expect(gaugeTone([gaugeLine(row('claude', 10)), gaugeLine(row('codex', 99))])).toBe('hot')
  })

  it('is gray when a provider is unknown and nothing is worse, never green without data', () => {
    expect(gaugeTone([gaugeLine(row('claude', 40)), gaugeLine(row('codex', undefined))])).toBe('unknown')
    expect(gaugeTone([gaugeLine(row('claude', 80)), gaugeLine(row('codex', undefined))])).toBe('warm')
    expect(gaugeTone([])).toBe('unknown')
  })

  it('treats a reached limit as red and explains an unknown value instead of a bare "?"', () => {
    const limit = gaugeLine(row('claude', undefined, { level: 'out', headline: { label: 'weekly', state: 'limit', leftPercent: 0 } }))
    expect(limit).toMatchObject({ tone: 'hot', usedPercent: 100, window: 'weekly' })
    expect(gaugeLine(row('codex', undefined, { error: 'codex not signed in' })).error).toBe('Could not read usage: codex not signed in')
    expect(gaugeLine(row('codex', undefined)).error).toBe('No usage report yet.')
    const expired = gaugeLine(row('codex', undefined, { headline: { label: 'weekly', state: 'unknown' } }))
    expect(expired.error).toMatch(/weekly window/)
  })

  it('reads fields a newer report puts on the row when the window lacks them', () => {
    const r = { ...row('codex', undefined), usedPercent: 50.4, windowLabel: 'weekly', resetsAt: soon, fetchedAt: now } as MeterRow
    expect(gaugeLine(r)).toMatchObject({ usedPercent: 50, window: 'weekly', resetsAt: soon, fetchedAt: now, tone: 'ok', error: undefined })
  })
})

describe('rail usage gauge', () => {
  let host: HTMLDivElement
  let root: Root

  const mount = async (v: UsagePolicyView | Error): Promise<HTMLElement> => {
    Object.assign(window, { genio: { api: { usagePolicy: vi.fn(async () => { if (v instanceof Error) throw v; return v }) } } })
    await act(async () => root.render(React.createElement(RailMeter)))
    return host.querySelector('.rail-gauge') as HTMLElement
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('is one focusable, non-clickable icon coloured by the worst plan', async () => {
    const g = await mount(view([row('claude', 88), row('codex', 20)]))
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(g.tagName).toBe('DIV')
    expect(g.tabIndex).toBe(0)
    expect(g.className).toContain('tone-hot')
    expect(g.getAttribute('aria-label')).toBe('Plan usage, 85% or more used: Claude 88% used, Codex 20% used')
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
    expect(host.textContent).not.toMatch(/CL|CD/)
  })

  it('shows per-plan details, mode and unit cap on hover and closes on leave', async () => {
    const g = await mount(view([row('claude', 72), row('codex', undefined, { error: 'rate-limit file missing' })]))
    expect(g.className).toContain('tone-warm')
    await act(async () => g.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const pop = host.querySelector('[role="tooltip"]')!
    expect(pop).not.toBeNull()
    expect(g.getAttribute('aria-describedby')).toBe(pop.id)
    const text = pop.textContent!
    expect(text).toContain('Claude')
    expect(text).toContain('72% used')
    expect(text).toContain('5-hour window')
    expect(text).toMatch(/resets /)
    expect(text).toMatch(/fetched .* ago · reported by Claude Code/)
    expect(text).toContain('Codex')
    expect(text).toContain('Could not read usage: rate-limit file missing')
    expect(text).toContain('Usage mode Balanced · unit cap 8')
    expect(text).not.toContain('?')
    expect(pop.querySelectorAll('.gauge-row .bar')).toHaveLength(2)
    await act(async () => g.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('opens on keyboard focus and closes on Escape or blur', async () => {
    const g = await mount(view([row('claude', 10), row('codex', 5)]))
    expect(g.className).toContain('tone-ok')
    await act(async () => g.focus())
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
    await act(async () => g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => { g.blur(); g.focus() })
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull()
    await act(async () => g.blur())
    expect(host.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('is gray with a readable error when usage cannot be read at all', async () => {
    const g = await mount(new Error('ipc down'))
    expect(g.className).toContain('tone-unknown')
    expect(g.getAttribute('aria-label')).toBe('Plan usage, unknown: unknown')
    await act(async () => g.focus())
    expect(host.querySelector('[role="tooltip"]')!.textContent).toContain('Could not refresh usage')
  })
})
