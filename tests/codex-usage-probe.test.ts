import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_PROBE_SOURCE, CodexUsageError, codexLimitsFile, codexProbeError, parseCodexRateLimits, probeCodexRateLimits, readCodexProbeLimits, refreshCodexPlanUsage
} from '../src/main/codex-usage-probe'
import type { CodexRpc } from '../src/main/codex-chat-driver'
import { codexLimits, parseCodexSession } from '../src/main/usage'
import { meterRows, planStatus } from '../src/shared/usage-mode'
import { QUOTA_EVIDENCE_TTL } from '../src/shared/dispatch'

const now = Date.parse('2026-10-14T07:00:00Z')
const reset = Math.floor(now / 1000) + 5 * 86400
/** The shape codex-cli 0.162 returns for account/rateLimits/read (trimmed). */
const response = (used = 25, secondary: unknown = null) => {
  const bucket = { limitId: 'codex', limitName: null, primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: reset }, secondary,
    credits: { hasCredits: true, unlimited: false, balance: '1.0' }, planType: 'pro', rateLimitReachedType: null }
  return { ordinaryUsageAllowed: true, rateLimits: bucket, rateLimitsByLimitId: { codex: bucket }, accountId: 'private-account-id' }
}
const at = new Date(now).toISOString()
let dir: string

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-probe-'))
})
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })

function fakeWire(result: () => Promise<unknown>, account: unknown = { account: { type: 'chatgpt', planType: 'pro' } }) {
  const calls: string[] = []
  const close = vi.fn()
  const rpc: CodexRpc = {
    request: async (method) => {
      calls.push(method)
      if (method === 'account/read') return account as Record<string, unknown>
      if (method === 'account/rateLimits/read') return result() as Promise<Record<string, unknown>>
      return {}
    },
    notify: (method) => { calls.push(method) },
    close
  }
  return { calls, close, wire: () => rpc }
}

describe('Codex plan usage parsing', () => {
  it('reads usedPercent as USED with the window length, reset and plan', () => {
    const [s] = parseCodexRateLimits(response(25), at)
    expect(s).toMatchObject({ limitId: 'codex', plan: 'pro', source: CODEX_PROBE_SOURCE,
      windows: [{ minutes: 10080, usedPercent: 25, resetsAt: new Date(reset * 1000).toISOString() }] })
    const limits = codexLimits([s], now)
    expect(limits[0].windows[0]).toMatchObject({ label: 'weekly', usedPercent: 25, observedAt: at, stale: false })
    const row = meterRows({ tools: [{ tool: 'codex', limits }] })[1]
    expect(row.headline).toMatchObject({ state: 'known', leftPercent: 75 })
    expect(row.summary).toEqual({ provider: 'codex', label: 'Codex', state: 'known', usedPercent: 25, leftPercent: 75, windowLabel: 'weekly',
      resetsAt: new Date(reset * 1000).toISOString(), fetchedAt: at, source: CODEX_PROBE_SOURCE, error: undefined, note: undefined })
  })

  it('keeps the 5-hour and weekly windows separate and reports the tighter one as headline', () => {
    const [s] = parseCodexRateLimits(response(10, { usedPercent: 80, windowDurationMins: 300, resetsAt: reset - 86400 }), at)
    const row = meterRows({ tools: [{ tool: 'codex', limits: codexLimits([s], now) }] })[1]
    expect(row.windows.map(w => [w.label, w.leftPercent])).toEqual([['weekly', 90], ['5-hour', 20]])
    expect(row.summary).toMatchObject({ windowLabel: '5-hour', usedPercent: 80 })
    expect(row.missing).toEqual([])
  })

  it('accepts the single legacy bucket, skips null windows and rejects a changed format', () => {
    expect(parseCodexRateLimits({ rateLimits: response(5).rateLimits }, at)[0].windows[0].usedPercent).toBe(5)
    expect(parseCodexRateLimits({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: null, secondary: null } } }, at)).toEqual([])
    for (const bad of [{}, null, { rateLimits: 'x' }, { rateLimits: { primary: { usedPercent: '25' } } }, { rateLimits: { primary: { usedPercent: -1 } } }])
      expect(() => parseCodexRateLimits(bad, at)).toThrow(CodexUsageError)
  })
})

describe('Codex plan usage probe', () => {
  it('reads limits from the signed-in app-server without a thread or prompt, then closes it', async () => {
    const fake = fakeWire(async () => response())
    expect(await probeCodexRateLimits(fake.wire)).toEqual(response())
    expect(fake.calls).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('names the reason when it genuinely cannot read: not installed, not signed in, timed out', async () => {
    await expect(probeCodexRateLimits(() => { throw new Error('Codex is not installed. Open Accounts.') })).rejects.toThrow('Codex CLI not found')
    const apiKey = fakeWire(async () => response(), { account: { type: 'apiKey' } })
    await expect(probeCodexRateLimits(apiKey.wire)).rejects.toThrow('not signed in with ChatGPT')
    expect(apiKey.calls).not.toContain('account/rateLimits/read')
    const stalled = fakeWire(() => new Promise(() => {}))
    const probing = probeCodexRateLimits(stalled.wire)
    const failed = expect(probing).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(25_001)
    await failed
    expect(stalled.close).toHaveBeenCalledOnce()
  })
})

describe('Codex plan usage refresh', () => {
  it('stores a fresh snapshot, single-flight, and re-reads only after the probe TTL or when forced', async () => {
    const probe = vi.fn(async () => response(25))
    await Promise.all([refreshCodexPlanUsage(dir, false, probe), refreshCodexPlanUsage(dir, false, probe)])
    expect(probe).toHaveBeenCalledOnce()
    expect(readCodexProbeLimits(dir)[0]).toMatchObject({ ts: at, windows: [{ usedPercent: 25 }] })
    await refreshCodexPlanUsage(dir, false, probe)
    expect(probe).toHaveBeenCalledOnce()
    await refreshCodexPlanUsage(dir, true, probe)
    expect(probe).toHaveBeenCalledTimes(2)
    vi.setSystemTime(now + 60_001)
    await refreshCodexPlanUsage(dir, false, probe)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(codexProbeError(dir)).toBeUndefined()
  })

  it('fixes the stuck "?": a log snapshot from last night is replaced by the fresh account read', async () => {
    const lastNight = new Date(now - 10 * 3600_000).toISOString()
    const log = parseCodexSession([JSON.stringify({ timestamp: lastNight, type: 'event_msg', payload: { type: 'token_count',
      rate_limits: { limit_id: 'codex', primary: { used_percent: 21, window_minutes: 10080, resets_at: reset }, secondary: null, plan_type: 'pro' } } })], 's')
    const before = meterRows({ tools: [{ tool: 'codex', limits: codexLimits(log.snapshots, now) }] })[1]
    expect(before.headline?.state).toBe('unknown')
    expect(before.summary).toMatchObject({ state: 'unknown', note: expect.stringContaining('expired') })
    await refreshCodexPlanUsage(dir, false, async () => response(25))
    const after = meterRows({ tools: [{ tool: 'codex', limits: codexLimits([...log.snapshots, ...readCodexProbeLimits(dir)], now) }] })[1]
    expect(after.summary).toMatchObject({ state: 'known', usedPercent: 25, leftPercent: 75, fetchedAt: at })
  })

  it('a failed read keeps the last report on its own clock, with a safe reason, and never blocks dispatch once it expires', async () => {
    await refreshCodexPlanUsage(dir, false, async () => response(97))
    const saved = fs.readFileSync(codexLimitsFile(dir), 'utf8')
    vi.setSystemTime(now + 60_001)
    await refreshCodexPlanUsage(dir, false, async () => { throw new Error('private provider response') })
    expect(codexProbeError(dir)).toBe('Codex rate-limit read failed')
    expect(fs.readFileSync(codexLimitsFile(dir), 'utf8')).toBe(saved)
    const limits = () => codexLimits(readCodexProbeLimits(dir))
    // still fresh: protection holds, the error shows beside the last report
    expect(planStatus('codex', limits()[0].windows).level).toBe('out')
    expect(meterRows({ tools: [{ tool: 'codex', limits: limits(), error: codexProbeError(dir) }] })[1].summary)
      .toMatchObject({ state: 'known', usedPercent: 97, error: 'Codex rate-limit read failed' })
    // expired: unknown, not held; the meter shows the error state with its reason
    vi.setSystemTime(now + QUOTA_EVIDENCE_TTL + 1)
    await refreshCodexPlanUsage(dir, false, async () => { throw new CodexUsageError('Codex rate-limit read timed out') })
    expect(planStatus('codex', limits()[0].windows)).toMatchObject({ level: 'ok', known: false })
    expect(meterRows({ tools: [{ tool: 'codex', limits: limits(), error: codexProbeError(dir) }] })[1].summary)
      .toMatchObject({ state: 'error', usedPercent: undefined, error: 'Codex rate-limit read timed out', windowLabel: 'weekly' })
    await refreshCodexPlanUsage(dir, true, async () => response(3))
    expect(codexProbeError(dir)).toBeUndefined()
  })

  it('reports a missing plan as an explicit state, never a bare unknown', () => {
    const row = meterRows({ tools: [{ tool: 'codex', limits: [], error: 'Codex is not signed in with ChatGPT, so there is no plan usage to read' }] })[1]
    expect(row.summary).toMatchObject({ provider: 'codex', state: 'error', error: expect.stringContaining('not signed in') })
    expect(meterRows({ tools: [] })[1].summary).toMatchObject({ state: 'unknown', note: 'no plan report yet' })
  })
})
