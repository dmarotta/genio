import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/settings'
import { classifyEffort, pickLoadout, type PickEnv } from '../src/main/loadout'
import type { DispatchRule, LoadoutInput, Settings } from '../src/shared/types'
import { CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'
import { CATEGORY_IDS } from '../src/shared/dispatch'
import { MODE_PRESETS, OPUS, USAGE_MODES, groupOf } from '../src/shared/usage-mode'

const base: LoadoutInput = { kind: 'ship', project: 'neon-runner', title: 'Fix double jump', intent: 'Fix the double jump on slopes' }

function settings(rules: DispatchRule[] = [], patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), dispatchRules: rules, ...patch }
}
const installed =
  (...ids: string[]) =>
  (h: { id: string }): boolean =>
    ids.includes(h.id)

describe('loadout picker', () => {
  it('falls back to the default unit tool with no rules and no category table', () => {
    const l = pickLoadout(base, settings([], { categoryPools: [] }), installed('claude'))
    expect(l.harness).toBe('claude')
    expect(l.source).toBe('default')
  })

  it("honours the player's explicit pick over any rule", () => {
    const rules: DispatchRule[] = [{ id: 'r', match: 'jump', candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    const l = pickLoadout({ ...base, harness: 'gemini', effort: 'max' }, settings(rules), installed('claude', 'codex', 'gemini'))
    expect(l).toMatchObject({ harness: 'gemini', effort: 'max', source: 'player' })
  })

  it('picks the most specific matching rule and the highest spend priority among installed tools', () => {
    const rules: DispatchRule[] = [
      { id: 'any', match: '', candidates: [{ harness: 'claude', spendPriority: 0 }] },
      {
        id: 'shader',
        match: 'shader, hlsl',
        kind: 'ship',
        candidates: [
          { harness: 'gemini', spendPriority: 9 },
          { harness: 'codex', model: 'gpt-5-codex', effort: 'high', spendPriority: 5 },
          { harness: 'claude', spendPriority: 1 }
        ]
      }
    ]
    const l = pickLoadout({ ...base, title: 'Water shader', intent: 'Port the HLSL water to Godot' }, settings(rules), installed('claude', 'codex'))
    expect(l).toMatchObject({ harness: 'codex', model: 'gpt-5-codex', effort: 'high', source: 'rule', ruleId: 'shader' })
  })

  it('matches whole words only and skips rules whose tools are missing', () => {
    const rules: DispatchRule[] = [
      { id: 'ui', match: 'ui', candidates: [{ harness: 'codex', spendPriority: 0 }] },
      { id: 'jump', match: 'jump', candidates: [{ harness: 'aider', spendPriority: 0 }] }
    ]
    const l = pickLoadout({ ...base, intent: 'Fix the double jump in the build' }, settings(rules), installed('claude', 'codex'))
    // no usable rule: Balanced sends a bugfix to Codex / medium
    expect(l).toMatchObject({ harness: 'codex', effort: 'medium', source: 'mode' })
    expect(l.reasons.join(' ')).toMatch(/none of its tools/)
  })

  it('applies the default model only to the default unit tool', () => {
    const rules: DispatchRule[] = [{ id: 'r', match: 'jump', candidates: [{ harness: 'codex', spendPriority: 0 }] }]
    const s = settings(rules, { defaultWorkerModel: 'opus' })
    expect(pickLoadout(base, s, installed('claude', 'codex')).model).toBe(CODEX_UNIT_MODEL)
    expect(pickLoadout({ ...base, intent: 'other', title: 'other' }, s, installed('claude')).model).toBe('opus')
  })
})

describe('Modeller loadouts', () => {
  const input: LoadoutInput = { ...base, category: 'art', modeller: true }
  const available = installed('claude', 'codex')
  const window = (usedPercent: number) => ({ label: '5-hour', usedPercent, observedAt: new Date().toISOString() })

  it('defaults to Opus at the mode effort for every category, including previews', () => {
    for (const usageMode of USAGE_MODES) for (const category of CATEGORY_IDS) for (const preview of [false, true]) {
      const l = pickLoadout({ ...input, category }, settings([], { usageMode }), { available, preview, rand: () => 0 })
      expect(l).toMatchObject({ harness: 'claude', model: OPUS, effort: MODE_PRESETS[usageMode].units[groupOf(category)][1], source: 'mode' })
      expect(l.reasons).toContain('Modeller: defaults to Claude Opus')
      expect(l.explored).toBeUndefined()
    }
  })

  it('keeps explicit harness and model pins and applies effort pins to the Modeller default', () => {
    expect(pickLoadout({ ...input, harness: 'codex', model: 'custom', effort: 'low' }, settings(), available))
      .toMatchObject({ harness: 'codex', model: 'custom', effort: 'low' })
    expect(pickLoadout({ ...input, harness: 'codex' }, settings(), available).harness).toBe('codex')
    expect(pickLoadout({ ...input, model: 'custom' }, settings(), available)).toMatchObject({ harness: 'codex', model: 'custom' })
    expect(pickLoadout({ ...input, effort: 'xhigh' }, settings(), available)).toMatchObject({ harness: 'claude', model: OPUS, effort: 'xhigh' })
  })

  it('preserves Settings, locked category, rule and follow-up pins', () => {
    expect(pickLoadout(input, settings([], { defaultWorkerEffort: 'xhigh' }), available))
      .toMatchObject({ harness: 'claude', model: OPUS, effort: 'xhigh' })
    expect(pickLoadout(input, settings([], { defaultHarness: 'codex', defaultWorkerModel: 'custom' }), available))
      .toMatchObject({ harness: 'codex', model: 'custom' })
    expect(pickLoadout(input, settings([], { defaultWorkerModel: 'custom' }), installed('claude')))
      .toMatchObject({ harness: 'claude', model: 'custom' })
    expect(pickLoadout(input, settings([], { categoryPools: [{ category: 'art', locked: true, candidates: [{ harness: 'codex', model: 'custom', effort: 'low' }] }] }), available))
      .toMatchObject({ harness: 'codex', model: 'custom', effort: 'low', source: 'table' })
    expect(pickLoadout(input, settings([{ id: 'r', match: '', candidates: [{ harness: 'codex', model: 'custom', effort: 'low', spendPriority: 0 }] }]), available))
      .toMatchObject({ harness: 'codex', model: 'custom', effort: 'low', source: 'rule' })
    expect(pickLoadout({ ...input, sticky: { from: 'previous', harness: 'codex', model: 'custom', effort: 'low' } }, settings(), available))
      .toMatchObject({ harness: 'codex', model: 'custom', effort: 'low', source: 'sticky' })
  })

  it('falls back to the normal picker when Claude is unavailable, quota held or protected', () => {
    const cases: Partial<PickEnv>[] = [
      { available: installed('codex') }, { loggedOut: id => id === 'claude' }, { unavailable: id => id === 'claude' },
      { quota: { claude: [window(90)] } }, { quota: { claude: [window(75)], codex: [window(20)] } }
    ]
    for (const extra of cases) {
      const env = { available, ...extra }
      const l = pickLoadout(input, settings(), env)
      const normal = pickLoadout({ ...input, modeller: false }, settings(), env)
      expect(l).toMatchObject({ harness: normal.harness, model: normal.model, effort: normal.effort })
      expect(l.reasons.join(' ')).toMatch(/Modeller: Claude Opus unavailable .*falling back to the normal picker/)
    }
    expect(() => pickLoadout(input, settings(), { available: installed('claude'), quota: { claude: [window(90)] } })).toThrow(/deferred/)
  })

  it('lowers automatic effort when warm Claude is the only eligible plan, preserving effort pins', () => {
    const env = { available: installed('claude'), quota: { claude: [window(75)] } }
    expect(pickLoadout(input, settings(), env)).toMatchObject({ harness: 'claude', model: OPUS, effort: 'low' })
    expect(pickLoadout({ ...input, effort: 'high' }, settings(), env).effort).toBe('high')
    expect(pickLoadout(input, settings([], { defaultWorkerEffort: 'high' }), env).effort).toBe('high')
  })

  it('leaves ordinary art and Recon loadouts unchanged', () => {
    expect(pickLoadout({ ...input, modeller: false }, settings(), available)).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL, effort: 'medium' })
    expect(pickLoadout({ ...input, kind: 'scout' }, settings(), available)).toMatchObject({ harness: 'codex', model: CODEX_UNIT_MODEL, effort: 'medium' })
  })
})

describe('effort guess', () => {
  it('reads the size of the ask', () => {
    expect(classifyEffort('ship', 'Fix the typo in the pause menu').effort).toBe('low')
    expect(classifyEffort('ship', 'Refactor the inventory system').effort).toBe('high')
    expect(classifyEffort('scout', 'How does saving work').effort).toBe('high')
    expect(classifyEffort('scout', 'Investigate why the netcode desyncs').effort).toBe('xhigh')
  })
  it('defers to the configured default effort', () => {
    expect(pickLoadout(base, settings([], { defaultWorkerEffort: 'medium' }), installed('claude')).effort).toBe('medium')
    // the built-in guess applies on the default-tool path (no table row); a table row follows the mode
    expect(pickLoadout(base, settings([], { categoryPools: [] }), installed('claude')).effort).toBe('low')
    expect(pickLoadout(base, settings(), installed('claude')).effort).toBe('medium')
  })
})
