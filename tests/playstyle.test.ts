import { describe, expect, it } from 'vitest'
import { classifyPlaystyle, familyOf } from '../src/shared/playstyle'
import type { TaskCategory } from '../src/shared/types'

type Rec = { kind: 'ship' | 'scout'; category: TaskCategory; landed: boolean }
const ship = (category: TaskCategory, landed = true): Rec => ({ kind: 'ship', category, landed })
const recon = (landed = true): Rec => ({ kind: 'scout', category: 'recon-design', landed })
const times = (n: number, r: Rec): Rec[] => Array.from({ length: n }, () => r)

describe('playstyle families', () => {
  it('maps recons to Scout whatever their topic, art and graphics to Artificer', () => {
    expect(familyOf({ kind: 'scout', category: 'art' })).toBe('scout')
    expect(familyOf({ kind: 'ship', category: 'art' })).toBe('artificer')
    expect(familyOf({ kind: 'ship', category: 'graphics' })).toBe('artificer')
    expect(familyOf({ kind: 'ship', category: 'tests' })).toBe('warden')
    expect(familyOf({ kind: 'ship', category: 'bugfix' })).toBe('warden')
    expect(familyOf({ kind: 'ship', category: 'feature' })).toBe('builder')
  })
})

describe('playstyle thresholds', () => {
  it('needs five landed missions before any title', () => {
    const r = classifyPlaystyle(times(4, ship('art')))
    expect(r).toMatchObject({ title: 'adventurer', samples: 4 })
    expect(r.why).toBe('Land 5 missions to earn a title · 4 so far')
    expect(classifyPlaystyle(times(5, ship('art'))).title).toBe('artificer')
  })

  it('awards a title at exactly 60% and not below', () => {
    const at = classifyPlaystyle([...times(3, ship('tests')), ship('feature'), recon()])
    expect(at.title).toBe('warden')
    expect(at.why).toBe('3 of last 5 landings were fixes, tests, reviews or CI (60%)')
    const below = classifyPlaystyle([...times(11, ship('tests')), ...times(5, ship('feature')), ...times(4, recon())])
    expect(below.title).toBe('adventurer')
    expect(below.why).toBe('No style above 60% in last 20 landings · Warden 11 · Builder 5 · Scout 4')
  })

  it('ignores failed or despawned missions and only reads the last 20 landings', () => {
    const old = times(30, recon())
    const recent = [...times(12, ship('graphics')), ...times(8, ship('feature'))]
    const failures = times(10, ship('feature', false))
    const r = classifyPlaystyle([...old, ...recent, ...failures])
    expect(r.samples).toBe(20)
    expect(r.counts).toEqual({ builder: 8, scout: 0, artificer: 12, warden: 0 })
    expect(r.title).toBe('artificer')
  })
})
