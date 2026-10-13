import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import { createDecisionService } from '../src/main/decisions'
import { answerChoice, clarifyChoice, applyRecommendations } from '../src/main/wksp-tools'
import { reviewRecommendation, choiceGroup } from '../src/shared/choice'
import { createAwayService } from '../src/main/away'
import { projectSnapshot, routeProjectEvent } from '../src/main/project-windows'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { FleetSnapshot } from '../src/shared/types'

let root: string, ctx: AppCtx, hc: HomeCtx
const send = vi.fn(), say = vi.fn(), award = vi.fn(), answered = vi.fn(), notify = vi.fn()
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-choice-scope-'))
  const home = new Home(path.join(root, 'project'), 'one'); home.ensure()
  const main = new Home(path.join(root, 'main'), 'main'); main.ensure()
  send.mockResolvedValue({ ok: true }); vi.clearAllMocks()
  ctx = {
    homes: new Map(), home: (name: string) => ctx.homes.get(name)!,
    main: { home: main, wksp: { say } },
    allies: { list: () => [{ name: 'one', projects: ['game'] }] },
    away: { state: () => ({ mode: 'online' }) },
    notifier: { sfx() {}, notify }, ledger: { record() {} }, stats: { award }, dispatch: { answered },
    settings: { get: () => ({ awayBatchSeconds: 90, alarm: 'off' }) }
  } as unknown as AppCtx
  hc = { home, decisions: createDecisionService(() => ctx, home),
    crew: { get: () => ({ state: 'blocked', project: 'game' }), send, appendStatus: vi.fn() },
    backlog: { get: () => undefined }, wksp: { say, deliverWakes() {} }
  } as unknown as HomeCtx
  ctx.homes.set('one', hc)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })

it('centrally claims simultaneous answers once, relays once and writes a receipt in the owner conversation', async () => {
  const d = hc.decisions.open({ question: 'Pick a route?', taskId: 'unit', source: 'unit' })
  const results = await Promise.all([answerChoice(ctx, d.id, ' A '), answerChoice(ctx, d.id, 'B')])
  expect(results.map(r => r.ok)).toEqual([true, false])
  expect(d.answer).toBe('A')
  expect(send).toHaveBeenCalledTimes(1)
  expect(award).toHaveBeenCalledTimes(1)
  expect(say).toHaveBeenCalledExactlyOnceWith('Answered: Pick a route?\n\nA', 'system')
})

it('rejects blank and stale deferred answers, and preserves choices and history across service reloads', async () => {
  const d = hc.decisions.open({ question: 'Pick a route?' })
  expect(d.project).toBe('game')
  expect((await answerChoice(ctx, d.id, '   ')).ok).toBe(false)
  const until = new Date(Date.now() + 60_000).toISOString()
  hc.decisions.defer(d.id, until)
  expect((await answerChoice(ctx, d.id, 'A')).ok).toBe(false)
  const reload = createDecisionService(() => ctx, hc.home)
  expect(reload.list()).toHaveLength(0)
  expect(reload.list(true)).toMatchObject([{ id: d.id, until }])
  reload.defer(d.id, '')
  reload.resolve(d.id, 'A')
  expect(createDecisionService(() => ctx, hc.home).list(true)).toMatchObject([{ id: d.id, answer: 'A' }])
  expect(() => reload.defer(d.id, 'bad')).not.toThrow() // answered record cannot change
})

it('carries exact notification targets and restricts project event and history scope', () => {
  const d = hc.decisions.open({ question: 'Pick a route?' })
  const target = { view: 'move' as const, project: 'game', wksp: 'one', decisionId: d.id }
  expect(notify).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'decision', { target })
  const s = { decisions: [d, { ...d, id: 'other', project: 'other' }], tasks: [], projects: [], backlog: [], wksps: [], allies: [] } as unknown as FleetSnapshot
  const binding = { project: 'game', wksp: 'one' }
  expect(projectSnapshot(s, binding).decisions).toEqual([d])
  expect(routeProjectEvent({ type: 'navigate', target }, { project: 'other', wksp: 'two' }, s)).toBeUndefined()
  expect(routeProjectEvent({ type: 'navigate', target }, binding, s)).toEqual({ type: 'navigate', target })
  expect(projectSnapshot(s).decisions).toHaveLength(2)
})

it('quietly counts current choices on return rather than replaying stale choice questions', () => {
  vi.useFakeTimers()
  const away = createAwayService(() => ctx); ctx.away = away
  const d = hc.decisions.open({ question: 'Private question?' })
  away.set('dnd')
  away.capture({ text: 'Private question?', severity: 'decision', wksp: 'one' })
  const summary = away.takeReturnBrief()
  expect(summary).toContain('1 choices waiting')
  expect(summary).not.toContain('Private question?')
  hc.decisions.resolve(d.id, 'A')
  away.capture({ text: 'Private question?', severity: 'decision', wksp: 'one' })
  expect(away.takeReturnBrief()).not.toContain('choices waiting')
  away.set('online')
})

it('relays clarification without resolving the key or the quest, and persists its history', async () => {
  const d = hc.decisions.open({ question: 'May I close my test scene?', taskId: 'unit', source: 'unit', options: ['Close it', 'Keep it'], recommendation: 'Close it' })
  expect((await clarifyChoice(ctx, d.id, 'Which scene?')).ok).toBe(true)
  expect(send).toHaveBeenCalledWith('unit', expect.stringContaining('not an answer or approval'), [])
  expect(hc.crew.appendStatus).not.toHaveBeenCalled()
  expect(d.resolvedAt).toBeUndefined()
  expect(d.answer).toBeUndefined()
  expect(award).not.toHaveBeenCalled()
  expect(createDecisionService(() => ctx, hc.home).get(d.id)?.clarifications).toEqual([{ question: 'Which scene?', at: expect.any(String) }])
  const updated = hc.decisions.openForTask('unit', d.key, 'May I close the isolated test scene?', 'unit', { context: 'PID 123; test copy only' })
  expect(updated.id).toBe(d.id)
  expect(updated.clarifications).toHaveLength(1)
})

it('keeps failed clarification and answer delivery pending', async () => {
  const d = hc.decisions.open({ question: 'Pick a route?', taskId: 'unit' })
  send.mockResolvedValue({ ok: false, message: 'Inbox unavailable' })
  expect((await clarifyChoice(ctx, d.id, 'Why?')).ok).toBe(false)
  expect((await answerChoice(ctx, d.id, 'A')).ok).toBe(false)
  expect(d.resolvedAt).toBeUndefined()
  expect(d.clarifications).toBeUndefined()
  expect(say).not.toHaveBeenCalled()
})

it('applies only the captured related recommendations and reports changed and failed rows individually', async () => {
  const a = hc.decisions.open({ question: 'Route A?', taskId: 'a', batch: 'routes', recommendation: 'Exact A' })
  const b = hc.decisions.open({ question: 'Route B?', taskId: 'b', batch: 'routes', recommendation: 'Exact B' })
  const c = hc.decisions.open({ question: 'Route C?', taskId: 'c', batch: 'routes', recommendation: 'Exact C' })
  const review = [a, b, c].map(d => reviewRecommendation(d)!)
  const newArrival = hc.decisions.open({ question: 'New route?', taskId: 'new', batch: 'routes', recommendation: 'New answer' })
  hc.decisions.openForTask('b', b.key, 'Changed route B?', 'unit')
  send.mockImplementation(async (task: string) => ({ ok: task !== 'c', message: 'Delivery failed' }))
  const results = await applyRecommendations(ctx, review)
  expect(results.map(r => [r.id, r.ok])).toEqual([[a.id, true], [b.id, false], [c.id, false]])
  expect(a.answer).toBe('Exact A')
  expect(b.resolvedAt).toBeUndefined()
  expect(c.resolvedAt).toBeUndefined()
  expect(newArrival.resolvedAt).toBeUndefined()
  expect(send).toHaveBeenCalledTimes(2)
  expect(award).toHaveBeenCalledTimes(1)
})

it('excludes guessed prose and rejects mixed groups, deferred and already answered snapshots', async () => {
  const plain = hc.decisions.open({ question: 'Maybe close it (recommended) or keep it?' })
  expect(reviewRecommendation(plain)).toBeUndefined()
  const a = hc.decisions.open({ question: 'Route A?', taskId: 'a', recommendation: 'A' })
  const b = hc.decisions.open({ question: 'Route B?', taskId: 'b', recommendation: 'B' })
  expect(choiceGroup(a)).not.toBe(choiceGroup(b))
  await expect(applyRecommendations(ctx, [reviewRecommendation(a)!, reviewRecommendation(b)!])).rejects.toThrow('one related group')
  const review = reviewRecommendation(a)!
  hc.decisions.defer(a.id, new Date(Date.now() + 60_000).toISOString())
  expect((await applyRecommendations(ctx, [review]))[0].ok).toBe(false)
  hc.decisions.defer(a.id, '')
  hc.decisions.resolve(a.id, 'B')
  expect((await applyRecommendations(ctx, [review]))[0].ok).toBe(false)
  expect(a.answer).toBe('B')
})

it('invalidates a review even when a changed question returns to its original wording', async () => {
  const d = hc.decisions.open({ taskId: 'unit', question: 'Pick a route?', recommendation: 'A' })
  const review = reviewRecommendation(d)!
  hc.decisions.openForTask('unit', d.key, 'A different question?', 'unit')
  hc.decisions.openForTask('unit', d.key, 'Pick a route?', 'unit')
  expect((await applyRecommendations(ctx, [review]))[0].ok).toBe(false)
  expect(send).not.toHaveBeenCalled()
  expect(createDecisionService(() => ctx, hc.home).get(d.id)?.revision).toBe(3)
})

it('routes a Genio clarification to its owning conversation without releasing its held quest', async () => {
  hc.wksp.send = vi.fn().mockResolvedValue(undefined)
  hc.backlog.get = vi.fn().mockReturnValue({ state: 'held' })
  hc.backlog.answer = vi.fn()
  const d = hc.decisions.open({ question: 'Which route?', backlogId: 'quest', source: 'genio' })
  expect((await clarifyChoice(ctx, d.id, 'What changes?')).ok).toBe(true)
  expect(hc.wksp.send).toHaveBeenCalledWith(expect.stringContaining(`choice ${d.id}`), 'player')
  expect(hc.backlog.answer).not.toHaveBeenCalled()
  expect(d.resolvedAt).toBeUndefined()
  expect(say).not.toHaveBeenCalled()
})
