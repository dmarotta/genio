import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pickLoadout } from '../src/main/loadout'
import { defaultSettings } from '../src/main/settings'
import { blockedWindow, expireWindow } from '../src/main/quota-policy'
import { QuotaDeferredError } from '../src/main/quota-deferred'
import { belongsToGenio, claudeLimitsFile, codexLimits, recordClaudeRateLimit } from '../src/main/usage'
import { SessionCostLedger, SessionQuotaPolicy } from '../src/main/session-usage'
import { relaunchPolicy } from '../src/main/relaunch-policy'
import type { LoadoutInput } from '../src/shared/types'

const now = Date.parse('2026-10-13T13:30:00Z')
const cold = { label: '5-hour', usedPercent: 11, observedAt: new Date(now).toISOString(), resetsAt: new Date(now + 3600_000).toISOString() }
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-usage-policy-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('quota evidence', () => {
  it('expires both cold and hot percentages and rejections to unknown', () => {
    const old = { ...cold, observedAt: new Date(now - 3600_000).toISOString() }
    expect(expireWindow(old, now)).toMatchObject({ stale: true, usedPercent: undefined, lastKnownUsedPercent: 11 })
    expect(blockedWindow(expireWindow(old, now))).toBe(false)
    expect(blockedWindow(expireWindow({ ...old, usedPercent: 85 }, now), now)).toBe(false)
    expect(blockedWindow(expireWindow({ ...old, status: 'rejected', usedPercent: undefined }, now), now)).toBe(false)
    expect(blockedWindow({ ...cold, usedPercent: 97 }, now)).toBe(true)
  })

  it('preserves independent Codex windows and refreshes observedAt without rewriting changedAt', () => {
    const limits = codexLimits([
      { ts: new Date(now - 60_000).toISOString(), limitId: 'codex', windows: [{ minutes: 10080, usedPercent: 97, resetsAt: cold.resetsAt }, { minutes: 300, usedPercent: 11 }] },
      { ts: new Date(now).toISOString(), limitId: 'codex', windows: [{ minutes: 300, usedPercent: 11 }] }
    ], now)
    expect(limits[0].windows).toMatchObject([
      { label: 'weekly', usedPercent: 97, observedAt: new Date(now - 60_000).toISOString() },
      { label: '5-hour', observedAt: new Date(now).toISOString(), changedAt: new Date(now - 60_000).toISOString() }
    ])
  })
})

describe('97% Claude Recon regression: nothing explores or moves into or out of a hot plan', () => {
  const input: LoadoutInput = { kind: 'scout', project: 'genio', title: 'Folder-first workspace', intent: 'Investigate folder-first sessions', category: 'recon-design' }
  const settings = { ...defaultSettings(), usageMode: 'max' as const,
    categoryPools: [{ category: 'recon-design' as const, candidates: [{ harness: 'codex' }, { harness: 'claude' }] }] }
  const env = () => ({ available: (h: { id: string }) => ['claude', 'codex'].includes(h.id),
    quota: { claude: [{ ...cold, resetsAt: undefined, observedAt: new Date().toISOString(), usedPercent: 97 }], codex: [{ ...cold, resetsAt: undefined, observedAt: new Date().toISOString() }] } })

  it('runs the row the player wrote, as written', () => {
    expect(pickLoadout(input, settings, env())).toMatchObject({ harness: 'codex', source: 'table' })
  })

  it('holds hot sticky, rule and explicit Claude picks instead of moving them to Codex', () => {
    expect(() => pickLoadout({ ...input, sticky: { from: 'previous', harness: 'claude' } }, settings, env())).toThrow(QuotaDeferredError)
    expect(() => pickLoadout(input, { ...settings, dispatchRules: [{ id: 'r', match: '', candidates: [{ harness: 'claude', spendPriority: 100 }, { harness: 'codex', spendPriority: 0 }] }] }, env())).toThrow(QuotaDeferredError)
    expect(() => pickLoadout({ ...input, harness: 'claude' }, settings, env())).toThrow(/keeps its tool and model/)
  })

  it('never explores, whatever the evidence or priority', () => {
    const fresh = { ...cold, observedAt: new Date().toISOString(), resetsAt: undefined }
    const known = { ...env(), quota: { codex: [fresh], claude: [fresh] } }
    for (const extra of [{}, { priority: 'critical' as const }, { effort: 'high' }])
      expect(pickLoadout({ ...input, ...extra }, settings, known).reasons.join('\n')).not.toMatch(/exploration/)
    expect(pickLoadout(input, settings, known).harness).toBe('codex')
  })
})

describe('durable session policy', () => {
  it('turning protection off releases percentage holds but keeps rejection backoff and retry rules', () => {
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.97 })
    expect(new SessionQuotaPolicy(dir).canStartTurn('system')).toBe(false)
    const off = new SessionQuotaPolicy(dir, false)
    expect(off.canStartTurn('system')).toBe(true)
    const rejectedAt = Date.now() + 1
    off.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (rejectedAt + 60_000) / 1000 }, rejectedAt)
    expect(off.canStartTurn('system', rejectedAt)).toBe(false)
    expect(off.canStartTurn('player', rejectedAt)).toBe(false)
    expect(off.canStartTurn('player', rejectedAt + 60_000)).toBe(true)
    expect(off.canStartTurn('player', rejectedAt + 60_001)).toBe(false)
  })

  it('blocks all session kinds across restarts, then allows only one foreground probe after reset', () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (now + 60_000) / 1000 }, now)
    expect(new SessionQuotaPolicy(dir).canStart(true, now + 59_999)).toBe(false)
    expect(new SessionQuotaPolicy(dir).canStart(false, now + 120_000)).toBe(false)
    expect(new SessionQuotaPolicy(dir).canStart(true, now + 60_000)).toBe(true)
    expect(new SessionQuotaPolicy(dir).canStart(true, now + 60_001)).toBe(false)
    policy.observe({ status: 'allowed', rateLimitType: 'five_hour' }, now + 120_000)
    expect(new SessionQuotaPolicy(dir).canStart(false, now + 120_000)).toBe(true)
  })

  it('unknown reset never becomes a one-minute retry; fresh evidence is required', () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.rejectError('429 rate_limit')
    expect(policy.canStart(false, now + 86400_000)).toBe(false)
    expect(policy.canStart(true, now + 86400_000)).toBe(false)
    expect(policy.notice('main', 'Usage limit reached')).toBe(true)
    expect(new SessionQuotaPolicy(dir).notice('main', 'Turn ended: rate_limit')).toBe(false)
    policy.observe({ status: 'allowed' })
    expect(policy.canStart(true)).toBe(true)
    expect(policy.notice('main', 'Usage limit reached')).toBe(true)
  })

  it('only the reserved foreground probe can confirm recovery; another running turn cannot release it', () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: now / 1000 }, now - 1000)
    expect(policy.canStart(true, now, true, 'main:genio')).toBe(true)
    policy.succeeded('other:genio')
    expect(policy.canStart(true, now + 1)).toBe(false)
    policy.succeeded('main:genio')
    expect(policy.canStart(true, now + 2)).toBe(true)
  })

  it('accepts newer provider evidence persisted by another process without resetting the session', () => {
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'rejected', rateLimitType: 'five_hour' }, now - 1000)
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 })
    expect(new SessionQuotaPolicy(dir).canStart(false)).toBe(true)
  })

  it('migrates rejection snapshots and does not let a cold different window clear them', () => {
    const observed = Date.now()
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'seven_day', resetsAt: (observed + 3600_000) / 1000 })
    const policy = new SessionQuotaPolicy(dir)
    policy.observe({ status: 'allowed', rateLimitType: 'five_hour' }, observed)
    expect(policy.canStart(true, observed)).toBe(false)
    expect(policy.unitBlocked()).toBe(true)
  })
})

describe('usage measurement regressions', () => {
  it('attributes all records from the persisted main session even after cwd drift', () => {
    const record = { session: 'main-id', ts: now, input: 1, cached: 100, output: 1 }
    expect(belongsToGenio({ key: 'msg:req', cwd: '/unrelated/project', record }, new Set(['main-id']), dir)).toBe(true)
    expect(belongsToGenio({ key: 'msg:req', cwd: '/unrelated/project', record }, new Set(), dir)).toBe(false)
  })

  it('does not charge a resumed $14.79 cumulative checkpoint as a turn and deduplicates replayed results', () => {
    const file = path.join(dir, 'costs.json')
    expect(new SessionCostLedger(file).record('main', 'r1', 14.7858063, true)).toEqual({ duplicate: false, delta: 0 })
    expect(new SessionCostLedger(file).record('main', 'r2', 15.0123861, true).delta).toBeCloseTo(0.2265798)
    expect(new SessionCostLedger(file).record('main', 'r1', 14.7858063, true)).toEqual({ duplicate: true, delta: 0 })
    expect(new SessionCostLedger(file).record('main', 'r3', 15.1123861, true).delta).toBeCloseTo(0.1)
    expect(new SessionCostLedger(file).record('main', 'r4', 0.2, true).delta).toBe(0.2)
    expect(new SessionCostLedger(file).record('new-session', 'r5', 0.3, false).delta).toBe(0.3)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.main.epoch).toBe(1)
  })
})

it('permits one automatic relaunch per recovery streak and permits manual resume', () => {
  const first = relaunchPolicy({ relaunches: 0 }, false)
  expect(first).toEqual({ allowed: true, nextAttempts: 1 })
  const persisted = JSON.parse(JSON.stringify({ relaunches: 1, automaticRelaunches: first.nextAttempts }))
  expect(relaunchPolicy(persisted, false).allowed).toBe(false)
  expect(relaunchPolicy({ relaunches: 8 }, false).allowed).toBe(false)
  expect(relaunchPolicy(persisted, true)).toEqual({ allowed: true, nextAttempts: 0 })
})
