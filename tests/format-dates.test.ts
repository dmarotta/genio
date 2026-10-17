/**
 * The shared date formatters print exactly what toLocale*String printed before they were cached,
 * invalid dates included, and stay fast enough to call per message.
 */
import { expect, it } from 'vitest'
import { clock, dateShort, dateTime } from '../src/renderer/src/lib/format'

const DATES = ['2026-10-17T07:05:00Z', '2026-01-01T00:00:00.000Z', '2026-06-30T23:59:59+02:00', '1999-12-31T12:00:00Z', 'not a date']

it('matches toLocaleTimeString, toLocaleDateString and toLocaleString', () => {
  for (const iso of DATES) {
    expect(clock(iso)).toBe(new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    expect(dateShort(iso)).toBe(new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }))
    expect(dateTime(iso)).toBe(new Date(iso).toLocaleString())
    expect(dateTime(Date.parse(iso))).toBe(new Date(Date.parse(iso)).toLocaleString())
  }
  expect(clock(undefined)).toBe('')
  expect(dateShort('')).toBe('')
})

it('formats a long transcript of timestamps several times faster than building a formatter per call', () => {
  const stamps = Array.from({ length: 2000 }, (_, i) => new Date(Date.UTC(2026, 9, 17, 0, i)).toISOString())
  const time = (fn: () => void): number => { const t = performance.now(); fn(); return performance.now() - t }
  time(() => stamps.forEach(clock))
  const cached = time(() => stamps.forEach(clock))
  const fresh = time(() => stamps.forEach((s) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
  expect(cached * 3).toBeLessThan(fresh)
})
