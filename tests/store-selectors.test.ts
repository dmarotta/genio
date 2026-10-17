// @vitest-environment jsdom
/**
 * Selectors that always-mounted components use return the same value until their input changes, so a
 * streamed delta (one store change each) does not re-render the answer cards or the title bar.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { Decision } from '../src/shared/types'
import { getState, openDecisions, setState } from '../src/renderer/src/store'

const initial = getState()
afterEach(() => { vi.useRealTimers(); setState(initial) })
const choice = (id: string, extra: Partial<Decision> = {}): Decision => ({ id, key: 'k', wksp: 'genio', question: id, options: ['a', 'b'], source: 'unit', urgency: 'normal', createdAt: '2026-10-17T08:00:00Z', revision: 1, ...extra } as Decision)

it('keeps the pending choices list stable across unrelated store changes', () => {
  setState({ snap: { ...initial.snap, decisions: [choice('a'), choice('b', { resolvedAt: '2026-10-17T08:01:00Z' })] } })
  const first = openDecisions(getState())
  expect(first.map(d => d.id)).toEqual(['a'])
  setState({ chats: { genio: [] } })
  expect(openDecisions(getState())).toBe(first)
  setState({ snap: { ...getState().snap, decisions: [choice('a'), choice('c')] } })
  expect(openDecisions(getState()).map(d => d.id)).toEqual(['a', 'c'])
})

it('brings a deferred choice back exactly when its deferral ends', () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-17T09:00:00Z') })
  setState({ snap: { ...initial.snap, decisions: [choice('later', { until: '2026-10-17T09:05:00Z' }), choice('now')] } })
  const before = openDecisions(getState())
  expect(before.map(d => d.id)).toEqual(['now'])
  vi.setSystemTime(Date.parse('2026-10-17T09:04:59Z'))
  expect(openDecisions(getState())).toBe(before)
  vi.setSystemTime(Date.parse('2026-10-17T09:05:00Z'))
  expect(openDecisions(getState()).map(d => d.id)).toEqual(['later', 'now'])
})
