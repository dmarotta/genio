import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Home } from '../src/main/home'
import { createMemoryService, estimateTokens, findStale, removeEntries } from '../src/main/memory'
import type { AppCtx } from '../src/main/services'

const tmpHome = (): Home => {
  const h = new Home(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mem-')))
  h.ensure()
  return h
}
const noCtx = (): AppCtx => {
  throw new Error('no ctx in tests')
}

describe('memory markers', () => {
  it('flags aging entries after 30 days and perishable after 7', () => {
    const now = new Date('2026-10-12T12:00:00Z')
    const txt = [
      '- keep me <!--P-->',
      '- old aging <!--a:2026-08-01-->',
      '- fresh aging <!--a:2026-10-01-->',
      '- old perishable until release <!--p:2026-10-01-->',
      '- fresh perishable <!--p:2026-10-10-->'
    ].join('\n')
    expect(findStale(txt, now)).toEqual(['- old aging <!--a:2026-08-01-->', '- old perishable until release <!--p:2026-10-01-->'])
  })

  it('removes entries by trimmed line', () => {
    const [next, removed] = removeEntries('# T\n- a\n  - b \n- c', ['- b', '- c'])
    expect(removed).toEqual(['- b', '- c'])
    expect(next).toBe('# T\n- a')
  })

  it('estimates tokens at ~4 chars each', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('memory service', () => {
  it('reads, writes, reports and archives with provenance', () => {
    const home = tmpHome()
    const mem = createMemoryService(noCtx)
    mem.write('lore', '# Lore\n- godot export needs templates <!--a:2020-01-01-->\n- pinned fact <!--P-->', home)
    expect(mem.read('lore', home)).toContain('pinned fact')
    const rep = mem.report(home)
    expect(rep.budget).toBe(7500)
    expect(rep.overBudget).toBe(false)
    expect(rep.stale).toHaveLength(1)
    mem.archive(rep.stale, 'decayed', home)
    expect(mem.read('lore', home)).not.toContain('godot export')
    const arch = fs.readFileSync(path.join(home.data, 'memory-archive.md'), 'utf8')
    expect(arch).toContain('save')
    expect(arch).toContain('godot export needs templates')
    expect(arch).toContain('from lore.md')
  })

  it('refuses ally writes to player-shared', () => {
    const main = tmpHome()
    const ally = new Home(path.join(main.root, 'wksps', 'art'), 'art', main)
    ally.ensure()
    const mem = createMemoryService(noCtx)
    expect(() => mem.write('player-shared', 'x', ally)).toThrow(/main base/)
    expect(mem.read('player-shared', ally)).toContain('Shared Player Profile')
  })
})
