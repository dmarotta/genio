import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetSnapshot, GenioEvent, TerminalInfo } from '../src/shared/types'
import { createEventRouter, DELTA_FLUSH_MS, TERM_CHANNEL, TERMINAL_FLUSH_MS, type EventRouter, type RoutedWindow } from '../src/main/event-router'

const tasks = [{ id: 'task-one', project: 'one', terminalId: 'term-one' }, { id: 'task-two', project: 'two', terminalId: 'term-two' }]
const snapshot = { tasks, projects: [{ name: 'one', path: '/games/one' }, { name: 'two', path: '/games/two' }], backlog: [], decisions: [], wksps: [], allies: [] } as unknown as FleetSnapshot
const terminals: Record<string, TerminalInfo> = {
  'term-one': { id: 'term-one', taskId: 'task-one', title: 'one', cwd: '/games/one/wt', alive: true, cols: 80, rows: 24, kind: 'worker' },
  'term-two': { id: 'term-two', taskId: 'task-two', title: 'two', cwd: '/games/two/wt', alive: true, cols: 80, rows: 24, kind: 'worker' }
}

type Win = RoutedWindow & { sent: { channel: string; payload: unknown }[]; gone: boolean }
const win = (binding?: { project: string; wksp: string }): Win => {
  const w: Win = { binding, sent: [], gone: false, alive: () => !w.gone, send: (channel, payload) => { w.sent.push({ channel, payload }) } }
  return w
}
const events = (w: Win): GenioEvent[] => w.sent.filter((s) => s.channel === 'genio:event').map((s) => s.payload as GenioEvent)

let hub: Win, one: Win, two: Win, router: EventRouter, snapshots: number
beforeEach(() => {
  vi.useFakeTimers()
  hub = win(); one = win({ project: 'one', wksp: 'ally-one' }); two = win({ project: 'two', wksp: 'ally-two' })
  snapshots = 0
  router = createEventRouter({ snapshot: () => { snapshots++; return snapshot }, terminal: (id) => terminals[id], windows: () => [hub, one, two] })
})
afterEach(() => { router.stop(); vi.useRealTimers() })

describe('chat streaming', () => {
  it('delivers a tip only to its focused project window, never the Hub', () => {
    const tip: GenioEvent = { type: 'tip', project: 'one', tip: { id: 'plans', line: 'Plan work.', question: 'How do plans work?' } }
    hub.focused = () => true; two.focused = () => true
    router.publish(tip)
    expect(events(hub)).toEqual([]); expect(events(one)).toEqual([]); expect(events(two)).toEqual([])
    one.focused = () => true
    router.publish(tip)
    expect(events(one)).toEqual([tip]); expect(events(hub)).toEqual([]); expect(events(two)).toEqual([])
    router.publish({ type: 'player-active', project: 'one' })
    router.publish({ type: 'unit-copy', project: 'one', ms: 61_000 })
    router.publish({ type: 'stats-award', event: 'merge', project: 'one' })
    expect(events(one)).toEqual([tip])
  })
  it('coalesces deltas per message, flushes them on a timer, and keeps them off the Hub', () => {
    for (let i = 0; i < 500; i++) router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm1', text: `${i} ` })
    router.publish({ type: 'chat-delta', wksp: 'ally-two', id: 'm2', text: 'two' })
    expect(one.sent).toHaveLength(0)
    vi.advanceTimersByTime(DELTA_FLUSH_MS)
    expect(events(one)).toEqual([{ type: 'chat-delta', wksp: 'ally-one', id: 'm1', text: Array.from({ length: 500 }, (_, i) => `${i} `).join('') }])
    expect(events(two)).toEqual([{ type: 'chat-delta', wksp: 'ally-two', id: 'm2', text: 'two' }])
    expect(hub.sent).toHaveLength(0)
    expect(snapshots).toBe(0)
  })

  it('never lets a later event overtake the deltas that preceded it', () => {
    router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm1', text: 'hello ' })
    router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm1', text: 'world' })
    const final = { type: 'chat', message: { id: 'm1', wksp: 'ally-one', role: 'genio', text: 'hello world', ts: 'now' } } as GenioEvent
    router.publish(final)
    expect(events(one).map((e) => e.type)).toEqual(['chat-delta', 'chat'])
    expect(events(one)[0]).toMatchObject({ text: 'hello world' })
    router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm2', text: 'next' })
    router.publish({ type: 'wksp', wksp: { name: 'ally-one', displayName: 'Genio', activity: 'idle', costUsd: 0, turns: 0, queued: 0 } })
    expect(events(one).map((e) => e.type)).toEqual(['chat-delta', 'chat', 'chat-delta', 'wksp'])
    vi.advanceTimersByTime(DELTA_FLUSH_MS)
    expect(events(one)).toHaveLength(4)
  })

  it('streams at a bounded rate: a token every millisecond becomes one event per flush window', () => {
    for (let i = 0; i < 400; i++) {
      router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm1', text: 'x' })
      vi.advanceTimersByTime(1)
    }
    vi.advanceTimersByTime(DELTA_FLUSH_MS)
    expect(events(one).length).toBeLessThanOrEqual(400 / DELTA_FLUSH_MS + 1)
    expect(events(one).map((e) => (e as { text: string }).text).join('')).toBe('x'.repeat(400))
  })
})

describe('snapshot work per event', () => {
  it('builds the fleet snapshot at most once per event, and only for events that route by it', () => {
    router.publish({ type: 'wksp', wksp: { name: 'ally-one', displayName: 'Genio', activity: 'tool', costUsd: 0, turns: 0, queued: 0 } })
    router.publish({ type: 'settings', settings: {} as never })
    router.publish({ type: 'chat', message: { id: 'm', wksp: 'ally-two', role: 'genio', text: '', ts: 'now' } })
    expect(snapshots).toBe(0)
    router.publish({ type: 'status', event: { taskId: 'task-two', ts: 'now', raw: 'working: x', kind: 'working', text: 'x', fields: {}, playerRelevant: false } })
    expect(snapshots).toBe(1)
    expect(events(two).map((e) => e.type)).toEqual(['settings', 'chat', 'status'])
    expect(events(one).map((e) => e.type)).toEqual(['wksp', 'settings'])
    expect(events(hub).map((e) => e.type)).toEqual(['wksp', 'settings', 'status'])
  })

  it('routes 5000 activity pings and 5000 deltas without a snapshot and well under a second', () => {
    const t0 = performance.now()
    for (let i = 0; i < 5000; i++) {
      router.publish({ type: 'wksp', wksp: { name: 'ally-one', displayName: 'Genio', activity: i % 2 ? 'tool' : 'thinking', costUsd: 0, turns: 0, queued: 0 } })
      router.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'm', text: 'y' })
    }
    router.flush()
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(snapshots).toBe(0)
    expect(events(one).filter((e) => e.type === 'chat-delta')).toHaveLength(5000)
    expect(hub.sent).toHaveLength(5000)
  })
})

describe('terminal output', () => {
  it('batches chunks per flush, resolves ownership once, and sends nothing to the Hub', () => {
    for (let round = 0; round < 3; round++) for (const id of ['term-one', 'term-two']) router.terminalData(id, `${id} ${round}\n`)
    expect(one.sent).toHaveLength(0)
    vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    expect(snapshots).toBe(1)
    expect(one.sent).toEqual([{ channel: TERM_CHANNEL, payload: [{ id: 'term-one', data: 'term-one 0\nterm-one 1\nterm-one 2\n', at: expect.any(String) }] }])
    expect(two.sent).toEqual([{ channel: TERM_CHANNEL, payload: [{ id: 'term-two', data: 'term-two 0\nterm-two 1\nterm-two 2\n', at: expect.any(String) }] }])
    expect(hub.sent).toHaveLength(0)
  })

  it('resolves each terminal’s owner once, not on every flush, and keeps routing it to its window', () => {
    for (let round = 0; round < 50; round++) {
      for (const id of ['term-one', 'term-two']) router.terminalData(id, `${id} ${round}\n`)
      vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    }
    expect(snapshots).toBe(1)
    expect(one.sent).toHaveLength(50)
    expect(one.sent.every((s) => (s.payload as { id: string }[]).every((c) => c.id === 'term-one'))).toBe(true)
    expect(two.sent.every((s) => (s.payload as { id: string }[]).every((c) => c.id === 'term-two'))).toBe(true)
    // A pane terminal names its project: no snapshot at all.
    terminals['pane-x'] = { id: 'pane-x', title: 'pane', cwd: '/elsewhere', alive: true, cols: 80, rows: 24, kind: 'pane', project: 'two' }
    router.terminalData('pane-x', 'ls\n')
    vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    expect(snapshots).toBe(1)
    expect(two.sent.at(-1)).toEqual({ channel: TERM_CHANNEL, payload: [{ id: 'pane-x', data: 'ls\n', at: expect.any(String) }] })
    delete terminals['pane-x']
  })

  it('looks an unknown owner up again on the terminal’s next event', () => {
    terminals['term-new'] = { id: 'term-new', taskId: 'task-new', title: 'new', cwd: '/nowhere', alive: true, cols: 80, rows: 24, kind: 'worker' }
    router.terminalData('term-new', 'early\n')
    vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    expect(one.sent).toHaveLength(0)
    tasks.push({ id: 'task-new', project: 'one', terminalId: 'term-new' })
    router.publish({ type: 'terminal', terminal: terminals['term-new'] })
    router.terminalData('term-new', 'later\n')
    vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    expect(one.sent.at(-1)).toEqual({ channel: TERM_CHANNEL, payload: [{ id: 'term-new', data: 'later\n', at: expect.any(String) }] })
    tasks.pop(); delete terminals['term-new']
  })

  it('remembers a removed terminal’s owner for the chunks still in the batch and skips dead windows', () => {
    router.publish({ type: 'terminal', terminal: terminals['term-one'] })
    expect(snapshots).toBe(1)
    router.terminalData('term-one', 'bye\n')
    delete (terminals as Record<string, TerminalInfo | undefined>)['term-one']
    router.publish({ type: 'terminal-removed', id: 'term-one' })
    two.gone = true
    vi.advanceTimersByTime(TERMINAL_FLUSH_MS)
    expect(one.sent.map((s) => s.channel)).toEqual(['genio:event', 'genio:event', TERM_CHANNEL])
    expect(two.sent).toHaveLength(0)
    terminals['term-one'] = { id: 'term-one', taskId: 'task-one', title: 'one', cwd: '/games/one/wt', alive: true, cols: 80, rows: 24, kind: 'worker' }
  })
})
