import { describe, expect, it, vi } from 'vitest'
import { ProviderChatSession } from '../src/main/provider-chat-session'
import { chatHandoff } from '../src/main/chat-handoff'
import type { ChatDriver, ChatDriverEvents, ChatProvider, ChatTurn } from '../src/main/chat-driver'
import { ACHIEVEMENTS } from '../src/main/stats'

class Driver implements ChatDriver {
  readonly capabilities = { mode: 'driver' as const, guardedTools: true }
  sessionId?: string
  busy = false
  queued = 0
  turns: ChatTurn[] = []
  current?: ChatTurn
  constructor(readonly events: ChatDriverEvents) {}
  get idle() { return !this.busy }
  async start() {}
  send(t: ChatTurn) { this.current = t; this.turns.push(t); this.busy = true; this.events.onStart?.(t) }
  cancel(): undefined { return undefined }
  hasEventsQueued() { return this.current?.kind === 'events' }
  async interrupt() { this.finish(false) }
  async yieldTurn() { if (this.busy) this.finish(false) }
  resume() {}
  stop() { this.busy = false }
  finish(ok = true) { this.busy = false; const t = this.current; this.current = undefined; this.events.onTurnEnd(t, ok, 'done', 0) }
}
function fixture() {
  let provider: ChatProvider = 'claude', context = 'before switch'
  const drivers: { provider: ChatProvider; driver: Driver }[] = []
  const events = { onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd: vi.fn(), onSessionId: vi.fn(), onError: vi.fn() }
  const switched = vi.fn()
  const session = new ProviderChatSession({ selection: () => provider, events, switched, handoff: () => context,
    persisted: { active: 'claude', ids: { claude: 'claude-history' } },
    create(p, e) { const d = new Driver(e); drivers.push({ provider: p, driver: d }); return d } })
  return { session, drivers, events, switched, select(p: ChatProvider) { provider = p }, context(c: string) { context = c } }
}
describe('one transcript across provider sessions', () => {
  it('finishes the active turn before switching and resumes old IDs with intervening context', async () => {
    const f = fixture(); f.session.enqueue({ kind: 'player', prompt: 'first' })
    f.select('codex'); f.session.enqueue({ kind: 'player', prompt: 'second' })
    expect(f.drivers).toHaveLength(1); expect(f.session.queued).toBe(1)
    f.drivers[0].driver.finish(); await Promise.resolve()
    expect(f.drivers[1].provider).toBe('codex')
    expect(f.drivers[1].driver.turns[0].prompt).toContain('before switch')
    f.drivers[1].driver.sessionId = 'codex-history'
    f.context('work done under Codex'); f.select('claude')
    f.session.enqueue({ kind: 'player', prompt: 'third' })
    f.drivers[1].driver.finish(); await Promise.resolve()
    expect(f.drivers[2].driver.sessionId).toBe('claude-history')
    expect(f.drivers[2].driver.turns[0].prompt).toContain('work done under Codex')
    expect(f.session.state()).toEqual({ active: 'claude', ids: { claude: 'claude-history', codex: 'codex-history' } })
    expect(f.switched.mock.calls).toEqual([['claude', 'codex'], ['codex', 'claude']])
  })
  it('cancels an active turn before switching without replaying it', async () => {
    const f = fixture(); f.session.enqueue({ kind: 'player', prompt: 'deploy' })
    f.select('codex'); f.session.enqueue({ kind: 'player', prompt: 'next' })
    await f.session.interrupt(); await Promise.resolve()
    expect(f.drivers).toHaveLength(2)
    expect(f.drivers[1].driver.turns[0].prompt).not.toContain('deploy')
    expect(f.events.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'deploy' }), false, 'done', 0)
  })
  it('tags the same visible message with provider and provider session', () => {
    const f = fixture(); f.session.enqueue({ kind: 'player', prompt: 'first' })
    f.drivers[0].driver.events.onMessage({ id: 'message', wksp: 'main', role: 'genio', text: 'hello', ts: '' }, true)
    expect(f.events.onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'message', provider: 'claude', providerSession: 'claude-history' }), true)
  })
})
describe('bounded app-owned handoff', () => {
  it('carries decisions, actual permissions, task state and image refs; excludes native blocks', () => {
    const text = chatHandoff({ projects: [], permissions: 'ask', tasks: [{ id: 'done', project: 'world', title: 'Deployed', state: 'done' },
      { id: 'waiting', project: 'world', title: 'Pending task', state: 'working' }],
      decisions: [{ id: 'choice', project: 'world', question: 'Which?', answer: 'A' }], messages: [{ id: 'p', wksp: 'main', role: 'player', ts: '',
        text: 'Current task', images: [{ file: 'image.png', mediaType: 'image/png' }], tools: [{ id: 't', name: 'deploy', input: 'PRIVATE TOOL BLOCK' }] }] })
    expect(text).toContain('Current task'); expect(text).toContain('Pending task'); expect(text).toContain('image.png')
    expect(text).toContain('"shellMode":"ask"'); expect(text).toContain('"answer":"A"'); expect(text).toContain('completedWork')
    expect(text).not.toContain('PRIVATE TOOL BLOCK')
  })
  it('omits opted-out worlds and ambiguous chat, including attachments', () => {
    const text = chatHandoff({ projects: [{ name: 'private', allowCheapModels: false }], permissions: 'all',
      tasks: [{ id: 'secret', project: 'private', title: 'SECRET TASK', state: 'working' }],
      decisions: [{ id: 'secret', project: 'private', question: 'SECRET DECISION' }],
      messages: [{ id: 'p', wksp: 'main', role: 'player', ts: '', text: 'SECRET CHAT', images: [{ file: 'secret.png', mediaType: 'image/png' }] }] })
    expect(text).not.toMatch(/SECRET|secret\.png/)
    expect(text).toContain('opt-outs')
  })
  it('remains valid JSON within a hard size bound', () => {
    const text = chatHandoff({ projects: [], permissions: 'ask', tasks: [], decisions: [], messages: Array.from({ length: 30 }, (_, i) => ({
      id: String(i), wksp: 'main', role: 'player', ts: '', text: 'x'.repeat(10_000), images: [{ file: 'a'.repeat(10_000), mediaType: 'image/png' }]
    })) })
    expect(text.length).toBeLessThanOrEqual(18_000)
    expect(() => JSON.parse(text.slice(text.indexOf('\n') + 1))).not.toThrow()
  })
})
it('guards both provider achievements with feature tags', () => {
  for (const id of ['chat-provider-switch', 'codex-chat-turn']) expect(ACHIEVEMENTS.find(a => a.id === id)?.feature).toBe('comms')
})
