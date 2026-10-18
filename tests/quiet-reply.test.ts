import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import { couldBecomeQuietReply, isQuietReply, withoutQuietReplies } from '../src/shared/quiet-reply'
import { QuietTurn, isEventTurn } from '../src/main/quiet-turn'

const who = ['Alex']
const msg = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, wksp: 'main', role, text, ts: `2026-10-17T10:00:${id.padStart(2, '0')}.000Z`, ...extra })

describe('isQuietReply', () => {
  it.each([
    'All clear, Alex.', 'all clear, alex', 'ALL CLEAR, ALEX!', '  All clear, Alex.  \n', '"All clear, Alex."', '“All clear, Alex.”',
    '`All clear, Alex.`', '**All clear, Alex.**', '_All clear, Alex._', 'All clear, Alex…', 'All clear Alex.', 'All  clear,   Alex.',
    '​All clear, Alex.', 'All clear.', 'all clear', 'GG, all clear, Alex.', 'gg all clear.',
    '', '   ', '\n\n', '(no content)', 'No response requested.'
  ])('hides %j', text => expect(isQuietReply(text, who)).toBe(true))

  it.each([
    'Done.', 'Done, Alex.', 'OK', 'All clear, Alex. The unit merged.', 'All clear, but one unit stopped.', 'All clear, the build is red',
    'All clear, Bob.', 'All clear?', 'All clear, Alex?', 'Not all clear, Alex.', 'Is it all clear, Alex.', 'All clear, Alex, and PR #4 is ready',
    'All clear, Alex.\n\nPR https://example.com/pr/1 is ready.', 'No response', '(no content) but here is a result'
  ])('shows %j', text => expect(isQuietReply(text, who)).toBe(false))

  it('knows only the names it is given', () => {
    expect(isQuietReply('All clear, Alex.')).toBe(false)
    expect(isQuietReply('All clear.')).toBe(true)
    expect(isQuietReply('All clear, Big Alex.', ['Big  Alex'])).toBe(true)
    expect(isQuietReply('All clear, (x).', ['(x)'])).toBe(true)
  })
})

describe('couldBecomeQuietReply', () => {
  it.each(['', ' ', 'A', 'All', 'all cl', 'All clear', 'All clear,', 'All clear, ', 'All clear, Al', 'All clear, Alex', 'All clear, Alex.', 'All clear, Alex."',
    '"All c', 'GG, all', '(no', '(no content)', 'No response requested.'])('holds %j', text => expect(couldBecomeQuietReply(text, who)).toBe(true))

  it.each(['Done', 'D', 'All clear, Alex. The', 'All clear, Alex!!! ok', 'All clear, the', 'Al clear', 'Not all', 'Hello', '(see below)'])('releases %j', text =>
    expect(couldBecomeQuietReply(text, who)).toBe(false))
})

describe('withoutQuietReplies (a log an older version wrote)', () => {
  it('drops the no-op rows of event turns and keeps everything else', () => {
    const log = [
      msg('1', 'player', 'status?'), msg('2', 'genio', 'All clear, Alex.'),                // the answer to the player's question
      msg('3', 'genio', 'All clear, Alex.'), msg('4', 'system', 'All clear, Alex.'),      // event turns
      msg('5', 'genio', 'Unit 3 is ready: https://example.com/pr/3'),
      msg('6', 'player', 'All clear, Alex.'),                                              // the player's own words
      msg('7', 'genio', 'Done.'), msg('8', 'genio', 'All clear, Alex.', { tools: [{ id: 't', name: 'fleet_view', input: '{}' }] }),
      msg('9', 'genio', 'All clear, Alex.', { reaction: { kind: 'like', at: '2026-10-17T10:00:09.000Z' } }),
      msg('10', 'genio', ''), msg('11', 'system', 'DND on, Alex.'), msg('12', 'genio', 'all clear, alex!')
    ]
    expect(withoutQuietReplies(log, who).map(m => m.id)).toEqual(['1', '2', '5', '6', '7', '8', '9', '11'])
  })

  it('keeps a sentence that follows the player directly even when it is the first row', () => {
    expect(withoutQuietReplies([msg('1', 'genio', 'All clear, Alex.')], who)).toEqual([])
    expect(withoutQuietReplies([msg('1', 'player', 'anything new?'), msg('2', 'genio', 'All clear, Alex.')], who)).toHaveLength(2)
  })
})

describe('QuietTurn', () => {
  const events = { kind: 'events' as const, prompt: '[GENIO EVENTS]\n#1 signal' }
  const player = { kind: 'player' as const, prompt: 'All clear, Alex.' }
  const reply = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => msg('9', 'genio', text, extra)

  it('knows which turns the player did not ask for', () => {
    expect(isEventTurn(events)).toBe(true)
    expect(isEventTurn({ kind: 'system', prompt: 'x\n[GENIO SESSION START]\nGenio just loaded' })).toBe(true)
    expect(isEventTurn({ kind: 'system', prompt: '/status' })).toBe(false)
    expect(isEventTurn(player)).toBe(false)
    expect(isEventTurn(undefined)).toBe(false)
  })

  it('holds a stream that may be the sentence, then drops it, whatever the chunking', () => {
    const q = new QuietTurn(() => who)
    q.begin(events)
    expect(['All', ' clear', ', Alex', '.'].map(d => q.delta('m', d))).toEqual(['', '', '', ''])
    expect(q.message(reply('All clear, Alex.'), false)).toBeUndefined()
    expect(q.message(reply('All clear, Alex.'), true)).toBeUndefined()
  })

  it('releases a stream the moment it turns out to be a real message, in one piece', () => {
    const q = new QuietTurn(() => who)
    q.begin(events)
    expect([q.delta('m', 'All clear'), q.delta('m', ', Alex.'), q.delta('m', ' Unit'), q.delta('m', ' 3 is ready.')]).toEqual(['', '', 'All clear, Alex. Unit', ' 3 is ready.'])
    expect(q.message(reply('All clear, Alex. Unit 3 is ready.'), true)?.text).toBe('All clear, Alex. Unit 3 is ready.')
    q.begin(events)
    expect(q.delta('m', 'Done.')).toBe('Done.')
  })

  it('passes everything through on a player turn', () => {
    const q = new QuietTurn(() => who)
    q.begin(player)
    expect(q.delta('m', 'All clear, Alex.')).toBe('All clear, Alex.')
    expect(q.message(reply('All clear, Alex.'), true)?.text).toBe('All clear, Alex.')
    expect(q.message(reply(''), false)?.text).toBe('')
    expect(q.silent('All clear, Alex.')).toBe(false)
    q.begin(events)
    q.end()
    expect(q.message(reply('All clear, Alex.'), true)).toBeDefined()
  })

  it('drops empty and placeholder messages, strips the sentence beside tool traces, keeps real text and the player\'s rows', () => {
    const q = new QuietTurn(() => who)
    q.begin(events)
    expect(q.message(reply(''), true)).toBeUndefined()
    expect(q.message(reply('(no content)'), true)).toBeUndefined()
    expect(q.message(reply('Done.'), true)?.text).toBe('Done.')
    expect(q.message(reply('All clear, Alex.', { tools: [{ id: 't', name: 'events_ack', input: '{}' }] }), true)).toMatchObject({ text: '', tools: [{ id: 't' }] })
    expect(q.message(reply('', { tools: [{ id: 't', name: 'events_ack', input: '{}' }] }), true)?.tools).toHaveLength(1)
    expect(q.message(msg('p', 'player', 'All clear, Alex.'), true)?.text).toBe('All clear, Alex.')
    expect(q.message(msg('s', 'system', 'All clear, Alex.'), true)?.text).toBe('All clear, Alex.')
    expect(q.silent('All clear, Alex.')).toBe(true)
    expect(q.silent('')).toBe(true)
    expect(q.silent('Unit 3 is ready.')).toBe(false)
  })
})
