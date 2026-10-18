import { describe, expect, it } from 'vitest'
import { BODY_MAX, TITLE_MAX, capWords, cleanNotifyText, formatNotification } from '../src/main/notify-format'

describe('formatNotification', () => {
  it('names the outcome and the world in the title', () => {
    expect(formatNotification({ kind: 'ready', text: 'PR ready: https://github.com/alex/genio/pull/42 — notifications use the Genio icon' })).toEqual({
      title: 'PR ready · genio',
      body: 'Notifications use the Genio icon'
    })
    expect(formatNotification({ kind: 'decision', text: 'Which palette should the HUD use?', where: 'lands-of-old' }).title).toBe('Choice needed · lands-of-old')
    expect(formatNotification({ kind: 'failure', text: 'Unit blocked: tests need a GPU', where: 'lands-of-old' }).title).toBe('Unit stuck · lands-of-old')
    expect(formatNotification({ kind: 'failure', text: 'Build broke on main' }).title).toBe('Something failed')
    expect(formatNotification({ kind: 'digest', count: 3, text: 'x' }).title).toBe('3 updates while away')
    expect(formatNotification({ kind: 'alarm', count: 2, text: 'x' }).title).toBe('2 waiting on you')
  })

  it('leaves the main home out of the title', () => {
    expect(formatNotification({ kind: 'info', text: 'Scout finished', where: 'main' }).title).toBe('Update')
  })

  it('caps title and body', () => {
    const long = 'word '.repeat(60)
    const n = formatNotification({ kind: 'decision', text: long, where: 'a-very-long-world-name-that-keeps-going-forever' })
    expect(n.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(n.body.length).toBeLessThanOrEqual(BODY_MAX)
    expect(n.body.endsWith('…')).toBe(true)
    expect(n.body).not.toContain('\n')
  })

  it('falls back to a short pointer when nothing is left', () => {
    expect(formatNotification({ kind: 'info', text: 'C:\\Users\\alex\\x.log' }).body).toBe('Open Genio for details.')
  })
})

describe('cleanNotifyText', () => {
  it('strips ids, paths and urls', () => {
    const s = cleanNotifyText(
      'Your move (desktop-notifications-genio-icon-and-sho-ff92): merge C:/Users/player/.genio/worktrees/x into src/main/notifier.ts? see https://example.com/a commit 5bf4b47 run 3f2c9a1e-1111-4222-8333-444455556666'
    )
    expect(s).not.toMatch(/ff92|C:\/|notifier\.ts|https?:|5bf4b47|3f2c9a1e/)
    expect(s.startsWith('Merge')).toBe(true)
  })

  it('strips posix paths and status tags but keeps words with slashes', () => {
    const s = cleanNotifyText('blocked [key=gpu]: and/or check /home/alex/.genio/state/x.status first')
    expect(s).not.toMatch(/\/home|key=|\.status/)
    expect(s).toContain('and/or')
  })

  it('tidies separators left behind', () => {
    expect(cleanNotifyText('Merged: — https://x.dev/y — all green')).toBe('Merged: all green')
  })

  it('drops boilerplate prefixes and keeps only the first line', () => {
    expect(cleanNotifyText('Genio // YOUR MOVE\n[FAIL] second line')).toBe('YOUR MOVE')
    expect(cleanNotifyText('[YOUR MOVE] Bot: pick a font\nmore detail here')).toBe('Pick a font')
    expect(cleanNotifyText('The Bot hit a problem: rate limited')).toBe('Rate limited')
  })

  it('keeps plain world names', () => {
    expect(cleanNotifyText('lands-of-old shipped the cave level')).toBe('Lands-of-old shipped the cave level')
  })
})

describe('capWords', () => {
  it('cuts at a word boundary under the cap', () => {
    const s = capWords('alpha beta gamma delta epsilon', 20)
    expect(s.length).toBeLessThanOrEqual(20)
    expect(s).toBe('alpha beta gamma…')
  })
})
