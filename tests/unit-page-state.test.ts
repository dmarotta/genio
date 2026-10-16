import { describe, expect, it } from 'vitest'
import type { Task, TerminalInfo } from '../src/shared/types'
import {
  canRate, deliveryLabel, mergeTimeline, needsInput, parseDiffStat, parsePings, parseStatusLines, parseUnitChanges, primaryAction, prMergeBlock,
  reportedTests, unitBadge
} from '../src/shared/unit-page'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const unit = (patch: Partial<Task> = {}): Task => ({ id: 'u1', title: 'Fix the jump', kind: 'ship', state: 'working', project: 'world', wksp: 'main',
  mode: 'local-only', harness: 'claude', branch: 'genio/u1', baseBranch: 'main', worktree: 'C:/wt/u1', relaunches: 0,
  createdAt: '2026-10-13T11:00:00Z', updatedAt: '2026-10-13T11:30:00Z', ...patch } as Task)
const pty = (patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 'pty-1', taskId: 'u1', title: 'u1', cwd: 'C:/wt/u1', alive: true, cols: 120, rows: 32, kind: 'worker', ...patch })
const pr = { url: 'https://github.com/o/r/pull/7', number: 7, state: 'OPEN' as const }

describe('primary action by state (the Recon table)', () => {
  it.each([
    ['working', unit(), 'steer'],
    ['spawning', unit({ state: 'spawning' }), 'steer'],
    ['validating', unit({ state: 'validating', mode: 'no-mistakes' }), 'steer'],
    ['lagging', unit({ state: 'stale' }), 'steer'],
    ['needs-decision', unit({ state: 'needs-decision' }), 'question'],
    ['blocked', unit({ state: 'blocked' }), 'question'],
    ['ready, Offline', unit({ state: 'ready', readyAt: '2026-10-13T11:50:00Z' }), 'merge-local'],
    ['ready, PR', unit({ state: 'ready', mode: 'direct-PR', readyAt: '2026-10-13T11:50:00Z', pr }), 'merge-pr'],
    ['ready, PR not open yet', unit({ state: 'ready', mode: 'direct-PR', readyAt: '2026-10-13T11:50:00Z' }), 'none'],
    ['failed', unit({ state: 'failed' }), 'respawn'],
    ['exited', unit({ state: 'exited' }), 'respawn'],
    ['detached', unit({ state: 'detached' }), 'respawn'],
    ['Recon done', unit({ kind: 'scout', state: 'done' }), 'recon-done'],
    ['merged', unit({ state: 'merged' }), 'none'],
    ['despawned', unit({ state: 'cleaned' }), 'none']
  ] as const)('%s', (_, t, want) => {
    expect(primaryAction(t)).toBe(want)
  })

  it('asks the open question even while the unit still reads working', () => {
    expect(primaryAction(unit(), undefined, true)).toBe('question')
  })

  it('steers a ready unit that resumed work, but still offers the merge while its idle CLI only prints chrome', () => {
    const t = unit({ state: 'ready', readyAt: '2026-10-13T11:50:00Z' })
    expect(primaryAction(t, pty({ lastOutputAt: '2026-10-13T11:55:00Z' }))).toBe('merge-local')
    expect(primaryAction({ ...t, resumedAt: '2026-10-13T11:55:00Z' }, pty())).toBe('steer')
  })
})

describe('header pieces', () => {
  it('keeps Merge PR off until the checks are green, in words', () => {
    expect(prMergeBlock({ checks: 'passing' })).toBe('')
    expect(prMergeBlock({ checks: 'none' })).toBe('')
    expect(prMergeBlock({ checks: 'failing' })).toMatch(/failing/)
    expect(prMergeBlock({ checks: 'pending' })).toMatch(/still running/)
    expect(prMergeBlock({})).toMatch(/not read/)
  })

  it('never shows a stopped agent as DONE or WORKING', () => {
    expect(unitBadge(unit({ state: 'detached' })).label).toBe('NOT RUNNING')
    expect(unitBadge(unit({ state: 'exited', stateReason: 'recalled' })).label).toBe('RECALLED')
    expect(unitBadge(unit({ state: 'exited', stateReason: 'exited (code 0)' })).label).toBe('STOPPED')
    expect(unitBadge(unit({ state: 'exited', stateReason: 'exited (code 1)' })).label).toBe('EXITED ABNORMALLY')
    expect(unitBadge(unit({ state: 'failed' }))).toEqual({ label: 'FAILED', tone: 'alert' })
    expect(unitBadge(unit({ state: 'paused' })).label).toBe('WAITING')
  })

  it('rates finished units only', () => {
    expect(canRate(unit({ state: 'ready', readyAt: NOW.toString() }))).toBe(false)
    expect(canRate(unit())).toBe(false)
    for (const state of ['merged', 'done', 'failed', 'cleaned'] as const) expect(canRate(unit({ state }))).toBe(true)
  })

  it('words the delivery mode as what landing means', () => {
    expect(deliveryLabel('local-only', 'main')).toBe('Merge into main')
    expect(deliveryLabel('direct-PR', 'dev')).toBe('Pull request into dev')
    expect(deliveryLabel('no-mistakes', 'main')).toMatch(/^Gauntlet/)
    expect(deliveryLabel(undefined, 'main')).toMatch(/^Recon/)
  })

  it('flags "needs input" from the lagging window or the stale state', () => {
    const quiet = pty({ lastOutputAt: '2026-10-13T11:50:00Z' })
    expect(needsInput(unit(), quiet, NOW, 240)).toBe(true)
    expect(needsInput(unit(), quiet, NOW, 900)).toBe(false)
    expect(needsInput(unit(), pty({ lastOutputAt: '2026-10-13T11:59:00Z' }), NOW, 240)).toBe(false)
    expect(needsInput(unit({ state: 'ready' }), quiet, NOW, 240)).toBe(false)
    expect(needsInput(unit({ state: 'stale' }), undefined, NOW)).toBe(true)
    expect(needsInput(unit(), pty({ alive: false, lastOutputAt: '2026-10-13T11:00:00Z' }), NOW)).toBe(false)
  })
})

describe('Changes and Timeline data', () => {
  it('reads git diff --stat, binary files included', () => {
    const s = parseDiffStat(' src/a.ts        | 12 ++++++----\n assets/logo.png | Bin 0 -> 2048 bytes\n 2 files changed, 8 insertions(+), 4 deletions(-)\n')
    expect(s).toEqual({ files: [{ path: 'src/a.ts', changes: 12, binary: false }, { path: 'assets/logo.png', changes: 0, binary: true }], insertions: 8, deletions: 4 })
    expect(parseDiffStat(' 1 file changed, 1 insertion(+)')).toMatchObject({ insertions: 1, deletions: 0 })
  })

  it('reads the diffstat task file, a removed copy and junk', () => {
    expect(parseUnitChanges(JSON.stringify({ stat: ' a | 1 +\n 1 file changed, 1 insertion(+)', commits: ['abc x'], uncommitted: ['?? b'] })))
      .toMatchObject({ insertions: 1, commits: ['abc x'], uncommitted: ['?? b'], removed: false })
    expect(parseUnitChanges('(worktree removed)').removed).toBe(true)
    expect(parseUnitChanges('{oops').files).toEqual([])
  })

  it('finds the unit\'s last word on tests', () => {
    expect(reportedTests([{ text: 'tests green' }, { text: 'branch ready' }])).toBe('tests green')
    expect(reportedTests([{ text: 'wiring the jump' }])).toBeUndefined()
  })

  it('parses status lines without their JSON metadata', () => {
    expect(parseStatusLines('needs-decision [key=k] [at=1791892800]: Keep it? || {"options":["a","b"]}\nfree text')).toEqual([
      { verb: 'needs-decision', tags: '[key=k]', text: 'Keep it?', at: 1791892800000 },
      { verb: 'note', tags: '', text: 'free text' }
    ])
  })

  it('reads pings with or without a time, and merges them with status lines newest first', () => {
    const pings = parsePings('--- PENDING 002.msg at=2026-10-13T11:58:00Z ---\nsecond\n\n--- READ 001.msg ---\nfirst')
    expect(pings.map((p) => [p.text, p.unread, !!p.at])).toEqual([['second', true, true], ['first', false, false]])
    const status = parseStatusLines('working [at=1791892000]: a\nnote: b\nworking [at=1791892600]: c')
    expect(mergeTimeline(status, pings).map((r) => r.text)).toEqual(['first', 'second', 'c', 'b', 'a'])
  })
})
