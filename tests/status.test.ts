import { describe, expect, it } from 'vitest'
import { foldOpenDecisions, formatStatusLine, parseStatusLine, parseStatusLog } from '../src/main/status'

describe('parseStatusLine', () => {
  it('parses verb, tags and note', () => {
    const e = parseStatusLine('needs-decision [key=palette] [at=1760000000]: pick a colour palette', 't1')
    expect(e.kind).toBe('needs-decision')
    expect(e.key).toBe('palette')
    expect(e.at).toBe(1760000000)
    expect(e.text).toBe('pick a colour palette')
    expect(e.playerRelevant).toBe(true)
  })

  it('defaults the key for decision verbs and accepts a leading key in the note', () => {
    expect(parseStatusLine('blocked: tests need a GPU', 't').key).toBe('default')
    const e = parseStatusLine('needs-decision: [key=api] which endpoint?', 't')
    expect(e.key).toBe('api')
    expect(e.text).toBe('which endpoint?')
  })

  it('treats malformed or duplicate at= as unknown', () => {
    expect(parseStatusLine('working [at=abc]: x', 't').at).toBeUndefined()
    expect(parseStatusLine('working [at=1234567890123]: x', 't').at).toBeUndefined()
    expect(parseStatusLine('working [at=1] [at=2]: x', 't').at).toBeUndefined()
  })

  it('extracts PR urls, paused until and ready branch', () => {
    expect(parseStatusLine('done: PR https://github.com/a/b/pull/42 checks green', 't').fields.pr).toBe(
      'https://github.com/a/b/pull/42'
    )
    expect(parseStatusLine('paused: waiting on CI until 2026-10-12T10:00Z', 't').fields.until).toBe('2026-10-12T10:00Z')
    expect(parseStatusLine('done: ready in branch genio/fix-1.', 't').fields.branch).toBe('genio/fix-1')
  })

  it('never marks working/resolved/player-held/note as relevant even with keywords', () => {
    for (const v of ['working', 'resolved', 'player-held', 'note']) {
      expect(parseStatusLine(`${v}: PR ready merged checks green`, 't').playerRelevant).toBe(false)
    }
  })

  it('treats bare legacy lines by keyword', () => {
    const e = parseStatusLine('PR ready https://github.com/a/b/pull/1', 't')
    expect(e.kind).toBe('unknown')
    expect(e.playerRelevant).toBe(true)
    expect(parseStatusLine('just chatting', 't').playerRelevant).toBe(false)
  })

  it('accepts a bare corr token', () => {
    expect(parseStatusLine('note corr=0123456789abcdef: hi', 't').fields.corr).toBe('0123456789abcdef')
  })
})

describe('foldOpenDecisions', () => {
  it('opens and closes keys', () => {
    const ev = parseStatusLog(
      ['needs-decision [key=a]: q1', 'blocked [key=b]: stuck', 'resolved [key=a]: answered: yes', 'working: on it'].join('\n'),
      't'
    )
    const open = foldOpenDecisions(ev)
    expect([...open.keys()]).toEqual(['b'])
  })

  it('player-held closes and done supersedes', () => {
    const ev = parseStatusLog(['needs-decision: q', 'player-held: moved to quest log'].join('\n'), 't')
    expect(foldOpenDecisions(ev).size).toBe(0)
    const ev2 = parseStatusLog(['blocked [key=x]: q', 'done: finished'].join('\n'), 't')
    expect(foldOpenDecisions(ev2).size).toBe(0)
  })

  it('working/paused do not close keys', () => {
    const ev = parseStatusLog(['needs-decision [key=z]: q', 'working: still going', 'paused: ci'].join('\n'), 't')
    expect(foldOpenDecisions(ev).has('z')).toBe(true)
  })
})

describe('formatStatusLine', () => {
  it('round-trips through the parser', () => {
    const line = formatStatusLine('resolved', 'answered: go\nahead', { key: 'k', at: 99 })
    const e = parseStatusLine(line, 't')
    expect(e.kind).toBe('resolved')
    expect(e.key).toBe('k')
    expect(e.at).toBe(99)
    expect(e.text).toBe('answered: go ahead')
  })
})
