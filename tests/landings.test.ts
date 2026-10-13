import { describe, expect, it } from 'vitest'
import { freshLandingLog, landedDaysInWeek, landingWindow, loadLandingLog, observeDay, recordLanding } from '../src/main/landings'

// Local wall-clock dates: the heatmap is in local calendar days.
const at = (y: number, m: number, d: number, h = 12): Date => new Date(y, m - 1, d, h)

describe('landing counts', () => {
  it('counts a mission once, never again through its quest or a re-delivered event', () => {
    const log = freshLandingLog(at(2026, 10, 1))
    expect(recordLanding(log, 'build', { taskId: 't1', questId: 'q1' }, at(2026, 10, 13))).toBe(true)
    expect(recordLanding(log, 'build', { taskId: 't1', questId: 'q1' }, at(2026, 10, 13))).toBe(false)
    // a second unit on the same quest is the same landing
    expect(recordLanding(log, 'build', { taskId: 't2', questId: 'q1' }, at(2026, 10, 14))).toBe(false)
    // the recon report of a later-promoted mission is its own event
    expect(recordLanding(log, 'recon', { taskId: 't1', questId: 'q1' }, at(2026, 10, 13))).toBe(true)
    expect(recordLanding(log, 'build', { taskId: 't3' }, at(2026, 10, 13))).toBe(true)
    expect(log.days).toEqual({ '2026-10-13': { builds: 2, recons: 1 } })
  })

  it('files a landing under the local calendar day, including just before midnight', () => {
    const log = freshLandingLog(at(2026, 10, 1))
    recordLanding(log, 'build', { taskId: 'late' }, at(2026, 10, 12, 23))
    recordLanding(log, 'build', { taskId: 'early' }, at(2026, 10, 13, 0))
    expect(Object.keys(log.days).sort()).toEqual(['2026-10-12', '2026-10-13'])
  })

  it('keeps dedupe keys long enough for an at-least-once ledger, then prunes them', () => {
    const log = freshLandingLog(at(2026, 1, 1))
    recordLanding(log, 'build', { taskId: 'x' }, at(2026, 1, 2))
    observeDay(log, at(2026, 3, 1))
    expect(recordLanding(log, 'build', { taskId: 'x' }, at(2026, 3, 1))).toBe(false)
    observeDay(log, at(2026, 9, 1))
    expect(log.seen).toEqual({})
  })
})

describe('landing window', () => {
  it('shows 8 Monday-first weeks ending this week, with later days as future', () => {
    const today = at(2026, 10, 14) // a Wednesday
    const w = landingWindow(freshLandingLog(today), today)
    expect(w).toHaveLength(56)
    expect(w[0].day).toBe('2026-08-24') // Monday seven weeks earlier
    expect(w[51]).toMatchObject({ day: '2026-10-14', state: 'recorded', builds: 0 })
    expect(w.slice(52).every((d) => d.state === 'future')).toBe(true)
  })

  it('shows days before recording or never observed as unknown, not zero', () => {
    const log = freshLandingLog(at(2026, 10, 5))
    observeDay(log, at(2026, 10, 7))
    recordLanding(log, 'recon', { taskId: 'r' }, at(2026, 10, 9))
    const byDay = Object.fromEntries(landingWindow(log, at(2026, 10, 9)).map((d) => [d.day, d]))
    expect(byDay['2026-10-04'].state).toBe('unknown') // before recording began
    expect(byDay['2026-10-05'].state).toBe('recorded')
    expect(byDay['2026-10-06'].state).toBe('unknown') // Genio never saw this day
    expect(byDay['2026-10-07']).toMatchObject({ state: 'recorded', builds: 0, recons: 0 })
    expect(byDay['2026-10-09']).toMatchObject({ state: 'recorded', recons: 1 })
  })

  it('starts recording today when stats.json has no or broken history', () => {
    expect(loadLandingLog(undefined, at(2026, 10, 13)).since).toBe('2026-10-13')
    expect(loadLandingLog({ since: 'yesterday' }, at(2026, 10, 13)).since).toBe('2026-10-13')
    const kept = loadLandingLog({ since: '2026-09-01', days: { '2026-09-02': { builds: 1, recons: 0 } }, seen: {}, observed: ['2026-09-02'] })
    expect(kept.days['2026-09-02'].builds).toBe(1)
  })

  it('counts days with a landing in the last seven', () => {
    const log = freshLandingLog(at(2026, 10, 1))
    for (const d of [7, 8, 10, 12, 13]) recordLanding(log, 'build', { taskId: `t${d}` }, at(2026, 10, d))
    expect(landedDaysInWeek(log, at(2026, 10, 13))).toBe(5)
    expect(landedDaysInWeek(log, at(2026, 10, 14))).toBe(4)
  })
})
