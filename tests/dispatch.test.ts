import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/settings'
import { cheapGate, classifyCategory, pickLoadout, type PickEnv } from '../src/main/loadout'
import {
  acceptsProposal, applyProposal, buildOutcome, createScorecard, openProposals, outcomeOf, planProposals, planReorder, scoreOutcome, scoreTable
} from '../src/main/scorecard'
import { openRouterEnv } from '../src/main/unitskills'
import { quotaFromUsage } from '../src/main/usage'
import { createDecisionService } from '../src/main/decisions'
import { Home } from '../src/main/home'
import { CHEAP_MODELS, LEARNING, defaultCategoryPools, type OutcomeRecord } from '../src/shared/dispatch'
import type { AppCtx } from '../src/main/services'
import type { CategoryPool, DispatchRule, LoadoutInput, Settings, Task } from '../src/shared/types'

const base: LoadoutInput = { kind: 'ship', project: 'neon-runner', title: 'Add a grappling hook', intent: 'Add a grappling hook mechanic to the player' }

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch })
const env = (ids: string[], extra: Partial<PickEnv> = {}): PickEnv => ({ available: (h) => ids.includes(h.id), ...extra })
const ALL = ['claude', 'codex', 'gemini', 'opencode']

function rec(p: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    v: 1, taskId: `t-${Math.random().toString(36).slice(2)}`, title: 'x', kind: 'ship', category: 'tests', world: 'w', harness: 'codex',
    outcome: 'landed', landed: true, pings: 0, relaunches: 0, lagging: 0, stopped: 0, wallMinutes: 10, endedAt: new Date().toISOString(), ...p
  }
}
const many = (n: number, p: Partial<OutcomeRecord>): OutcomeRecord[] => Array.from({ length: n }, () => rec(p))

describe('category classification', () => {
  it('falls back to keywords when nobody passed a category', () => {
    expect(classifyCategory('ship', 'Water shader stutters', 'the shader drops fps on Switch').category).toBe('graphics')
    expect(classifyCategory('ship', 'Add unit tests for the inventory', '').category).toBe('tests')
    expect(classifyCategory('ship', 'Update the README', 'document the export steps in the readme').category).toBe('docs')
    expect(classifyCategory('ship', 'Pause menu', 'the pause menu buttons overlap on small screens').category).toBe('ui')
    expect(classifyCategory('ship', 'Wobble', 'make it wobble').category).toBe('feature')
    expect(classifyCategory('scout', 'How does saving work', 'tell me how saves are written').category).toBe('recon-design')
    expect(classifyCategory('scout', 'Review the netcode PR', 'review it').category).toBe('review')
  })

  it('uses the category Genio passed and says where it came from', () => {
    const given = pickLoadout({ ...base, category: 'docs' }, settings(), env(ALL))
    expect(given.category).toBe('docs')
    expect(given.reasons[0]).toMatch(/given at deploy/)
    const guessed = pickLoadout({ ...base, title: 'Add unit tests', intent: 'cover the inventory with tests' }, settings(), env(ALL))
    expect(guessed.category).toBe('tests')
    expect(guessed.reasons[0]).toMatch(/keywords/)
  })
})

describe('precedence: explicit > rules > category table > default', () => {
  const rule: DispatchRule = { id: 'r1', match: 'grappling', candidates: [{ harness: 'gemini', spendPriority: 0 }] }

  it('an explicit harness/model wins over rules and the table', () => {
    const l = pickLoadout({ ...base, harness: 'codex', model: 'gpt-x' }, settings({ dispatchRules: [rule] }), env(ALL))
    expect(l).toMatchObject({ harness: 'codex', model: 'gpt-x', source: 'player' })
  })

  it('a matching rule beats the category table', () => {
    const l = pickLoadout(base, settings({ dispatchRules: [rule] }), env(ALL))
    expect(l).toMatchObject({ harness: 'gemini', source: 'rule', ruleId: 'r1' })
  })

  it('the category table applies when no rule matches', () => {
    expect(pickLoadout({ ...base, category: 'feature' }, settings(), env(ALL))).toMatchObject({ harness: 'claude', source: 'table' })
    expect(pickLoadout({ ...base, category: 'tests' }, settings(), env(ALL))).toMatchObject({ harness: 'codex', source: 'table' })
    // Gemini leads large-context reads when installed, otherwise Claude
    expect(pickLoadout({ ...base, category: 'large-context' }, settings(), env(ALL)).harness).toBe('gemini')
    expect(pickLoadout({ ...base, category: 'large-context' }, settings(), env(['claude', 'codex'])).harness).toBe('claude')
  })

  it('the default unit tool applies when the table has nothing usable', () => {
    const l = pickLoadout({ ...base, category: 'tests' }, settings(), env(['aider']))
    expect(l.source).toBe('default')
    expect(l.reasons.join('\n')).toMatch(/none of its tools/)
  })

  it('skips tools that are installed but logged out', () => {
    const l = pickLoadout({ ...base, category: 'tests' }, settings(), env(ALL, { loggedOut: (id) => id === 'codex' }))
    expect(l.harness).toBe('claude')
    expect(l.reasons.join('\n')).toMatch(/Codex CLI skipped: not logged in/)
  })
})

describe('cost dial', () => {
  const cheapOk = { allowed: true, why: 'allowed' }

  it('Quality raises effort, picks the stronger model and keeps cheap models last', () => {
    const l = pickLoadout({ ...base, category: 'feature' }, settings({ costDial: 'quality' }), env(ALL, { cheap: cheapOk }))
    expect(l.harness).toBe('claude')
    expect(l.model).toBe('claude-opus-5-5')
    expect(l.effort).toBe('medium') // small explicit Build: low + 1
    expect(l.reasons.join('\n')).toMatch(/raised from low by the Quality dial/)
    expect(pickLoadout({ ...base, category: 'tests' }, settings({ costDial: 'quality' }), env(ALL, { cheap: cheapOk })).harness).toBe('codex')
  })

  it('Cost puts cheap candidates first where allowed and lowers effort', () => {
    const l = pickLoadout({ ...base, category: 'tests' }, settings({ costDial: 'cost' }), env(ALL, { cheap: cheapOk }))
    expect(l).toMatchObject({ harness: 'opencode', model: CHEAP_MODELS[0].model })
    const claude = pickLoadout({ ...base, category: 'feature' }, settings({ costDial: 'cost', defaultWorkerEffort: 'high' }), env(ALL))
    expect(claude.model).toBe('claude-sonnet-5-5')
    expect(claude.effort).toBe('medium')
  })

  it('a world override wins over the global dial', () => {
    const l = pickLoadout({ ...base, category: 'feature' }, settings({ costDial: 'cost', defaultWorkerEffort: 'high' }), env(ALL, { dial: 'balanced' }))
    expect(l.model).toBeUndefined()
    expect(l.effort).toBe('high')
  })

  it('never shifts an explicit effort', () => {
    expect(pickLoadout({ ...base, category: 'feature', effort: 'low' }, settings({ costDial: 'quality' }), env(ALL)).effort).toBe('low')
  })
})

describe('quota down-ranking', () => {
  it('moves a tool above ~85% of a plan window behind cooler candidates, and says so', () => {
    const l = pickLoadout({ ...base, category: 'feature' }, settings(), env(ALL, { quota: { claude: [{ label: '5-hour', usedPercent: 91 }] } }))
    expect(l.harness).toBe('codex')
    expect(l.reasons.join('\n')).toMatch(/Claude Code down-ranked: 5-hour window at 91%/)
  })

  it('still picks a hot tool when nothing cooler is available', () => {
    const l = pickLoadout({ ...base, category: 'feature' }, settings(), env(['claude'], { quota: { claude: [{ label: 'weekly', usedPercent: 97 }] } }))
    expect(l.harness).toBe('claude')
    expect(l.reasons.join('\n')).toMatch(/97% of its weekly window/)
  })

  it('reads live 5-hour and weekly windows from the usage report', () => {
    const q = quotaFromUsage({
      generatedAt: '',
      fal: { source: '', updatedAt: '', todayUsd: 0, weekUsd: 0, runs: 0, costed: 0 },
      tools: [
        { tool: 'claude', limits: [{ source: '', updatedAt: '', windows: [{ label: '5-hour', usedPercent: 88 }, { label: 'weekly', status: 'rejected' }, { label: 'weekly (Opus)', usedPercent: 99, stale: true }] }] },
        { tool: 'codex', limits: [] }
      ]
    })
    expect(q).toEqual({ claude: [{ label: '5-hour', usedPercent: 88 }, { label: 'weekly', usedPercent: 100 }] })
  })
})

describe('stickiness', () => {
  const sticky = { from: 'old-unit', harness: 'codex', model: 'gpt-x', effort: 'high', category: 'bugfix' as const }

  it('a follow-up on the same quest keeps the original loadout', () => {
    const l = pickLoadout({ ...base, sticky }, settings({ explorationRate: 1 }), env(ALL, { rand: () => 0 }))
    expect(l).toMatchObject({ harness: 'codex', model: 'gpt-x', effort: 'high', category: 'bugfix', source: 'sticky' })
    expect(l.explored).toBeUndefined()
  })

  it('an explicit pick still wins, and an unavailable sticky tool is picked again', () => {
    expect(pickLoadout({ ...base, sticky, harness: 'claude' }, settings(), env(ALL)).harness).toBe('claude')
    const l = pickLoadout({ ...base, sticky }, settings(), env(['claude']))
    expect(l.harness).toBe('claude')
    expect(l.reasons.join('\n')).toMatch(/not available now/)
  })
})

describe('exploration gating', () => {
  const s = settings({ explorationRate: 0.2 })
  const stats = scoreTable(many(9, { category: 'tests', harness: 'codex' }))

  it('about rate-share of picks try a less-proven candidate', () => {
    const l = pickLoadout({ ...base, category: 'tests' }, s, env(ALL, { rand: () => 0.1, stats }))
    expect(l).toMatchObject({ harness: 'claude', explored: true })
    expect(l.reasons.join('\n')).toMatch(/exploration \(20%\): trying Claude Code, less proven for Tests \(0 vs 9 outcomes\)/)
    expect(pickLoadout({ ...base, category: 'tests' }, s, env(ALL, { rand: () => 0.5, stats })).harness).toBe('codex')
  })

  it('never explores on explicit picks, critical quests, a 0 rate or a single eligible candidate', () => {
    const roll = env(ALL, { rand: () => 0, stats })
    expect(pickLoadout({ ...base, category: 'tests', model: 'gpt-x' }, s, roll).explored).toBeUndefined()
    expect(pickLoadout({ ...base, category: 'tests', harness: 'codex' }, s, roll).explored).toBeUndefined()
    expect(pickLoadout({ ...base, category: 'tests', priority: 'critical' }, s, roll).explored).toBeUndefined()
    expect(pickLoadout({ ...base, category: 'tests' }, settings({ explorationRate: 0 }), roll).explored).toBeUndefined()
    expect(pickLoadout({ ...base, category: 'tests' }, s, env(['codex'], { rand: () => 0 })).explored).toBeUndefined()
  })

  it('the preview only says exploration may happen', () => {
    const l = pickLoadout({ ...base, category: 'tests' }, s, env(ALL, { rand: () => 0, preview: true }))
    expect(l.harness).toBe('codex')
    expect(l.reasons.join('\n')).toMatch(/20% of deploys try a less-proven candidate/)
  })
})

describe('OpenRouter gating', () => {
  it('needs the world opt-in, the key and OpenCode installed', () => {
    expect(cheapGate({ worldAllows: true, keySet: true, opencodeReady: true }).allowed).toBe(true)
    expect(cheapGate({ worldAllows: false, keySet: true, opencodeReady: true })).toMatchObject({ allowed: false, why: expect.stringMatching(/off for this world/) })
    expect(cheapGate({ worldAllows: true, keySet: false, opencodeReady: true })).toMatchObject({ allowed: false, why: expect.stringMatching(/OpenRouter key/) })
    expect(cheapGate({ worldAllows: true, keySet: true, opencodeReady: false })).toMatchObject({ allowed: false, why: expect.stringMatching(/OpenCode/) })
  })

  it('cheap candidates are skipped unless the gate is open', () => {
    const s = settings({ costDial: 'cost' })
    const closed = pickLoadout({ ...base, category: 'docs' }, s, env(ALL, { cheap: cheapGate({ worldAllows: false, keySet: true, opencodeReady: true }) }))
    expect(closed.harness).toBe('codex')
    expect(closed.reasons.join('\n')).toMatch(/off for this world/)
    // never in high-stakes categories
    expect(defaultCategoryPools().find((p) => p.category === 'feature')!.candidates.some((c) => c.cheap)).toBe(false)
  })

  it('passes the key to OpenCode units only, only in opted-in worlds', () => {
    expect(openRouterEnv('opencode', true, 'sk-or-1')).toEqual({ OPENROUTER_API_KEY: 'sk-or-1' })
    expect(openRouterEnv('opencode', false, 'sk-or-1')).toEqual({})
    expect(openRouterEnv('claude', true, 'sk-or-1')).toEqual({})
    expect(openRouterEnv('opencode', true, undefined)).toEqual({})
  })
})

describe('scorecard', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-dispatch-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const task = (p: Partial<Task> = {}): Task =>
    ({
      id: 'u1', kind: 'ship', title: 'Tests for saves', project: 'w', wksp: 'main', mode: 'no-mistakes', branchPrefix: 'genio/', baseBranch: 'main', branch: 'b', worktree: '', briefPath: '',
      harness: 'codex', model: 'gpt-x', effort: 'medium', category: 'tests', loadoutSource: 'table', state: 'merged', createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      updatedAt: '', inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0, relaunches: 1, usageAtStart: 40,
      counters: { pings: 3, lagging: 1, stopped: 0, fixRounds: 2 }, ...p
    }) as Task

  it('records how a unit ended with its rework signals', () => {
    expect(outcomeOf(task())).toBe('landed')
    expect(outcomeOf(task({ state: 'failed' }))).toBe('failed')
    expect(outcomeOf(task({ state: 'cleaned', stateReason: 'despawned: forced by the player' }))).toBe('despawned')
    expect(outcomeOf(task({ state: 'cleaned', stateReason: 'despawned: landed (merged)' }))).toBe('landed')
    expect(outcomeOf(task({ state: 'working' }))).toBeUndefined()
    const r = buildOutcome(task(), 'landed', Date.now(), 55)
    expect(r).toMatchObject({ category: 'tests', world: 'w', harness: 'codex', model: 'gpt-x', effort: 'medium', landed: true, pings: 1, relaunches: 1, lagging: 1, fixRounds: 2, planUsage: { start: 40, end: 55 } })
    expect(r.wallMinutes).toBe(30)
  })

  it('upserts one record per task, keeps verdicts and a landing', () => {
    const card = createScorecard(path.join(dir, 'dispatch', 'scorecard.json'))
    card.upsert(buildOutcome(task(), 'landed'))
    expect(card.rate('u1', 'up', 'clean work')).toBe(true)
    card.upsert(buildOutcome(task({ state: 'cleaned' }), 'despawned'))
    const again = createScorecard(path.join(dir, 'dispatch', 'scorecard.json')).list()
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ landed: true, outcome: 'landed', verdict: 'up', note: 'clean work' })
    expect(card.rate('nope', 'down')).toBe(false)
  })

  it('scores landings high, rework and a thumbs-down low', () => {
    expect(scoreOutcome(rec())).toBe(1)
    expect(scoreOutcome(rec({ pings: 2, fixRounds: 1 }))).toBeCloseTo(0.8)
    expect(scoreOutcome(rec({ landed: false, outcome: 'failed' }))).toBe(0)
    expect(scoreOutcome(rec({ verdict: 'down' }))).toBeCloseTo(0.2)
    expect(scoreOutcome(rec({ landed: false, outcome: 'despawned', verdict: 'up' }))).toBeCloseTo(0.6)
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const rows = scoreTable([rec({ endedAt: old, landed: false, outcome: 'failed' }), rec()])
    expect(rows[0].score).toBeGreaterThan(0.75) // the recent landing outweighs the 60-day-old failure
  })
})

describe('learning: automatic reordering', () => {
  const pools = (locked = false): CategoryPool[] => [{ category: 'tests', candidates: [{ harness: 'claude' }, { harness: 'codex' }], locked }]
  const s = (p: CategoryPool[], rules: DispatchRule[] = []) => ({ categoryPools: p, dispatchRules: rules })

  it(`waits for ${LEARNING.minSamples} outcomes each and a clear margin`, () => {
    const few = scoreTable([...many(4, { harness: 'codex' }), ...many(5, { harness: 'claude', landed: false, outcome: 'failed' })])
    expect(planReorder(s(pools()), few)).toBeUndefined()
    const close = scoreTable([...many(5, { harness: 'codex', pings: 2 }), ...many(5, { harness: 'claude', pings: 1 })])
    expect(planReorder(s(pools()), close)).toBeUndefined()
    const clear = scoreTable([...many(5, { harness: 'codex' }), ...many(5, { harness: 'claude', relaunches: 3 })])
    const plan = planReorder(s(pools()), clear)!
    expect(plan.categoryPools[0].candidates.map((c) => c.harness)).toEqual(['codex', 'claude'])
    expect(plan.changes[0]).toMatch(/Tests: codex landed 5\/5/)
  })

  it('never touches locked rows or rules', () => {
    const clear = scoreTable([...many(5, { harness: 'codex', source: 'rule', ruleId: 'r' }), ...many(5, { harness: 'claude', relaunches: 3, source: 'rule', ruleId: 'r' })])
    const rule: DispatchRule = { id: 'r', match: 'x', locked: true, candidates: [{ harness: 'claude', spendPriority: 0 }, { harness: 'codex', spendPriority: 0 }] }
    expect(planReorder(s(pools(true), [rule]), clear)).toBeUndefined()
    expect(planReorder(s(pools(true), [{ ...rule, locked: false }]), clear)!.dispatchRules[0].candidates[0].harness).toBe('codex')
  })
})

describe('learning: proposals need the player', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-proposals-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const noCtx = (): AppCtx => {
    throw new Error('not wired')
  }
  const pools: CategoryPool[] = [{ category: 'tests', candidates: [{ harness: 'codex' }, { harness: 'claude' }] }]
  const bad = scoreTable([...many(8, { harness: 'claude', landed: false, outcome: 'failed' }), ...many(7, { harness: 'codex' })])

  it('proposes a removal as a choice under Your Move with the evidence, once', () => {
    const settingsLike = { categoryPools: pools, dispatchRules: [] }
    const props = planProposals(settingsLike, bad)
    expect(props).toEqual([expect.objectContaining({ op: 'pool-remove', category: 'tests', candidate: { harness: 'claude' } })])
    const home = new Home(dir)
    home.ensure()
    const decisions = createDecisionService(noCtx, home)
    const opened = openProposals(decisions, props, settingsLike)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ source: 'system', action: { kind: 'dispatch-proposal' }, options: ['Apply the change', 'Keep things as they are'] })
    expect(opened[0].question).toMatch(/Remove claude from the Tests dispatch table/)
    expect(opened[0].context).toMatch(/claude landed 0\/8/)
    expect(openProposals(decisions, props, settingsLike)).toHaveLength(0)
    decisions.resolve(opened[0].id, 'Keep things as they are')
    expect(openProposals(decisions, props, settingsLike)).toHaveLength(0) // declined recently: not asked again
  })

  it('proposes an outside tool that clearly beats the first candidate', () => {
    const rows = scoreTable([...many(5, { harness: 'codex', relaunches: 3 }), ...many(5, { harness: 'gemini' })])
    expect(planProposals({ categoryPools: pools, dispatchRules: [] }, rows)).toEqual([expect.objectContaining({ op: 'pool-add', candidate: { harness: 'gemini' } })])
  })

  it('applies an accepted proposal, never on a locked row', () => {
    const p = planProposals({ categoryPools: pools, dispatchRules: [] }, bad)[0]
    expect(applyProposal({ categoryPools: pools, dispatchRules: [] }, p)!.categoryPools![0].candidates).toEqual([{ harness: 'codex' }])
    expect(applyProposal({ categoryPools: [{ ...pools[0], locked: true }], dispatchRules: [] }, p)).toBeUndefined()
    expect(planProposals({ categoryPools: [{ ...pools[0], locked: true }], dispatchRules: [] }, bad)).toEqual([])
    expect(acceptsProposal({ options: ['Apply the change', 'Keep'] }, 'Apply the change')).toBe(true)
    expect(acceptsProposal({ options: ['Apply the change', 'Keep'] }, 'yes, do it')).toBe(true)
    expect(acceptsProposal({ options: ['Apply the change', 'Keep'] }, 'Keep')).toBe(false)
  })

  it('proposes dropping a failing rule candidate, but leaves locked rules alone', () => {
    const rows = scoreTable(many(8, { harness: 'aider', landed: false, outcome: 'failed', source: 'rule', ruleId: 'r' }))
    const rule: DispatchRule = { id: 'r', match: 'shader', candidates: [{ harness: 'aider', spendPriority: 0 }, { harness: 'claude', spendPriority: 0 }] }
    const props = planProposals({ categoryPools: [], dispatchRules: [rule] }, rows)
    expect(props).toEqual([expect.objectContaining({ op: 'rule-drop-candidate', ruleId: 'r' })])
    expect(applyProposal({ categoryPools: [], dispatchRules: [rule] }, props[0])!.dispatchRules![0].candidates.map((c) => c.harness)).toEqual(['claude'])
    expect(planProposals({ categoryPools: [], dispatchRules: [{ ...rule, locked: true }] }, rows)).toEqual([])
  })
})
