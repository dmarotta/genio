import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createBacklogService } from '../src/main/backlog'
import { createDecisionService } from '../src/main/decisions'
import { createWakeService } from '../src/main/wakes'
import { createWkspService } from '../src/main/wksp'
import { createReactionService, DISLIKE_GRACE_MS, REACTION_OPTIONS, pauseSummary } from '../src/main/reactions'
import { answerChoice, createToolRegistry } from '../src/main/wksp-tools'
import { scoreOutcome } from '../src/main/scorecard'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { ChatMessage, MessageActions, Task } from '../src/shared/types'
import type { OutcomeRecord } from '../src/shared/dispatch'

let root: string, ctx: AppCtx, home: Home, hc: HomeCtx
let control: ReturnType<typeof vi.fn>
const record = vi.fn()

function wire(): void {
  hc.wksp = createWkspService(() => ctx, home, undefined, false, () => false)
  vi.spyOn(hc.wksp, 'deliverWakes')
  hc.reactions = createReactionService(() => ctx, home)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T10:00:00Z'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-reactions-'))
  const mainHome = new Home(root); mainHome.ensure()
  home = new Home(path.join(root, 'wksps', 'world'), 'world', mainHome); home.ensure()
  hc = { home } as unknown as HomeCtx
  const main = { home: mainHome, wksp: { deliverWakes: vi.fn(), say: vi.fn() } } as unknown as HomeCtx
  record.mockReset()
  ctx = { appRoot: path.join(root, 'no-bundle'), main, home: (name: string) => name === 'main' ? main : hc,
    homes: new Map([['main', main], ['world', hc]]),
    settings: { get: () => ({ usageMode: 'save', gamertag: 'Dani' }), harness: () => undefined },
    allies: { list: () => [{ name: 'world', projects: ['world'], scope: 'world', home: home.root }] },
    projects: { get: () => ({ name: 'world', path: root, gitRepo: true }), list: () => [] },
    terminals: { get: () => undefined, lastOutputAt: () => undefined, kill: vi.fn() },
    dispatch: { capacity: () => ({ cap: 2, used: 0 }), quotaWait: () => undefined, record },
    notifier: { sfx() {}, notify() {} }, ledger: { record() {} }, stats: { award() {}, unlock: vi.fn() }, away: { state: () => ({ mode: 'online' }) }
  } as unknown as AppCtx
  for (const base of [main, hc]) {
    base.crew = createCrewService(() => ctx, base.home)
    base.backlog = createBacklogService(() => ctx, base.home)
    base.decisions = createDecisionService(() => ctx, base.home)
    base.wakes = createWakeService(() => ctx, base.home)
  }
  wire()
  // lifecycle stays in-process: interrupt reports success, relaunch resumes work
  control = vi.fn(async (id: string, action: string) => {
    if (action === 'relaunch') hc.crew.update(id, { state: 'working', stateReason: 'respawned', dislikePause: undefined })
    return { ok: true, message: `${action} ${id}` }
  })
  hc.crew.control = control as unknown as HomeCtx['crew']['control']
})
afterEach(() => {
  hc.reactions.stop()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function unit(id: string, state: Task['state'], extra: Partial<Task> = {}): Task {
  const task = { id, kind: 'ship', title: `Build ${id}`, project: 'world', wksp: 'world', state, mode: 'local-only', harness: 'claude',
    worktree: path.join(root, 'worktrees', id), briefPath: home.briefFile(id), branch: `genio/${id}`, relaunches: 0, terminalId: `term-${id}`,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', inbox: { seq: 0, acked: 0 }, statusOffset: 0, ...extra } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([...hc.crew.list(), task]))
  const keep = hc.crew.control
  hc.crew = createCrewService(() => ctx, home)
  hc.crew.control = keep
  return task
}

function say(id: string, text: string, actions?: MessageActions): ChatMessage {
  const m: ChatMessage = { id, wksp: 'world', role: 'genio', text, ts: '2026-05-01T09:59:00Z', ...(actions ? { actions } : {}) }
  hc.wksp.post(m, true)
  return m
}

const msg = (id: string) => hc.wksp.history().find(m => m.id === id)!
const reactions = () => hc.wakes.recent(0).filter(w => w.kind === 'reaction')
const choices = () => hc.decisions.list(true).filter(d => d.action?.kind === 'reaction')
const calls = (action: string) => control.mock.calls.filter(c => c[1] === action).map(c => c[0])
const grace = async (ms = DISLIKE_GRACE_MS) => { await vi.advanceTimersByTimeAsync(ms) }

describe('dislike grace period', () => {
  it('pauses nothing when undone within the grace period, but still acknowledges both', async () => {
    unit('u1', 'working')
    const q = hc.backlog.add({ title: 'Wire the menu', project: 'world' })
    say('m-1', 'Deploying the menu work now.', { units: ['u1'], quests: [q.id] })

    const set = await hc.reactions.react('m-1', 'dislike')
    expect(set.reaction).toMatchObject({ kind: 'dislike', pause: 'grace' })
    expect(hc.wksp.deliverWakes).not.toHaveBeenCalled() // delivery waits out the grace period too
    await grace(400)
    const undone = await hc.reactions.react('m-1', null)
    expect(undone.reaction).toBeUndefined()
    await grace(5 * DISLIKE_GRACE_MS)

    expect(control).not.toHaveBeenCalled()
    expect(hc.crew.get('u1')).toMatchObject({ state: 'working' })
    expect(hc.crew.get('u1')?.dislikePause).toBeUndefined()
    expect(hc.backlog.get(q.id)?.hold).toBeUndefined()
    expect(choices()).toHaveLength(0)
    const [dislike, removal] = reactions()
    expect(reactions()).toHaveLength(2)
    expect(dislike.reason).toContain('Player disliked your message m-1: "Deploying the menu work now."')
    expect(dislike.lines.join('\n')).toContain('Do not continue that line of work until the player answers that choice.')
    expect(dislike.lines.join('\n')).toContain('Bot (AFK): a dislike is an escalation')
    expect(removal.reason).toContain('Player removed their dislike on your message m-1')
    expect(removal.lines.join('\n')).toContain('removed 0.4 s after it was set, inside the 1 s grace period: nothing was paused')
    expect(removal.lines.join('\n')).toContain('did not mean it')
    expect([dislike, removal].every(w => !w.routine)).toBe(true)
    expect(hc.wksp.deliverWakes).toHaveBeenCalled()
  })

  it('after the grace period pauses exactly what the message started; an undo resumes exactly that', async () => {
    unit('u1', 'working')
    unit('u2', 'working') // not in the record
    unit('u3', 'ready') // ready work: only its merge waits
    const q1 = hc.backlog.add({ title: 'Wire the menu', project: 'world' })
    const q2 = hc.backlog.add({ title: 'Unrelated quest', project: 'world' })
    say('m-1', 'Started the menu rework and queued the polish.', { units: ['u1', 'u3'], quests: [q1.id], choices: ['ch-x'] })
    const cleanup = vi.spyOn(hc.crew, 'cleanup')

    await hc.reactions.react('m-1', 'dislike')
    await grace()

    expect(calls('interrupt')).toEqual(['u1'])
    expect(hc.crew.get('u1')).toMatchObject({ state: 'paused', stateReason: 'paused by your dislike', dislikePause: { message: 'm-1', wksp: 'world', prevState: 'working', interrupted: true } })
    expect(hc.crew.get('u2')).toMatchObject({ state: 'working' })
    expect(hc.crew.get('u2')?.dislikePause).toBeUndefined()
    expect(hc.crew.get('u3')).toMatchObject({ state: 'ready', dislikePause: { message: 'm-1', interrupted: false } })
    expect(hc.backlog.get(q1.id)).toMatchObject({ state: 'queued', hold: { reaction: 'm-1' } })
    expect(hc.backlog.get(q2.id)?.hold).toBeUndefined()
    const [d] = choices()
    expect(choices()).toHaveLength(1)
    expect(d).toMatchObject({ key: 'reaction:m-1', urgency: 'urgent', project: 'world', recommendation: REACTION_OPTIONS.explain,
      options: [REACTION_OPTIONS.stop, REACTION_OPTIONS.keep, REACTION_OPTIONS.explain], action: { kind: 'reaction', wksp: 'world', message: 'm-1' } })
    expect(d.question).toContain('Started the menu rework')
    expect(msg('m-1')).toMatchObject({ reaction: { kind: 'dislike', pause: 'paused', choice: d.id }, reactionNote: 'Paused 1 unit, 1 quest and 1 merge' })
    const paused = reactions().find(w => w.reason.includes(' paused: '))!
    expect(paused.reason).toContain(`opened choice ${d.id}`)
    expect(paused.lines.join('\n')).toContain('Interrupted and paused Build u1')
    expect(paused.lines.join('\n')).toContain('Merge on hold for Build u3')

    // Going past the dislike is the chat's call, cleared by its approval mode: here the player denies each prompt
    const ask = vi.fn(async () => false)
    Object.assign(ctx, { permissions: { ask } })
    const tools = createToolRegistry(() => ctx, home, 'genio')
    const tool = (name: string) => tools.find(t => t.name === name)!
    const merge = vi.spyOn(hc.crew, 'merge')
    expect((await tool('merge').invoke({ task: 'u3', player_words: 'merge it' })).content[0]).toMatchObject({ text: expect.stringContaining('Dani denied it: Merge u3') })
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'merge', input: expect.stringContaining('Your dislike paused it') }))
    expect(merge).not.toHaveBeenCalled()
    expect((await tool('control').invoke({ task: 'u1', action: 'relaunch' })).isError).toBe(true)
    expect((await tool('quest_release').invoke({ id: q1.id })).isError).toBe(true)
    expect(ask).toHaveBeenCalledTimes(3)
    expect(calls('relaunch')).toEqual([])
    const bot = createToolRegistry(() => ctx, home, 'bot')
    expect((await bot.find(t => t.name === 'control')!.invoke({ task: 'u1', action: 'relaunch' })).content[0]).toMatchObject({ text: expect.stringContaining(`wait for their answer to choice ${d.id}`) })
    expect(ask).toHaveBeenCalledTimes(3)

    const undone = await hc.reactions.react('m-1', null)
    expect(calls('relaunch')).toEqual(['u1'])
    expect(control.mock.calls.find(c => c[1] === 'relaunch')).toEqual(['u1', 'relaunch', expect.stringContaining('undid their dislike'), true])
    expect(hc.crew.get('u1')).toMatchObject({ state: 'working' })
    expect(hc.crew.get('u1')?.dislikePause).toBeUndefined()
    expect(hc.crew.get('u3')).toMatchObject({ state: 'ready' })
    expect(hc.crew.get('u3')?.dislikePause).toBeUndefined()
    expect(hc.backlog.get(q1.id)?.hold).toBeUndefined()
    expect(hc.decisions.get(d.id)).toMatchObject({ answer: expect.stringContaining('you undid the dislike') })
    expect(undone).toMatchObject({ reactionNote: 'Resumed 2 units and 1 quest' })
    expect(undone.reaction).toBeUndefined()
    const removal = reactions().at(-1)!
    expect(removal.reason).toContain('removed their dislike')
    expect(removal.lines.join('\n')).toContain('Relaunched Build u1')
    expect(removal.lines.join('\n')).toContain('tell the player in one short line')
    expect(calls('exit')).toEqual([])
    expect(cleanup).not.toHaveBeenCalled() // never despawned, copies kept
  })

  it('"keep going" resumes what it paused; "stop" keeps it paused for Genio', async () => {
    unit('u1', 'working')
    say('m-1', 'Rebuilding the save system.', { units: ['u1'] })
    say('m-2', 'Rewriting the inventory.', { units: ['u2'] })
    unit('u2', 'working')
    await hc.reactions.react('m-1', 'dislike')
    await hc.reactions.react('m-2', 'dislike')
    await grace()
    const [keep, stop] = choices()
    await answerChoice(ctx, stop.id, REACTION_OPTIONS.stop)
    await answerChoice(ctx, keep.id, REACTION_OPTIONS.keep)
    await vi.waitFor(() => expect(calls('relaunch')).toEqual(['u1']))
    expect(msg('m-1')).toMatchObject({ reaction: { kind: 'dislike', pause: 'resumed' }, reactionNote: 'Resumed 1 unit' })
    expect(hc.crew.get('u2')).toMatchObject({ state: 'paused', dislikePause: { message: 'm-2' } })
    const answers = hc.wakes.recent(0).filter(w => w.kind === 'answer')
    expect(answers.map(w => w.lines.join('\n')).join('\n')).toContain('"Stop this work": keep it stopped')
  })
})

describe('scope and safety', () => {
  it('a dislike with no action record only opens the question', async () => {
    unit('u1', 'working')
    say('m-1', 'Here is how the combat loop works.')
    await hc.reactions.react('m-1', 'dislike')
    await grace()
    expect(control).not.toHaveBeenCalled()
    expect(hc.crew.get('u1')?.dislikePause).toBeUndefined()
    expect(choices()).toHaveLength(1)
    expect(choices()[0].options).toEqual([REACTION_OPTIONS.explain, REACTION_OPTIONS.keep])
    expect(msg('m-1').reactionNote).toBe('Nothing was running from it; Genio asked what is wrong')
    expect(reactions()[0].lines.join('\n')).toContain('Action record: none')
  })

  it('an old message whose units already landed only records the signal and asks', async () => {
    unit('u1', 'merged')
    unit('u2', 'cleaned')
    say('m-1', 'Merged the jump fix.', { merges: ['u1'], units: ['u2'] })
    await hc.reactions.react('m-1', 'dislike')
    await grace()
    expect(control).not.toHaveBeenCalled()
    expect(hc.crew.get('u1')?.dislikePause).toBeUndefined()
    expect(choices()[0].context).toContain('Not touched: Build u2 "Build u2" (already cleaned); Build u1 "Build u1" (already merged)')
    expect(hc.reactions.log().map(e => e.kind)).toEqual(['dislike'])
  })

  it('a like never merges: it is a confidence signal counted on the scorecard', async () => {
    unit('u1', 'ready', { yolo: false })
    unit('u2', 'merged', { verdict: undefined })
    const merge = vi.spyOn(hc.crew, 'merge')
    say('m-1', 'Both builds are ready.', { units: ['u1'], merges: ['u2'] })
    await hc.reactions.react('m-1', 'like')
    expect(merge).not.toHaveBeenCalled()
    expect(control).not.toHaveBeenCalled()
    expect(choices()).toHaveLength(0)
    expect(hc.crew.get('u1')).toMatchObject({ state: 'ready', likes: 1 })
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2', likes: 1 }))
    const [w] = reactions()
    expect(w.reason).toContain('Player liked your message m-1')
    expect(w.lines.join('\n')).toContain('It never approves a merge, force, spending or a destructive step')
    expect(hc.wksp.deliverWakes).toHaveBeenCalled()
    expect(hc.reactions.log()[0]).toMatchObject({ kind: 'like', message: 'm-1', wksp: 'world', project: 'world', actions: { units: ['u1'], merges: ['u2'] } })
    // switching to a dislike withdraws the like
    await hc.reactions.react('m-1', 'dislike')
    expect(hc.crew.get('u1')?.likes).toBe(0)
    expect(reactions().at(-1)!.reason).toContain('switched like to dislike')

    const base: OutcomeRecord = { v: 1, taskId: 'x', title: 'x', kind: 'ship', category: 'feature', world: 'w', harness: 'claude', outcome: 'landed',
      landed: true, pings: 2, relaunches: 1, lagging: 0, stopped: 0, wallMinutes: 5, endedAt: '2026-05-01T00:00:00Z' }
    expect(scoreOutcome({ ...base, likes: 1 })).toBeGreaterThan(scoreOutcome(base))
    expect(scoreOutcome({ ...base, likes: 9, verdict: 'down' })).toBeLessThan(scoreOutcome(base))
  })

  it('records each reaction once: a repeated click wakes nobody again, and every event is urgent', async () => {
    say('m-1', 'Queued it.')
    await hc.reactions.react('m-1', 'like')
    await hc.reactions.react('m-1', 'like')
    expect(reactions()).toHaveLength(1)
    expect(hc.reactions.log()).toHaveLength(1)
    await hc.reactions.react('m-1', null)
    expect(reactions().map(w => w.routine)).toEqual([false, false])
    expect(reactions()[1].reason).toContain('removed their like')
    expect(hc.wakes.drain().text).toContain('reaction: Reaction rx-')
    await expect(hc.reactions.react('missing', 'like')).rejects.toThrow('Only a finished Genio message')
    hc.wksp.post({ id: 'p-1', wksp: 'world', role: 'player', text: 'hi', ts: '2026-05-01T09:00:00Z' }, true)
    await expect(hc.reactions.react('p-1', 'like')).rejects.toThrow()
  })
})

describe('action records', () => {
  it('come from the tool wrappers themselves, for the visible chat only', async () => {
    unit('u1', 'working')
    Object.assign(ctx.projects, { update: (name: string) => ({ name, mode: 'local-only', yolo: false, branchPrefix: 'genio/' }) })
    hc.crew.spawn = vi.fn(async () => ({ id: 'u9', backlogId: 'q-deploy', kind: 'ship', title: 'Polish', project: 'world', harness: 'claude', mode: 'local-only', branch: 'genio/u9' } as Task))
    const got: [string, string][] = []
    const tools = createToolRegistry(() => ctx, home, 'genio', { action: (kind, id) => got.push([kind, id]) })
    const run = (name: string, args: unknown) => tools.find(t => t.name === name)!.invoke(args)
    await run('deploy', { kind: 'ship', world: 'world', title: 'Polish the HUD', intent: 'polish the hud', category: 'ui' })
    await run('quest_add', { title: 'Tune the jump', world: 'world' })
    const quest = hc.backlog.list().find(q => q.title === 'Tune the jump')!
    await run('quest_update', { id: quest.id, priority: 'high' })
    await run('choice_open', { question: 'Which art style?', options: ['Pixel', 'Painted'] })
    await run('control', { task: 'u1', action: 'interrupt' })
    await run('world_update', { world: 'world', capacity: 3 })
    await run('fleet_view', {}).catch(() => undefined) // reads record nothing
    await run('quest_add', { title: 'x' }) // too short: a failed call records nothing
    const choice = hc.decisions.list(false).find(d => d.question === 'Which art style?')!
    expect(got).toEqual([['units', 'u9'], ['quests', 'q-deploy'], ['quests', quest.id], ['quests', quest.id], ['choices', choice.id], ['units', 'u1'], ['settings', 'project world']])
  })
})

describe('persistence', () => {
  it('keeps reactions in the chat history and pauses a dislike whose grace ran out while Genio was down', async () => {
    unit('u1', 'working')
    say('m-1', 'Deploying it.', { units: ['u1'] })
    await hc.reactions.react('m-1', 'dislike')
    // the app stops inside the grace period
    hc.reactions.stop()
    await grace(10 * DISLIKE_GRACE_MS)
    expect(control).not.toHaveBeenCalled()

    wire() // a restart: the chat history comes back from disk
    expect(msg('m-1')).toMatchObject({ actions: { units: ['u1'] }, reaction: { kind: 'dislike', pause: 'grace' } })
    expect(await hc.reactions.recover()).toBe(1)
    expect(calls('interrupt')).toEqual(['u1'])
    expect(choices()).toHaveLength(1)
    expect(await hc.reactions.recover()).toBe(0)
    expect(choices()).toHaveLength(1)
    // the dislike event itself was never doubled
    expect(reactions().filter(w => w.reason.includes('Player disliked'))).toHaveLength(1)

    wire()
    expect(msg('m-1')).toMatchObject({ reaction: { kind: 'dislike', pause: 'paused' }, reactionNote: 'Paused 1 unit' })
    await hc.reactions.react('m-1', null)
    expect(calls('relaunch')).toEqual(['u1'])
  })
})

it('summarizes what was paused', () => {
  expect(pauseSummary(2, 1, 0)).toBe('2 units and 1 quest')
  expect(pauseSummary(1, 0, 0)).toBe('1 unit')
  expect(pauseSummary(1, 2, 1)).toBe('1 unit, 2 quests and 1 merge')
})
