import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../src/main/settings'
import { classifyEffort, pickLoadout } from '../src/main/loadout'
import type { DispatchRule, LoadoutInput, Settings } from '../src/shared/types'

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
    expect(pickLoadout(base, s, installed('claude', 'codex')).model).toBeUndefined()
    expect(pickLoadout({ ...base, intent: 'other', title: 'other' }, s, installed('claude')).model).toBe('opus')
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
