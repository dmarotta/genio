import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageReport, UsageWindow } from '../src/shared/api'
import type { BacklogItem, LoadoutInput, Settings, Task, TaskCategory } from '../src/shared/types'
import { CATEGORY_IDS, CHEAP_MODELS } from '../src/shared/dispatch'
import {
  MODE_PRESETS, OPUS, SONNET, USAGE_MODES, meterRows, planStatus, quotaWait, resolveChat, unitCaps, type PlanStatus, type UsageMode
} from '../src/shared/usage-mode'
import { defaultSettings } from '../src/main/settings'
import { pickLoadout, type PickEnv } from '../src/main/loadout'
import { PolicyNotices, chatSettings, heartbeatFor, migrateUsageSettings, routineDelay, worldUsage } from '../src/main/usage-policy'
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

// The report's table, written out literally (S Sonnet, O Opus, C Codex default).
const TABLE: Record<UsageMode, Record<string, string>> = {
  save: { light: 'C/low', build: 'S/medium', deep: 'C/medium', review: 'C/medium', art: 'C/low' },
  balanced: { light: 'C/medium', build: 'C/medium', deep: 'C/high', review: 'C/high', art: 'C/medium' },
  max: { light: 'C/high', build: 'O/high', deep: 'O/xhigh', review: 'C/xhigh', art: 'C/high' }
}
const GROUP: Record<TaskCategory, string> = {
  chore: 'light', docs: 'light', tests: 'light', 'build-ci': 'light', feature: 'build', bugfix: 'build', ui: 'build',
  'recon-design': 'deep', refactor: 'deep', graphics: 'deep', review: 'review', 'large-context': 'review', art: 'art'
}
const SLOT = { S: { harness: 'claude', model: SONNET }, O: { harness: 'claude', model: OPUS }, C: { harness: 'codex', model: undefined } }
const FALLBACK = { S: 'C', C: 'S', O: 'C' } as const

describe('every preset x category', () => {
  for (const mode of USAGE_MODES) {
    for (const category of CATEGORY_IDS) {
      const [slot, effort] = TABLE[mode][GROUP[category]].split('/') as ['S' | 'O' | 'C', string]
      it(`${mode} / ${category} -> ${slot} ${effort}, falling back to ${FALLBACK[slot]} at the same effort`, () => {
        const l = pickLoadout(input(category), settings({ usageMode: mode }), env(ALL))
        expect(l).toMatchObject({ ...SLOT[slot], effort, source: 'mode', category })
        expect(l.explored).toBeUndefined()
        const without = ALL.filter((id) => id !== SLOT[slot].harness)
        const f = pickLoadout(input(category), settings({ usageMode: mode }), env(without))
        expect(f).toMatchObject({ ...SLOT[FALLBACK[slot]], effort, source: 'mode' })
      })
    }
  }

  it('sets cap, exploration, cheap use, batching and targets exactly per the table', () => {
    expect(USAGE_MODES.map((m) => MODE_PRESETS[m].unitCap)).toEqual([1, 2, 4])
    expect(USAGE_MODES.map((m) => MODE_PRESETS[m].exploration)).toEqual([0, 0, 0.05])
    expect(USAGE_MODES.map((m) => MODE_PRESETS[m].cheap)).toEqual(['first', 'fallback', 'off'])
    expect(USAGE_MODES.map((m) => MODE_PRESETS[m].wakeBatchMinutes)).toEqual([10, 5, 1])
    expect(USAGE_MODES.map((m) => heartbeatFor({ usageMode: m }))).toEqual([30, 15, 10].map((b) => ({ baseMs: b * 60_000, maxMs: 120 * 60_000 })))
    expect(USAGE_MODES.map((m) => [MODE_PRESETS[m].answerWords, MODE_PRESETS[m].reconWords])).toEqual([[150, 400], [250, 800], [400, 1500]])
    expect(USAGE_MODES.map((m) => resolveChat(m, {}))).toMatchObject([
      { model: SONNET, effort: 'low' }, { model: SONNET, effort: 'medium' }, { model: OPUS, effort: 'high' }
    ])
  })

  it('cheap models: Save first, Balanced after the plans, Max never, never for high-stakes work, never without the allowance', () => {
    const open = { cheap: { allowed: true, why: 'ok' } }
    expect(pickLoadout(input('docs'), settings({ usageMode: 'save' }), env(ALL, open))).toMatchObject({ harness: 'opencode', model: CHEAP_MODELS[0].model })
    expect(pickLoadout(input('docs'), settings({ usageMode: 'balanced' }), env(ALL, open)).harness).toBe('codex')
    expect(pickLoadout(input('docs'), settings({ usageMode: 'balanced' }), env(['opencode'], open)).harness).toBe('opencode')
    expect(() => pickLoadout(input('docs'), settings({ usageMode: 'max' }), env(['opencode'], open))).toThrow(/deferred/)
    expect(pickLoadout(input('feature'), settings({ usageMode: 'save' }), env(ALL, open)).harness).toBe('claude')
    const closed = pickLoadout(input('docs'), settings({ usageMode: 'save' }), env(ALL, { cheap: { allowed: false, why: 'no paid-spend allowance' } }))
    expect(closed.harness).toBe('codex')
    expect(closed.reasons.join('\n')).toMatch(/no paid-spend allowance/)
  })

  it('a world mode applies to its picks', () => {
    expect(pickLoadout(input('feature'), settings({ usageMode: 'save' }), env(ALL, { mode: 'max', modeFromWorld: true }))).toMatchObject({ harness: 'claude', model: OPUS, effort: 'high' })
    expect(worldUsage({ usageMode: 'balanced' }, { name: 'w', usageMode: 'save' })).toMatchObject({ mode: 'save', source: 'world' })
    expect(worldUsage({ usageMode: 'balanced' }, { name: 'w', costDial: 'quality' })).toMatchObject({ mode: 'max', source: 'legacy-dial' })
    expect(worldUsage({ usageMode: 'save' }, { name: 'w' })).toMatchObject({ mode: 'save', source: 'global' })
  })
})

describe('pinned overrides', () => {
  it('migrates explicit picks as Pinned and only the old shipped chat default to Auto', () => {
    const old = { wkspModel: 'claude-sonnet-5-5', wkspEffort: 'high', costDial: 'balanced', defaultWorkerModel: 'opus', explorationRate: 0.2 } as Partial<Settings>
    expect(migrateUsageSettings(old)).toMatchObject({ usageMode: 'balanced', wkspModel: 'claude-sonnet-5-5', wkspEffort: 'high', defaultWorkerModel: 'opus' })
    expect(migrateUsageSettings({ wkspModel: '', wkspEffort: 'high' })).toMatchObject({ usageMode: 'balanced', wkspEffort: '' })
    expect(migrateUsageSettings({ wkspModel: '', wkspEffort: 'low' }).wkspEffort).toBe('low')
    expect(migrateUsageSettings({ costDial: 'quality' }).usageMode).toBe('max')
    expect(migrateUsageSettings({ costDial: 'cost' }).usageMode).toBe('save')
    const done = { usageMode: 'save', wkspEffort: 'high' } as Partial<Settings>
    expect(migrateUsageSettings(done)).toBe(done)
  })

  it('never changes a pinned chat model or effort, at any protection level', () => {
    for (const level of [20, 75, 90, 97]) {
      const claude = planStatus('claude', [fresh(level)])
      expect(resolveChat('balanced', { model: OPUS, effort: 'high' }, claude)).toMatchObject({ model: OPUS, effort: 'high', pinnedModel: true, pinnedEffort: true })
    }
  })

  it('keeps pinned unit model/effort over the mode, and explicit deploy picks over everything', () => {
    const s = settings({ usageMode: 'balanced', defaultHarness: 'claude', defaultWorkerModel: 'claude-fable-5-1', defaultWorkerEffort: 'max' })
    const l = pickLoadout(input('feature'), s, env(['claude']))
    expect(l).toMatchObject({ harness: 'claude', model: 'claude-fable-5-1', effort: 'max' })
    expect(l.reasons.join('\n')).toMatch(/Pinned default/)
    // the pinned model belongs to the default tool only
    expect(pickLoadout(input('feature'), s, env(ALL))).toMatchObject({ harness: 'codex', model: undefined, effort: 'max' })
    // a warm plan never lowers a pinned effort
    expect(pickLoadout(input('feature'), s, env(['codex'], { quota: { codex: [fresh(75)] } })).effort).toBe('max')
    expect(pickLoadout(input('feature', { harness: 'claude', model: 'm', effort: 'low' }), settings({ usageMode: 'max' }), env(ALL))).toMatchObject({ harness: 'claude', model: 'm', effort: 'low', source: 'player' })
  })

  it('a locked category row is Pinned: used as written in every mode', () => {
    const pools = defaultSettings().categoryPools.map((p) => (p.category === 'feature' ? { ...p, locked: true, candidates: [{ harness: 'claude', model: 'x', effort: 'low' }] } : p))
    for (const mode of USAGE_MODES) expect(pickLoadout(input('feature'), settings({ usageMode: mode, categoryPools: pools }), env(ALL))).toMatchObject({ harness: 'claude', model: 'x', source: 'table' })
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
    expect(planStatus('claude', [fresh(10), { label: 'weekly', status: 'rejected' }])).toMatchObject({ level: 'out', rejected: true, window: 'weekly' })
    // stale cold evidence is unknown; stale hot evidence keeps protecting
    expect(planStatus('claude', [stale(40)])).toMatchObject({ level: 'ok', known: false })
    expect(planStatus('claude', [stale(97)])).toMatchObject({ level: 'out', known: false })
    expect(planStatus('claude', [fresh(20), stale(88)]).level).toBe('hot')
  })

  const cases: [string, Record<string, UsageWindow[]>, string, string][] = [
    ['codex warm (75%): Sonnet preferred at the mode effort', { claude: [fresh(20)], codex: [fresh(75)] }, 'claude', 'medium'],
    ['codex hot (88%): excluded', { claude: [fresh(20)], codex: [fresh(88)] }, 'claude', 'medium'],
    ['codex out (96%): excluded', { claude: [fresh(20)], codex: [fresh(96)] }, 'claude', 'medium'],
    ['codex rejected: excluded', { claude: [fresh(20)], codex: [{ label: 'weekly', status: 'rejected' }] }, 'claude', 'medium'],
    ['codex stale hot: still excluded', { claude: [fresh(20)], codex: [stale(97)] }, 'claude', 'medium'],
    ['codex stale cold: unknown, ordinary dispatch', { claude: [fresh(20)], codex: [stale(30)] }, 'codex', 'medium'],
    ['codex never reported: ordinary dispatch', { claude: [fresh(20)] }, 'codex', 'medium'],
    ['both warm: no preference, effort one step lower', { claude: [fresh(75)], codex: [fresh(72)] }, 'codex', 'low']
  ]
  for (const [name, quota, harness, effort] of cases) {
    it(`Balanced feature: ${name}`, () => {
      expect(pickLoadout(input('feature'), settings(), env(ALL, { quota }))).toMatchObject({ harness, effort })
    })
  }

  it('lowers Auto effort one step on a warm plan and says why; queues when every plan is hot or out', () => {
    const l = pickLoadout(input('feature'), settings(), env(['codex'], { quota: { codex: [fresh(76)] } }))
    expect(l).toMatchObject({ harness: 'codex', effort: 'low' })
    expect(l.reasons.join('\n')).toMatch(/lowered from medium: Codex 5-hour at 76%/)
    for (const quota of [{ claude: [fresh(90)], codex: [fresh(96)] }, { claude: [{ label: 'weekly', status: 'rejected' }], codex: [stale(99)] }])
      expect(() => pickLoadout(input('feature'), settings(), env(['claude', 'codex'], { quota }))).toThrow(/deferred/)
  })

  it('Max explores only with fresh evidence below 70% on both plans', () => {
    const roll = { rand: () => 0 }
    expect(pickLoadout(input('feature'), settings({ usageMode: 'max' }), env(ALL, roll)).explored).toBe(true)
    for (const quota of [{ claude: [fresh(20)], codex: [fresh(70)] }, { claude: [fresh(20)], codex: [stale(10)] }, { claude: [fresh(20)] }])
      expect(pickLoadout(input('feature'), settings({ usageMode: 'max' }), env(ALL, { ...roll, quota })).explored).toBeUndefined()
    for (const mode of ['save', 'balanced'] as const) expect(pickLoadout(input('feature'), settings({ usageMode: mode }), env(ALL, roll)).explored).toBeUndefined()
  })

  it('chat: Auto lowers one step at 70-84% and drops to Sonnet / low at 85%+', () => {
    expect(resolveChat('max', {}, planStatus('claude', [fresh(50)]))).toMatchObject({ model: OPUS, effort: 'high' })
    expect(resolveChat('max', {}, planStatus('claude', [fresh(75)]))).toMatchObject({ model: OPUS, effort: 'medium' })
    expect(resolveChat('max', {}, planStatus('claude', [fresh(86)]))).toMatchObject({ model: SONNET, effort: 'low' })
    expect(resolveChat('balanced', {}, planStatus('claude', [{ label: '5-hour', status: 'rejected' }]))).toMatchObject({ model: SONNET, effort: 'low' })
    expect(resolveChat('balanced', {}, planStatus('claude', [stale(40)]))).toMatchObject({ model: SONNET, effort: 'medium' })
    // a pinned model keeps its model, only its Auto effort follows protection
    expect(resolveChat('max', { model: OPUS }, planStatus('claude', [fresh(90)]))).toMatchObject({ model: OPUS, effort: 'low' })
  })

  it('the chat sessions read the resolved values from the shared Claude evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-mode-'))
    try {
      expect(chatSettings(settings({ usageMode: 'max' }), dir)).toMatchObject({ wkspModel: OPUS, wkspEffort: 'high', botModel: SONNET })
      recordClaudeRateLimit(claudeLimitsFile(dir), { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 })
      expect(chatSettings(settings({ usageMode: 'max' }), dir)).toMatchObject({ wkspModel: SONNET, wkspEffort: 'low' })
      expect(chatSettings(settings({ usageMode: 'max', wkspModel: OPUS, wkspEffort: 'high', botModel: 'claude-haiku-5-5' }), dir)).toMatchObject({ wkspModel: OPUS, wkspEffort: 'high', botModel: 'claude-haiku-5-5' })
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
    expect(meterRows({ tools: [{ tool: 'claude', limits: [{ source: '', updatedAt: '', windows: [{ label: '5-hour', status: 'rejected' }] }] }] })[0].headline).toMatchObject({ state: 'limit', leftPercent: 0 })
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
    expect(warm[0]).toMatchObject({ from: 'ok', to: 'warm', text: expect.stringMatching(/^Claude at 75%: exploration off/) })
    expect(warm[0].details).toMatch(/cause: Claude 5-hour window 75% · evidence under a minute old/)
    expect(n.observe([at(78)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(80)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(97)], 2)[0].text).toMatch(/Claude reached its limit: no new automatic Claude work until .*; chat is saved; 2 low-priority quests wait/)
    expect(new PolicyNotices(dir).observe([at(97)])).toEqual([])
    expect(new PolicyNotices(dir).observe([at(20)])[0]).toMatchObject({ to: 'ok', text: 'Claude is back under 70%: the Usage mode applies again.' })
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

  const task = (project: string, state: Task['state'] = 'working'): Task => ({ id: `${project}-${Math.random()}`, project, state, harness: 'codex' }) as Task
  function service(mode: UsageMode, tasks: Task[] = [], worlds: Record<string, { capacity?: number; usageMode?: UsageMode }> = {}, backlog: BacklogItem[] = []) {
    const s = settings({ usageMode: mode })
    const homes = new Map([
      ['main', { crew: { list: () => tasks.filter((t) => !t.wksp) }, backlog: { list: () => backlog } }],
      ['ally', { crew: { list: () => tasks.filter((t) => t.wksp === 'ally') }, backlog: { list: () => [] } }]
    ])
    const ctx = {
      settings: { get: () => s, availableHarnesses: () => s.harnesses.filter((h) => ['claude', 'codex'].includes(h.id)) },
      projects: { get: (name: string) => (worlds[name] ? { name, ...worlds[name] } : { name }), list: () => Object.keys(worlds).map((name) => ({ name, ...worlds[name] })) },
      main: { home: { data: dir } }, homes, terminals: { get: () => undefined }
    } as unknown as AppCtx
    return createDispatchService(() => ctx)
  }
  const ship = (project: string): LoadoutInput => ({ kind: 'ship', project, title: 'Add docs', intent: 'Add docs', category: 'docs' })

  it('counts units in every world and base against the global mode cap', async () => {
    await expect(service('save', [task('a')]).reserve(ship('b'))).rejects.toThrow(/Save usage mode allows 1 concurrent unit across all worlds/)
    await expect(service('balanced', [task('a'), { ...task('b'), wksp: 'ally' }]).reserve(ship('c'))).rejects.toThrow(/allows 2/)
    const ok = await service('balanced', [task('a'), task('b', 'done'), { ...task('c'), pr: { url: 'x' } }]).reserve(ship('d'))
    ok.release()
    expect(service('max', [task('a'), task('b')]).capacity()).toEqual({ cap: 4, used: 2 })
  })

  it('counts launches that are reserved but not listed yet, and frees them on listing or release', async () => {
    const svc = service('balanced')
    const a = await svc.reserve(ship('a'))
    expect(svc.capacity().used).toBe(1)
    const b = await svc.reserve({ ...ship('b'), harness: 'claude' })
    await expect(svc.reserve({ ...ship('c'), harness: 'claude' })).rejects.toThrow(/allows 2/)
    a.listed()
    a.listed()
    expect(svc.capacity().used).toBe(1)
    a.release()
    b.release()
    expect(svc.capacity().used).toBe(0)
  })

  it('a world mode or capacity can only lower the cap; a respawn keeps its place', async () => {
    expect(unitCaps('save', { mode: 'max' })).toEqual({ global: 1, world: undefined })
    expect(unitCaps('max', { mode: 'save' })).toEqual({ global: 4, world: 1 })
    expect(unitCaps('max', { capacity: 2 })).toEqual({ global: 4, world: 2 })
    expect(unitCaps('balanced', { capacity: 5 })).toEqual({ global: 2, world: undefined })
    await expect(service('max', [task('slow')], { slow: { usageMode: 'save' } }).reserve(ship('slow'))).rejects.toThrow(/slow allows 1 concurrent unit/)
    const other = await service('max', [task('slow')], { slow: { usageMode: 'save' } }).reserve(ship('fast'))
    other.release()
    const respawn = await service('save', [task('a')]).reserve({ ...ship('a'), harness: 'codex' }, { respawn: true })
    respawn.release()
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
