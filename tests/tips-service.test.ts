import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'
import { Home } from '../src/main/home'
import { createStatsService } from '../src/main/stats'
import { createTipsService, type TipWindow } from '../src/main/tips'
import { defaultSettings, createSettingsService } from '../src/main/settings'
import type { AppCtx } from '../src/main/services'
import type { Decision, GenioEvent, Task } from '../src/shared/types'

let dir: string, ctx: AppCtx, tasks: Task[], decisions: Decision[], focus: TipWindow | undefined
let clock: number, playing: boolean, activity: string, presence: string
let engine: ReturnType<typeof createTipsService>, events: Extract<GenioEvent, { type: 'tip' }>[]
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-tips-'))
  const home = new Home(dir); home.ensure()
  fs.mkdirSync(path.join(dir, 'project'))
  tasks = []; decisions = []; clock = new Date(2026, 9, 17, 12).getTime()
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock)
  fs.writeFileSync(path.join(home.state, 'setup.json'), JSON.stringify({ startedAt: new Date(clock).toISOString() }))
  focus = { project: 'game', wksp: 'game-chat', active: true, dialogOpen: false }
  playing = false; activity = 'idle'; presence = 'online'; events = []
  const hc = { home, crew: { list: () => tasks, get: (id: string) => tasks.find(t => t.id === id) },
    wksp: { info: () => ({ activity }) }, decisions: { list: () => decisions } }
  ctx = { main: hc, homes: new Map([['game-chat', hc]]), home: () => hc,
    projects: { get: (name: string) => name === 'game' ? { name, path: path.join(dir, 'project'), engine: 'unity' } : undefined },
    settings: { get: () => ({ featureTips: true }) }, away: { state: () => ({ mode: presence }) },
    permissions: { pending: () => [] }, notifier: { sfx: vi.fn() }, ledger: { record: vi.fn() }
  } as unknown as AppCtx
  ctx.stats = createStatsService(() => ctx)
  bus.onEvent(e => { if (e.type === 'tip') events.push(e) })
})
afterEach(() => { engine?.stop(); bus.removeAllListeners('event'); vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }) })
function start(volumes = { projectBlockClone: false, cloneVolumeMounted: true }): void {
  engine = createTipsService(() => ctx, { focused: () => focus, playing: () => playing, now: () => clock, volumes: async () => volumes })
}
const emit = (e: unknown): void => bus.publish(e as GenioEvent)
const generated = (id: string, count = 1): void => emit({ type: 'feature-used', feature: 'chat-image', project: 'game', id, count })
const used = (id: string): boolean => !!ctx.stats.get().achievements.find(a => a.id === id)?.unlockedAt

describe('tip event replay', () => {
  it('saves before publishing and enforces day/session caps across restart', () => {
    start()
    bus.onEvent(e => { if (e.type === 'tip') expect(JSON.parse(fs.readFileSync(path.join(dir, 'data/tips.json'), 'utf8')).shown[e.tip.id]).toBeTruthy() })
    generated('first')
    expect(events.map(e => e.tip.id)).toEqual(['art-bible'])
    clock += 24 * 60 * 60_000
    ctx.stats.unlock('play-first')
    emit({ type: 'task', task: { id: 't', kind: 'ship', state: 'ready', project: 'game' } })
    expect(events).toHaveLength(1)
    engine.stop(); start()
    generated('second') // art-bible is permanently seen
    emit({ type: 'task', task: { id: 't2', kind: 'ship', state: 'ready', project: 'game' } })
    expect(events.map(e => e.tip.id)).toEqual(['art-bible', 'play-unit'])
    engine.stop(); start()
    emit({ type: 'player-active', project: 'game' })
    expect(events).toHaveLength(2) // setup is unused, but today's cap survives restart
  })

  it('counts deduplicated generations per day across restart, including spend approvals', () => {
    ctx.stats.unlock('art-bible-edit'); start()
    generated('1'); generated('1'); generated('2', 4); generated('failed', 0)
    expect(events).toHaveLength(0)
    engine.stop(); start()
    emit({ type: 'feature-used', feature: 'spend-approve', project: 'game', id: '3' })
    expect(events.map(e => e.tip.id)).toEqual(['generator'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'data/tip-signals.json'), 'utf8')).generations).toHaveLength(3)
  })

  it('resets daily generation counts', () => {
    ctx.stats.unlock('art-bible-edit'); start()
    generated('1'); generated('2'); clock += 24 * 60 * 60_000; generated('3')
    expect(events).toHaveLength(0)
  })

  it('counts only specific successful merges approved in words in this project in the last two hours', () => {
    tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, project: 'game', state: 'merged',
      mergeApproval: { kind: 'specific', at: new Date(clock - i * 60_000).toISOString(), words: 'merge it' } }) as Task)
    start(); ctx.stats.award('merge', 't0')
    expect(events.map(e => e.tip.id)).toEqual(['standing'])
  })

  it('retains approvals from cleaned landed tasks and remembers standing use after a task is removed', () => {
    tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, project: 'game', state: 'cleaned', landedAt: new Date(clock).toISOString(),
      mergeApproval: { kind: 'specific', at: new Date(clock).toISOString(), words: 'merge it' } }) as Task)
    start()
    emit({ type: 'task', task: { id: 'standing', project: 'other', state: 'merged', mergeApproval: { kind: 'standing' } } })
    emit({ type: 'task-removed', id: 'standing' })
    engine.stop(); start()
    emit({ type: 'stats-award', event: 'merge', project: 'game' })
    expect(events).toHaveLength(0)
  })

  it.each(['old', 'other-project', 'button', 'failed', 'auto-loot', 'standing-used'])('does not suggest standing approval for %s', why => {
    tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, project: why === 'other-project' ? 'other' : 'game',
      state: why === 'failed' ? 'ready' : 'merged', mergeApproval: { kind: why === 'button' ? 'ui-button' : why === 'auto-loot' ? 'autoloot' : 'specific',
        at: new Date(clock - (why === 'old' ? 121 : 1) * 60_000).toISOString(), words: 'merge it' } }) as Task)
    if (why === 'standing-used') tasks.push({ id: 'standing', mergeApproval: { kind: 'standing' } } as Task)
    start(); emit({ type: 'stats-award', event: 'merge', project: 'game' })
    expect(events).toHaveLength(0)
  })

  it('suggests plans at the tenth real landing, never at a ready/scout outcome', () => {
    start()
    for (let i = 0; i < 9; i++) { tasks.push({ id: `t${i}`, project: 'game', state: 'merged' } as Task); ctx.stats.award('merge', `t${i}`) }
    ctx.stats.award('scout'); ctx.stats.award('ship')
    expect(events).toHaveLength(0)
    tasks.push({ id: 't9', project: 'game', state: 'merged' } as Task); ctx.stats.award('merge', 't9')
    expect(events.map(e => e.tip.id)).toEqual(['plans'])
  })

  it('measures the waiting choice on active input, with no timer or other open card', () => {
    decisions = Array.from({ length: 5 }, (_, i) => ({ id: `${i}`, project: 'game', resolvedAt: 'yesterday', answeredVia: 'ui' }) as Decision)
    decisions.push({ id: 'waiting', project: 'game', createdAt: new Date(clock).toISOString() } as Decision)
    start(); clock += 599_999; emit({ type: 'player-active', project: 'game' })
    expect(events).toHaveLength(0)
    clock++; focus!.active = false; emit({ type: 'player-active', project: 'game' })
    expect(events).toHaveLength(0)
    focus!.active = true; decisions.push({ id: 'other', project: 'game', createdAt: 'yesterday' } as Decision)
    emit({ type: 'player-active', project: 'game' }); expect(events).toHaveLength(0)
    decisions.pop(); emit({ type: 'player-active', project: 'game' })
    expect(events.map(e => e.tip.id)).toEqual(['ask-genio'])
  })

  it('only checks setup on the first active visit, never startup or future openings', () => {
    fs.unlinkSync(path.join(dir, 'state/setup.json'))
    start(); expect(events).toHaveLength(0)
    emit({ type: 'player-active', project: 'game' })
    expect(events.map(e => e.tip.id)).toEqual(['setup'])
    engine.stop(); clock += 24 * 60 * 60_000; start()
    emit({ type: 'player-active', project: 'game' }); expect(events).toHaveLength(1)
  })

  it.each(['dnd', 'afk', 'play', 'dialog', 'reply', 'hub', 'other-project', 'choice'])('does not deliver during %s', gate => {
    start()
    if (gate === 'dnd' || gate === 'afk') presence = gate
    if (gate === 'play') playing = true
    if (gate === 'dialog') focus!.dialogOpen = true
    if (gate === 'reply') activity = 'thinking'
    if (gate === 'hub') focus = undefined
    if (gate === 'other-project') focus!.project = 'other'
    if (gate === 'choice') decisions.push({ project: 'game' } as Decision)
    generated('1'); expect(events).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'data/tips.json'))).toBe(false)
  })

  it('settles a real generation after its reply, without generating a new moment on idle', () => {
    start(); activity = 'tool'; generated('1'); expect(events).toHaveLength(0)
    activity = 'idle'; emit({ type: 'wksp', wksp: { name: 'game-chat', activity: 'idle' } })
    expect(events.map(e => e.tip.id)).toEqual(['art-bible'])
  })

  it('rechecks focus and Play after asynchronous volume probing, and ignores fast copies', async () => {
    const volumes = vi.fn(async () => ({ projectBlockClone: false, cloneVolumeMounted: true }))
    engine = createTipsService(() => ctx, { focused: () => focus, playing: () => playing, now: () => clock, volumes })
    emit({ type: 'unit-copy', project: 'game', ms: 60_000 }); expect(volumes).not.toHaveBeenCalled()
    emit({ type: 'unit-copy', project: 'game', ms: 60_001 }); playing = true
    await Promise.resolve(); expect(events).toHaveLength(0)
    playing = false; emit({ type: 'unit-copy', project: 'game', ms: 60_001 }); await Promise.resolve()
    expect(events.map(e => e.tip.id)).toEqual(['dev-drive'])
  })

  it('unlocks Take the Hint only on the used achievement within 24 hours', () => {
    start(); generated('1'); expect(used('tip-taken')).toBe(false)
    ctx.stats.unlock('screenshot'); expect(used('tip-taken')).toBe(false)
    ctx.stats.unlock('art-bible-chat'); expect(used('tip-taken')).toBe(true)
  })

  it('does not unlock Take the Hint for late adoption', () => {
    start(); generated('1'); clock += 24 * 60 * 60_000 + 1
    emit({ type: 'achievement', achievement: { id: 'art-bible-chat', unlockedAt: new Date(clock).toISOString() } })
    expect(used('tip-taken')).toBe(false)
  })

  it('uses persisted shown times for adoption after restarting', () => {
    start(); generated('1'); engine.stop(); start()
    ctx.stats.unlock('art-bible-edit')
    expect(used('tip-taken')).toBe(true)
  })

  it('does not publish or consume a cap when the history cannot be saved', () => {
    fs.mkdirSync(path.join(dir, 'data/tips.json'))
    start(); generated('1'); expect(events).toHaveLength(0)
    fs.rmdirSync(path.join(dir, 'data/tips.json'))
    generated('2'); expect(events.map(e => e.tip.id)).toEqual(['art-bible'])
  })

  it('checks renderer dialogs before recording a tip and rechecks all gates after that read', async () => {
    const canShow = vi.fn(async () => false)
    engine = createTipsService(() => ctx, { focused: () => focus, playing: () => playing, now: () => clock, canShow })
    generated('1'); await Promise.resolve(); expect(events).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, 'data/tips.json'))).toBe(false)
    canShow.mockResolvedValue(true)
    generated('2'); playing = true; await Promise.resolve(); expect(events).toHaveLength(0)
    playing = false
    generated('3'); generated('4'); await Promise.resolve()
    expect(events.map(e => e.tip.id)).toEqual(['art-bible'])
  })

  it('leaves a known feature untaught and respects the off setting', () => {
    ctx.stats.unlock('art-bible-chat'); start(); generated('1'); expect(events).toHaveLength(0)
    ctx.settings.get = () => ({ featureTips: false } as ReturnType<AppCtx['settings']['get']>)
    ctx.stats.unlock('play-first')
    emit({ type: 'task', task: { id: 'ready', kind: 'ship', state: 'ready', project: 'game' } })
    expect(events).toHaveLength(0)
  })

  it('tolerates empty persisted signal records', () => {
    fs.writeFileSync(path.join(dir, 'data/tips.json'), 'null')
    fs.writeFileSync(path.join(dir, 'data/tip-signals.json'), '{}')
    start(); generated('1'); expect(events.map(e => e.tip.id)).toEqual(['art-bible'])
  })

  it('defaults tips on for existing settings and persists an explicit off', () => {
    expect(defaultSettings().featureTips).toBe(true)
    const home = new Home(dir)
    fs.writeFileSync(home.settingsFile, JSON.stringify({ firstRunDone: true }))
    expect(createSettingsService(home).get().featureTips).toBe(true)
    createSettingsService(home).save({ featureTips: false })
    expect(createSettingsService(home).get().featureTips).toBe(false)
  })
})
