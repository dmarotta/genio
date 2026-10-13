import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageReport } from '../src/shared/api'
import type { AppCtx } from '../src/main/services'
import { defaultSettings } from '../src/main/settings'

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

it('claims a launch atomically and holds the provider slot until launch finishes', async () => {
  const svc = service()
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
  const fallback = await svc.reserve({ ...input, harness: undefined })
  expect(fallback.loadout.harness).toBe('codex')
  fallback.release()
})

it('does not erase hot evidence when a later scan fails or omits the bucket', async () => {
  const svc = service()
  scan.report.tools[0].limits[0].windows[0].usedPercent = 97
  await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
  scan.report = { tools: [{ tool: 'claude', limits: [], error: 'locked transcript' }] } as unknown as UsageReport
  await expect(svc.reserve(input)).rejects.toThrow(/deferred/)
})
