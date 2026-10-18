import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/settings'
import { pickLoadout, type PickEnv } from '../src/main/loadout'
import { QuotaDeferredError } from '../src/main/quota-deferred'
import type { DispatchRule, LoadoutInput, Settings } from '../src/shared/types'
import { CLAUDE_UNIT_MODEL, CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'
import { CATEGORY_IDS } from '../src/shared/dispatch'
import { USAGE_MODES } from '../src/shared/usage-mode'

const base: LoadoutInput = { kind: 'ship', project: 'neon-runner', title: 'Fix double jump', intent: 'Fix the double jump on slopes' }

function settings(rules: DispatchRule[] = [], patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), dispatchRules: rules, ...patch }
}
const installed =
  (...ids: string[]) =>
  (h: { id: string }): boolean =>
    ids.includes(h.id)
const window = (usedPercent: number) => ({ label: '5-hour', usedPercent, observedAt: new Date().toISOString() })

describe('the default model where the player set nothing', () => {
  const signIn = (claude: boolean, codex: boolean): PickEnv => ({
    available: installed('claude', 'codex'),
    loggedOut: (id) => (id === 'claude' ? !claude : id === 'codex' ? !codex : false)
  })

  it('is Claude Sonnet 5.5 at medium while Claude is signed in, whatever Codex is', () => {
    for (const codex of [true, false]) {
      expect(pickLoadout(base, settings(), signIn(true, codex))).toMatchObject({ harness: 'claude', model: CLAUDE_UNIT_MODEL, effort: 'medium', source: 'default' })
    }
  })

  it('falls back to Codex Sol 6.1 when only Codex is signed in, and when Claude is not installed', () => {
    expect(pickLoadout(base, settings(), signIn(false, true))).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL, effort: 'medium', source: 'default' })
    expect(pickLoadout(base, settings(), installed('codex'))).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL })
  })

  it('starts nothing when neither is signed in', () => {
    expect(() => pickLoadout(base, settings(), signIn(false, false))).toThrow(/deferred: Claude Code is not signed in/)
  })

  it('is the same for every category, Usage mode and Modeller Build; a Recon gets high effort', () => {
    for (const usageMode of USAGE_MODES) for (const category of CATEGORY_IDS) for (const modeller of [false, true]) {
      expect(pickLoadout({ ...base, category, modeller }, settings([], { usageMode }), signIn(true, true)))
        .toMatchObject({ harness: 'claude', model: CLAUDE_UNIT_MODEL, effort: 'medium', source: 'default' })
    }
    expect(pickLoadout({ ...base, kind: 'scout' }, settings(), signIn(true, true)).effort).toBe('high')
  })

  it('ignores the scorecard: no exploration, no learned switch', () => {
    const l = pickLoadout(base, settings(), { ...signIn(true, true), stats: [{ scope: 'bugfix', harness: 'codex', score: 1, samples: 50, landed: 50, weight: 50 }] } as PickEnv)
    expect(l).toMatchObject({ harness: 'claude', model: CLAUDE_UNIT_MODEL })
    expect(l.reasons.join(' ')).not.toMatch(/learning|exploration/)
  })
})

describe('what the player set always wins', () => {
  const available = installed('claude', 'codex', 'gemini')

  it("honours the explicit pick over any rule, row or default", () => {
    const rules: DispatchRule[] = [{ id: 'r', match: 'jump', candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    const l = pickLoadout({ ...base, harness: 'gemini', effort: 'max' }, settings(rules), available)
    expect(l).toMatchObject({ harness: 'gemini', effort: 'max', source: 'player' })
    expect(pickLoadout({ ...base, harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, settings(), available))
      .toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', source: 'player' })
  })

  it('picks the most specific matching rule and the highest spend priority among installed tools', () => {
    const rules: DispatchRule[] = [
      { id: 'any', match: '', candidates: [{ harness: 'claude', spendPriority: 0 }] },
      {
        id: 'shader',
        match: 'shader, hlsl',
        kind: 'ship',
        candidates: [
          { harness: 'aider', spendPriority: 9 },
          { harness: 'codex', model: 'gpt-5-codex', effort: 'high', spendPriority: 5 },
          { harness: 'claude', spendPriority: 1 }
        ]
      }
    ]
    const l = pickLoadout({ ...base, title: 'Water shader', intent: 'Port the HLSL water to Godot' }, settings(rules), installed('claude', 'codex'))
    expect(l).toMatchObject({ harness: 'codex', model: 'gpt-5-codex', effort: 'high', source: 'rule', ruleId: 'shader' })
  })

  it('matches whole words only and skips rules whose tools are missing, then uses the default', () => {
    const rules: DispatchRule[] = [
      { id: 'ui', match: 'ui', candidates: [{ harness: 'codex', spendPriority: 0 }] },
      { id: 'jump', match: 'jump', candidates: [{ harness: 'aider', spendPriority: 0 }] }
    ]
    const l = pickLoadout({ ...base, intent: 'Fix the double jump in the build' }, settings(rules), installed('claude', 'codex'))
    expect(l).toMatchObject({ harness: 'claude', model: CLAUDE_UNIT_MODEL, effort: 'medium', source: 'default' })
    expect(l.reasons.join(' ')).toMatch(/none of its tools/)
  })

  it("uses the player's category row as written, and only for that category", () => {
    const s = settings([], { categoryPools: [{ category: 'art', candidates: [{ harness: 'codex', model: 'custom', effort: 'low' }] }] })
    expect(pickLoadout({ ...base, category: 'art' }, s, available)).toMatchObject({ harness: 'codex', model: 'custom', effort: 'low', source: 'table' })
    expect(pickLoadout({ ...base, category: 'ui' }, s, available)).toMatchObject({ harness: 'claude', model: CLAUDE_UNIT_MODEL, source: 'default' })
  })

  it("uses the player's default unit tool, model and effort", () => {
    expect(pickLoadout(base, settings([], { defaultHarness: 'codex' }), available)).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL })
    expect(pickLoadout(base, settings([], { defaultHarness: 'claude', defaultWorkerModel: 'claude-opus-5-5', defaultWorkerEffort: 'xhigh' }), available))
      .toMatchObject({ harness: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' })
    // the default model belongs to the default tool only
    const rules: DispatchRule[] = [{ id: 'r', match: 'jump', candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    expect(pickLoadout(base, settings(rules, { defaultHarness: 'claude', defaultWorkerModel: 'opus' }), available).model).toBe(CODEX_UNIT_MODEL)
  })

  it("never swaps a player's Claude default for Codex when only Codex is signed in: the quest waits", () => {
    const env: PickEnv = { available, loggedOut: (id) => id === 'claude' }
    expect(() => pickLoadout(base, settings([], { defaultHarness: 'claude' }), env)).toThrow(/Claude Code is not signed in/)
  })

  it('keeps a follow-up on its original loadout', () => {
    expect(pickLoadout({ ...base, sticky: { from: 'previous', harness: 'codex', model: 'custom', effort: 'low' } }, settings(), available))
      .toMatchObject({ harness: 'codex', model: 'custom', effort: 'low', source: 'sticky' })
  })
})

describe('quota protection never changes the model', () => {
  const available = installed('claude', 'codex')

  it('makes a held plan wait instead of moving the unit to the other plan', () => {
    for (const env of [{ available, quota: { claude: [window(90)] } }, { available, unavailable: (id: string) => id === 'claude' }] as PickEnv[]) {
      expect(() => pickLoadout(base, settings(), env)).toThrow(QuotaDeferredError)
      expect(() => pickLoadout({ ...base, harness: 'claude', model: 'claude-opus-5-5' }, settings(), env)).toThrow(/keeps its tool and model/)
      expect(() => pickLoadout(base, settings([{ id: 'r', match: '', candidates: [{ harness: 'claude', spendPriority: 1 }, { harness: 'codex', spendPriority: 0 }] }]), env)).toThrow(QuotaDeferredError)
    }
  })

  it('leaves the effort alone at 70%+', () => {
    expect(pickLoadout(base, settings(), { available, quota: { claude: [window(75)] } })).toMatchObject({ harness: 'claude', effort: 'medium' })
  })

  it('does nothing when switched off', () => {
    expect(pickLoadout(base, settings([], { quotaProtection: false }), { available, quota: { claude: [window(99)] } }).harness).toBe('claude')
  })
})
