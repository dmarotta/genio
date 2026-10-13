import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSession } from '../src/main/claude-chat-driver'
import { ProviderChatSession } from '../src/main/provider-chat-session'
import { SessionCostLedger, SessionQuotaPolicy } from '../src/main/session-usage'
import { claudeLimitsFile, recordClaudeRateLimit, readClaudeLimits } from '../src/main/usage'
import type { ChatDriverEvents, ChatProvider } from '../src/main/chat-driver'
import { claudeStatus } from '../src/main/usage-policy'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)
vi.mock('../src/main/model-discovery', () => ({ registerModelQuery: () => () => {}, supportedClaudeEfforts: () => undefined }))
const now = Date.parse('2026-10-13T15:39:04.911Z')
let dir: string
const sessions: { stop(): void }[] = []
let emit: (message: unknown) => void
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); sdk.query.mockReset()
  sdk.query.mockImplementation(() => ({ close: vi.fn(), interrupt: vi.fn(),
    [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { emit = message => resolve({ value: message, done: false }) }) } }
  }))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-startup-'))
  recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour', resetsAt: now / 1000 + 3600 })
  vi.setSystemTime(now + 600_001)
})
afterEach(() => { sessions.splice(0).forEach(s => s.stop()); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })
function setup(build = vi.fn(async () => ({})), preflight = true, stale = false) {
  if (!stale) recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0.97, rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600 })
  const policy = new SessionQuotaPolicy(dir)
  const events: ChatDriverEvents = { onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd: vi.fn(),
    onSessionId: vi.fn(), onError: vi.fn(), onStart: vi.fn(), onLimit: vi.fn() }
  let provider: ChatProvider = 'claude'
  const created: ChatProvider[] = []
  const session = new ProviderChatSession({ selection: () => provider, handoff: () => '', switched: vi.fn(), events,
    hold: (p, item) => preflight && p === 'claude' && !policy.canStartTurn(item.kind, Date.now(), false) ? policy.limitState() : undefined,
    create: (p, e) => {
      created.push(p)
      if (p === 'codex') return {
        capabilities: { mode: 'driver' as const, guardedTools: true }, busy: false, idle: true, queued: 0,
        start: async () => {}, send: item => { e.onStart?.(item) }, interrupt: async () => {},
        resume: () => {}, stop: () => {}, cancel: () => undefined, hasEventsQueued: () => false
      }
      const driver = new AgentSession('genio', build, { ...e, onRateLimit: vi.fn() }, 'main', () => ({}),
        () => policy, new SessionCostLedger(path.join(dir, 'costs.json')))
      return driver
    }
  })
  sessions.push(session)
  return { session, policy, events, created, build, select: (p: ChatProvider) => { provider = p } }
}

describe('event turns bypass plan protection at preflight and driver boundaries', () => {
  it('lets a new status batch pass optional system work held by fresh 97%', async () => {
    const f = setup()
    f.session.enqueue({ kind: 'system', prompt: 'optional boot' })
    expect(sdk.query).not.toHaveBeenCalled()
    f.session.enqueue({ kind: 'events', prompt: 'unit blocked', ackThrough: 42 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(f.events.onStart).toHaveBeenCalledWith(expect.objectContaining({ kind: 'events', ackThrough: 42 }))
  })
  it.each(['stale 97%', 'fresh 97%'] as const)('delivers and acknowledges an event after restart with %s', async evidence => {
    const f = setup(undefined, true, evidence === 'stale 97%')
    f.session.restart()
    f.session.enqueue({ kind: 'events', prompt: 'unit ready and blocked', ackThrough: 42 })
    await vi.advanceTimersByTimeAsync(0)
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(f.events.onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ackThrough: 42 }))
    expect(f.events.onTurnEnd).not.toHaveBeenCalled()
    emit({ type: 'system', subtype: 'init', session_id: 'test' }); await vi.advanceTimersByTimeAsync(0)
    emit({ type: 'result', uuid: 'event-result', is_error: false, total_cost_usd: 0 }); await vi.advanceTimersByTimeAsync(0)
    expect(f.events.onTurnEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ackThrough: 42 }), true, '', 0)
  })
})

describe('startup quota holds do not own the foreground queue', () => {
  it('reports unreadable usage instead of converting it into a missing report', () => {
    fs.writeFileSync(claudeLimitsFile(dir), '{broken')
    expect(() => readClaudeLimits(dir)).toThrow()
    fs.unlinkSync(claudeLimitsFile(dir))
    expect(readClaudeLimits(dir)).toBeUndefined()
    fs.writeFileSync(claudeLimitsFile(dir), JSON.stringify({ windows: { five_hour: null } }))
    expect(() => readClaudeLimits(dir)).toThrow('Invalid Claude usage window')
    expect(new SessionQuotaPolicy(dir).unitBlocked()).toBe(false)
    expect(new SessionQuotaPolicy(dir).canStart(false)).toBe(true)
    expect(claudeStatus(dir)).toMatchObject({ level: 'ok', known: false })
  })
  it('defers fresh 97% optional work, then accepts a player turn', async () => {
    const f = setup()
    f.session.enqueue({ kind: 'system', prompt: 'boot', ackThrough: 42 })
    expect(f.session.busy).toBe(false); expect(f.created).toEqual([])
    expect(f.events.onTurnEnd).not.toHaveBeenCalled()
    expect(f.events.onLimit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: expect.stringContaining('Background') }))
    f.session.enqueue({ kind: 'player', prompt: 'hello' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.onStart).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }))
    expect(f.session.queued).toBe(1); expect(sdk.query).toHaveBeenCalledTimes(1)
  })
  it('allows an explicit provider change before any Claude driver exists', async () => {
    const f = setup()
    f.session.enqueue({ kind: 'system', prompt: 'boot' })
    f.select('codex'); f.session.enqueue({ kind: 'player', prompt: 'new route' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.created).toEqual(['codex']); expect(f.session.currentProvider).toBe('codex')
    expect(f.events.onStart).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'new route' }))
  })
  it('interrupt and restart do not submit held boot; newer evidence releases it once', async () => {
    const f = setup()
    f.session.enqueue({ kind: 'system', prompt: 'boot', ackThrough: 42 })
    await f.session.interrupt(); f.session.restart()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sdk.query).not.toHaveBeenCalled(); expect(f.events.onTurnEnd).not.toHaveBeenCalled()
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', utilization: 0, rateLimitType: 'five_hour' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sdk.query).toHaveBeenCalledTimes(1)
    expect(f.events.onStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ackThrough: 42 }))
    emit({ type: 'system', subtype: 'init', session_id: 'test' }); await vi.advanceTimersByTimeAsync(0)
    emit({ type: 'result', uuid: 'result', is_error: false, total_cost_usd: 0 }); await vi.advanceTimersByTimeAsync(0)
    expect(f.events.onTurnEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ackThrough: 42 }), true, '', 0)
  })
  it('retains genuine rejection protection for foreground and allows another route', async () => {
    const f = setup(); f.policy.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600 })
    f.session.enqueue({ kind: 'player', prompt: 'blocked' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.created).toEqual([]); expect(sdk.query).not.toHaveBeenCalled()
    f.select('codex'); f.session.enqueue({ kind: 'player', prompt: 'switch' })
    expect(f.session.currentProvider).toBe('codex')
    expect(f.policy.canStart(true, Date.now(), false)).toBe(false)
  })
  it('returns a preflight-race refusal to the owner without occupying the driver', () => {
    const f = setup()
    const deferred = vi.fn()
    const driver = new AgentSession('genio', f.build, { ...f.events, onDeferred: deferred, onRateLimit: vi.fn() },
      'main', () => ({}), () => f.policy, new SessionCostLedger(path.join(dir, 'costs.json')))
    sessions.push(driver)
    driver.send({ kind: 'system', prompt: 'race' })
    expect(deferred).toHaveBeenCalledOnce(); expect(driver.queued).toBe(0); expect(driver.busy).toBe(false)
  })
  it('can switch away from a driver that refused an unsubmitted startup turn', () => {
    const f = setup(undefined, false)
    f.session.enqueue({ kind: 'system', prompt: 'boot', ackThrough: 42 })
    expect(f.created).toEqual(['claude']); expect(f.session.busy).toBe(false)
    f.select('codex'); f.session.enqueue({ kind: 'player', prompt: 'switch' })
    expect(f.created).toEqual(['claude', 'codex']); expect(f.session.queued).toBe(1)
    expect(f.events.onTurnEnd).not.toHaveBeenCalled(); expect(sdk.query).not.toHaveBeenCalled()
  })
})

describe('bounded Claude initialization', () => {
  it('reports a silent query timeout and never replays the submitted turn', async () => {
    const f = setup(); f.session.enqueue({ kind: 'player', prompt: 'one request' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(f.events.onError).toHaveBeenCalledWith(expect.stringContaining('initialization timed out'))
    expect(f.session.busy).toBe(false); expect(f.events.onTurnEnd).toHaveBeenCalledOnce()
    f.session.enqueue({ kind: 'events', prompt: 'unacknowledged wake retry', ackThrough: 42 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sdk.query).toHaveBeenCalledTimes(1)
    expect(f.events.onLimit).toHaveBeenLastCalledWith(expect.objectContaining({ restartRequired: true, reason: expect.stringContaining('outcome is unknown') }))
  })
  it('ignores late option building after timeout', async () => {
    let finish!: (value: {}) => void
    const f = setup(vi.fn(() => new Promise<{}>(resolve => { finish = resolve })))
    f.session.enqueue({ kind: 'player', prompt: 'one request' })
    await vi.advanceTimersByTimeAsync(30_001)
    finish({}); await vi.advanceTimersByTimeAsync(0)
    expect(sdk.query).not.toHaveBeenCalled(); expect(f.events.onTurnEnd).toHaveBeenCalledOnce()
  })
  it('clears the initialization deadline on init without timing out a running turn', async () => {
    const f = setup(); f.session.enqueue({ kind: 'player', prompt: 'long turn' })
    await vi.advanceTimersByTimeAsync(0)
    emit({ type: 'system', subtype: 'init', session_id: 'test' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.events.onError).not.toHaveBeenCalled(); expect(f.session.busy).toBe(true)
  })
})
