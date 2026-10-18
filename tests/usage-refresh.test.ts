import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { USAGE_REFRESH_INTERVAL, usageRefreshLoop } from '../src/main/usage-refresh'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('refreshes on startup without a screen, polls while work waits, skips idle probes and stops', async () => {
  let active = false
  const refresh = vi.fn(async () => true)
  const loop = usageRefreshLoop(refresh, () => active)
  loop.start(); loop.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(refresh).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL)
  expect(refresh).toHaveBeenCalledOnce()
  active = true
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL)
  expect(refresh).toHaveBeenCalledTimes(2)
  loop.stop()
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL * 10)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('backs off failing sources at 2, 4, 8, 16 and at most 30 minutes, then recovers', async () => {
  const refresh = vi.fn(async () => false)
  const loop = usageRefreshLoop(refresh, () => true)
  loop.start()
  await vi.advanceTimersByTimeAsync(0)
  for (const minutes of [2, 4, 8, 16, 30, 30]) {
    const count = refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1)
    expect(refresh).toHaveBeenCalledTimes(count)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(count + 1)
  }
  refresh.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  const count = refresh.mock.calls.length
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL)
  expect(refresh).toHaveBeenCalledTimes(count + 1)
  loop.stop()
})

it('does not overlap slow refreshes or reschedule after stopping an in-flight refresh', async () => {
  let finish!: (ok: boolean) => void
  const refresh = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const loop = usageRefreshLoop(refresh, () => true)
  loop.start()
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL * 10)
  expect(refresh).toHaveBeenCalledOnce()
  loop.stop()
  finish(true)
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL * 10)
  expect(refresh).toHaveBeenCalledOnce()
})
