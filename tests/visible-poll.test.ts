// @vitest-environment jsdom
/** Fallback polls skip while the window is minimized and catch up once when it is shown again. */
import { afterEach, expect, it, vi } from 'vitest'
import { pollWhileVisible } from '../src/renderer/src/lib/visible-poll'

let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
afterEach(() => { vi.useRealTimers(); hidden = false })
const show = (h: boolean): void => { hidden = h; document.dispatchEvent(new Event('visibilitychange')) }

it('runs on schedule while visible, not while hidden, and once on return', () => {
  vi.useFakeTimers()
  const run = vi.fn()
  const stop = pollWhileVisible(run, 1000)
  vi.advanceTimersByTime(3000)
  expect(run).toHaveBeenCalledTimes(3)
  show(true)
  vi.advanceTimersByTime(10_000)
  expect(run).toHaveBeenCalledTimes(3)
  show(false)
  expect(run).toHaveBeenCalledTimes(4)
  vi.advanceTimersByTime(1000)
  expect(run).toHaveBeenCalledTimes(5)
  // Hidden and shown again before anything came due: nothing extra.
  show(true); show(false)
  expect(run).toHaveBeenCalledTimes(5)
  stop()
  vi.advanceTimersByTime(5000); show(true); show(false)
  expect(run).toHaveBeenCalledTimes(5)
})
