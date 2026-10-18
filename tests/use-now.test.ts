// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useNow } from '../src/renderer/src/lib/use-now'

it('shares one timer, limits slow renders and releases the ticker after the last subscriber', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z') })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'), root = createRoot(host)
  const renders = { a: 0, b: 0, slow: 0 }
  function Clock({ id, ms = 1000 }: { id: keyof typeof renders; ms?: number }) {
    const now = useNow(ms)
    renders[id]++
    return React.createElement('span', { id }, String(now))
  }
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Clock, { id: 'a' }), React.createElement(Clock, { id: 'b' }),
      React.createElement(Clock, { id: 'slow', ms: 30_000 }))))
    expect(vi.getTimerCount()).toBe(1)
    const before = { ...renders }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(renders).toEqual({ a: before.a + 1, b: before.b + 1, slow: before.slow })
    expect(host.querySelector('#a')!.textContent).toBe(host.querySelector('#b')!.textContent)
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
    expect(renders.slow).toBe(before.slow + 1)
    expect(host.querySelector('#slow')!.textContent).toBe(String(Date.now()))
    await act(async () => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    await act(async () => root.render(React.createElement(Clock, { id: 'a' })))
    expect(host.textContent).toBe(String(Date.now()))
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  }
})
