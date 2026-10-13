import { describe, expect, it } from 'vitest'
import { approvalModel, CODEX_UNIT_MODEL, unitModel } from '../src/shared/unit-model-policy'
import { CATEGORY_IDS } from '../src/shared/dispatch'
import { USAGE_MODES } from '../src/shared/usage-mode'
import { defaultSettings } from '../src/main/settings'
import { pickLoadout } from '../src/main/loadout'

describe('conservative unit models', () => {
  it.each(['fable', 'astra', 'CLAUDE-FABLE-5-1', 'gpt-6-astra', 'openrouter/anthropic/claude-fable-5-1', 'openai/gpt-6-astra-20261001'])('requires approval for %s aliases and qualified IDs', model => {
    expect(approvalModel(unitModel('custom', model))).toBe(true)
  })

  it.each([undefined, '', '  ', 'auto', 'default'])('never inherits a premium CLI default (%s)', model => {
    expect(unitModel('codex', model)).toBe(CODEX_UNIT_MODEL)
    expect(approvalModel(unitModel('claude', model))).toBe(false)
  })

  it('keeps all unpinned categories and modes on conservative models, including visual work', () => {
    for (const usageMode of USAGE_MODES) for (const category of CATEGORY_IDS) {
      const loadout = pickLoadout({ kind: 'ship', project: 'w', title: 'Work', intent: 'Work', category },
        { ...defaultSettings(), usageMode }, h => ['codex', 'claude'].includes(h.id))
      expect(loadout.model).toBeTruthy()
      expect(approvalModel(loadout.model)).toBe(false)
    }
  })
})
