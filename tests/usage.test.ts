import { describe, expect, it } from 'vitest'
import type { FalRun } from '@shared/api'
import {
  claudeLimits, claudePercent, claudeProjectDir, codexLimits, falSpend, mergeClaudeRateLimit, parseClaudeUsageLine,
  parseCodexSession, tally, usageWindows, windowLabel
} from '../src/main/usage'

// Shapes copied from codex-cli 0.162 session logs (~/.codex/sessions), trimmed.
const codexMeta = JSON.stringify({ timestamp: '2026-10-12T19:36:30.542Z', type: 'session_meta', payload: { id: 's1', cwd: 'C:\\Users\\p\\.genio\\worktrees\\w\\t1' } })
const codexTokens = (ts: string, input: number, cached: number, output: number, used: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 10, total_tokens: input + output },
        last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 },
        model_context_window: 258400
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: used, window_minutes: 10080, resets_at: 1792312471 },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: '1.0' },
        plan_type: 'pro',
        ...extra
      }
    }
  })

describe('parseCodexSession', () => {
  it('reads the cwd, token deltas and rate-limit snapshots', () => {
    const s = parseCodexSession(
      [
        codexMeta,
        '{"timestamp":"2026-10-12T19:37:00.000Z","type":"response_item","payload":{"type":"message","content":"token_count is not parsed here"}}',
        codexTokens('2026-10-12T19:38:00.000Z', 1000, 800, 50, 23),
        // same totals repeated: no new tokens
        codexTokens('2026-10-12T19:38:01.000Z', 1000, 800, 50, 23),
        codexTokens('2026-10-12T19:39:00.000Z', 2500, 2000, 80, 24)
      ],
      's1'
    )
    expect(s.cwd).toBe('C:\\Users\\p\\.genio\\worktrees\\w\\t1')
    expect(s.records.map(({ input, cached, output }) => ({ input, cached, output }))).toEqual([
      { input: 200, cached: 800, output: 50 },
      { input: 300, cached: 1200, output: 30 }
    ])
    expect(s.snapshots).toHaveLength(3)
    expect(s.snapshots[2]).toEqual({
      ts: '2026-10-12T19:39:00.000Z',
      limitId: 'codex',
      name: undefined,
      plan: 'pro',
      windows: [{ minutes: 10080, usedPercent: 24, resetsAt: new Date(1792312471 * 1000).toISOString() }]
    })
  })

  it('handles a counter restart and the older resets_in_seconds form', () => {
    const old = JSON.stringify({
      timestamp: '2026-08-01T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 3600 } }
      }
    })
    const s = parseCodexSession([codexTokens('2026-08-01T09:00:00.000Z', 5000, 0, 100, 1), old], 's2')
    expect(s.records[1]).toMatchObject({ input: 10, cached: 0, output: 5 })
    expect(s.snapshots[1].limitId).toBe('codex')
    expect(s.snapshots[1].windows).toEqual([
      { minutes: 300, usedPercent: 12.5, resetsAt: '2026-08-01T10:10:00.000Z' },
      { minutes: 10080, usedPercent: 40, resetsAt: '2026-08-01T11:00:00.000Z' }
    ])
  })
})

describe('codexLimits', () => {
  it('keeps the latest snapshot per bucket, main bucket first, and flags passed resets', () => {
    const now = Date.parse('2026-10-13T12:00:00.000Z')
    const limits = codexLimits(
      [
        { ts: '2026-10-12T10:00:00.000Z', limitId: 'codex_bengalfox', name: 'GPT-5.3-Codex-Spark', windows: [{ minutes: 300, usedPercent: 0, resetsAt: '2026-10-12T15:00:00.000Z' }] },
        { ts: '2026-10-12T09:00:00.000Z', limitId: 'codex', plan: 'pro', windows: [{ minutes: 10080, usedPercent: 20, resetsAt: '2026-10-18T00:00:00.000Z' }] },
        { ts: '2026-10-13T09:00:00.000Z', limitId: 'codex', windows: [{ minutes: 10080, usedPercent: 24, resetsAt: '2026-10-18T00:00:00.000Z' }] }
      ],
      now
    )
    expect(limits).toEqual([
      { source: 'reported by Codex', updatedAt: '2026-10-13T09:00:00.000Z', name: undefined, plan: 'pro', windows: [{ label: 'weekly', usedPercent: 24, resetsAt: '2026-10-18T00:00:00.000Z', stale: false }] },
      { source: 'reported by Codex', updatedAt: '2026-10-12T10:00:00.000Z', name: 'GPT-5.3-Codex-Spark', plan: undefined, windows: [{ label: '5-hour', usedPercent: 0, resetsAt: '2026-10-12T15:00:00.000Z', stale: true }] }
    ])
  })

  it('labels windows', () => {
    expect([300, 10080, 1440, 90, undefined].map(windowLabel)).toEqual(['5-hour', 'weekly', '1-day', '90-min', 'limit'])
  })
})

describe('parseClaudeUsageLine', () => {
  // Shape from a Claude Code 2.1 transcript (~/.claude/projects/<dir>/<session>.jsonl), trimmed.
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_01',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 2, cache_creation_input_tokens: 3890, cache_read_input_tokens: 73666, output_tokens: 943, output_tokens_details: { thinking_tokens: 654 } }
    },
    requestId: 'req_01',
    timestamp: '2026-10-13T09:05:20.174Z',
    sessionId: 'sess-1',
    cwd: 'C:\\Users\\p\\.genio\\worktrees\\genio\\t1'
  })

  it('reads per-message usage with a dedupe key', () => {
    expect(parseClaudeUsageLine(line)).toEqual({
      key: 'msg_01:req_01',
      cwd: 'C:\\Users\\p\\.genio\\worktrees\\genio\\t1',
      record: { ts: Date.parse('2026-10-13T09:05:20.174Z'), session: 'sess-1', input: 3892, cached: 73666, output: 943 }
    })
  })

  it('ignores user lines and tool output that merely mention usage', () => {
    expect(parseClaudeUsageLine(JSON.stringify({ type: 'user', message: { content: '"usage" "assistant"' } }))).toBeUndefined()
    expect(parseClaudeUsageLine('{"type":"assistant","message":{"content":[]}}')).toBeUndefined()
    expect(parseClaudeUsageLine('not json "usage" "assistant"')).toBeUndefined()
  })

  it('maps a cwd to its project folder', () => {
    expect(claudeProjectDir('C:\\Users\\alice\\.genio')).toBe('C--Users-danie--genio')
  })
})

describe('Claude Code rate limits', () => {
  it('merges rate_limit_event info per window and skips unchanged events', () => {
    const a = mergeClaudeRateLimit({ windows: {} }, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1792312471 }, '2026-10-13T09:00:00.000Z')!
    expect(a.windows.five_hour).toEqual({ status: 'allowed', utilization: 0.42, resetsAt: 1792312471, updatedAt: '2026-10-13T09:00:00.000Z' })
    expect(mergeClaudeRateLimit(a, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1792312471 })).toBeUndefined()
    const b = mergeClaudeRateLimit(a, { status: 'allowed_warning', rateLimitType: 'seven_day' }, '2026-10-13T10:00:00.000Z')!
    expect(Object.keys(b.windows)).toEqual(['five_hour', 'seven_day'])
  })

  it('reports windows in a fixed order with percentages and staleness', () => {
    const file = {
      windows: {
        seven_day: { status: 'allowed_warning', updatedAt: '2026-10-13T10:00:00.000Z' },
        five_hour: { status: 'allowed', utilization: 0.42, resetsAt: Date.parse('2026-10-13T11:00:00.000Z') / 1000, updatedAt: '2026-10-13T09:00:00.000Z' }
      }
    }
    const l = claudeLimits(file, Date.parse('2026-10-13T12:00:00.000Z'))!
    expect(l.source).toBe("reported by Claude Code to Genio's chat")
    expect(l.updatedAt).toBe('2026-10-13T10:00:00.000Z')
    expect(l.windows).toEqual([
      { label: '5-hour', usedPercent: 42, status: 'allowed', resetsAt: '2026-10-13T11:00:00.000Z', stale: true },
      { label: 'weekly', usedPercent: undefined, status: 'allowed_warning', resetsAt: undefined, stale: undefined }
    ])
    expect(claudeLimits({ windows: {} })).toBeUndefined()
    expect(claudeLimits(undefined)).toBeUndefined()
  })

  it('treats utilization as a fraction', () => {
    expect(claudePercent(0.756)).toBe(75.6)
    expect(claudePercent(1)).toBe(100)
    expect(claudePercent(64)).toBe(64)
  })
})

describe('tally and windows', () => {
  it('sums records in a window and counts sessions', () => {
    const now = new Date(2026, 9, 13, 15, 0, 0).getTime()
    const { todayStart, weekStart } = usageWindows(now)
    expect(new Date(todayStart).getHours()).toBe(0)
    expect(new Date(weekStart).getDate()).toBe(7)
    const records = [
      { ts: now - 1000, session: 'a', input: 10, cached: 100, output: 5 },
      { ts: now - 2000, session: 'b', input: 1, cached: 0, output: 1 },
      { ts: todayStart - 1, session: 'a', input: 1000, cached: 0, output: 0 },
      { ts: weekStart - 1, session: 'c', input: 9999, cached: 0, output: 0 }
    ]
    expect(tally(records, todayStart)).toEqual({ input: 11, cached: 100, output: 6, total: 117, sessions: 2 })
    expect(tally(records, weekStart)).toEqual({ input: 1011, cached: 100, output: 6, total: 1117, sessions: 2 })
  })
})

describe('falSpend', () => {
  const now = new Date(2026, 9, 13, 15, 0, 0).getTime()
  const run = (daysAgo: number, costUsd?: number): FalRun => ({
    id: `r${daysAgo}-${costUsd}`,
    endpoint: 'fal-ai/flux/dev',
    input: {},
    status: 'completed',
    logs: [],
    outputs: [],
    costUsd,
    createdAt: new Date(now - daysAgo * 86_400_000).toISOString()
  })

  it('sums recorded costs for today and the last 7 days', () => {
    const s = falSpend([run(0, 0.25), run(0), run(2, 1.5), run(10, 99)], now)
    expect(s).toMatchObject({ todayUsd: 0.25, weekUsd: 1.75, runs: 3, costed: 2 })
  })

  it('handles an empty history', () => {
    expect(falSpend([], now)).toMatchObject({ todayUsd: 0, weekUsd: 0, runs: 0, costed: 0 })
  })
})
