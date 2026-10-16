import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { leaseSource, onSourceRemoved, sourceLeases, sourceRemoved, yieldSource } from '../src/main/source-leases'

// Folders here are never touched: the registry only compares paths.
const DIR = 'C:/units/never-created-lease-test'
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('lets a cleanup go at once when nothing reads the worktree', async () => {
  await expect(yieldSource(DIR)).resolves.toBe('free')
})

it('defers a cleanup until a read in progress finishes', async () => {
  const abort = vi.fn()
  const lease = leaseSource(DIR, abort)
  expect(sourceLeases(DIR)).toBe(1)
  const waiting = yieldSource(DIR, { waitMs: 8000, abortMs: 10000 })
  await vi.advanceTimersByTimeAsync(3000)
  lease.release()
  await expect(waiting).resolves.toBe('finished')
  expect(abort).not.toHaveBeenCalled()
  expect(lease.gone).toBe(false)
  expect(sourceLeases(DIR)).toBe(0)
})

it('stops a long read cleanly after the bounded wait, marked gone, then lets the cleanup go', async () => {
  let lease: ReturnType<typeof leaseSource> | undefined
  const abort = vi.fn(() => { setTimeout(() => lease!.release(), 200) })
  lease = leaseSource(DIR, abort)
  const waiting = yieldSource(DIR, { waitMs: 8000, abortMs: 10000 })
  await vi.advanceTimersByTimeAsync(8000)
  expect(abort).toHaveBeenCalledTimes(1)
  expect(lease.gone).toBe(true)
  await vi.advanceTimersByTimeAsync(200)
  await expect(waiting).resolves.toBe('aborted')
})

it('never hangs a cleanup on a read that will not stop', async () => {
  const lease = leaseSource(DIR, () => { throw new Error('already finishing') })
  const waiting = yieldSource(DIR, { waitMs: 100, abortMs: 100 })
  await vi.advanceTimersByTimeAsync(250)
  await expect(waiting).resolves.toBe('timeout')
  lease.release()
})

it('tells listeners a checkout was removed, and one failing listener never stops the next', () => {
  const seen: string[] = []
  const off1 = onSourceRemoved(() => { throw new Error('boom') })
  const off2 = onSourceRemoved(dir => seen.push(dir))
  sourceRemoved(DIR)
  expect(seen).toEqual([DIR])
  off1(); off2()
  sourceRemoved(DIR)
  expect(seen).toEqual([DIR])
})
