import { describe, expect, it } from 'vitest'
import { LEVEL_TITLES, TITLE_CAP, levelTitle, nextTitle } from '../src/shared/level-titles'

describe('level titles', () => {
  it('gives every level up to the cap its own title, about forty of them', () => {
    expect(TITLE_CAP).toBeGreaterThanOrEqual(30)
    expect(TITLE_CAP).toBeLessThanOrEqual(50)
    const titles = Array.from({ length: TITLE_CAP }, (_, i) => levelTitle(i + 1))
    expect(new Set(titles).size).toBe(TITLE_CAP)
    expect(titles).toEqual(LEVEL_TITLES)
  })
  it('numbers a repeated family Mk I, Mk II, Mk III in order', () => {
    for (const t of LEVEL_TITLES) expect(t.trim()).toBe(t)
    const families = new Map<string, string[]>()
    for (const t of LEVEL_TITLES) {
      const m = t.match(/^(.+) Mk ([IVX]+)$/)
      if (m) families.set(m[1], [...(families.get(m[1]) ?? []), m[2]])
    }
    expect(families.size).toBeGreaterThan(0)
    for (const [family, marks] of families) {
      expect(marks, family).toEqual(['I', 'II', 'III', 'IV', 'V'].slice(0, marks.length))
      expect(LEVEL_TITLES, `${family} also stands alone`).not.toContain(family)
    }
  })
  it.each([
    [1, 'Recruit', { title: 'Rookie', level: 2 }],
    [13, 'Ace Mk II', { title: 'Ace Mk III', level: 14 }],
    [14, 'Ace Mk III', { title: 'Elite', level: 15 }],
    [TITLE_CAP - 1, 'Hall of Famer', { title: 'Living Legend', level: TITLE_CAP }],
    [TITLE_CAP, 'Living Legend', undefined],
    [TITLE_CAP + 12, 'Living Legend', undefined]
  ])('level %i is %s, then the teaser', (level, title, next) => {
    expect(levelTitle(level)).toBe(title)
    expect(nextTitle(level)).toEqual(next)
  })
  it('treats a missing or broken level as level 1', () => {
    expect(levelTitle(0)).toBe('Recruit')
    expect(levelTitle(Number.NaN)).toBe('Recruit')
    expect(nextTitle(0)).toEqual({ title: 'Rookie', level: 2 })
  })
})
