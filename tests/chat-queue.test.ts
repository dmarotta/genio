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
    private emit(m: unknown): void {
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
  return { queries, FakeQuery }
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
vi.mock('../src/main/wksp-tools', () => ({ buildTools: () => [] }))

const { Home } = await import('../src/main/home')
const { createWkspService } = await import('../src/main/wksp')
const { bus } = await import('../src/main/bus')

const PNG = 'iVBORw0KGgo='

let dir: string
let cleanup: (() => void)[] = []
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-chat-queue-'))
  fake.queries.length = 0
})
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
  fs.rmSync(dir, { recursive: true, force: true })
})

const ctx = {
  settings: { get: () => ({ gamertag: 'Dani', chatShellMode: 'ask', wkspModel: '', wkspEffort: '', botModel: '' }) },
  allies: { list: () => [] },
  projects: { list: () => [] },
  memory: { read: () => '' },
  inventory: { thumbnail: async () => undefined },
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
  expect(fake.queries[0].received[1]).toContain('[inventory: ')
  expect(fake.queries[0].received[1]).toContain('Assets/Audio/door.wav')
  expect(fake.queries[0].received[1]).not.toContain('elsewhere')
  expect(ctx.stats.unlock).toHaveBeenCalledWith('inventory-chat')
})
