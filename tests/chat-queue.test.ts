import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, GenioEvent } from '@shared/types'
import { applyChatEvent, compactChat, splitQueued, strandQueued } from '@shared/chat'

/** A stand-in for the SDK's streaming query: records what each turn received; the test ends turns. */
const fake = vi.hoisted(() => {
  type Msg = { message: { content: string | { type: string; text?: string; source?: { data: string } }[] } }
  class FakeQuery {
    received: string[] = []
    images: string[][] = []
    private out: unknown[] = []
    private wake?: () => void
    private done = false
    constructor(prompt: AsyncIterable<Msg>) {
      void this.pull(prompt)
    }
    private async pull(prompt: AsyncIterable<Msg>): Promise<void> {
      for await (const m of prompt) {
        const c = m.message.content
        this.received.push(typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join(''))
        this.images.push(typeof c === 'string' ? [] : c.filter((b) => b.type === 'image').map((b) => b.source!.data))
        this.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' })
      }
    }
    emit(m: unknown): void {
      this.out.push(m)
      const w = this.wake
      this.wake = undefined
      w?.()
    }
    finishTurn(): void {
      this.emit({ type: 'result', total_cost_usd: 0 })
    }
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        while (this.out.length) yield this.out.shift()
        if (this.done) return
        await new Promise<void>((r) => (this.wake = r))
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
  const resumes: (string | undefined)[] = []
  return { queries, resumes, FakeQuery }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<never>; options: { resume?: string } }) => {
    fake.resumes.push(options.resume)
    const q = new fake.FakeQuery(prompt)
    fake.queries.push(q)
    return q
  },
  tool: () => ({}),
  createSdkMcpServer: () => ({})
}))
vi.mock('../src/main/wksp-tools', () => ({ buildTools: () => [] }))

const { Home } = await import('../src/main/home')
const { createWkspService, AgentSession } = await import('../src/main/wksp')
const { bus } = await import('../src/main/bus')
const { SessionQuotaPolicy, SessionCostLedger } = await import('../src/main/session-usage')
const { createWakeService } = await import('../src/main/wakes')

const PNG = 'iVBORw0KGgo='

let dir: string
let cleanup: (() => void)[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-queue-'))
  fake.queries.length = 0
  fake.resumes.length = 0
})
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = {
  settings: { get: () => ({ gamertag: 'Dani', chatShellMode: 'ask', wkspModel: '', wkspEffort: '', botModel: '' }) },
  allies: { list: () => [] },
  projects: { list: () => [] },
  memory: { read: () => '' },
  inventory: { thumbnail: vi.fn(async (): Promise<string | undefined> => undefined) },
  stats: { unlock: vi.fn(), addCost: () => undefined, award: () => undefined },
  away: { state: () => ({ mode: 'online' }) },
  home: () => ({ wakes: { pending: () => [], drain: () => ({ text: '', ackThrough: -1, count: 0 }), ack: () => undefined }, crew: { list: () => [] }, decisions: { list: () => [] } }),
  main: { home: { data: '' } }
}

/** An ally chat base with its own session, plus the message list a renderer would build from its events. */
function chat(name: string) {
  const root = path.join(dir, 'wksps', name)
  const home = new Home(root, name, new Home(dir))
  ctx.main.home.data = path.join(dir, 'data')
  const svc = createWkspService(() => ctx as never, home)
  let shown: ChatMessage[] = []
  const off = bus.onEvent((ev: GenioEvent) => {
    if (ev.type === 'chat' && ev.message.wksp === name) shown = applyChatEvent(shown, ev.message)
  })
  cleanup.push(off, () => void svc.stop())
  return { home, svc, view: () => splitQueued(shown), shown: () => shown }
}

const byText = (h: ChatMessage[], text: string): ChatMessage | undefined => h.find((m) => m.text === text)
const waitReceived = (q: () => { received: string[] } | undefined, n: number): Promise<void> =>
  vi.waitFor(() => expect(q()?.received.length).toBe(n))

describe('queue state helpers', () => {
  const m = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, wksp: 'main', role: 'player', text: id, ts: `2026-10-13T10:00:0${id.length}Z`, ...extra })

  it('a picked-up message moves to the end once, with no duplicate', () => {
    let list = [m('a'), m('q', { queue: 'queued' }), m('g', { role: 'genio' })]
    expect(splitQueued(list).queued.map((x) => x.id)).toEqual(['q'])
    expect(splitQueued(list).log.map((x) => x.id)).toEqual(['a', 'g'])
    list = applyChatEvent(list, { ...list[1], queue: undefined })
    expect(list.map((x) => x.id)).toEqual(['a', 'g', 'q'])
    expect(splitQueued(list).queued).toEqual([])
  })

  it('a cancelled message leaves the list', () => {
    const list = applyChatEvent([m('a'), m('q', { queue: 'queued' })], m('q', { queue: 'cancelled' }))
    expect(list.map((x) => x.id)).toEqual(['a'])
  })

  it('the disk log keeps the last write of each message and drops cancelled ones', () => {
    const lines = [m('a'), m('q', { queue: 'queued' }), m('x', { queue: 'queued' }), m('g'), m('q'), m('x', { queue: 'cancelled' })]
    expect(compactChat(lines).map((x) => [x.id, x.queue])).toEqual([['a', undefined], ['g', undefined], ['q', undefined]])
  })

  it('after a restart, queued messages become unsent', () => {
    const { list, stranded } = strandQueued([m('a'), m('q', { queue: 'queued' })])
    expect(list.map((x) => x.queue)).toEqual([undefined, 'unsent'])
    expect(stranded.map((x) => x.id)).toEqual(['q'])
  })
})

describe('queued chat messages', () => {
  it('shows messages sent mid-turn as queued, in send order, then sent in place as the session reads them', async () => {
    const c = chat('art')
    await c.svc.send('first')
    await waitReceived(() => fake.queries[0], 1)
    expect(byText(c.svc.history(), 'first')?.queue).toBeUndefined()

    await c.svc.send('second')
    await c.svc.send('third')
    expect(c.svc.history().filter((m) => m.queue === 'queued').map((m) => m.text)).toEqual(['second', 'third'])
    expect(c.view().queued.map((m) => m.text)).toEqual(['second', 'third'])
    expect(c.svc.info().queued).toBe(2)

    fake.queries[0].finishTurn()
    await waitReceived(() => fake.queries[0], 2)
    expect(fake.queries[0].received[1]).toBe('second')
    expect(byText(c.svc.history(), 'second')?.queue).toBeUndefined()
    expect(c.view().queued.map((m) => m.text)).toEqual(['third'])
    const log = c.view().log
    expect(log[log.length - 1].text).toBe('second')
    expect(c.shown().filter((m) => m.text === 'second')).toHaveLength(1)

    fake.queries[0].finishTurn()
    await waitReceived(() => fake.queries[0], 3)
    expect(c.view().queued).toEqual([])
    expect(c.view().log.map((m) => m.text)).toEqual(['first', 'second', 'third'])
  })

  it('cancel takes a message out of the queue; edit hands back its text and images', async () => {
    const c = chat('art')
    await c.svc.send('busy now')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('drop me')
    await c.svc.send('fix me', 'player', [{ mediaType: 'image/png', data: PNG, width: 1, height: 1 }])
    await c.svc.send('keep me')
    const drop = byText(c.svc.history(), 'drop me')!
    const fix = byText(c.svc.history(), 'fix me')!
    expect(fix.images).toHaveLength(1)

    expect(c.svc.unqueue(drop.id)).toEqual({ text: 'drop me' })
    expect(c.svc.unqueue(fix.id)).toEqual({ text: 'fix me', images: [{ mediaType: 'image/png', data: PNG, width: 1, height: 1 }] })
    expect(c.svc.unqueue(fix.id)).toBeNull()
    expect(c.view().queued.map((m) => m.text)).toEqual(['keep me'])
    expect(c.svc.history().map((m) => m.text)).toEqual(['busy now', 'keep me'])
    expect(c.svc.info().queued).toBe(1)

    fake.queries[0].finishTurn()
    await waitReceived(() => fake.queries[0], 2)
    fake.queries[0].finishTurn()
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.queries[0].received).toEqual(['busy now', 'keep me'])
    // once read, a message can no longer be taken back
    expect(c.svc.unqueue(byText(c.svc.history(), 'keep me')!.id)).toBeNull()
    // the cancelled ones stay gone after a reload
    const again = createWkspService(() => ctx as never, c.home)
    expect(again.history().map((m) => m.text)).toEqual(['busy now', 'keep me'])
  })

  it('keeps each chat’s queue to itself', async () => {
    const art = chat('art')
    const audio = chat('audio')
    await art.svc.send('art turn')
    await waitReceived(() => fake.queries[0], 1)
    await art.svc.send('art waits')
    await audio.svc.send('audio goes straight in')
    await waitReceived(() => fake.queries[1], 1)
    expect(byText(audio.svc.history(), 'audio goes straight in')?.queue).toBeUndefined()
    expect(art.view().queued.map((m) => m.text)).toEqual(['art waits'])
    expect(audio.view().queued).toEqual([])
    expect(audio.svc.unqueue(byText(art.svc.history(), 'art waits')!.id)).toBeNull()
    expect(art.view().queued).toHaveLength(1)
  })

  it('a session restart still delivers what was queued', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('two')
    await c.svc.restart(false)
    await waitReceived(() => fake.queries[1], 1)
    expect(fake.queries[1].received).toEqual(['two'])
    expect(byText(c.svc.history(), 'two')?.queue).toBeUndefined()
  })

  it('after Genio restarts, messages that were still queued show as not sent and can be taken back with their images', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('lost in the restart', 'player', [{ mediaType: 'image/png', data: PNG }])
    await c.svc.stop()

    const after = createWkspService(() => ctx as never, c.home)
    cleanup.push(() => void after.stop())
    const lost = byText(after.history(), 'lost in the restart')!
    expect(lost.queue).toBe('unsent')
    expect(createWkspService(() => ctx as never, c.home).history().find((m) => m.id === lost.id)?.queue).toBe('unsent')
    expect(after.unqueue(lost.id)).toEqual({ text: 'lost in the restart', images: [{ mediaType: 'image/png', data: PNG }] })
    expect(createWkspService(() => ctx as never, c.home).history().map((m) => m.text)).toEqual(['one'])
  })
})


it('snapshots Inventory context in queued history and returns it intact for editing', async () => {
  const { svc } = chat('inventory-test')
  await svc.send('first')
  await waitReceived(() => fake.queries[0], 1)
  const context = { world: 'forest', folder: 'Assets/Audio', preview: { path: 'Assets/Audio/door.wav', kind: 'audio' as const, size: 123, mtimeMs: 1, generated: false } }
  await svc.send('a heavier one', 'player', [], context)
  const queued = svc.history().find(m => m.text === 'a heavier one')!
  context.folder = 'elsewhere'
  expect(queued.context?.folder).toBe('Assets/Audio')
  expect(queued.queue).toBe('queued')
  const edit = svc.unqueue(queued.id)!
  expect(edit.context?.folder).toBe('Assets/Audio')
  await svc.send(edit.text, 'player', edit.images, edit.context)
  fake.queries[0].finishTurn()
  await waitReceived(() => fake.queries[0], 2)
  expect(fake.queries[0].received[1]).toContain('[screen: ')
  expect(fake.queries[0].received[1]).toContain('Assets/Audio/door.wav')
  expect(fake.queries[0].received[1]).not.toContain('elsewhere')
  expect(ctx.stats.unlock).toHaveBeenCalledWith('inventory-chat')
})


it('keeps send order while a preview thumbnail is loading and isolates later context changes', async () => {
  const { svc } = chat('slow-preview')
  let release!: (file: string | undefined) => void
  ctx.inventory.thumbnail.mockImplementationOnce(() => new Promise(r => { release = r }))
  const context = { world: 'forest', folder: 'Assets', preview: { path: 'Assets/tree.png', kind: 'image' as const, size: 123, mtimeMs: 1, generated: false } }
  const first = svc.send('first with image', 'player', [], context)
  const second = svc.send('second without image')
  context.folder = 'later browsing'
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  // both are on screen as queued at once, in send order, while the preview is still loading
  expect(svc.history().map(m => [m.text, m.queue])).toEqual([['first with image', 'queued'], ['second without image', 'queued']])
  expect(svc.info().queued).toBe(2)
  release(undefined)
  await Promise.all([first, second])
  const { log, queued } = splitQueued(svc.history())
  expect([...log, ...queued].filter(m => m.role === 'player').map(m => [m.text, m.queue])).toEqual([['first with image', undefined], ['second without image', 'queued']])
  expect(byText(svc.history(), 'first with image')?.context?.folder).toBe('Assets')
})

describe('every submitted message is visible as queued right away', () => {
  it('shows a message sent while the project is still opening, keeps it queued through the greeting, then sends it once', async () => {
    vi.useFakeTimers()
    const c = chat('opening-visible')
    c.svc.prepareProjectOpen()
    const sending = c.svc.send('sent during reconcile')
    const other = c.svc.send('and another')
    expect(c.view().queued.map(m => m.text)).toEqual(['sent during reconcile', 'and another'])
    expect(c.svc.history().map(m => m.queue)).toEqual(['queued', 'queued'])
    expect(c.svc.info().queued).toBe(2)
    await flush()
    expect(fake.queries).toHaveLength(0)
    c.svc.wakeProject('Reconciled')
    await Promise.all([sending, other])
    await flush()
    expect(fake.queries[0].received).toHaveLength(1)
    expect(fake.queries[0].received[0]).toContain('[GENIO PROJECT OPEN]')
    expect(c.view().queued.map(m => m.text)).toEqual(['sent during reconcile', 'and another'])
    fake.queries[0].finishTurn()
    await flush()
    expect(fake.queries[0].received[1]).toBe('sent during reconcile')
    expect(c.view().queued.map(m => m.text)).toEqual(['and another'])
    fake.queries[0].finishTurn()
    await flush()
    expect(fake.queries[0].received[2]).toBe('and another')
    expect(c.view().queued).toEqual([])
    expect(c.shown().filter(m => m.role === 'player').map(m => m.text)).toEqual(['sent during reconcile', 'and another'])
  })

  it('a failed project reconciliation still opens the chat, so a message sent meanwhile is delivered', async () => {
    vi.useFakeTimers()
    const c = chat('reconcile-fails')
    const { reconcileProjectOpen } = await import('../src/main/project-startup')
    c.svc.prepareProjectOpen()
    const sending = c.svc.send('are you there?')
    expect(c.view().queued.map(m => m.text)).toEqual(['are you there?'])
    const hc = { home: c.home, wksp: c.svc, supervisor: { replayStatus: () => undefined },
      crew: { reconcileOnStart: async () => { throw new Error('disk on fire') } } }
    await expect(reconcileProjectOpen({ home: () => hc, homes: new Map([['x', hc]]) } as never, 'forest', 'reconcile-fails', () => true)).rejects.toThrow('disk on fire')
    await sending
    await flush()
    expect(fake.queries[0].received[0]).toContain('Startup reconciliation failed: disk on fire')
    expect(c.view().queued.map(m => m.text)).toEqual(['are you there?'])
    fake.queries[0].finishTurn()
    await flush()
    expect(fake.queries[0].received[1]).toBe('are you there?')
    expect(c.view().queued).toEqual([])
  })

  it('a project window closing during the opening keeps the waiting message as not sent instead of dropping it', async () => {
    vi.useFakeTimers()
    const c = chat('opening-closed')
    c.svc.prepareProjectOpen()
    const sending = c.svc.send('do not lose me')
    await c.svc.stop()
    await expect(sending).resolves.toBeUndefined()
    await flush()
    expect(fake.queries).toHaveLength(0)
    expect(byText(c.svc.history(), 'do not lose me')?.queue).toBe('unsent')
    expect(c.shown().map(m => [m.text, m.queue])).toEqual([['do not lose me', 'unsent']])
    expect(createWkspService(() => ctx as never, c.home).history().map(m => m.queue)).toEqual(['unsent'])
  })

  it('stopping a busy session shows the messages it dropped as not sent, never stuck as queued', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('two')
    await c.svc.send('three')
    await c.svc.stop()
    expect(c.svc.history().map(m => [m.text, m.queue])).toEqual([['one', undefined], ['two', 'unsent'], ['three', 'unsent']])
    expect(c.view().queued).toEqual([])
    expect(c.shown().filter(m => m.queue === 'unsent').map(m => m.text)).toEqual(['two', 'three'])
    expect(c.svc.info().queued).toBe(0)
    // reopened in the same run: they stay not sent (editable), and a new message flows normally
    c.svc.prepareProjectOpen(); c.svc.wakeProject('Reopened')
    await waitReceived(() => fake.queries[1], 1)
    fake.queries[1].finishTurn()
    await c.svc.send('four')
    await waitReceived(() => fake.queries[1], 2)
    expect(fake.queries[1].received[1]).toBe('four')
    expect(c.svc.unqueue(byText(c.svc.history(), 'two')!.id)).toEqual({ text: 'two' })
  })

  it('a slash command that becomes a turn waits as queued while busy, then turns sent exactly once', async () => {
    const c = chat('art')
    await c.svc.send('busy')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('/recap')
    await c.svc.send('after the recap')
    expect(c.view().queued.map(m => m.text)).toEqual(['/recap', 'after the recap'])
    expect(c.svc.info().queued).toBe(2)
    fake.queries[0].finishTurn()
    await waitReceived(() => fake.queries[0], 2)
    expect(fake.queries[0].received[1]).toContain('previously on')
    expect(c.view().queued.map(m => m.text)).toEqual(['after the recap'])
    fake.queries[0].finishTurn()
    await waitReceived(() => fake.queries[0], 3)
    expect(c.view().queued).toEqual([])
    expect(c.shown().filter(m => m.role === 'player').map(m => m.text)).toEqual(['busy', '/recap', 'after the recap'])
  })

  it('a slash command answered on the spot shows as sent at once, even mid-turn', async () => {
    const c = chat('art')
    await c.svc.send('busy')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('/help')
    expect(c.view().queued).toEqual([])
    expect(c.shown().filter(m => m.text === '/help')).toHaveLength(1)
    expect(c.svc.history().find(m => m.role === 'system')?.text).toContain('/recap')
  })

  it('a send that fails before its turn is queued leaves the chat and hands the draft back', async () => {
    const c = chat('art')
    await expect(c.svc.send('bad image', 'player', [{ mediaType: 'image/bmp' as never, data: PNG }])).rejects.toThrow('Unsupported image type')
    expect(c.shown()).toEqual([])
    expect(c.svc.history()).toEqual([])
    const away = vi.spyOn(ctx.away, 'state').mockReturnValue({ mode: 'afk' } as never)
    const awayCtx = ctx as unknown as { away: { set?: unknown; takeReturnBrief?: unknown } }
    awayCtx.away.takeReturnBrief = () => ''
    awayCtx.away.set = async () => { throw new Error('presence store unavailable') }
    try {
      await expect(c.svc.send('back from afk')).rejects.toThrow('presence store unavailable')
    } finally { away.mockRestore(); delete awayCtx.away.set; delete awayCtx.away.takeReturnBrief }
    expect(c.shown()).toEqual([])
    expect(c.svc.history()).toEqual([])
    expect(c.svc.info().queued).toBe(0)
    expect(createWkspService(() => ctx as never, c.home).history()).toEqual([])
    expect(fake.queries).toHaveLength(0)
  })

  it('cancel or edit while the turn is still being prepared: never sent, images handed back', async () => {
    const c = chat('slow-cancel')
    let release!: (file: string | undefined) => void
    ctx.inventory.thumbnail.mockImplementationOnce(() => new Promise(r => { release = r }))
    const context = { world: 'forest', folder: 'Assets', preview: { path: 'Assets/tree.png', kind: 'image' as const, size: 1, mtimeMs: 1, generated: false } }
    const first = c.svc.send('take me back', 'player', [{ mediaType: 'image/png', data: PNG, width: 1, height: 1 }], context)
    const second = c.svc.send('still goes')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const waitingOne = byText(c.svc.history(), 'take me back')!
    expect(waitingOne.queue).toBe('queued')
    expect(c.svc.unqueue(waitingOne.id)).toMatchObject({ text: 'take me back', images: [{ mediaType: 'image/png', data: PNG, width: 1, height: 1 }], context: { folder: 'Assets' } })
    release(undefined)
    await Promise.all([first, second])
    await waitReceived(() => fake.queries[0], 1)
    expect(fake.queries[0].received).toEqual(['still goes'])
    expect(c.shown().map(m => m.text)).toEqual(['still goes'])
    expect(c.svc.info().queued).toBe(0)
  })

  it('a message sent during an event turn stays visibly queued and goes before the next events batch', async () => {
    vi.useFakeTimers()
    const c = chat('event-turn')
    const wakes = createWakeService(() => ctx as never, c.home)
    const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
    try {
      wakes.enqueue({ kind: 'signal', reason: 'unit finished' })
      c.svc.deliverWakes()
      await flush()
      expect(fake.queries[0].received[0]).toContain('unit finished')
      await c.svc.send('player during events')
      wakes.enqueue({ kind: 'signal', reason: 'next unit failed' })
      c.svc.deliverWakes()
      expect(c.view().queued.map(m => m.text)).toEqual(['player during events'])
      fake.queries[0].finishTurn()
      await flush()
      expect(fake.queries[0].received[1]).toBe('player during events')
      expect(c.view().queued).toEqual([])
      expect(c.shown().filter(m => m.text === 'player during events')).toHaveLength(1)
      fake.queries[0].finishTurn()
      await vi.advanceTimersByTimeAsync(300)
      await flush()
      expect(fake.queries[0].received[2]).toContain('next unit failed')
    } finally { homeRead.mockRestore() }
  })

  it('a reload reads waiting messages back as queued, in send order, at the end of the log', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await waitReceived(() => fake.queries[0], 1)
    await c.svc.send('two')
    await c.svc.send('three')
    const read = c.svc.history(300)
    expect(splitQueued(read).queued.map(m => m.text)).toEqual(['two', 'three'])
    expect(read.filter(m => m.text === 'two')).toHaveLength(1)
  })
})


const flush = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve() }
const limitResult = (text = "You've hit your session limit ? resets 2:30pm (Europe/Rome)") => ({ type: 'result', subtype: 'success', is_error: true, result: text })

it('delivers events arriving during player and event turns without acknowledging later arrivals', async () => {
  vi.useFakeTimers()
  const c = chat('busy-events')
  const wakes = createWakeService(() => ctx as never, c.home)
  const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
  try {
    await c.svc.send('implement my request')
    await flush()
    wakes.enqueue({ kind: 'signal', reason: 'unit ready to land' })
    c.svc.deliverWakes()
    expect(fake.queries[0].received).toHaveLength(1)
    expect(wakes.pending()).toHaveLength(1)
    fake.queries[0].finishTurn()
    await flush()
    expect(fake.queries[0].received[1]).toContain('unit ready to land')
    wakes.enqueue({ kind: 'signal', reason: 'second unit failed' })
    c.svc.deliverWakes()
    fake.queries[0].finishTurn()
    await flush()
    expect(wakes.pending().map(w => w.reason)).toEqual(['second unit failed'])
    await vi.advanceTimersByTimeAsync(300)
    await flush()
    expect(fake.queries[0].received[2]).toContain('second unit failed')
    fake.queries[0].finishTurn()
    await flush()
    expect(wakes.pending()).toHaveLength(0)
  } finally { homeRead.mockRestore() }
})

describe('Claude limit recovery through the SDK stream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T13:32:00Z'))
  })

  it('refreshes a retained event turn after partial acknowledgement before retrying', async () => {
    const c = chat('events')
    const wakes = createWakeService(() => ctx as never, c.home)
    wakes.enqueue({ kind: 'signal', reason: 'handled outcome' })
    wakes.enqueue({ kind: 'signal', reason: 'unfinished outcome' })
    const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
    try {
      c.svc.deliverWakes()
      await flush()
      expect(fake.queries[0].received[0]).toContain('handled outcome')
      wakes.ackEvents([1])
      fake.queries[0].emit(limitResult("You've hit your session limit ? resets 7pm (Europe/Rome)"))
      await flush()
      fake.queries[0].emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
      await flush()
      expect(fake.queries[1].received[0]).toContain('unfinished outcome')
      expect(fake.queries[1].received[0]).not.toContain('handled outcome')
      fake.queries[1].finishTurn()
      await flush()
      expect(wakes.pending()).toHaveLength(0)
    } finally { homeRead.mockRestore() }
  })

  it('silently resumes the same conversation and resends the failed message once, retaining images and the queue', async () => {
    const c = chat('art')
    await c.svc.send('first', 'player', [{ mediaType: 'image/png', data: PNG }])
    await flush()
    await c.svc.send('second')
    const prompt = fake.queries[0].received[0]
    fake.queries[0].emit(limitResult())
    await flush()
    expect(fake.queries).toHaveLength(2)
    expect(fake.resumes).toEqual([undefined, 'sess-1'])
    expect(fake.queries[1].received).toEqual([prompt])
    expect(fake.queries[1].images).toEqual([[PNG]])
    expect(c.view().queued.map(m => m.text)).toEqual(['second'])
    expect(c.svc.info().limit).toBeUndefined()
    expect(c.svc.history().filter(m => m.role === 'error')).toEqual([])
    fake.queries[1].emit(limitResult())
    await flush()
    expect(fake.queries).toHaveLength(2)
    expect(c.svc.info().limit?.restartRequired).toBe(true)
    expect(c.view().queued.map(m => m.text)).toEqual(['first', 'second'])
    expect(c.svc.history().filter(m => m.text === 'first')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.queries).toHaveLength(2)
    await c.svc.restart(false)
    await flush()
    expect(fake.queries).toHaveLength(2) // restarting cannot reset the durable retry budget
    expect(c.view().queued.map(m => m.text)).toEqual(['first', 'second'])
  })

  it('deduplicates rejected events and results, keeps messages visibly queued, then resumes at reset', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await flush()
    const resetsAt = (Date.now() + 60_000) / 1000
    const event = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } }
    fake.queries[0].emit(event)
    fake.queries[0].emit(event)
    fake.queries[0].emit(limitResult("You've hit your session limit"))
    await flush()
    await c.svc.send('two')
    expect(c.view().queued.map(m => m.text)).toEqual(['one', 'two'])
    expect(c.svc.info().limit).toEqual({ resetsAt: resetsAt * 1000, restartRequired: false })
    expect(c.svc.history().filter(m => m.role === 'error')).toEqual([])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fake.queries).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(102)
    expect(fake.queries).toHaveLength(2)
    expect(fake.queries[1].received).toEqual(['one'])
    fake.queries[1].finishTurn()
    await flush()
    expect(c.svc.info().limit).toBeUndefined()
    expect(fake.queries[1].received).toEqual(['one', 'two'])
  })

  it('a rejection supersedes older allowed evidence and waits for a new allowed observation', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await flush()
    fake.queries[0].emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
    fake.queries[0].emit({ type: 'assistant', error: 'rate_limit', message: { id: 'limit', content: [{ type: 'text', text: "You've hit your session limit" }] } })
    fake.queries[0].emit(limitResult("You've hit your session limit"))
    await flush()
    expect(fake.queries).toHaveLength(1)
    expect(c.svc.history().map(m => m.text)).toEqual(['one'])
    expect(c.svc.info().lastError).toBeUndefined()
    fake.queries[0].emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
    await flush()
    expect(fake.queries).toHaveLength(2)
  })

  it('a later allowed event clears a genuine banner and restarts the waiting query', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await flush()
    fake.queries[0].emit(limitResult("You've hit your session limit ? resets 7pm (Europe/Rome)"))
    await flush()
    expect(c.svc.info().limit).toBeDefined()
    fake.queries[0].emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
    await flush()
    expect(c.svc.info().limit).toBeUndefined()
    expect(fake.queries[1].received).toEqual(['one'])
  })

  it('Retry now cannot bypass a future reset; stopping cancels scheduled recovery', async () => {
    const c = chat('art')
    await c.svc.send('one')
    await flush()
    const error = limitResult("You've hit your session limit ? resets 7pm (Europe/Rome)")
    fake.queries[0].emit(error)
    await flush()
    await c.svc.send('two')
    await c.svc.restart(false)
    await flush()
    expect(fake.queries).toHaveLength(1)
    expect(c.view().queued.map(m => m.text)).toEqual(['one', 'two'])
    await c.svc.stop()
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(fake.queries).toHaveLength(1)
  })

  it('shares rejection protection with other allies and Bot without dropping queued work', async () => {
    const art = chat('art')
    const audio = chat('audio')
    await art.svc.send('art')
    await flush()
    fake.queries[0].emit(limitResult("You've hit your session limit ? resets 7pm (Europe/Rome)"))
    await flush()
    await audio.svc.send('audio')
    await flush()
    expect(fake.queries).toHaveLength(1)
    expect(audio.view().queued.map(m => m.text)).toEqual(['audio'])
    expect(audio.svc.info().limit).toBeDefined()
    const onTurnEnd = vi.fn()
    const bot = new AgentSession('bot', async resume => ({ resume }), {
      onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd,
      onSessionId: vi.fn(), onError: vi.fn(), onRateLimit: vi.fn()
    }, 'main', () => ({}), () => new SessionQuotaPolicy(ctx.main.home.data), new SessionCostLedger(path.join(dir, 'bot-costs.json')))
    cleanup.push(() => bot.stop())
    bot.enqueue({ kind: 'events', prompt: 'wake events', ackThrough: 42 })
    await vi.advanceTimersByTimeAsync(5 * 3600_000)
    expect(onTurnEnd).not.toHaveBeenCalled()
    expect(bot.pending[0]).toMatchObject({ ackThrough: 42 })
    // At most one queued foreground turn may probe after reset; Bot never probes.
    expect(fake.queries).toHaveLength(2)
    const policy = new SessionQuotaPolicy(ctx.main.home.data)
    policy.observe({ status: 'allowed' })
    await vi.advanceTimersByTimeAsync(30_001)
    expect(fake.queries.some(q => q.received.includes('wake events'))).toBe(true)
  })
})

describe('automatic project opening turn', () => {
  it('places a player message sent during reconcile after the opening greeting', async () => {
    vi.useFakeTimers()
    const c = chat('early-message')
    c.svc.prepareProjectOpen()
    const sending = c.svc.send('continue with my request')
    await flush()
    expect(fake.queries).toHaveLength(0)
    c.svc.wakeProject('Reconciliation finished')
    await sending
    await flush()
    expect(fake.queries[0].received).toHaveLength(1)
    expect(fake.queries[0].received[0]).toContain('[GENIO PROJECT OPEN]')
    fake.queries[0].finishTurn()
    await flush()
    expect(fake.queries[0].received[1]).toBe('continue with my request')
  })

  it.each(['online', 'dnd', 'afk'])('greets an empty project immediately in the visible session (%s)', async mode => {
    vi.useFakeTimers()
    const c = chat('project')
    const presence = vi.spyOn(ctx.away, 'state').mockReturnValue({ mode } as never)
    try {
      c.svc.prepareProjectOpen()
      c.svc.wakeProject('Project: project. Running (0). Queued quests: 0.')
      c.svc.wakeProject('duplicate opening')
      await flush()
      expect(fake.queries).toHaveLength(1)
      expect(fake.queries[0].received[0]).toContain('[GENIO PROJECT OPEN]')
      expect(fake.queries[0].received[0]).toContain('Greet Dani')
      expect(fake.queries[0].received[0]).toContain('Running (0)')
      expect(c.svc.history().filter(m => m.role === 'player')).toEqual([])
      fake.queries[0].emit({ type: 'assistant', message: { id: 'hello', content: [{ type: 'text', text: 'Hi Dani, this project is ready for your first task.' }] } })
      fake.queries[0].finishTurn()
      await flush()
      expect(c.svc.history().find(m => m.text.includes('Hi Dani, this project is ready'))?.role).toBe('genio')
      expect(ctx.stats.unlock).toHaveBeenCalledWith('project-welcome')
      await vi.advanceTimersByTimeAsync(7100)
      await flush()
      expect(fake.queries[0].received).toHaveLength(1)
    } finally { presence.mockRestore() }
  })

  it('holds status delivery until reconciliation, refreshes replay on retry, and acknowledges only a successful batch', async () => {
    vi.useFakeTimers()
    const c = chat('startup-events')
    const wakes = createWakeService(() => ctx as never, c.home)
    const homeRead = vi.spyOn(ctx, 'home').mockReturnValue({ wakes, crew: { list: () => [] }, decisions: { list: () => [] } } as never)
    try {
      c.svc.prepareProjectOpen()
      wakes.enqueue({ kind: 'signal', reason: 'offline completed work' })
      wakes.enqueue({ kind: 'signal', reason: 'decision waiting' })
      c.svc.deliverWakes()
      await flush()
      expect(fake.queries).toHaveLength(0)
      c.svc.wakeProject('Startup reconciliation: unit resumed. Running (1).')
      await flush()
      expect(fake.queries[0].received[0]).toContain('offline completed work')
      expect(wakes.pending()).toHaveLength(2)
      wakes.ackEvents([1])
      fake.queries[0].emit(limitResult("You've hit your session limit ? resets 7pm (Europe/Rome)"))
      await flush()
      fake.queries[0].emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
      await flush()
      expect(fake.queries[1].received[0]).toContain('[GENIO PROJECT OPEN]')
      expect(fake.queries[1].received[0]).toContain('unit resumed')
      expect(fake.queries[1].received[0]).toContain('decision waiting')
      expect(fake.queries[1].received[0]).not.toContain('offline completed work')
      wakes.enqueue({ kind: 'signal', reason: 'later outcome' })
      fake.queries[1].finishTurn()
      await flush()
      expect(wakes.pending().map(w => w.reason)).toEqual(['later outcome'])
    } finally { homeRead.mockRestore() }
  })

  it('starts another welcome on close and reopen while retaining the provider conversation', async () => {
    const c = chat('reopened')
    c.svc.prepareProjectOpen(); c.svc.wakeProject('First open')
    await waitReceived(() => fake.queries[0], 1)
    fake.queries[0].finishTurn()
    await new Promise(r => setTimeout(r, 20))
    await c.svc.stop()
    c.svc.prepareProjectOpen(); c.svc.wakeProject('Reopened with real state')
    await waitReceived(() => fake.queries[1], 1)
    expect(fake.resumes).toEqual([undefined, 'sess-1'])
    expect(fake.queries[1].received[0]).toContain('Reopened with real state')
  })
})

it('keeps the service display identity Genio while retaining a non-genio project base key', async () => {
  const name = 'founders-of-avalon'
  const home = new Home(path.join(dir, 'wksps', name), name, new Home(dir))
  const ally = { name, projects: [name], scope: `All work in ${name}`, charter: '', home: home.root, createdAt: '2026-10-14' }
  ctx.main.home.data = path.join(dir, 'data')
  const svc = createWkspService(() => ctx as never, home, ally)
  try { expect(svc.info()).toMatchObject({ name, displayName: 'Genio' }) }
  finally { await svc.stop() }
})
