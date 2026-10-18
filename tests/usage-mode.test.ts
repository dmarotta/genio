import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageReport, UsageWindow } from '../src/shared/api'
import type { BacklogItem, LoadoutInput, Settings, Task, TaskCategory, WorkPlan } from '../src/shared/types'
import { CATEGORY_IDS, CHEAP_MODELS } from '../src/shared/dispatch'
import { CLAUDE_UNIT_MODEL, CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'
import {
  MODE_PRESETS, USAGE_MODES, meterRows, modeSummary, planStatus, quotaWait, type PlanStatus, type UsageMode
} from '../src/shared/usage-mode'
import { unitCaps } from '../src/shared/unit-capacity'
import { createSettingsService, defaultSettings } from '../src/main/settings'
import { createBacklogService } from '../src/main/backlog'
import { Home } from '../src/main/home'
import { bus } from '../src/main/bus'
import { QuotaDeferredQueue } from '../src/main/quota-deferred'
import { pickLoadout, type PickEnv } from '../src/main/loadout'
import { PolicyNotices, chatSettings, heartbeatFor, migrateModelDefaults, migrateUsageSettings, routineDelay, worldUsage } from '../src/main/usage-policy'
import { ACHIEVEMENTS } from '../src/main/stats'
import type { AppCtx } from '../src/main/services'

const scan = vi.hoisted(() => ({ report: {} as UsageReport }))
vi.mock('../src/main/accounts', () => ({ listAccounts: async () => [] }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/usage', async (original) => ({ ...await original<typeof import('../src/main/usage')>(), usageReport: async () => scan.report }))
const { createDispatchService } = await import('../src/main/dispatch')
const { claudeLimitsFile, recordClaudeRateLimit } = await import('../src/main/usage')

const fresh = (usedPercent: number, extra: Partial<UsageWindow> = {}): UsageWindow =>
  ({ label: '5-hour', usedPercent, observedAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 3600_000).toISOString(), ...extra })
const cool = (): Record<string, UsageWindow[]> => ({ claude: [fresh(20)], codex: [fresh(20)] })
const env = (ids: string[], extra: Partial<PickEnv> = {}): PickEnv => ({ available: (h) => ids.includes(h.id), quota: cool(), ...extra })
const ALL = ['claude', 'codex', 'opencode']
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch })
const input = (category: TaskCategory, extra: Partial<LoadoutInput> = {}): LoadoutInput => ({ kind: 'ship', project: 'w', title: 'Work', intent: 'Do the work', category, ...extra })
const SONNET = CLAUDE_UNIT_MODEL

describe('Usage mode: batching and answer length, never a model', () => {
  it('sets batching and targets exactly per the table, and nothing else', () => {
    expect(USAGE_MODES.map((m) => Object.keys(MODE_PRESETS[m]).sort())).toEqual(USAGE_MODES.map(() => ['answerWords', 'heartbeat', 'reconWords', 'wakeBatchMinutes']))
    expect(USAGE_MODES.map((m) => MODE_PRESETS[m].wakeBatchMinutes)).toEqual([10, 5, 1])
    expect(USAGE_MODES.map((m) => heartbeatFor({ usageMode: m }))).toEqual([30, 15, 10].map((b) => ({ baseMs: b * 60_000, maxMs: 120 * 60_000 })))
    expect(USAGE_MODES.map((m) => [MODE_PRESETS[m].answerWords, MODE_PRESETS[m].reconWords])).toEqual([[150, 400], [250, 800], [400, 1500]])
  })

  it.each(USAGE_MODES)('the %s summary names answers and batching, not models or units', mode => {
    expect(modeSummary(mode)).toMatch(/words.*batched/)
    expect(modeSummary(mode)).not.toMatch(/Sonnet|Opus|Codex|units/)
  })

  it('every mode and category gets the same default unit model', () => {
    for (const mode of USAGE_MODES) for (const category of CATEGORY_IDS) {
      expect(pickLoadout(input(category), settings({ usageMode: mode }), env(ALL))).toMatchObject({ harness: 'claude', model: SONNET, effort: 'medium', source: 'default' })
      expect(pickLoadout(input(category), settings({ usageMode: mode }), env(['codex', 'opencode']))).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL, effort: 'medium' })
    }
  })

  it("cheap models only from the player's own lists, and never without the allowance", () => {
    const row = { categoryPools: [{ category: 'docs' as const, candidates: [{ harness: 'opencode', model: CHEAP_MODELS[0].model, cheap: true }, { harness: 'codex' }] }] }
    expect(pickLoadout(input('docs'), settings(row), env(ALL, { cheap: { allowed: true, why: 'ok' } }))).toMatchObject({ harness: 'opencode', model: CHEAP_MODELS[0].model })
    const closed = pickLoadout(input('docs'), settings(row), env(ALL, { cheap: { allowed: false, why: 'no paid-spend allowance' } }))
    expect(closed.harness).toBe('codex')
    expect(closed.reasons.join('\n')).toMatch(/no paid-spend allowance/)
    for (const mode of USAGE_MODES) expect(pickLoadout(input('docs'), settings({ usageMode: mode }), env(ALL, { cheap: { allowed: true, why: 'ok' } })).harness).toBe('claude')
  })

  it('a world mode is read for batching and answers', () => {
    expect(worldUsage({ usageMode: 'balanced' }, { name: 'w', usageMode: 'save' })).toMatchObject({ mode: 'save', source: 'world' })
    expect(worldUsage({ usageMode: 'balanced' }, { name: 'w', costDial: 'quality' })).toMatchObject({ mode: 'max', source: 'legacy-dial' })
    expect(worldUsage({ usageMode: 'save' }, { name: 'w' })).toMatchObject({ mode: 'save', source: 'global' })
  })
})

describe('settings migration', () => {
  it('persists default-on protection without a prompt and retains an explicit opt-out across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-protection-settings-'))
    const events: string[] = []
    const off = bus.onEvent(ev => { if (ev.type === 'feature-used') events.push(ev.feature) })
    try {
      const home = new Home(dir)
      fs.mkdirSync(home.config, { recursive: true })
      fs.writeFileSync(home.settingsFile, JSON.stringify({ usageMode: 'balanced', inboxToken: 'fixture' }))
      const svc = createSettingsService(home)
      expect(svc.get().quotaProtection).toBe(true)
      expect(JSON.parse(fs.readFileSync(home.settingsFile, 'utf8')).quotaProtection).toBe(true)
      expect(events).toEqual([])
      svc.save({ quotaProtection: true })
      expect(events).toEqual([])
      svc.save({ quotaProtection: false })
      expect(events).toEqual(['quota-protection'])
      expect(createSettingsService(home).get().quotaProtection).toBe(false)
    } finally { off(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('keeps explicit picks as written and unsets only the old shipped chat default', () => {
    const old = { wkspModel: 'claude-sonnet-5-5', wkspEffort: 'high', costDial: 'balanced', defaultWorkerModel: 'opus', explorationRate: 0.2 } as Partial<Settings>
    expect(migrateUsageSettings(old)).toMatchObject({ usageMode: 'balanced', wkspModel: 'claude-sonnet-5-5', wkspEffort: 'high', defaultWorkerModel: 'opus' })
    expect(migrateUsageSettings({ wkspModel: '', wkspEffort: 'high' })).toMatchObject({ usageMode: 'balanced', wkspEffort: '' })
    expect(migrateUsageSettings({ wkspModel: '', wkspEffort: 'low' }).wkspEffort).toBe('low')
    expect(migrateUsageSettings({ costDial: 'quality' }).usageMode).toBe('max')
    expect(migrateUsageSettings({ costDial: 'cost' }).usageMode).toBe('save')
    expect(defaultSettings().quotaProtection).toBe(true)
    expect(migrateUsageSettings({ usageMode: 'save' }).quotaProtection).toBe(true)
    const done = { usageMode: 'save', unitsAtOnce: 4, wkspEffort: 'high', quotaProtection: false, plainModelDefaults: true } as Partial<Settings>
    expect(migrateUsageSettings(done)).toBe(done)
  })

  it('keeps locked category rows and rules as the player wrote them; the old shipped defaults become unset', () => {
    const legacy = {
      usageMode: 'balanced', unitsAtOnce: 8, defaultHarness: 'claude', autoReorder: true,
      categoryPools: [
        { category: 'feature', candidates: [{ harness: 'claude' }, { harness: 'codex' }] },
        { category: 'art', locked: true, candidates: [{ harness: 'codex', model: 'custom', effort: 'low' }] }
      ],
      dispatchRules: [{ id: 'r', match: 'shader', locked: true, candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    } as unknown as Partial<Settings>
    const next = migrateModelDefaults(legacy)
    expect(next).toMatchObject({ plainModelDefaults: true, defaultHarness: '', categoryPools: [{ category: 'art', candidates: [{ harness: 'codex', model: 'custom', effort: 'low' }] }] })
    expect(next.categoryPools![0]).not.toHaveProperty('locked')
    expect(next.dispatchRules).toEqual([{ id: 'r', match: 'shader', candidates: [{ harness: 'codex', spendPriority: 0 }] }])
    expect(next).not.toHaveProperty('autoReorder')
    expect(migrateModelDefaults(next)).toBe(next)
    // an explicitly chosen tool, or a tool with its own default model or effort, stays
    expect(migrateModelDefaults({ defaultHarness: 'codex' }).defaultHarness).toBe('codex')
    expect(migrateModelDefaults({ defaultHarness: 'claude', defaultWorkerModel: 'claude-opus-5-5' }).defaultHarness).toBe('claude')
    expect(migrateModelDefaults({ defaultHarness: 'claude', defaultWorkerEffort: 'high' }).defaultHarness).toBe('claude')
    // explicit chat and unit picks are untouched
    expect(migrateModelDefaults({ wkspModel: 'claude-opus-5-5', wkspEffort: 'xhigh', botModel: 'claude-haiku-5-5', defaultWorkerModel: 'm', defaultHarness: 'claude' }))
      .toMatchObject({ wkspModel: 'claude-opus-5-5', wkspEffort: 'xhigh', botModel: 'claude-haiku-5-5', defaultWorkerModel: 'm', defaultHarness: 'claude' })
  })

  it('migrates a saved settings file once, and a new install starts on the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-model-migration-'))
    try {
      const home = new Home(dir)
      fs.mkdirSync(home.config, { recursive: true })
      fs.writeFileSync(home.settingsFile, JSON.stringify({ usageMode: 'max', unitsAtOnce: 16, inboxToken: 't', defaultHarness: 'claude', autoReorder: true,
        categoryPools: [{ category: 'feature', candidates: [{ harness: 'claude' }] }, { category: 'ui', locked: true, candidates: [{ harness: 'claude', model: 'claude-opus-5-5' }] }] }))
      const s = createSettingsService(home).get()
      expect(s).toMatchObject({ defaultHarness: '', plainModelDefaults: true, categoryPools: [{ category: 'ui', candidates: [{ harness: 'claude', model: 'claude-opus-5-5' }] }] })
      const saved = JSON.parse(fs.readFileSync(home.settingsFile, 'utf8'))
      expect(saved).toMatchObject({ plainModelDefaults: true, defaultHarness: '' })
      expect(saved).not.toHaveProperty('autoReorder')
      // a later explicit choice of Claude survives the next start
      createSettingsService(home).save({ defaultHarness: 'claude' })
      expect(createSettingsService(home).get().defaultHarness).toBe('claude')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    expect(defaultSettings()).toMatchObject({ defaultHarness: '', categoryPools: [], wkspModel: '', wkspEffort: '', plainModelDefaults: true })
  })
})

describe('the chat model: the player’s, else the default', () => {
  it('defaults to Claude Sonnet 5.5 / medium, or Codex Sol 6.1 when only Codex is signed in', () => {
    const cases: [Parameters<typeof chatSettings>[1], string][] = [
      [{}, SONNET], [{ claude: true, codex: true }, SONNET], [{ claude: true, codex: false }, SONNET],
      [{ claude: false, codex: true }, `codex:OpenAI:${CODEX_UNIT_MODEL}`], [{ claude: false, codex: false }, SONNET], [{ claude: undefined, codex: true }, SONNET]
    ]
    for (const [signIns, model] of cases) expect(chatSettings(settings(), signIns)).toMatchObject({ wkspModel: model, wkspEffort: 'medium', botModel: SONNET })
  })

  it('never changes a chat model or effort the player set, at any mode or protection level', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-mode-'))
    try {
      recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.97 })
      for (const usageMode of USAGE_MODES) for (const signIns of [{}, { claude: false, codex: true }]) {
        expect(chatSettings(settings({ usageMode, wkspModel: 'claude-opus-5-5', wkspEffort: 'high', botModel: 'claude-haiku-5-5' }), signIns))
          .toMatchObject({ wkspModel: 'claude-opus-5-5', wkspEffort: 'high', botModel: 'claude-haiku-5-5' })
        expect(chatSettings(settings({ usageMode }), {})).toMatchObject({ wkspModel: SONNET, wkspEffort: 'medium' })
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('explicit unit picks', () => {
  it('keeps the unit model/effort the player set, and explicit deploy picks over everything', () => {
    const s = settings({ usageMode: 'balanced', defaultHarness: 'claude', defaultWorkerModel: 'claude-fable-5-1', defaultWorkerEffort: 'max' })
    const l = pickLoadout(input('feature'), s, env(['claude']))
    expect(l).toMatchObject({ harness: 'claude', model: 'claude-fable-5-1', effort: 'max' })
    expect(l.reasons.join('\n')).toMatch(/your default unit model/)
    // a warm plan never lowers an effort
    expect(pickLoadout(input('feature'), s, env(['claude'], { quota: { claude: [fresh(75)] } })).effort).toBe('max')
    expect(pickLoadout(input('feature', { harness: 'claude', model: 'm', effort: 'low' }), settings({ usageMode: 'max' }), env(ALL))).toMatchObject({ harness: 'claude', model: 'm', effort: 'low', source: 'player' })
  })

  it('a category row is used as written in every mode', () => {
    const pools = [{ category: 'feature' as const, candidates: [{ harness: 'claude', model: 'x', effort: 'low' }] }]
    for (const mode of USAGE_MODES) expect(pickLoadout(input('feature'), settings({ usageMode: mode, categoryPools: pools }), env(ALL))).toMatchObject({ harness: 'claude', model: 'x', effort: 'low', source: 'table' })
  })
})

describe('stale, unknown and rejected quota combinations', () => {
  const stale = (pct: number): UsageWindow => ({ label: '5-hour', stale: true, lastKnownUsedPercent: pct, observedAt: new Date(Date.now() - 3600_000).toISOString() })

  it('maps evidence to protection levels', () => {
    expect(planStatus('claude', undefined)).toMatchObject({ level: 'ok', known: false })
    expect(planStatus('claude', [fresh(69)])).toMatchObject({ level: 'ok', known: true, percent: 69 })
    expect(planStatus('claude', [fresh(70)]).level).toBe('warm')
    expect(planStatus('claude', [fresh(84)]).level).toBe('warm')
    expect(planStatus('claude', [fresh(85)]).level).toBe('hot')
    expect(planStatus('claude', [fresh(94)]).level).toBe('hot')
    expect(planStatus('claude', [fresh(95)]).level).toBe('out')
    expect(planStatus('claude', [fresh(10), { label: 'weekly', status: 'rejected', observedAt: new Date().toISOString() }])).toMatchObject({ level: 'out', rejected: true, window: 'weekly' })
    // All expired evidence is unknown; current readings alone protect quota
    expect(planStatus('claude', [stale(40)])).toMatchObject({ level: 'ok', known: false })
    expect(planStatus('claude', [stale(97)])).toMatchObject({ level: 'ok', known: false })
    expect(planStatus('claude', [fresh(20), stale(88)]).level).toBe('ok')
  })

  const runs: [string, Record<string, UsageWindow[]>][] = [
    ['claude warm (75%)', { claude: [fresh(75)], codex: [fresh(20)] }],
    ['claude stale hot: unknown', { claude: [stale(97)], codex: [fresh(20)] }],
    ['claude never reported', { codex: [fresh(20)] }],
    ['codex hot (88%)', { claude: [fresh(20)], codex: [fresh(88)] }],
    ['codex rejected', { claude: [fresh(20)], codex: [{ label: 'weekly', status: 'rejected', observedAt: new Date().toISOString() }] }]
  ]
  for (const [name, quota] of runs) {
    it(`default feature unit: ${name} runs the default at its effort`, () => {
      expect(pickLoadout(input('feature'), settings(), env(ALL, { quota }))).toMatchObject({ harness: 'claude', model: SONNET, effort: 'medium' })
    })
  }

  const waits: [string, Record<string, UsageWindow[]>][] = [
    ['claude hot (88%)', { claude: [fresh(88)], codex: [fresh(20)] }],
    ['claude out (96%)', { claude: [fresh(96)], codex: [fresh(20)] }],
    ['claude rejected', { claude: [{ label: 'weekly', status: 'rejected', observedAt: new Date().toISOString() }], codex: [fresh(20)] }]
  ]
  for (const [name, quota] of waits) {
    it(`default feature unit: ${name} waits and is never moved to Codex`, () => {
      expect(() => pickLoadout(input('feature'), settings(), env(ALL, { quota }))).toThrow(/deferred: Claude Code is held by quota protection.*keeps its tool and model/)
      expect(pickLoadout(input('feature'), settings({ quotaProtection: false }), env(ALL, { quota })).harness).toBe('claude')
    })
  }

  it('the chat sessions never read quota for their model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-quota-'))
    try {
      recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'five_hour' })
      expect(chatSettings(settings({ usageMode: 'max' }), { claude: true })).toMatchObject({ wkspModel: SONNET, wkspEffort: 'medium' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('queued work waits for a reset instead of being dropped', () => {
    const p = (plan: 'claude' | 'codex', level: PlanStatus['level'], resetsAt?: string): PlanStatus => ({ plan, level, known: true, percent: 96, resetsAt })
    const soon = new Date(Date.now() + 3600_000).toISOString()
    expect(quotaWait('normal', [p('claude', 'ok'), p('codex', 'ok')])).toBeUndefined()
    expect(quotaWait('low', [p('claude', 'out', soon), p('codex', 'ok')])).toMatchObject({ plan: 'claude', until: soon, reason: expect.stringMatching(/low priority/) })
    expect(quotaWait('normal', [p('claude', 'out', soon), p('codex', 'ok')])).toBeUndefined()
    expect(quotaWait('critical', [p('claude', 'hot'), p('codex', 'out', soon)])).toMatchObject({ reason: expect.stringMatching(/no plan has headroom/) })
    expect(quotaWait('low', [p('claude', 'out', new Date(Date.now() - 1000).toISOString())])).toMatchObject({ until: undefined })
    expect(quotaWait('low', [])).toBeUndefined()
  })
})

describe('shared plan meter', () => {
  it('shows each plan separately, unknown for expired or missing evidence, never 100% left', () => {
    const report = {
      tools: [
        { tool: 'claude', limits: [{ source: 'reported by Claude Code', updatedAt: '', windows: [{ label: '5-hour', usedPercent: 97, observedAt: new Date().toISOString() }, { label: 'weekly', stale: true, lastKnownUsedPercent: 10 }] }] },
        { tool: 'codex', limits: [{ source: 'reported by Codex', updatedAt: '', windows: [{ label: 'weekly', usedPercent: 11, observedAt: new Date().toISOString() }] }] }
      ]
    }
    const [claude, codex] = meterRows(report)
    expect(claude).toMatchObject({ plan: 'claude', level: 'out', headline: { label: '5-hour', state: 'known', leftPercent: 3 }, missing: [] })
    expect(claude.windows[1]).toMatchObject({ label: 'weekly', state: 'unknown' })
    expect(claude.windows[1].leftPercent).toBeUndefined()
    expect(codex).toMatchObject({ plan: 'codex', headline: { leftPercent: 89 }, missing: ['5-hour'] })
    const empty = meterRows({ tools: [] })
    expect(empty.map((r) => r.headline)).toEqual([undefined, undefined])
    expect(meterRows({ tools: [{ tool: 'claude', limits: [{ source: '', updatedAt: '', windows: [{ label: '5-hour', status: 'rejected', observedAt: new Date().toISOString() }] }] }] })[0].headline).toMatchObject({ state: 'limit', leftPercent: 0 })
  })
})

describe('notices on policy transitions only', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-notices-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('emits once per level change, survives restarts, ignores unknown headroom', () => {
    const at = (pct?: number): PlanStatus => planStatus('claude', pct === undefined ? undefined : [fresh(pct)])
    const n = new PolicyNotices(dir)
    expect(n.observe([at(undefined)])).toEqual([])
    expect(n.observe([at(40)])).toEqual([])
    const warm = n.observe([at(75)])
    expect(warm).toHaveLength(1)
    expect(warm[0]).toMatchObject({ from: 'ok', to: 'warm', text: 'Claude at 75%: one Claude unit at a time.' })
    expect(warm[0].details).toMatch(/cause: Claude 5-hour window 75% · evidence under a minute old/)
    expect(n.observe([at(78)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(80)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(97)], 2)[0].text).toMatch(/Claude reached its limit: new Claude units wait until .*; optional chat work waits; 2 low-priority quests wait/)
    expect(new PolicyNotices(dir).observe([at(97)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(20)])[0]).toMatchObject({ to: 'ok', text: 'Claude is back under 70%: no limit on Claude units.' })
    expect(new PolicyNotices(dir).list().map((x) => x.to)).toEqual(['ok', 'out', 'warm'])
  })
})

describe('routine wake batching', () => {
  it('holds routine-only batches for the mode window and never delays urgent events', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    const ts = new Date(now - 60_000).toISOString()
    expect(routineDelay([{ routine: true, ts }], 5 * 60_000, now)).toBe(4 * 60_000)
    expect(routineDelay([{ routine: true, ts }, { routine: false, ts }], 5 * 60_000, now)).toBe(0)
    expect(routineDelay([{ routine: true, ts: new Date(now - 600_000).toISOString() }], 5 * 60_000, now)).toBe(0)
    expect(routineDelay([], 5 * 60_000, now)).toBe(0)
  })
})

describe('concurrent unit cap across worlds', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-cap-'))
    scan.report = { tools: ['claude', 'codex'].map((tool) => ({ tool, limits: [{ source: 'test', updatedAt: new Date().toISOString(), windows: [{ label: '5-hour', usedPercent: 20 }] }] })) } as UsageReport
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const task = (project: string, state: Task['state'] = 'working'): Task => ({ id: `${project}-${Math.random()}`, project, state, harness: 'codex', terminalId: 'live' }) as Task
  function service(mode: UsageMode, tasks: Task[] = [], worlds: Record<string, { capacity?: number; usageMode?: UsageMode }> = {}, backlog: BacklogItem[] = [], overrides: Partial<Settings> = {}) {
    const s = settings({ ...migrateUsageSettings({ usageMode: mode }), ...overrides })
    const homes = new Map([
      ['main', { home: { data: dir }, plans: { list: vi.fn(() => [] as WorkPlan[]) }, supervisor: { poke: vi.fn() }, wakes: { pending: () => [] }, crew: { retryQuotaDeferred: vi.fn(async () => {}), hasQuotaDeferred: () => false, list: () => tasks.filter((t) => !t.wksp), get: (id: string) => tasks.find(t => t.id === id && !t.wksp) }, backlog: { list: () => backlog } }],
      ['ally', { home: { data: path.join(dir, 'ally') }, plans: { list: vi.fn(() => [] as WorkPlan[]) }, supervisor: { poke: vi.fn() }, wakes: { pending: () => [] }, crew: { retryQuotaDeferred: vi.fn(async () => {}), hasQuotaDeferred: () => false, list: () => tasks.filter((t) => t.wksp === 'ally'), get: (id: string) => tasks.find(t => t.id === id && t.wksp === 'ally') }, backlog: { list: () => [] } }]
    ])
    const ctx = {
      settings: { get: () => s, availableHarnesses: () => s.harnesses.filter((h) => ['claude', 'codex'].includes(h.id)) },
      projects: { get: (name: string) => (worlds[name] ? { name, ...worlds[name] } : { name }), list: () => Object.keys(worlds).map((name) => ({ name, ...worlds[name] })) },
      main: { home: { data: dir } }, homes, terminals: { get: (id: string) => id === 'live' ? { alive: true } : undefined }
    } as unknown as AppCtx
    return Object.assign(createDispatchService(() => ctx), { settings: s, homes })
  }
  const ship = (project: string): LoadoutInput => ({ kind: 'ship', project, title: 'Add docs', intent: 'Add docs', category: 'docs' })

  it('queues by the independent limit, ignores mode changes and reopens capacity when the limit changes', async () => {
    const svc = service('max', [task('a'), task('b')], {}, [], { unitsAtOnce: 2 })
    const home = new Home(dir); home.ensure()
    const ctx = { dispatch: svc, homes: new Map(), projects: { get: () => ({ capacity: 0 }) } } as unknown as AppCtx
    const backlog = createBacklogService(() => ctx, home)
    const quest = backlog.add({ project: 'next', title: 'Waiting quest', kind: 'ship' })
    expect(backlog.dispatchable()).toHaveLength(0)
    svc.settings.usageMode = 'save'
    expect(svc.capacity().cap).toBe(2)
    expect(backlog.dispatchable()).toHaveLength(0)
    svc.settings.unitsAtOnce = 3
    expect(backlog.dispatchable().map(q => q.id)).toEqual([quest.id])
    const slot = await svc.reserve(ship('next'))
    expect(backlog.dispatchable()).toHaveLength(0)
    slot.release()
    expect(backlog.dispatchable().map(q => q.id)).toEqual([quest.id])
  })

  it('counts units in every world and base against the configured global cap', async () => {
    for (const [mode, cap] of [['save', 4], ['balanced', 8], ['max', 16]] as const) {
      const tasks = Array.from({ length: cap - 1 }, (_, i) => ({ ...task(`world-${i}`), ...(i % 2 ? { wksp: 'ally' } : {}) }))
      const svc = service(mode, tasks)
      const last = await svc.reserve(ship('last'))
      expect(svc.capacity()).toEqual({ cap, used: cap })
      await expect(svc.reserve(ship('over'))).rejects.toThrow(`allows ${cap} concurrent units across all projects`)
      last.release()
    }
    const ok = await service('balanced', [task('a'), task('b', 'done'), { ...task('c', 'ready'), pr: { url: 'x' } }]).reserve(ship('d'))
    ok.release()
    expect(service('max', [task('a'), task('b')]).capacity()).toEqual({ cap: 16, used: 2 })
  })

  it('counts launches that are reserved but not listed yet, and frees them on listing or release', async () => {
    const svc = service('balanced', Array.from({ length: 6 }, () => task('existing')))
    const a = await svc.reserve(ship('a'))
    expect(svc.capacity().used).toBe(7)
    const b = await svc.reserve({ ...ship('b'), harness: 'claude' })
    expect(svc.capacity().used).toBe(8)
    await expect(svc.reserve({ ...ship('c'), harness: 'claude' })).rejects.toThrow(/allows 8/)
    a.listed()
    a.listed()
    expect(svc.capacity().used).toBe(7)
    a.release()
    b.release()
    expect(svc.capacity().used).toBe(6)
  })

  it('serializes competing project launches against the last global place across providers', async () => {
    const svc = service('save', [task('a'), { ...task('b'), wksp: 'ally' }, task('c')])
    const attempts = await Promise.allSettled([
      svc.reserve({ ...ship('d'), harness: 'codex' }),
      svc.reserve({ ...ship('e'), harness: 'claude' })
    ])
    expect(attempts.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((attempts[1] as PromiseRejectedResult).reason.message).toContain('allows 4 concurrent units across all projects')
    const slot = (attempts[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.reserve>>>).value
    slot.release()
    const next = await svc.reserve({ ...ship('e'), harness: 'claude' })
    expect(svc.capacity().used).toBe(4)
    next.release()
  })

  it('disables holds for launches with a chosen model, concurrent launches and queued quests without hiding the meter', async () => {
    for (const tool of scan.report.tools) tool.limits[0].windows = [fresh(97)]
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'five_hour' })
    const quest = { id: 'q', kind: 'ship', state: 'queued', priority: 'low' } as BacklogItem
    const svc = service('max', [task('running')], {}, [quest], { quotaProtection: false })
    const first = await svc.reserve({ ...ship('a'), harness: 'codex', model: 'chosen-model', effort: 'high' })
    const second = await svc.reserve({ ...ship('b'), harness: 'codex' })
    const claude = await svc.reserve({ ...ship('c'), harness: 'claude' })
    await first.check()
    await second.check()
    await claude.check()
    expect(first.loadout).toMatchObject({ model: 'chosen-model', effort: 'high' })
    expect(svc.quotaWait(quest)).toBeUndefined()
    expect(svc.view()).toMatchObject({ quotaProtection: false, waiting: [], heldLaunches: [], chat: { model: SONNET, effort: 'medium' } })
    expect(svc.view().meter[0].headline?.state).toBe('limit')
    expect(svc.reportWords('a', 'claude')).toBe(MODE_PRESETS.max.reconWords)
    first.release(); second.release(); claude.release()
  })

  it('reads held launch names from the durable retry queue and removes them on recovery, cancellation or switch-off', async () => {
    scan.report.tools.find(t => t.tool === 'codex')!.limits[0].windows = [fresh(90)]
    const svc = service('balanced')
    await expect(svc.reserve({ ...ship('a'), title: 'Build the castle', harness: 'codex' })).rejects.toThrow(/held/)
    const queue = new QuotaDeferredQueue(dir)
    queue.put('quest:castle', { kind: 'spawn', request: { ...ship('a'), title: 'Build the castle', harness: 'codex', backlogId: 'castle' } })
    const restarted = service('balanced')
    restarted.noteUsage(scan.report)
    expect(restarted.view().heldLaunches).toEqual([{ project: 'a', title: 'Build the castle', plan: 'codex' }])
    restarted.settings.quotaProtection = false
    expect(restarted.view().heldLaunches).toEqual([])
    const door = { ...task('a'), title: 'Fix the door' }
    queue.put(`unit:${door.id}`, { kind: 'relaunch', id: door.id, manual: true })
    const resumed = service('balanced', [door])
    resumed.noteUsage(scan.report)
    expect(resumed.view().heldLaunches.map(launch => launch.title)).toEqual(['Build the castle', 'Fix the door'])
    queue.remove(`unit:${door.id}`)
    queue.remove('quest:castle')
    expect(svc.view().heldLaunches).toEqual([])
    queue.put('quest:castle', { kind: 'spawn', request: { ...ship('a'), title: 'Build the castle', harness: 'codex', backlogId: 'castle' } })
    const recovery = structuredClone(scan.report)
    recovery.tools.find(t => t.tool === 'codex')!.limits[0].windows = [fresh(20, { observedAt: new Date(Date.now() + 1).toISOString() })]
    svc.noteUsage(recovery)
    expect(svc.view().heldLaunches).toEqual([])
  })

  it('also names held plan steps, whose retries belong to the plan rather than the standalone queue', () => {
    scan.report.tools.find(t => t.tool === 'codex')!.limits[0].windows = [fresh(90)]
    const quest = { id: 'step-quest', kind: 'ship', state: 'queued' } as BacklogItem
    const svc = service('balanced', [], {}, [quest])
    const work = { world: 'a', state: 'active', steps: [{ questId: quest.id, title: 'Build the bridge', harness: 'codex', lastAttempt: { message: 'waiting for quota: held by quota protection' } }] } as WorkPlan
    svc.homes.get('main')!.plans.list.mockReturnValue([work])
    svc.noteUsage(scan.report)
    expect(svc.view().heldLaunches).toEqual([{ project: 'a', title: 'Build the bridge', plan: 'codex' }])
    quest.hold = { reason: 'Later', since: '' }
    expect(svc.view().heldLaunches).toEqual([])
  })

  it('retries held launches immediately when protection is disabled and cleans up its settings listener', async () => {
    const svc = service('balanced')
    svc.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    const home = svc.homes.get('main')!
    home.crew.retryQuotaDeferred.mockClear()
    home.supervisor.poke.mockClear()
    try {
      svc.settings.quotaProtection = false
      bus.publish({ type: 'settings', settings: svc.settings })
      expect(home.crew.retryQuotaDeferred).toHaveBeenCalledOnce()
      expect(home.supervisor.poke).toHaveBeenCalledWith(true)
      svc.stop()
      svc.settings.quotaProtection = true
      bus.publish({ type: 'settings', settings: svc.settings })
      expect(home.supervisor.poke).toHaveBeenCalledOnce()
    } finally { svc.stop() }
  })

  it('runs one unit at a time on a warm plan across project bases, and never moves the launch to the other plan', async () => {
    scan.report.tools.find(t => t.tool === 'claude')!.limits[0].windows[0] = fresh(75)
    const svc = service('balanced', [{ ...task('a'), harness: 'claude', wksp: 'ally' }])
    await expect(svc.reserve({ ...ship('b'), harness: 'claude' })).rejects.toThrow(/deferred: .*held by quota protection/)
    await expect(svc.reserve(ship('b'))).rejects.toThrow(/keeps its tool and model/)
    const other = await svc.reserve({ ...ship('b'), harness: 'codex' })
    await other.check()
    other.release()
  })

  it('lets launches on a plan below 70% run side by side', async () => {
    const svc = service('balanced')
    const a = await svc.reserve(ship('a'))
    const b = await svc.reserve(ship('b'))
    expect([a.loadout.harness, b.loadout.harness]).toEqual(['claude', 'claude'])
    a.release(); b.release()
  })

  it.each(['ready', 'merged', 'done', 'failed', 'cleaned'] as const)('finished %s records in every home release global and world capacity despite live terminals', async state => {
    const records = Array.from({ length: 8 }, (_, i) => ({ ...task('a', state), wksp: i % 2 ? 'ally' : '', pr: i % 3 ? { url: 'https://example.com/pull/1' } : undefined }))
    const svc = service('balanced', records, { a: { capacity: 2 } })
    expect(svc.capacity()).toEqual({ cap: 8, used: 0 })
    const slot = await svc.reserve({ ...ship('a'), harness: 'codex' })
    expect(svc.capacity().used).toBe(1)
    expect(svc.view().liveUnits).toBe(1)
    slot.release()
    expect(svc.capacity().used).toBe(0)
  })

  it.each(['ready', 'merged', 'done', 'exited'] as const)('releases an unlisted %s respawn after a deferred or failed launch, without stealing another reservation', async state => {
    const target = { ...task('a', state), terminalId: state === 'exited' ? undefined : 'live' }
    const svc = service('balanced', [target], { a: { capacity: 2 } })
    const restartInput = { ...ship('a'), harness: 'codex' }
    const restartOptions = { respawn: { id: target.id, wksp: 'main' } }
    for (let i = 0; i < 10; i++) {
      const restart = await svc.reserve(restartInput, restartOptions)
      expect(svc.capacity().used).toBe(1)
      restart.release() // preparation failed or deferred before task was listed
      expect(svc.capacity().used).toBe(0)
      const next = await svc.reserve(restartInput, restartOptions)
      restart.listed()
      restart.release()
      expect(svc.capacity().used).toBe(1)
      next.listed() // now the respawn is recorded as spawning
      target.state = 'spawning'
      expect(svc.capacity().used).toBe(1)
      target.state = state // terminal creation failed, or the run finished
      next.release()
      expect(svc.capacity().used).toBe(0)
    }
  })

  it('counts working units with historical PRs and ignores finished terminals for warm provider protection', async () => {
    const active = { ...task('a'), pr: { url: 'https://example.com/pull/1' } }
    expect(service('balanced', [active]).capacity().used).toBe(1)
    await expect(service('balanced', [active, task('a')], { a: { capacity: 2 } }).reserve(ship('a'))).rejects.toThrow(/a allows 2 concurrent units/)
    scan.report = { tools: [{ tool: 'codex', limits: [{ source: 'test', updatedAt: new Date().toISOString(), windows: [fresh(75)] }] }] } as UsageReport
    const finished = ['ready', 'merged', 'done', 'failed', 'cleaned'].map(state => task('a', state as Task['state']))
    const svc = service('balanced', finished)
    const slot = await svc.reserve({ ...ship('a'), harness: 'codex' })
    await slot.check()
    slot.release()
    await expect(service('balanced', [active]).reserve({ ...ship('b'), harness: 'codex' })).rejects.toThrow(/deferred/)
  })

  it.each(USAGE_MODES)('uses the independent limit in %s for reservations and the policy view', async mode => {
    const svc = service(mode, [task('a'), task('b')], {}, [], { unitsAtOnce: 3 })
    expect(svc.capacity()).toEqual({ cap: 3, used: 2 })
    expect(svc.view().unitCap).toBe(3)
    const slot = await svc.reserve(ship('c'))
    await expect(svc.reserve(ship('d'))).rejects.toThrow(/allows 3 concurrent units/)
    slot.release()
  })

  it('only explicit project capacity lowers the cap; a respawn keeps its place', async () => {
    expect(unitCaps(4)).toEqual({ global: 4, world: undefined })
    expect(unitCaps(16, { capacity: 2 })).toEqual({ global: 16, world: 2 })
    expect(unitCaps(8, { capacity: 20 })).toEqual({ global: 8, world: undefined })
    expect(unitCaps(8, { capacity: 8 })).toEqual({ global: 8, world: undefined })
    expect(unitCaps(8, { capacity: 0 })).toEqual({ global: 8, world: undefined })
    const slow = service('max', Array.from({ length: 4 }, () => task('slow')), { slow: { usageMode: 'save' } })
    const allowed = await slow.reserve(ship('slow'))
    expect(slow.view().worlds[0].cap).toBeUndefined()
    allowed.release()
    await expect(service('max', [task('slow'), task('slow')], { slow: { usageMode: 'save', capacity: 2 } }).reserve(ship('slow'))).rejects.toThrow(/slow allows 2 concurrent units/)
    const active = task('a')
    const respawn = await service('save', [active, task('b'), task('c'), task('d')]).reserve({ ...ship('a'), harness: 'codex' }, { respawn: { id: active.id, wksp: 'main' } })
    respawn.release()
  })

  it('frees absent, dead and recalled terminals but counts live waits and unstarted launches', async () => {
    const records = [...Array.from({ length: 7 }, () => task('a')), ...(['exited', 'detached', 'working', 'paused'] as const).map(state => ({ ...task('b', state), terminalId: undefined }))]
    const svc = service('balanced', records)
    expect(svc.capacity()).toEqual({ used: 7, cap: 8 })
    const slot = await svc.reserve(ship('new'))
    expect(svc.capacity().used).toBe(8)
    await expect(svc.reserve(ship('over'))).rejects.toThrow(/allows 8/)
    slot.release()
    expect(service('max', [task('a', 'paused'), { ...task('a', 'spawning'), terminalId: undefined }, { ...task('a'), terminalId: 'dead' }]).capacity().used).toBe(2)
  })

  it('reserves a new place for an absent-terminal restart instead of bypassing caps', async () => {
    const stopped = { ...task('b', 'exited'), terminalId: undefined }
    const full = service('save', [task('a'), task('c'), task('d'), task('e'), stopped])
    const refusal = full.reserve({ ...ship('b'), harness: 'codex' }, { respawn: { id: stopped.id, wksp: 'main' } })
    await expect(refusal).rejects.toThrow(/allows 4/)
    // A respawn has no quest to queue: it says the unit stays as it is.
    await expect(refusal).rejects.toThrow(/not respawned and stays as it is/)
    await expect(refusal).rejects.not.toThrow(/quest stays queued/)
    await expect(full.reserve({ ...ship('f'), harness: 'codex' })).rejects.toThrow(/The quest stays queued/)
    const svc = service('balanced', [task('a'), stopped])
    const restart = await svc.reserve({ ...ship('b'), harness: 'codex' }, { respawn: { id: stopped.id, wksp: 'main' } })
    expect(svc.capacity().used).toBe(2)
    restart.release()
    expect(svc.capacity().used).toBe(1)
  })

  it('does not mistake a live replacement for a second warm-plan unit', async () => {
    scan.report = { tools: [{ tool: 'codex', limits: [{ source: 'test', updatedAt: new Date().toISOString(), windows: [fresh(75)] }] }] } as UsageReport
    const active = task('a')
    const svc = service('save', [active])
    const replacement = await svc.reserve({ ...ship('a'), harness: 'codex' }, { respawn: { id: active.id, wksp: 'main' } })
    await replacement.check()
    replacement.release()
  })

  it('reports queued-until-reset quests in the policy view', async () => {
    recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600 })
    const quest = (id: string, priority: BacklogItem['priority']): BacklogItem => ({ id, title: id, kind: 'ship', state: 'queued', priority, dependsOn: [], tags: [], notes: '', createdAt: '', updatedAt: '' })
    const view = service('balanced', [], {}, [quest('low-one', 'low'), quest('normal-one', 'normal')]).view()
    expect(view.waiting.map((w) => w.id)).toEqual(['low-one'])
    expect(view.plans[0]).toMatchObject({ plan: 'claude', level: 'out' })
    expect(view.meter[0].headline).toMatchObject({ state: 'limit' })
    expect(view.notices[0]).toMatchObject({ plan: 'claude', to: 'out' })
  })
})

it('switching the Usage mode is an achievement with a feature tag', () => {
  expect(ACHIEVEMENTS.find((a) => a.id === 'usage-mode')).toMatchObject({ feature: 'systems', name: expect.any(String) })
})
