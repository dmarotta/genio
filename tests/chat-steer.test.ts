import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, GenioEvent } from '@shared/types'
import { applyChatEvent, splitQueued } from '@shared/chat'
import type { ChatDriver, ChatDriverEvents, ChatTurn } from '../src/main/chat-driver'

/** A stand-in for the SDK's streaming query: records each turn's prompt; the test ends turns and runs tools. */
const fake = vi.hoisted(() => {
  type Msg = { message: { content: string | { type: string; text?: string }[] } }
  class FakeQuery {
    received: string[] = []
    interrupts = 0
    private out: unknown[] = []
    private wake?: () => void
    private done = false
    constructor(prompt: AsyncIterable<Msg>, readonly options: { canUseTool?: (name: string, input: unknown) => Promise<{ behavior: string }> }) {
      void this.pull(prompt)
    }
    private async pull(prompt: AsyncIterable<Msg>): Promise<void> {
      for await (const m of prompt) {
        const c = m.message.content
        this.received.push(typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join(''))
        this.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' })
      }
    }
    emit(m: unknown): void {
      this.out.push(m)
      const w = this.wake
      this.wake = undefined
      w?.()
    }
    finishTurn(): void { this.emit({ type: 'result', total_cost_usd: 0 }) }
    say(id: string, text: string): void { this.emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } }) }
    startTool(id: string, toolId: string, name = 'mcp__genio__deploy', input: unknown = {}): void {
      this.emit({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id: toolId, name, input }] } })
    }
    toolDone(toolId: string): void {
      this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'deployed' }] } })
    }
    /** what the CLI does on interrupt: the turn ends with an error result */
    async interrupt(): Promise<void> {
      this.interrupts++
      if (this.autoStop) this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0 })
    }
    autoStop = true
    async setModel(): Promise<void> {}
    async applyFlagSettings(): Promise<void> {}
    close(): void {
      this.done = true
      const w = this.wake
      this.wake = undefined
      w?.()
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (this.out.length) yield this.out.shift()
        if (this.done) return
        await new Promise<void>((r) => (this.wake = r))
      }
    }
  }
  const queries: FakeQuery[] = []
  const hooks: { action?: (kind: string, id: string) => void }[] = []
  return { queries, hooks, FakeQuery }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: never }) => {
    const q = new fake.FakeQuery(prompt, options)
    fake.queries.push(q)
    return q
  },
  tool: () => ({}),
  createSdkMcpServer: () => ({})
}))
vi.mock('../src/main/wksp-tools', () => ({ buildTools: (_t: unknown, _g: unknown, _h: unknown, _role: unknown, hooks: { action?: () => void }) => { fake.hooks.push(hooks); return [] } }))
vi.mock('../src/main/chat-tool-policy', async (actual) => ({ ...(await actual<object>()), DISALLOWED: [], enforceTool: async () => ({ behavior: 'allow' }) }))
vi.mock('../src/main/chat-tool-bridge', () => ({
  openChatToolBridge: async () => ({ entry: 'bridge.js', env: {}, close: async () => {} }), closeChatToolBridges: async () => {}
}))

const { Home } = await import('../src/main/home')
const { createWkspService, startedText } = await import('../src/main/wksp')
const { bus } = await import('../src/main/bus')
const { createWakeService } = await import('../src/main/wakes')
const { ProviderChatSession } = await import('../src/main/provider-chat-session')

let dir: string
let cleanup: (() => void)[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-steer-'))
  fake.queries.length = 0
  fake.hooks.length = 0
})
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = {
  settings: { get: () => ({ gamertag: 'Alex', chatShellMode: 'ask', wkspModel: '', wkspEffort: '', botModel: '' }) },
  allies: { list: () => [] },
  projects: { list: () => [] },
  memory: { read: () => '' },
  permissions: {},
  inventory: { thumbnail: async (): Promise<string | undefined> => undefined },
  stats: { unlock: () => undefined, addCost: () => undefined, award: () => undefined },
  away: { state: () => ({ mode: 'online' }) } as { state: () => { mode: string }; set?: (m: string) => Promise<void>; takeReturnBrief?: () => string },
  home: () => ({ wakes: { pending: () => [], drain: () => ({ text: '', ackThrough: -1, count: 0 }), ack: () => undefined }, crew: { list: () => [] }, decisions: { list: () => [] } }),
  main: { home: { data: '' } }
}

function chat(name = 'art') {
  const home = new Home(path.join(dir, 'wksps', name), name, new Home(dir))
  ctx.main.home.data = path.join(dir, 'data')
  const svc = createWkspService(() => ctx as never, home)
  let shown: ChatMessage[] = []
  const off = bus.onEvent((ev: GenioEvent) => {
    if (ev.type === 'chat' && ev.message.wksp === name) shown = applyChatEvent(shown, ev.message)
  })
  cleanup.push(off, () => void svc.stop())
  return { home, svc, view: () => splitQueued(shown) }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve() }
const q = (i = 0) => fake.queries[i]
const received = (n: number, i = 0): Promise<void> => vi.waitFor(() => expect(q(i)?.received.length).toBe(n))

describe('steering the visible turn', () => {
  it('interrupts the turn in progress and delivers the steering message first; queued messages keep their order', async () => {
    const c = chat()
    await c.svc.send('build the castle')
    await received(1)
    expect(c.svc.info().steerable).toBe(true)
    q().say('a1', 'Planning the castle…')
    await c.svc.send('then the moat')
    await c.svc.send('and a bridge')
    await c.svc.steer('stop, use stone not wood')
    await received(2)
    expect(q().interrupts).toBe(1)
    expect(q().received[1]).toContain('stop, use stone not wood')
    expect(q().received[1]).toContain('Your previous turn was interrupted by Alex')
    expect(c.view().queued.map(m => m.text)).toEqual(['then the moat', 'and a bridge'])
    // the interrupted turn stays in the transcript, followed by the note; no error is shown
    const log = c.view().log.map(m => [m.role, m.text])
    expect(log).toEqual([['player', 'build the castle'], ['genio', 'Planning the castle…'], ['system', 'Interrupted by your message.'], ['player', 'stop, use stone not wood']])
    expect(c.svc.history().some(m => m.role === 'error')).toBe(false)
    q().finishTurn()
    await received(3)
    expect(q().received[2]).toBe('then the moat')
    q().finishTurn()
    await received(4)
    expect(q().received[3]).toBe('and a bridge')
    expect(q().received.filter(t => t.includes('stop, use stone'))).toHaveLength(1)
  })

  it('lets a running tool call finish before interrupting, and starts no new tool meanwhile', async () => {
    const c = chat()
    await c.svc.send('deploy a unit')
    await received(1)
    q().startTool('a1', 'tool-1')
    await flush()
    fake.hooks[0].action?.('units', 'castle-unit')
    await c.svc.steer('wait, not that one')
    await flush()
    expect(q().interrupts).toBe(0)
    expect(await q().options.canUseTool!('mcp__genio__file_quest', {})).toMatchObject({ behavior: 'deny' })
    q().toolDone('tool-1')
    await received(2)
    expect(q().interrupts).toBe(1)
    // the interrupted message carries what the turn had started; the note and the next turn's context name it
    expect(c.svc.history().find(m => m.id === 'm-a1')?.actions).toEqual({ units: ['castle-unit'] })
    expect(c.svc.history().find(m => m.role === 'system')?.text).toBe('Interrupted by your message. It had started: units castle-unit.')
    expect(q().received[1]).toMatch(/^\[GENIO NOTE\] Your previous turn was interrupted by Alex; it had started: units castle-unit; verify state \(unit_state, quests\) before continuing\.\n\nwait, not that one$/)
    // tools run normally again in the steering turn
    expect(await q().options.canUseTool!('mcp__genio__file_quest', {})).toMatchObject({ behavior: 'allow' })
    q().finishTurn()
    await flush()
    expect(c.svc.info().steerable).toBe(false)
  })

  it('Send now moves a queued message to the front and steers the same way; the rest keep order', async () => {
    const c = chat()
    await c.svc.send('first')
    await received(1)
    await c.svc.send('a')
    await c.svc.send('b')
    await c.svc.send('c')
    const b = c.svc.history().find(m => m.text === 'b')!
    expect(c.svc.sendNow(b.id)).toEqual({ ok: true })
    await received(2)
    expect(q().interrupts).toBe(1)
    expect(q().received[1]).toContain('\n\nb')
    expect(c.view().queued.map(m => m.text)).toEqual(['a', 'c'])
    // already picked up: nothing to send now
    expect(c.svc.sendNow(b.id)).toEqual({ ok: false, reason: 'Genio picked that message up already.' })
    q().finishTurn()
    await received(3)
    q().finishTurn()
    await received(4)
    expect(q().received.slice(2)).toEqual(['a', 'c'])
  })

  it('a repeated steer or Send now never sends a message twice', async () => {
    const c = chat()
    await c.svc.send('first')
    await received(1)
    q().autoStop = false
    await c.svc.send('x')
    const x = c.svc.history().find(m => m.text === 'x')!
    expect(c.svc.sendNow(x.id)).toMatchObject({ ok: true })
    expect(c.svc.sendNow(x.id)).toMatchObject({ ok: true })
    await flush()
    expect(q().interrupts).toBe(1)
    q().finishTurn()
    await received(2)
    q().finishTurn()
    await flush()
    expect(q().received.filter(t => t.endsWith('x'))).toHaveLength(1)
    expect(c.svc.history().filter(m => m.text === 'x')).toHaveLength(1)
  })

  it('Send now during a running action says what it waits for and shows the message as steering until it is read', async () => {
    const c = chat()
    await c.svc.send('deploy a unit')
    await received(1)
    q().startTool('a1', 'tool-1')
    await flush()
    await c.svc.send('wait, not that one')
    const x = c.svc.history().find(m => m.text === 'wait, not that one')!
    // the turn is inside a deploy: it cannot stop yet, and the player is told so instead of nothing happening
    expect(c.svc.sendNow(x.id)).toEqual({ ok: true, note: 'Genio stops as soon as deploy finishes (a running action is never cut in half), then reads it first.' })
    await flush()
    expect(q().interrupts).toBe(0)
    expect(c.view().queued).toMatchObject([{ id: x.id, queue: 'queued', steering: true }])
    q().toolDone('tool-1')
    await received(2)
    expect(q().interrupts).toBe(1)
    expect(q().received[1]).toContain('wait, not that one')
    // read: no longer queued, and the steering mark went with the queue state
    expect(c.view().queued).toEqual([])
    const sent = c.view().log.find(m => m.id === x.id)!
    expect(sent.queue).toBeUndefined()
    expect(sent.steering).toBeUndefined()
  })

  it('Send now cuts a read-only wait at once instead of sitting it out', async () => {
    const c = chat()
    await c.svc.send('check on the unit')
    await received(1)
    q().startTool('a1', 'tool-1', 'PowerShell', { command: "Start-Sleep 75; $d='C:\\Users\\alex\\data'; Get-ChildItem $d -Recurse -File | Select-Object -ExpandProperty FullName" })
    await flush()
    await c.svc.send('now it does')
    const x = c.svc.history().find(m => m.text === 'now it does')!
    expect(c.svc.sendNow(x.id)).toEqual({ ok: true })
    await received(2)
    expect(q().interrupts).toBe(1)
    expect(q().received[1]).toContain('now it does')
  })

  it('a stale queued record (no turn waits for it) is shown as not sent, with the reason, never left queued', async () => {
    const c = chat()
    await c.svc.send('first')
    await received(1)
    const lost: ChatMessage = { id: 'p-lost', wksp: 'art', role: 'player', text: 'lost message', ts: new Date().toISOString(), queue: 'queued' }
    c.svc.post(lost, true)
    expect(c.view().queued.map(m => m.id)).toEqual(['p-lost'])
    expect(c.svc.sendNow('p-lost')).toEqual({ ok: false, reason: 'That message was no longer waiting in the session, so it is marked Not sent. Edit it to send it again.' })
    expect(c.view().queued).toEqual([])
    expect(c.svc.history().find(m => m.id === 'p-lost')?.queue).toBe('unsent')
    // still on record that way after a restart
    const reloaded = createWkspService(() => ctx as never, c.home)
    cleanup.push(() => void reloaded.stop())
    expect(reloaded.history().find(m => m.id === 'p-lost')?.queue).toBe('unsent')
    expect(q().interrupts).toBe(0)
  })

  it('a message the running turn already read but still recorded as queued turns sent', async () => {
    const c = chat()
    await c.svc.send('read me')
    await received(1)
    const m = c.svc.history().find(x => x.text === 'read me')!
    expect(m.queue).toBeUndefined()
    c.svc.post({ ...m, queue: 'queued' }, true)
    expect(c.svc.sendNow(m.id)).toEqual({ ok: false, reason: 'Genio is already reading that message.' })
    expect(c.view().queued).toEqual([])
    expect(c.svc.history().find(x => x.id === m.id)?.queue).toBeUndefined()
    expect(q().interrupts).toBe(0)
  })

  it('Send now on a message the screen still shows queued re-sends its real state', async () => {
    const c = chat()
    await c.svc.send('already read')
    await received(1)
    const m = c.svc.history().find(x => x.text === 'already read')!
    const seen: ChatMessage[] = []
    const off = bus.onEvent((ev: GenioEvent) => { if (ev.type === 'chat') seen.push(ev.message) })
    cleanup.push(off)
    expect(c.svc.sendNow(m.id)).toEqual({ ok: false, reason: 'Genio picked that message up already.' })
    expect(seen).toEqual([m])
  })

  it('steers an event turn without dropping its events or one arriving meanwhile', async () => {
    vi.useFakeTimers()
    const c = chat('events')
    const wakes = createWakeService(() => ctx as never, c.home)
    const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
    try {
      wakes.enqueue({ kind: 'signal', reason: 'unit ready to land' })
      c.svc.deliverWakes()
      await flush()
      expect(q().received[0]).toContain('unit ready to land')
      expect(c.svc.info().steerable).toBe(true)
      await c.svc.steer('hold the merge')
      wakes.enqueue({ kind: 'signal', reason: 'second unit failed' })
      c.svc.deliverWakes()
      await flush()
      expect(q().interrupts).toBe(1)
      expect(q().received[1]).toContain('hold the merge')
      expect(wakes.pending().map(w => w.reason)).toEqual(['unit ready to land', 'second unit failed'])
      q().finishTurn()
      await vi.advanceTimersByTimeAsync(300)
      await flush()
      // delivered again right after the player's turn, not after a failure backoff
      expect(q().received[2]).toContain('unit ready to land')
      expect(q().received[2]).toContain('second unit failed')
      q().finishTurn()
      await flush()
      expect(wakes.pending()).toHaveLength(0)
    } finally { homeRead.mockRestore() }
  })

  it('steers the startup greeting turn', async () => {
    vi.useFakeTimers()
    const c = chat('opening')
    c.svc.prepareProjectOpen()
    c.svc.wakeProject('Reconciled')
    await flush()
    expect(q().received[0]).toContain('[GENIO PROJECT OPEN]')
    expect(c.svc.info().steerable).toBe(true)
    await c.svc.steer('skip the recap')
    await flush()
    expect(q().interrupts).toBe(1)
    expect(q().received[1]).toContain('skip the recap')
  })

  it('an interrupt the query never answers restarts the session instead of holding the message forever', async () => {
    vi.useFakeTimers()
    const c = chat()
    await c.svc.send('first')
    await vi.waitFor(() => expect(q()?.received.length).toBe(1))
    q().autoStop = false
    q().say('a1', 'Halfway')
    await flush()
    await c.svc.steer('are you stuck?')
    await flush()
    expect(q().interrupts).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(2_100)
    await vi.waitFor(() => expect(q(1)?.received.length).toBe(1))
    expect(q(1).received[0]).toContain('are you stuck?')
    expect(c.svc.history().find(m => m.id === 'm-a1')).toMatchObject({ text: 'Halfway', partial: false })
  })

  it('with no turn running, a steer is an ordinary message: no interrupt, no note', async () => {
    const c = chat()
    expect(c.svc.info().steerable).toBe(false)
    await c.svc.steer('hello')
    await received(1)
    expect(q().received).toEqual(['hello'])
    expect(q().interrupts).toBe(0)
    q().finishTurn()
    await flush()
    expect(c.svc.history().some(m => m.role === 'system')).toBe(false)
  })

  it('a turn that completes before the interrupt lands gets no interruption note', async () => {
    const c = chat()
    await c.svc.send('first')
    await received(1)
    q().startTool('a1', 'tool-1')
    await flush()
    await c.svc.steer('next')
    q().toolDone('tool-1')
    q().autoStop = false
    q().finishTurn()
    await received(2)
    expect(q().received[1]).toBe('next')
    expect(c.svc.history().some(m => m.role === 'system')).toBe(false)
  })

  it('never steers the Bot: while its away turn runs, a steer just queues', async () => {
    vi.useFakeTimers()
    const c = chat('afk')
    const wakes = createWakeService(() => ctx as never, c.home)
    const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
    let mode = 'online'
    const away = vi.spyOn(ctx.away, 'state').mockImplementation(() => ({ mode }))
    ctx.away.set = async (m: string) => { mode = m }
    ctx.away.takeReturnBrief = () => ''
    try {
      await c.svc.send('first')
      await flush()
      mode = 'afk'
      wakes.enqueue({ kind: 'signal', reason: 'routine' })
      c.svc.deliverWakes()
      await vi.waitFor(() => expect(q(1)?.received.length).toBe(1))
      const genio = q(0), bot = q(1)
      expect(bot.received[0]).toContain('routine')
      expect(c.svc.info().steerable).toBe(false)
      await c.svc.steer('when you can')
      await flush()
      expect(genio.interrupts + bot.interrupts).toBe(0)
      expect(c.view().queued.map(m => m.text)).toEqual(['when you can'])
    } finally { homeRead.mockRestore(); away.mockRestore(); delete ctx.away.set; delete ctx.away.takeReturnBrief }
  })
})

it('names what an interrupted turn had started', () => {
  expect(startedText({})).toBe('')
  expect(startedText({ units: ['a', 'b'], merges: ['c'], choices: ['d'] })).toBe('units a, b; merges c; choices d')
})

class Driver implements ChatDriver {
  readonly capabilities = { mode: 'driver' as const, guardedTools: true }
  busy = false
  queued = 0
  turns: ChatTurn[] = []
  current?: ChatTurn
  yields = 0
  constructor(readonly events: ChatDriverEvents) {}
  get idle() { return !this.busy }
  async start() {}
  send(t: ChatTurn) { this.current = t; this.turns.push(t); this.busy = true; this.events.onStart?.(t) }
  cancel(): undefined { return undefined }
  hasEventsQueued() { return this.current?.kind === 'events' }
  async interrupt() { this.finish(false) }
  async yieldTurn() { this.yields++; if (this.busy) this.finish(false) }
  resume() {}
  stop() { this.busy = false }
  finish(ok = true) { this.busy = false; const t = this.current; this.current = undefined; this.events.onTurnEnd(t, ok, '', 0) }
}

describe('steering across the provider queue', () => {
  const fixture = () => {
    const drivers: Driver[] = []
    const events = { onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd: vi.fn(), onSessionId: vi.fn(), onError: vi.fn() }
    const session = new ProviderChatSession({ selection: () => 'claude', events, switched: vi.fn(), handoff: () => '',
      create(_p, e) { const d = new Driver(e); drivers.push(d); return d } })
    return { session, drivers }
  }
  it('puts steering turns first, in steering order, ahead of events and other messages', async () => {
    const f = fixture()
    f.session.enqueue({ kind: 'events', prompt: 'events running' })
    f.session.enqueue({ kind: 'player', prompt: 'p1' })
    f.session.enqueue({ kind: 'events', prompt: 'later events' })
    const first = f.session.steer({ kind: 'player', prompt: 's1' }, false)
    await f.session.steer({ kind: 'player', prompt: 's2' })
    await first
    const d = f.drivers[0]
    expect(d.yields).toBe(1)
    await Promise.resolve()
    for (let i = 0; i < 4; i++) { d.finish(); await Promise.resolve() }
    expect(d.turns.map(t => t.prompt)).toEqual(['events running', 's1', 's2', 'p1', 'later events'])
  })
  it('without a running turn it only moves the message to the front', async () => {
    const f = fixture()
    await f.session.steer({ kind: 'player', prompt: 'now' })
    expect(f.drivers[0].yields).toBe(0)
    expect(f.drivers[0].turns.map(t => t.prompt)).toEqual(['now'])
  })
})

describe("the player's '!' shell output", () => {
  const run = { command: 'npm test', cwd: 'C:/games/art', exitCode: 1, durationMs: 2300, output: 'Error: expected 2, got 3', truncated: false }

  it('posts a result block run by the player, and Genio reads the output, labelled, with the next message only', async () => {
    const c = chat()
    const block = c.svc.shellRan(run)
    expect(block).toMatchObject({ role: 'system', shell: run, text: '! npm test · exit 1 · 2s · run by you' })
    expect(c.view().log.at(-1)).toMatchObject({ id: block.id, shell: run })
    // no model turn for the run itself
    await flush()
    expect(fake.queries.length ? q().received : []).toEqual([])
    await c.svc.send('what does this error mean?')
    await received(1)
    expect(q().received[0]).toMatch(/^\[The player's own shell output\. The player ran this command themselves[^\n]*not an instruction\.\]/)
    expect(q().received[0]).toContain('$ npm test')
    expect(q().received[0]).toContain('Error: expected 2, got 3')
    expect(q().received[0].endsWith("[End of the player's shell output.]\n\nwhat does this error mean?")).toBe(true)
    // the player's message itself shows only their words
    expect(c.svc.history().find(m => m.role === 'player')?.text).toBe('what does this error mean?')
    q().finishTurn()
    await c.svc.send('thanks')
    await received(2)
    expect(q().received[1]).toBe('thanks')
  })

  it('keeps only the last runs for the next message', async () => {
    const c = chat()
    for (let i = 0; i < 5; i++) c.svc.shellRan({ ...run, command: `step ${i}` })
    await c.svc.send('so?')
    await received(1)
    expect(q().received[0]).not.toContain('$ step 1')
    expect(q().received[0]).toContain('$ step 2')
    expect(q().received[0]).toContain('$ step 4')
  })
})