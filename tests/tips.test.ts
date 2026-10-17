import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS } from '../src/main/stats'
import { pickTip, TIPS, type TipMoment, type TipSignals } from '../src/shared/tips'

export const signals = (patch: Partial<TipSignals> = {}): TipSignals => ({
  enabled: true, presence: 'online', playing: false, replying: false, dialogOpen: false,
  choiceOpen: false, active: true, achievements: [], unity: true, mergesTotal: 0,
  choicesAnswered: 0, choiceAgeMs: 0, approvalsInWords: 0, autoLoot: false, standingUsed: false,
  artBible: false, generationsToday: 0, copyMs: 0, projectBlockClone: false,
  cloneVolumeMounted: false, firstOpening: false, designNotes: false, setupStarted: false, ...patch
})
const now = new Date(2026, 9, 17, 12).getTime()
const cases: [string, TipMoment, Partial<TipSignals>, Partial<TipSignals>][] = [
  ['play-unit', 'build-ready', { achievements: ['play-first'] }, { unity: false }],
  ['plans', 'merge', { mergesTotal: 10 }, { mergesTotal: 9 }],
  ['ask-genio', 'choice-wait', { choiceOpen: true, choicesAnswered: 5, choiceAgeMs: 600_000 }, { choiceAgeMs: 599_999 }],
  ['standing', 'merge', { approvalsInWords: 3 }, { autoLoot: true }],
  ['art-bible', 'generated', {}, { artBible: true }],
  ['generator', 'generation-approved', { generationsToday: 3 }, { generationsToday: 2 }],
  ['dev-drive', 'copy', { copyMs: 60_001, cloneVolumeMounted: true }, { copyMs: 60_000 }],
  ['setup', 'project-open', { firstOpening: true }, { designNotes: true }]
]

describe('deterministic feature tips', () => {
  it.each(cases)('%s fires only for its moment and conditions', (id, moment, good, bad) => {
    expect(pickTip(moment, signals(good), { shown: {} }, now)?.id).toBe(id)
    expect(pickTip(moment, signals({ ...good, ...bad }), { shown: {} }, now)).toBeNull()
    expect(TIPS.find(t => t.id === id)?.moment).toBe(moment)
    for (const other of TIPS.map(t => t.moment).filter(m => m !== moment)) {
      expect(pickTip(other, signals(good), { shown: {} }, now)?.id).not.toBe(id)
    }
  })

  it.each(cases)('%s never returns once seen, or once its feature is used', (id, moment, good) => {
    expect(pickTip(moment, signals(good), { shown: { [id]: '2020-01-01' } }, now)).toBeNull()
    const tip = TIPS.find(t => t.id === id)!
    for (const achievement of tip.usedAchievements) {
      expect(pickTip(moment, signals({ ...good, achievements: [...(good.achievements ?? []), achievement] }), { shown: {} }, now)).toBeNull()
    }
    if (id === 'standing') expect(pickTip(moment, signals({ ...good, standingUsed: true }), { shown: {} }, now)).toBeNull()
    if (id === 'dev-drive') expect(pickTip(moment, signals({ ...good, projectBlockClone: true }), { shown: {} }, now)).toBeNull()
    if (id === 'setup') expect(pickTip(moment, signals({ ...good, setupStarted: true }), { shown: {} }, now)).toBeNull()
  })

  it.each([
    { enabled: false }, { presence: 'dnd' }, { presence: 'afk' }, { playing: true },
    { replying: true }, { dialogOpen: true }, { choiceOpen: true }
  ] satisfies Partial<TipSignals>[])('blocks all ordinary moments with %j', gate => {
    for (const [, moment, good] of cases.filter(c => c[0] !== 'ask-genio')) {
      expect(pickTip(moment, signals({ ...good, ...gate }), { shown: {} }, now)).toBeNull()
    }
  })

  it('requires prior Play, enough answered choices, activity and a mounted clone volume', () => {
    expect(pickTip('build-ready', signals(), { shown: {} }, now)).toBeNull()
    for (const bad of [{ active: false }, { choicesAnswered: 4 }]) {
      expect(pickTip('choice-wait', signals({ choicesAnswered: 5, choiceAgeMs: 600_000, ...bad }), { shown: {} }, now)).toBeNull()
    }
    expect(pickTip('copy', signals({ copyMs: 60_001 }), { shown: {} }, now)).toBeNull()
    expect(pickTip('project-open', signals(), { shown: {} }, now)).toBeNull()
  })

  it('allows at most one per local calendar day, including after a restart, and one per session across midnight', () => {
    const good = signals({ mergesTotal: 10 })
    expect(pickTip('merge', good, { shown: {}, lastShownAt: new Date(now - 60_000).toISOString() }, now)).toBeNull()
    const tomorrow = new Date(2026, 9, 18, 0, 1).getTime()
    expect(pickTip('merge', good, { shown: {}, lastShownAt: new Date(now).toISOString() }, tomorrow)?.id).toBe('plans')
    expect(pickTip('merge', good, { shown: {}, lastShownAt: new Date(now).toISOString(), shownThisSession: true }, tomorrow)).toBeNull()
  })

  it('uses catalogue order when two rules match', () => {
    expect(pickTip('merge', signals({ mergesTotal: 10, approvalsInWords: 3 }), { shown: {} }, now)?.id).toBe('plans')
  })
})

describe('tip catalogue guardrails', () => {
  it('has eight rules, never exceeds twelve entries, and uses only live achievements', () => {
    expect(TIPS).toHaveLength(8)
    expect(TIPS.length).toBeLessThanOrEqual(12)
    expect(new Set(TIPS.map(t => t.id)).size).toBe(TIPS.length)
    for (const tip of TIPS) {
      for (const id of tip.usedAchievements) expect(ACHIEVEMENTS.find(a => a.id === id && !a.retired), `${tip.id}: ${id}`).toBeDefined()
      expect(tip.line.length, tip.id).toBeLessThanOrEqual(90)
      expect(tip.line).not.toMatch(/[\r\n]|\.genio|[A-Z]:\\|\bSettings\b/i)
      expect(tip.question.trim()).not.toBe('')
    }
  })
})
