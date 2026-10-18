import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeLimits, claudeLimitsFile, mergeClaudeRateLimit, readClaudeLimits, recordClaudeRateLimit } from '../src/main/usage'
import { claudeProbeError, parseClaudePlanUsage, refreshClaudePlanUsage } from '../src/main/claude-usage-probe'
import { planStatus, meterRows } from '../src/shared/usage-mode'
import { SessionQuotaPolicy } from '../src/main/session-usage'
import { QUOTA_EVIDENCE_TTL } from '../src/shared/dispatch'

const sdk = vi.hoisted(() => ({ query: vi.fn(), usage: vi.fn(), close: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
let dir: string
const now = Date.parse('2026-10-13T19:00:00Z')
const response = (five = 0, week = 0) => ({ subscription_type: 'max', rate_limits_available: true,
  rate_limits: { five_hour: { utilization: five, resets_at: new Date(now + 3600_000).toISOString() },
    seven_day: { utilization: week, resets_at: new Date(now + 7 * 86400_000).toISOString() } } })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-claude-probe-'))
  sdk.query.mockReset(); sdk.usage.mockReset(); sdk.close.mockReset()
  sdk.query.mockReturnValue({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sdk.usage, close: sdk.close })
  sdk.usage.mockResolvedValue(response())
})
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('Claude account plan usage', () => {
  it.each([0, 1, 2, 97, 100])('reads %s as USED percent, with exactly one remaining inversion', percent => {
    const limits = claudeLimits(parseClaudePlanUsage(response(percent), new Date(now).toISOString()), now)!
    expect(limits.windows[0].usedPercent).toBe(percent)
    const row = meterRows({ tools: [{ tool: 'claude', limits: [limits] }] })[0]
    const window = row.windows.find(w => w.label === '5-hour')!
    expect(window).toMatchObject({ state: 'known', usedPercent: percent, leftPercent: 100 - percent })
    expect(row.source).toContain('/usage'); expect(row.planName).toBe('max')
  })

  it('keeps weekly and model windows independent of five-hour and measured session counters', () => {
    const report = { ...response(0, 97), session: { total_cost_usd: 97, model_usage: { tokens: 100000 } } }
    const file = parseClaudePlanUsage({ ...report, rate_limits: { ...report.rate_limits,
      model_scoped: [{ display_name: 'Fable', utilization: 99, resets_at: null }] } }, new Date(now).toISOString())
    const limits = claudeLimits(file, now)!
    expect(limits.windows.find(w => w.label === '5-hour')?.usedPercent).toBe(0)
    expect(limits.windows.find(w => w.label === 'weekly (Fable)')?.usedPercent).toBe(99)
    expect(planStatus('claude', limits.windows, now)).toMatchObject({ level: 'out', window: 'weekly (Fable)' })
  })

  it('replaces persisted stale 97% on restart with the current account snapshot, without sending a model prompt', async () => {
    vi.setSystemTime(now - 3600_000)
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
    vi.setSystemTime(now)
    expect(new SessionQuotaPolicy(dir).canStart(false)).toBe(true)
    await Promise.all([refreshClaudePlanUsage(dir, dir, 'claude.exe'), refreshClaudePlanUsage(dir, dir, 'claude.exe')])
    expect(sdk.query).toHaveBeenCalledOnce(); expect(sdk.close).toHaveBeenCalledOnce()
    expect(sdk.usage).toHaveBeenCalledExactlyOnceWith({ skipBehaviors: true })
    const args = sdk.query.mock.calls[0][0]
    expect(args.options).toMatchObject({ tools: [], settingSources: [], mcpServers: {}, persistSession: false, pathToClaudeCodeExecutable: 'claude.exe' })
    expect(typeof args.prompt).not.toBe('string')
    // Closing releases an EMPTY input stream, with zero user messages.
    expect(await args.prompt[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
    const limits = claudeLimits(readClaudeLimits(dir), now)!
    expect(limits.windows[0].usedPercent).toBe(0)
    expect(planStatus('claude', limits.windows, now).known).toBe(true)
  })

  it('a failed refresh preserves fresh protection but cannot refresh or perpetuate stale 97%', async () => {
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour' })
    const original = fs.readFileSync(claudeLimitsFile(dir), 'utf8')
    sdk.usage.mockRejectedValue(new Error('private provider response'))
    await refreshClaudePlanUsage(dir, dir)
    expect(claudeProbeError(dir)).toContain('refresh failed')
    expect(claudeProbeError(dir)).not.toContain('private')
    expect(fs.readFileSync(claudeLimitsFile(dir), 'utf8')).toBe(original)
    expect(planStatus('claude', claudeLimits(readClaudeLimits(dir))?.windows).level).toBe('out')
    vi.setSystemTime(now + QUOTA_EVIDENCE_TTL + 1)
    await refreshClaudePlanUsage(dir, dir)
    expect(planStatus('claude', claudeLimits(readClaudeLimits(dir))?.windows)).toMatchObject({ level: 'ok', known: false })
    expect(new SessionQuotaPolicy(dir).canStart(false)).toBe(true)
    sdk.usage.mockResolvedValue(response(2))
    vi.setSystemTime(Date.now() + 240_000)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(claudeProbeError(dir)).toBeUndefined()
  })

  it('status-only events never renew the utilization clock, and a new reset invalidates that percentage', () => {
    const first = mergeClaudeRateLimit({ windows: {} }, { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour', resetsAt: now / 1000 + 3600 }, new Date(now).toISOString())!
    const later = now + QUOTA_EVIDENCE_TTL + 1
    const second = mergeClaudeRateLimit(first, { status: 'allowed', rateLimitType: 'five_hour' }, new Date(later).toISOString())!
    expect(claudeLimits(second, later)?.windows[0]).toMatchObject({ usedPercent: undefined, lastKnownUsedPercent: 97, stale: true, observedAt: new Date(now).toISOString() })
    const reset = mergeClaudeRateLimit(first, { status: 'allowed', rateLimitType: 'five_hour', resetsAt: now / 1000 + 7200 }, new Date(now + 1000).toISOString())!
    expect(claudeLimits(reset, now + 1000)?.windows[0].usedPercent).toBeUndefined()
  })

  it('expires persisted rejection evidence for unit dispatch but keeps real chat rejection backoff', () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected', rateLimitType: 'five_hour' }, now)
    expect(policy.unitBlocked(now)).toBe(true)
    expect(policy.canStartTurn('events', now)).toBe(false)
    expect(new SessionQuotaPolicy(dir).unitBlocked(now + QUOTA_EVIDENCE_TTL + 1)).toBe(false)
  })

  it('a newer full account report clears a real past rejection only when its window has recovered', async () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected', rateLimitType: 'five_hour' }, now - 1000)
    sdk.usage.mockResolvedValue(response(97))
    await refreshClaudePlanUsage(dir, dir)
    expect(policy.unitBlocked()).toBe(true)
    sdk.usage.mockResolvedValue(response(0))
    vi.setSystemTime(now + 60_000)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(new SessionQuotaPolicy(dir).unitBlocked()).toBe(false)
    expect(new SessionQuotaPolicy(dir).canStart(true)).toBe(true)
  })

  it('recovers an unspecified rejection and starts a new deduplicated notice episode', async () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected' }, now - 1000)
    expect(policy.notice('wakes', '429')).toBe(true)
    await refreshClaudePlanUsage(dir, dir)
    expect(policy.canStartTurn('events')).toBe(true)
    vi.setSystemTime(now + 1000)
    policy.observe({ status: 'rejected' })
    expect(policy.notice('wakes', '429')).toBe(true)
    expect(policy.notice('wakes', '429')).toBe(false)
  })

  it('renews observation but preserves change time for identical full account snapshots', async () => {
    await refreshClaudePlanUsage(dir, dir)
    vi.setSystemTime(now + 60_000)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(readClaudeLimits(dir)?.windows.five_hour).toMatchObject({ changedAt: new Date(now).toISOString(), observedAt: new Date(now + 60_000).toISOString() })
  })

  it('honours minimum intervals and exponential error backoff even for forced launch refreshes', async () => {
    sdk.usage.mockRejectedValue(new Error('unavailable'))
    await refreshClaudePlanUsage(dir, dir)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(sdk.usage).toHaveBeenCalledOnce()
    vi.setSystemTime(now + 120_000)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(sdk.usage).toHaveBeenCalledTimes(2)
    vi.setSystemTime(now + 240_000)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(sdk.usage).toHaveBeenCalledTimes(2)
    vi.setSystemTime(now + 360_000)
    sdk.usage.mockResolvedValue(response(1))
    await refreshClaudePlanUsage(dir, dir)
    expect(sdk.usage).toHaveBeenCalledTimes(3)
    await refreshClaudePlanUsage(dir, dir, undefined, true)
    expect(sdk.usage).toHaveBeenCalledTimes(3)
    vi.setSystemTime(now + 420_000)
    await refreshClaudePlanUsage(dir, dir)
    expect(sdk.usage).toHaveBeenCalledTimes(4)
  })

  it('does not fabricate a subscription balance for API-key accounts or malformed responses', async () => {
    recordClaudeRateLimit(claudeLimitsFile(dir), { utilization: 0.97 })
    sdk.usage.mockResolvedValue({ rate_limits_available: false, subscription_type: null, rate_limits: null })
    await refreshClaudePlanUsage(dir, dir)
    expect(readClaudeLimits(dir)?.windows).toEqual({})
    for (const v of [-1, 101, NaN, '97']) expect(() => parseClaudePlanUsage(response(v as number), new Date(now).toISOString())).toThrow()
    expect(() => parseClaudePlanUsage({}, new Date(now).toISOString())).toThrow()
  })

  it('bounds stalled refreshes and closes the probe without changing saved evidence', async () => {
    sdk.usage.mockReturnValue(new Promise(() => {}))
    const refreshing = refreshClaudePlanUsage(dir, dir)
    await vi.advanceTimersByTimeAsync(25_001)
    await refreshing
    expect(claudeProbeError(dir)).toContain('refresh failed'); expect(sdk.close).toHaveBeenCalledOnce()
    expect(readClaudeLimits(dir)).toBeUndefined()
  })
})
