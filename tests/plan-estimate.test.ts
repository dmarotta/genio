import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_USD_PER_UNIT, estimatePlan, formatEstimate, stepMinutes, unitRunMinutes } from '../src/shared/plan-estimate'
import { hintOverlap, isAlwaysHot, matchesHint } from '../src/main/plan-hints'
import type { Task } from '../src/shared/types'

const start = Date.parse('2026-10-16T10:00:00Z')
const run = (minutes: number, extra: Partial<Task> = {}): Task =>
  ({ id: `u${minutes}`, kind: 'ship', project: 'world', state: 'cleaned', createdAt: new Date(start).toISOString(),
    finishedAt: new Date(start + minutes * 60_000).toISOString(), ...extra }) as Task

describe('plan estimate', () => {
  it('measures a unit from launch to first finish and skips discarded, unfinished and implausible runs', () => {
    expect(unitRunMinutes(run(30))).toBe(30)
    expect(unitRunMinutes(run(30, { discarded: true }))).toBeUndefined()
    expect(unitRunMinutes(run(30, { finishedAt: undefined }))).toBeUndefined()
    expect(unitRunMinutes(run(1))).toBeUndefined()
    expect(unitRunMinutes(run(9 * 60))).toBeUndefined()
  })

  it('uses the same category first, then the same kind, then the defaults', () => {
    const history = [run(10, { category: 'docs' }), run(12, { category: 'docs' }), run(14, { category: 'docs' }), run(40), run(50), run(60)]
    expect(stepMinutes({ key: 'd', kind: 'ship', category: 'docs' }, history, 'world')).toEqual({ minutes: [12, 13], samples: 3 })
    expect(stepMinutes({ key: 'f', kind: 'ship', category: 'feature' }, history, 'world').samples).toBe(6)
    expect(stepMinutes({ key: 'r', kind: 'scout' }, history)).toEqual({ minutes: [15, 35], samples: 0 })
    // another project's history counts when this one has too little
    expect(stepMinutes({ key: 'd', kind: 'ship', category: 'docs' }, history, 'other').samples).toBe(3)
  })

  it('times a serial chain end to end and parallel branches along the longest one', () => {
    const serial = estimatePlan([{ key: 'a' }, { key: 'b', after: ['a'] }, { key: 'c', after: ['b'] }], [])
    expect(serial).toMatchObject({ units: 3, unitMinutes: [60, 135], elapsedMinutes: [60, 135], samples: 0 })
    const diamond = estimatePlan([{ key: 'a' }, { key: 'b', after: ['a'] }, { key: 'c', after: ['a'] }, { key: 'd', after: ['b', 'c'] }], [], { maxParallel: 2 })
    expect(diamond.elapsedMinutes).toEqual([60, 135])
    // max parallel 1 runs every step back to back
    expect(estimatePlan([{ key: 'a' }, { key: 'b' }], [], { maxParallel: 1 }).elapsedMinutes).toEqual([40, 90])
  })

  it('prices the main chat from its measured cost per unit, or the defaults', () => {
    expect(estimatePlan([{ key: 'a' }, { key: 'b' }], []).mainChatUsd).toEqual([DEFAULT_CHAT_USD_PER_UNIT[0] * 2, DEFAULT_CHAT_USD_PER_UNIT[1] * 2])
    expect(estimatePlan([{ key: 'a' }, { key: 'b' }], [], { chatUsdPerUnit: 1 }).mainChatUsd).toEqual([1.7, 2.3])
  })

  it('formats the announcement line', () => {
    expect(formatEstimate(estimatePlan([{ key: 'a' }, { key: 'b', after: ['a'] }, { key: 'c', after: ['b'] }], []))).toBe('About 1-2.5 h, 3 units (~1.5 unit-hours), main chat ~$1.50-2.10')
    expect(formatEstimate(estimatePlan([{ key: 'a' }], []))).toBe('About 20-45 min, 1 unit (~0.5 unit-hours), main chat ~$0.50-0.70')
  })
})

describe('rebase hints', () => {
  it('matches paths, folders, bare file names and globs', () => {
    expect(matchesHint('src/main/gauntlet.ts', 'src/main/gauntlet.ts')).toBe(true)
    expect(matchesHint('src\\main\\gauntlet.ts', './src/main/')).toBe(true)
    expect(matchesHint('src/main/gauntlet.ts', 'gauntlet.ts')).toBe(true)
    expect(matchesHint('src/renderer/views/Squad.tsx', 'src/**/*.tsx')).toBe(true)
    expect(matchesHint('src/renderer/views/Squad.tsx', 'src/*.tsx')).toBe(false)
    expect(matchesHint('src/main/crew.ts', 'src/main/crew-*.ts')).toBe(false)
    expect(matchesHint('src/mainline.ts', 'src/main')).toBe(false)
  })

  it('leaves the always-hot files out of every overlap', () => {
    for (const f of ['src/shared/types.ts', 'src/shared/api.ts', 'src/main/ipc.ts', 'src/renderer/src/app.css', 'tsconfig.node.json', 'package-lock.json', 'Packages/packages-lock.json']) expect(isAlwaysHot(f)).toBe(true)
    expect(isAlwaysHot('src/main/plans.ts')).toBe(false)
    expect(hintOverlap(['src/shared/types.ts', 'src/main/plans.ts', 'src/main/crew.ts'], ['src/shared/', 'src/main/plans.ts'])).toEqual(['src/main/plans.ts'])
    expect(hintOverlap(['src/main/plans.ts'], [])).toEqual([])
  })
})
