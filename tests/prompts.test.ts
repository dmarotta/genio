import { describe, expect, it } from 'vitest'
import { customContract, CUSTOM_CONTRACT_BUDGET, procedureText, PROCEDURES } from '../src/main/prompts'
import { chatUsageLine } from '../src/shared/usage-mode'

describe('bounded custom contract and lazy procedures', () => {
  it('fits main, ally and Bot including usage and arbitrarily large memory/charters', () => {
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const o = { gamertag: 'Dani', base: 'art', isAlly, charter: 'charter'.repeat(20000), scope: 'scope'.repeat(20000),
        playerProfile: 'private-memory'.repeat(20000), sharedProfile: 'shared'.repeat(20000), lore: 'lore'.repeat(20000) }
      const prompt = customContract(o, bot, chatUsageLine('balanced'))
      expect(prompt.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
      expect(prompt).not.toContain('private-memory')
      expect(prompt).not.toContain('chartercharter')
      expect(prompt).toContain('skill_read')
      expect(prompt).toContain('events_ack')
      expect(prompt).toContain('Auto-loot')
      expect(prompt).toContain('Never merge')
    }
  })

  it('serves only the requested procedure with the complete ally charter on demand', () => {
    const o = { gamertag: 'Dani', base: 'art', isAlly: true, charter: 'full charter '.repeat(2000), scope: 'art assets' }
    for (const name of PROCEDURES) expect(procedureText(name, o).length).toBeGreaterThan(50)
    expect(procedureText('ally', o)).toContain(o.charter)
    expect(procedureText('delivery', o)).not.toContain('## 9.')
    expect(procedureText('memory', o)).toContain('memory_archive')
    expect(() => customContract(o, false, 'x'.repeat(10000))).toThrow('Custom contract exceeds')
  })

  it('leaves budget for provider instructions even with long identity fields', () => {
    expect(customContract({ gamertag: 'x'.repeat(1000), base: 'b'.repeat(1000), isAlly: true }, true, 'u'.repeat(300)).length)
      .toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
  })
})
