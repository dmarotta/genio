import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, GenioEvent } from '@shared/types'

/** A stand-in for the SDK's streaming query: the test writes what the model says and ends turns. */
const fake = vi.hoisted(() => {
  class FakeQuery {
    received: string[] = []
    private out: unknown[] = []
    private wake?: () => void
    private done = false
    constructor(prompt: AsyncIterable<{ message: { content: unknown } }>) {
      void this.pull(prompt)
    }
    private async pull(prompt: AsyncIterable<{ message: { content: unknown } }>): Promise<void> {
      for await (const m of prompt) {
        const c = m.message.content
        this.received.push(typeof c === 'string' ? c : (c as { type: string; text?: string }[]).filter(b => b.type === 'text').map(b => b.text).join(''))
        this.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' })
      }
    }
    emit(m: unknown): void {
      this.out.push(m)
      const w = this.wake
      this.wake = undefined
      w?.()
    }
    /** the model streams a reply in chunks, then the SDK delivers the whole message */
    say(id: string, chunks: string[], blocks?: unknown[]): void {
      this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } })
      for (const text of chunks) this.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
      this.emit({ type: 'assistant', parent_tool_use_id: null, message: { id, content: blocks ?? [{ type: 'text', text: chunks.join('') }] } })
    }
    finishTurn(): void {
      this.emit({ type: 'result', total_cost_usd: 0 })
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (this.out.length) yield this.out.shift()
        if (this.done) return
        await new Promise<void>(r => (this.wake = r))
      }
    }
    async interrupt(): Promise<void> {}
    async setModel(): Promise<void> {}
    async applyFlagSettings(): Promise<void> {}
    close(): void {
      this.done = true
      const w = this.wake
      this.wake = undefined
      w?.()
    }
  }
  const queries: FakeQuery[] = []
  /** the hooks Genio's tools were built with (escalate among them) */
  const hooks: { escalate?: (text: string, severity: string) => void } = {}
  return { queries, hooks, FakeQuery }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<never> }) => {
    const q = new fake.FakeQuery(prompt)
    fake.queries.push(q)
    return q
  },
  tool: () => ({}),
  createSdkMcpServer: () => ({})
}))
vi.mock('../src/main/wksp-tools', () => ({ buildTools: (_tool: unknown, _ctx: unknown, _home: unknown, _role: unknown, hooks: typeof fake.hooks) => { Object.assign(fake.hooks, hooks); return [] } }))

const { Home } = await import('../src/main/home')
const { createWkspService } = await import('../src/main/wksp')
const { bus } = await import('../src/main/bus')
const { createWakeService } = await import('../src/main/wakes')

const NOOP = 'All clear, Alex.'
let dir: string
let cleanup: (() => void)[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-quiet-turns-'))
  fake.queries.length = 0
})
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = {
  settings: { get: () => ({ gamertag: 'Alex', voice: true, chatShellMode: 'ask', wkspModel: '', wkspEffort: '', botModel: '' }) },
  allies: { list: () => [] },
  projects: { list: () => [] },
  memory: { read: () => '' },
  inventory: { thumbnail: vi.fn(async (): Promise<string | undefined> => undefined) },
  stats: { unlock: vi.fn(), addCost: () => undefined, award: () => undefined },
  away: { state: () => ({ mode: 'online' }), capture: vi.fn() },
  notifier: { notify: vi.fn(), sfx: vi.fn() },
  home: (() => undefined) as unknown as () => unknown,
  main: { home: { data: '' } }
}

/** A project chat base with its own session, the wake queue it reads, and what a renderer would have received. */
function chat(name: string, beforeStart?: (home: InstanceType<typeof Home>) => void) {
  const root = path.join(dir, 'workspaces', name)
  const home = new Home(root, name, new Home(dir))
  home.ensure()
  beforeStart?.(home)
  ctx.main.home.data = path.join(dir, 'data')
  const wakes = createWakeService(() => ctx as never, home)
  const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] }, home } as never)
  const svc = createWkspService(() => ctx as never, home)
  const seen: GenioEvent[] = []
  const off = bus.onEvent((ev: GenioEvent) => {
    if (ev.type === 'sfx' || ev.type === 'speak' || ('wksp' in ev && ev.wksp === name) || (ev.type === 'chat' && ev.message.wksp === name)) seen.push(ev)
  })
  cleanup.push(off, () => homeRead.mockRestore(), () => void svc.stop())
  const rows = (): ChatMessage[] => svc.history(300)
  /** the chat events a renderer would draw: streamed text and messages (not the status line) */
  const drawn = (): GenioEvent[] => seen.filter(ev => ev.type === 'chat' || ev.type === 'chat-delta')
  const sounds = (): string[] => seen.flatMap(ev => ev.type === 'sfx' ? [ev.sound] : ev.type === 'speak' ? [`speak:${ev.text}`] : [])
  /** one events batch delivered and read by the session */
  const eventTurn = async (reason = 'unit finished'): Promise<InstanceType<typeof fake.FakeQuery>> => {
    wakes.enqueue({ kind: 'signal', reason, routine: false })
    svc.deliverWakes()
    await vi.waitFor(() => expect(fake.queries[0]?.received.some(r => r.includes(reason))).toBe(true))
    return fake.queries[0]
  }
  return { home, svc, wakes, rows, drawn, sounds, eventTurn }
}

describe('an event turn with nothing for the player', () => {
  it.each([
    ['the sentence', NOOP], ['lower case, no stop', 'all clear, alex'], ['quoted', `"${NOOP}"`], ['emphasised', `**${NOOP}**`],
    ['the Bot form', 'All clear.'], ['a trailing newline', `${NOOP}\n`], ['the CLI placeholder', '(no content)']
  ])('leaves no bubble, row, sound or voice: %s', async (_, text) => {
    const c = chat('noop')
    const q = await c.eventTurn()
    q.say('a1', text.split(/(?<=[ ,])/))
    q.finishTurn()
    await vi.waitFor(() => expect(c.wakes.pending()).toEqual([]))
    await vi.waitFor(() => expect(c.svc.info().activity).toBe('idle'))
    expect(c.drawn()).toEqual([])
    expect(c.rows()).toEqual([])
    expect(c.sounds()).toEqual([])
    expect(fs.existsSync(c.home.chatFile) ? fs.readFileSync(c.home.chatFile, 'utf8') : '').not.toMatch(/all clear|no content/i)
  })

  it('leaves no bubble when the turn says nothing, or only thinks', async () => {
    const c = chat('empty')
    const q = await c.eventTurn()
    q.say('t1', [], [{ type: 'thinking', thinking: 'nothing changed' }])
    q.say('t2', [''], [{ type: 'text', text: '  ' }])
    q.finishTurn()
    await vi.waitFor(() => expect(c.wakes.pending()).toEqual([]))
    await vi.waitFor(() => expect(c.svc.info().activity).toBe('idle'))
    expect(c.drawn()).toEqual([])
    expect(c.rows()).toEqual([])
    expect(c.sounds()).toEqual([])
    expect(c.svc.info().lastError).toBeUndefined()
    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0].received).toHaveLength(1) // not retried
  })

  it('does not clear a queued player message, which is read next; its reply is shown even when it is the sentence', async () => {
    const c = chat('queued')
    const q = await c.eventTurn()
    await c.svc.send('player during events')
    expect(c.rows().find(m => m.text === 'player during events')?.queue).toBe('queued')
    q.say('a1', [NOOP])
    q.finishTurn()
    await vi.waitFor(() => expect(q.received).toHaveLength(2))
    expect(q.received[1]).toBe('player during events')
    expect(c.rows().filter(m => m.text === 'player during events')).toHaveLength(1)
    expect(c.rows().find(m => m.text === 'player during events')?.queue).toBeUndefined()
    expect(c.rows().filter(m => m.role !== 'player')).toEqual([])
    // the player's turn replies with the same words: that is an answer, so it shows
    q.say('a2', [NOOP])
    q.finishTurn()
    await vi.waitFor(() => expect(c.rows().filter(m => m.role === 'genio')).toHaveLength(1))
    expect(c.rows().at(-1)).toMatchObject({ role: 'genio', text: NOOP })
    expect(c.sounds()).toContain('blip')
    await vi.waitFor(() => expect(c.svc.info().activity).toBe('idle'))
    expect(c.svc.info().queued).toBe(0)
  })

  it('shows a real reply live, in the log, with sound and voice, however short', async () => {
    const c = chat('real')
    const q = await c.eventTurn()
    q.say('a1', ['Done', '.'])
    q.finishTurn()
    await vi.waitFor(() => expect(c.rows().map(m => m.text)).toEqual(['Done.']))
    expect(c.drawn().filter(ev => ev.type === 'chat-delta').map(ev => (ev as { text: string }).text).join('')).toBe('Done.')
    expect(c.rows()[0]).toMatchObject({ role: 'genio', text: 'Done.' })
    expect(c.sounds()).toEqual(['blip', 'speak:Done.'])
  })

  it('shows a message that only starts like the sentence, streamed in full', async () => {
    const c = chat('prefix')
    const q = await c.eventTurn()
    const text = `${NOOP} Unit 3 is ready: https://example.com/pr/3`
    q.say('a1', ['All clear', ', Alex.', ' Unit 3', ' is ready: https://example.com/pr/3'])
    q.finishTurn()
    await vi.waitFor(() => expect(c.rows().map(m => m.text)).toEqual([text]))
    expect(c.drawn().filter(ev => ev.type === 'chat-delta').map(ev => (ev as { text: string }).text).join('')).toBe(text)
  })

  it('keeps a tool trace but not the sentence beside it', async () => {
    const c = chat('tools')
    const q = await c.eventTurn()
    q.say('a1', [NOOP], [{ type: 'text', text: NOOP }, { type: 'tool_use', id: 'tu1', name: 'mcp__genio__events_ack', input: { seqs: [1] } }])
    q.finishTurn()
    await vi.waitFor(() => expect(c.rows()).toHaveLength(1))
    expect(c.rows()[0]).toMatchObject({ role: 'genio', text: '', tools: [{ id: 'tu1' }] })
  })

  it('a thinking-only message leaves no empty bubble on a player turn either', async () => {
    const c = chat('thinking')
    await c.svc.send('how is it going?')
    await vi.waitFor(() => expect(fake.queries[0]?.received).toHaveLength(1))
    fake.queries[0].say('t1', [], [{ type: 'thinking', thinking: 'let me look' }])
    fake.queries[0].say('a1', ['Fine.'])
    fake.queries[0].finishTurn()
    await vi.waitFor(() => expect(c.rows().map(m => m.text)).toEqual(['how is it going?', 'Fine.']))
    expect(c.drawn().filter(ev => ev.type === 'chat' && ev.message.role === 'genio').map(ev => (ev as { message: ChatMessage }).message.text)).not.toContain('')
  })

  it('never sends the sentence to notifications, even through the Bot\'s escalation tool', async () => {
    const c = chat('escalate')
    await c.eventTurn()
    for (const text of [NOOP, 'All clear.', '"all clear, alex!"', '(no content)']) fake.hooks.escalate!(text, 'info')
    expect(ctx.notifier.notify).not.toHaveBeenCalled()
    expect(c.rows()).toEqual([])
    fake.hooks.escalate!('Unit 3 is ready: https://example.com/pr/3', 'ready')
    expect(ctx.notifier.notify).toHaveBeenCalledOnce()
    expect(c.rows().map(m => m.text)).toEqual(['Bot: Unit 3 is ready: https://example.com/pr/3'])
  })

  it('a player message with the same words is shown', async () => {
    const c = chat('player-words')
    await c.svc.send(NOOP)
    await vi.waitFor(() => expect(fake.queries[0]?.received).toEqual([NOOP]))
    fake.queries[0].say('a1', ['Noted.'])
    fake.queries[0].finishTurn()
    await vi.waitFor(() => expect(c.rows().map(m => [m.role, m.text])).toEqual([['player', NOOP], ['genio', 'Noted.']]))
  })
})

describe('a log written before event turns went quiet', () => {
  it('hides the sentence rows of event turns on load, and keeps answers, real messages and the player\'s own words', () => {
    const at = (n: number): string => `2026-10-17T09:00:${String(n).padStart(2, '0')}.000Z`
    const row = (id: string, role: string, text: string, n: number) => JSON.stringify({ id, wksp: 'legacy', role, text, ts: at(n) })
    const c = chat('legacy', home => fs.writeFileSync(home.chatFile, [
      row('p1', 'player', 'anything new?', 1), row('g1', 'genio', NOOP, 2),
      row('g2', 'genio', NOOP, 3), row('s1', 'system', NOOP, 4), row('g3', 'genio', 'all clear, alex!', 5),
      row('g4', 'genio', 'Unit 3 is ready: https://example.com/pr/3', 6),
      row('p2', 'player', NOOP, 7), row('g5', 'genio', 'Done.', 8), row('g6', 'genio', NOOP, 9)
    ].join('\n') + '\n'))
    expect(c.rows().map(m => m.id)).toEqual(['p1', 'g1', 'g4', 'p2', 'g5'])
    expect(c.svc.history(2).map(m => m.id)).toEqual(['p2', 'g5'])
  })
})
