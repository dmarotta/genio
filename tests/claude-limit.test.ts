import { describe, expect, it } from 'vitest'
import { claudeLimitState, claudeResetTime, isClaudeLimit } from '../src/main/claude-limit'
import { claudeLimits, mergeClaudeRateLimit, quotaFromUsage } from '../src/main/usage'
import type { UsageReport } from '../src/shared/api'

const now = Date.parse('2026-10-13T13:32:00Z')

describe('Claude reset clocks', () => {
  it.each([
    ['2:30pm (Europe/Rome)', '2026-10-13T12:30:00Z'],
    ['Oct 20 at 2:30pm (Europe/Rome)', '2026-10-20T12:30:00Z'],
    ['Oct 20, 2026, 2:30pm (Europe/Rome)', '2026-10-20T12:30:00Z'],
    ['2026-10-20T12:30:00Z', '2026-10-20T12:30:00Z'],
    ['14:30 (Europe/Rome)', '2026-10-13T12:30:00Z'],
    ['7 PM (Europe/Rome)', '2026-10-13T17:00:00Z'],
    ['12am (UTC)', '2026-10-13T00:00:00Z'],
    ['12:00 PM (UTC)', '2026-10-13T12:00:00Z'],
    ['9:30am (America/New_York)', '2026-10-13T13:30:00Z'],
    ['7:30pm (Asia/Kolkata)', '2026-10-13T14:00:00Z'],
    ['tomorrow at 2am (Europe/Rome)', '2026-10-14T00:00:00Z'],
    ['today 2:30pm (Europe/Rome)', '2026-10-13T12:30:00Z']
  ])('parses %s', (clock, expected) => {
    expect(claudeResetTime(`You've hit your session limit · resets ${clock}`, now)).toBe(Date.parse(expected))
  })

  it('uses the timezone date across midnight and its seasonal offset', () => {
    expect(claudeResetTime('resets 2am (Asia/Tokyo)', Date.parse('2026-10-13T18:00Z'))).toBe(Date.parse('2026-10-13T17:00Z'))
    expect(claudeResetTime('resets 2:30pm (Europe/Rome)', Date.parse('2026-12-13T14:00Z'))).toBe(Date.parse('2026-12-13T13:30Z'))
    const local = new Date(now)
    local.setHours(14, 30, 0, 0)
    expect(claudeResetTime('resets 2:30pm', now)).toBe(local.getTime())
  })

  it.each(['resets later', 'resets 30pm (UTC)', 'resets 0pm (UTC)', 'resets 2:99pm (UTC)', 'resets 2pm (bogus/zone)'])('leaves unknown or invalid reset times unknown: %s', text => {
    expect(claudeResetTime(text, now)).toBeUndefined()
  })

  it('detects stale errors without rolling an expired clock into tomorrow', () => {
    expect(claudeLimitState('resets 2:30pm (Europe/Rome)', undefined, now).stale).toBe(true)
    expect(claudeLimitState('resets 7pm (Europe/Rome)', undefined, now).stale).toBe(false)
    expect(claudeLimitState('', { resetsAt: now / 1000 }, now).stale).toBe(true)
    expect(claudeLimitState('', { resetsAt: now / 1000 + 60 }, now).stale).toBe(false)
    expect(claudeLimitState('', { status: 'allowed' }, now).stale).toBe(true)
    expect(claudeLimitState('', { status: 'allowed', resetsAt: now / 1000 + 3600 }, now).stale).toBe(true)
    expect(claudeLimitState('', { status: 'rejected' }, now).stale).toBe(false)
    expect(claudeLimitState('resets 2:30pm (Europe/Rome)', { resetsAt: now / 1000 + 60 }, now).stale).toBe(true)
    expect(isClaudeLimit("You've hit your session limit")).toBe(true)
    expect(isClaudeLimit('rate_limit')).toBe(true)
    expect(isClaudeLimit('permission denied')).toBe(false)
  })
})

describe('expired Claude usage snapshots', () => {
  it('does not freshen an old percentage when only status is reported', () => {
    const at = new Date(now - 600_001).toISOString()
    const file = mergeClaudeRateLimit({ windows: {} }, { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.97 }, at)!
    const status = mergeClaudeRateLimit(file, { rateLimitType: 'five_hour', status: 'allowed' }, new Date(now).toISOString())!
    expect(claudeLimits(status, now)?.windows[0]).toMatchObject({ stale: true, usedPercent: undefined, lastKnownUsedPercent: 97, observedAt: at })
    const fresh = mergeClaudeRateLimit(status, { rateLimitType: 'five_hour', status: 'allowed', utilization: 0 }, new Date(now).toISOString())!
    expect(claudeLimits(fresh, now)?.windows[0]).toMatchObject({ stale: false, usedPercent: 0 })
  })

  it('shows expired usage as unknown while keeping its protective history', () => {
    const file = mergeClaudeRateLimit({ windows: {} }, { rateLimitType: 'five_hour', status: 'rejected', utilization: 1, resetsAt: now / 1000 - 1 }, new Date(now).toISOString())!
    const limits = claudeLimits(file, now)!
    expect(limits.windows[0]).toMatchObject({ stale: true, status: undefined })
    expect(quotaFromUsage({ tools: [{ tool: 'claude', limits: [limits] }] } as UsageReport).claude[0]).toMatchObject({ usedPercent: undefined, lastKnownUsedPercent: 100, stale: true })
  })

  it('allowed without utilization does not inherit an exhausted rejected percentage', () => {
    const file = mergeClaudeRateLimit({ windows: {} }, { rateLimitType: 'five_hour', status: 'rejected', utilization: 1 }, new Date(now).toISOString())!
    const allowed = mergeClaudeRateLimit(file, { rateLimitType: 'five_hour', status: 'allowed' }, new Date(now).toISOString())!
    expect(claudeLimits(allowed, now)?.windows[0]).toMatchObject({ status: 'allowed', usedPercent: undefined })
  })
})
