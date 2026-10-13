import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Home } from '../src/main/home'
import { createDecisionService } from '../src/main/decisions'
import { answerChoice } from '../src/main/wksp-tools'
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
    crew: { get: () => ({ state: 'blocked', project: 'game' }), send },
    backlog: { get: () => undefined }, wksp: { say, deliverWakes() {} }
  } as unknown as HomeCtx
  ctx.homes.set('one', hc)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })

it('centrally claims simultaneous answers once, relays once and writes a receipt in the owner conversation', async () => {
  const d = hc.decisions.open({ question: 'Pick a route?', taskId: 'unit', source: 'unit' })
  const results = await Promise.all([answerChoice(ctx, d.id, ' A '), answerChoice(ctx, d.id, 'B')])
  expect(results.every(r => r.ok)).toBe(true)
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
