import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageReport } from '../src/shared/api'
import type { AppCtx } from '../src/main/services'
import { defaultSettings } from '../src/main/settings'
import { QuotaDeferredError, QuotaDeferredQueue } from '../src/main/quota-deferred'
import { USAGE_REFRESH_INTERVAL } from '../src/main/usage-refresh'

const scan = vi.hoisted(() => ({ report: {} as UsageReport, read: vi.fn() }))
vi.mock('../src/main/accounts', () => ({ listAccounts: async () => [] }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/usage', async original => ({ ...await original<typeof import('../src/main/usage')>(), usageReport: async () => { scan.read(); return scan.report } }))
const { createDispatchService } = await import('../src/main/dispatch')

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-quota-background-'))
  scan.read.mockClear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })

const report = (percent: number, observed = Date.now(), reset = Date.now() + 3600_000): UsageReport => ({
  tools: ['claude', 'codex'].map(tool => ({ tool, limits: [{ source: 'fixture', updatedAt: new Date(observed).toISOString(),
    windows: [{ label: '5-hour', usedPercent: percent, observedAt: new Date(observed).toISOString(), resetsAt: new Date(reset).toISOString() }] }] }))
}) as UsageReport

function fixture() {
  const settings = defaultSettings()
  const deferred = new QuotaDeferredQueue(dir)
  let launched = 0
  const poke = vi.fn()
  const crew = { list: () => [], hasQuotaDeferred: () => deferred.has(), retryQuotaDeferred: async () => {
    await deferred.drain(async entry => {
      if (entry.kind !== 'spawn') return false
      try {
        const reservation = await dispatch.reserve(entry.request)
        await reservation.check()
        launched++
        reservation.release()
        return true
      } catch (e) { if (e instanceof QuotaDeferredError) return false; throw e }
    })
  } }
  const home = { crew, supervisor: { poke }, wakes: { pending: () => [] }, backlog: { list: () => [{ id: 'q', kind: 'ship', state: 'queued', priority: 'low' }] } }
  const ctx = { settings: { get: () => settings, availableHarnesses: () => settings.harnesses.filter(h => ['claude', 'codex'].includes(h.id)) },
    projects: { get: () => ({}) }, main: { home: { data: dir } }, homes: new Map([['main', home]]) } as unknown as AppCtx
  const dispatch = createDispatchService(() => ctx)
  return { dispatch, deferred, poke, launched: () => launched }
}

it('refreshes without Settings and dispatches a persisted pinned request when the hold clears', async () => {
  const { dispatch, deferred, poke, launched } = fixture()
  const request = { kind: 'ship' as const, project: 'genio', title: 'Fix bug', intent: 'Fix bug', harness: 'claude', backlogId: 'q' }
  scan.report = report(97)
  await expect(dispatch.reserve(request)).rejects.toBeInstanceOf(QuotaDeferredError)
  deferred.put('quest:q', { kind: 'spawn', request })
  expect(dispatch.quotaWait({ kind: 'ship', priority: 'low' } as never)).toBeDefined()
  dispatch.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(launched()).toBe(0)
  expect(new QuotaDeferredQueue(dir).has()).toBe(true)
  poke.mockClear()
  scan.report = report(1)
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL)
  expect(launched()).toBe(1)
  expect(deferred.has()).toBe(false)
  expect(dispatch.quotaWait({ kind: 'ship', priority: 'low' } as never)).toBeUndefined()
  expect(poke).toHaveBeenCalledWith(true)
  dispatch.stop()
  const reads = scan.read.mock.calls.length
  await vi.advanceTimersByTimeAsync(USAGE_REFRESH_INTERVAL * 10)
  expect(scan.read).toHaveBeenCalledTimes(reads)
})

it.each(['stale', '5-hour reset', 'weekly reset', 'source error'] as const)('does not let %s evidence block a pinned launch', async kind => {
  const { dispatch } = fixture()
  scan.report = report(99)
  if (kind === 'stale') scan.report = report(99, Date.now() - 600_001)
  else if (kind.endsWith('reset')) {
    scan.report = report(99, Date.now() - 1000, Date.now())
    if (kind === 'weekly reset') for (const t of scan.report.tools) t.limits[0].windows[0].label = 'weekly'
  } else for (const t of scan.report.tools) t.error = 'source unavailable'
  const reservation = await dispatch.reserve({ kind: 'ship', project: 'genio', title: 'Fix', intent: 'Fix', harness: 'claude' })
  expect(reservation.loadout.harness).toBe('claude')
  expect(reservation.loadout.reasons.join('\n')).toContain('quota unverified')
  await reservation.check()
  reservation.release()
})

it('refreshes a would-be quota hold before choosing to defer a dispatch or relaunch', async () => {
  const { dispatch } = fixture()
  dispatch.noteUsage(report(99, Date.now() - 600_001))
  scan.report = report(2)
  const reservation = await dispatch.reserve({ kind: 'ship', project: 'genio', title: 'Resume', intent: 'Resume', harness: 'claude' })
  expect(scan.read).toHaveBeenCalled()
  expect(reservation.loadout.harness).toBe('claude')
  reservation.release()
})
