import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageReport } from '../src/shared/api'
import type { AppCtx } from '../src/main/services'
import { defaultSettings } from '../src/main/settings'
import { bus } from '../src/main/bus'

const scan = vi.hoisted(() => ({ report: {} as UsageReport }))
vi.mock('../src/main/accounts', () => ({ listAccounts: async () => [] }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/usage', async (original) => ({ ...await original<typeof import('../src/main/usage')>(), usageReport: async () => scan.report }))
const { createDispatchService } = await import('../src/main/dispatch')
const { claudeLimitsFile, recordClaudeRateLimit } = await import('../src/main/usage')

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-reservation-'))
  scan.report = { tools: ['claude', 'codex'].map(tool => ({ tool, limits: [{ source: 'test', updatedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 20 }] }] })) } as UsageReport
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function service() {
  const settings = defaultSettings()
  const ctx = {
    settings: { get: () => settings, availableHarnesses: () => settings.harnesses.filter(h => ['claude', 'codex'].includes(h.id)) },
    projects: { get: () => ({}) }, main: { home: { data: dir } }, homes: new Map()
  } as unknown as AppCtx
  return createDispatchService(() => ctx)
}
const input = { kind: 'ship' as const, project: 'genio', title: 'Fix bug', intent: 'Fix bug', harness: 'claude' }

it('does not leak pending slots when a UI observer fails, and an old release cannot remove a new slot', async () => {
  const stop = bus.onEvent(event => { if (event.type === 'pending-units') throw new Error('window closed') })
  try {
    const svc = service()
    const first = await svc.reserve(input)
    expect(svc.pendingUnits()).toEqual(['genio'])
    first.release()
    expect(svc.capacity().used).toBe(0)
    const next = await svc.reserve(input)
    first.listed()
    first.release()
    expect(svc.capacity().used).toBe(1)
    next.release()
    expect(svc.pendingUnits()).toEqual([])
  } finally { stop() }
})

it('lets launches run side by side below 70%; on a warm plan claims one launch atomically and holds the slot until it finishes', async () => {
  const svc = service()
  const side = await Promise.allSettled([svc.reserve(input), svc.reserve(input)])
  expect(side.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
  for (const r of side) (r as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.reserve>>>).value.release()
  scan.report.tools[0].limits[0].windows[0].usedPercent = 75
  const attempts = await Promise.allSettled([svc.reserve(input), svc.reserve(input), svc.reserve(input)])
  expect(attempts.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
  const first = (attempts[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.reserve>>>).value
  await first.check()
  first.release()
  const next = await svc.reserve(input)
  first.release() // an old release must not drop the new launch's reservation
  await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
  next.release()
})

it('rechecks provider evidence immediately before terminal creation and releases failed launches', async () => {
  const svc = service()
  const reservation = await svc.reserve(input)
  recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 600 })
  await expect(reservation.check()).rejects.toThrow(/deferred/)
  reservation.release()
  await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
  // the default waits too: it is never moved to Codex
  await expect(svc.reserve({ ...input, harness: undefined })).rejects.toThrow(/keeps its tool and model/)
  const codex = await svc.reserve({ ...input, harness: 'codex' })
  expect(codex.loadout.harness).toBe('codex')
  codex.release()
})

it('fails open with the existing quiet warning when a source fails, including fresh hot evidence', async () => {
  const svc = service()
  scan.report.tools[0].limits[0].windows[0].usedPercent = 97
  await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
  scan.report = { tools: [{ tool: 'claude', limits: [], error: 'locked transcript' }] } as unknown as UsageReport
  recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'five_hour' })
  const reservation = await svc.reserve(input)
  expect(reservation.loadout.reasons.filter(r => /Claude.*quota unverified/.test(r))).toHaveLength(1)
  reservation.release()
})

it('allows dispatch with a warning after a failed refresh and TTL expiry, including a persisted 97% restart', async () => {
  vi.useFakeTimers()
  try {
    const start = Date.now()
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
    const svc = service()
    await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
    vi.setSystemTime(start + 600_001)
    scan.report = { tools: [{ tool: 'claude', limits: [], error: 'refresh failed' }] } as unknown as UsageReport
    for (const dispatcher of [svc, service()]) {
      const reservation = await dispatcher.reserve(input)
      expect(reservation.loadout.harness).toBe('claude')
      expect(reservation.loadout.reasons.join('\n')).toContain('quota unverified')
      await reservation.check()
      reservation.release()
    }
  } finally { vi.useRealTimers() }
})
