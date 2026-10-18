import { expect, it } from 'vitest'
import { formatDuration } from '../src/shared/duration'
import { ago } from '../src/renderer/src/lib/format'

it.each([
  [0, '0s'], [999, '0s'], [59_000, '59s'], [60_000, '1m 0s'],
  [3_600_000, '1h 0m 0s'], [3_605_000, '1h 0m 5s'],
  [4_083_000, '1h 8m 3s'], [483_000, '8m 3s'], [42_000, '42s'],
  [90_000_000, '25h 0m 0s'], [-1000, '0s'], [NaN, '0s'], [Infinity, '0s']
])('formats %s ms as %s', (ms, expected) => {
  expect(formatDuration(ms)).toBe(expected)
})

it('offers the largest two units for coarse history, and minute precision for estimates', () => {
  expect(formatDuration(90_005_000, { largestTwoUnits: true })).toBe('1d 1h')
  expect(formatDuration(3_605_000, { largestTwoUnits: true })).toBe('1h 0m')
  expect(formatDuration(65_000, { largestTwoUnits: true })).toBe('1m 5s')
  expect(formatDuration(5000, { largestTwoUnits: true })).toBe('5s')
  expect(formatDuration(20 * 60_000, { precision: 'minutes' })).toBe('20m')
  expect(formatDuration(0, { precision: 'minutes' })).toBe('0m')
  expect(formatDuration(3_605_000, { precision: 'minutes' })).toBe('1h 0m')
})

it('uses the same coarse format for usage report ages, with safe missing dates', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  expect(ago('2026-10-18T10:59:00Z', now)).toBe('1h 1m')
  expect(ago('2026-10-17T11:00:00Z', now)).toBe('1d 1h')
  expect(ago('2026-10-18T11:59:59Z', now)).toBe('now')
  expect(ago(undefined, now)).toBe('—')
  expect(ago('invalid', now)).toBe('—')
})
