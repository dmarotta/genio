import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { autocompactOfferKey, BUILTIN_HARNESSES } from '../src/main/harness'
import { answerAutoCompactOffer, claudeHomeDir, configureClaudeHome, type ClaudeRunner } from '../src/main/claude-home'
import { stripAnsi } from '../src/main/util'
import { createActivityMeter } from '../src/shared/unit-activity'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'

// Two stalls seen on 2026-10-16: Claude's autocompact offer holding a unit at a
// turn end, and a ping typed into a unit's input box but never submitted.

/** Real unit terminal tails from that day's stale events (the "| " prefix removed, ESC restored). */
const OFFER_TAILS = [
  [
    '✻Cooked for 1m 56s · done 1:13 PM',
    '────────────────────────────────────────────────────────────────────────We recommend compacting earlierEachmesagere-sends the whole conversation, so lo…',
    'Keep auto (1m tokens)',
    '     Autocompact at ‹ 400k › tokens',
    '   ↑/↓ choose · ←/→ change size · enter confirm · esc not now❯Keep auto (1m tokens)Autocompact at ‹ 400k › tokens\x1b[<u\x1b[>5u\x1b[>4;2m Keep auto (1m tokens)Autocompact at ‹ 400k › tokens❯Keep auto (1m tok…'
  ].join('\r\n'),
  [
    '✻Crunched for 1h 1m 29s · done 8:01 PM────────────────────────────────────────────────────────We recommend compacting earlier',
    ' Each message r-sends thewholeconversation,solongconversationsuseupyourplan\'susagelimitsfaster.With your current settings, ClaudeCodeautocompacts(replacesoldermessageswithasummary)at1mtokens(defaultv…',
    '     Keepauto (1m token)Autocompact at ‹ 400k › tokens',
    '       This conversation is at 372.1k, so it will be summarized on your next message.',
    '   ↑/↓ choose · ←/→ change size · enter confirm · esc not now❯Keep auto (1m tokens)Autocompact at ‹ 400k › tokens\x1b[<u\x1b[>5u\x1b[>4;2m Keep auto (1m tokens)Autocompact at ‹ 400k › tokens❯Keep auto (1m tok…'
  ].join('\r\n')
]
/** The same offer for an account that sees the smaller size first, pointer on it. */
const OFFER_LOWER_FIRST = 'We recommend compacting earlier\r\n❯ Autocompact at ‹ 400k › tokens\r\n  Keep auto (1m tokens)\r\n↑/↓ choose · ←/→ change size · enter confirm · esc not now'
const squash = (s: string): string => stripAnsi(s).replace(/\s+/g, '').toLowerCase()

describe("recognising Claude's autocompact offer", () => {
  it.each(OFFER_TAILS.map((t, i) => [i, t]))('real tail %i: Enter keeps the preselected "Keep auto (1m tokens)"', (_i, tail) => {
    expect(autocompactOfferKey(squash(tail as string))).toBe('\r')
  })

  it('answers Esc (not now, no setting changed) when the pointer is on the smaller size', () => {
    expect(autocompactOfferKey(squash(OFFER_LOWER_FIRST))).toBe('\x1b')
  })

  it('ignores the answered offer, the status-bar hint and ordinary work', () => {
    for (const text of ['Keeping auto (1m tokens) · /autocompact to change', 'Autocompact unchanged · /autocompact to change',
      '  ⎿  Added 1 line, removed 1 line', '12% until auto-compact']) expect(autocompactOfferKey(squash(text))).toBeUndefined()
  })

  it('strips the keyboard-mode sequences the offer prints, and never counts it as work', () => {
    expect(stripAnsi('a\x1b[<u\x1b[>5u\x1b[>4;2mb')).toBe('ab')
    const meter = createActivityMeter('claude')
    let at = 0
    for (let i = 0; i < 8; i++) for (const tail of OFFER_TAILS) expect(meter.push(stripAnsi(tail), (at += 1_500))).toBe(false)
  })
})

describe('the pre-answered offer in Genio\'s Claude home', () => {
  let dir: string, cfg: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-offer-'))
    cfg = path.join(dir, '.claude.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const read = () => JSON.parse(fs.readFileSync(cfg, 'utf8'))

  it('keeps the automatic window for the signed-in account, its models and every offer Claude recorded', () => {
    fs.writeFileSync(cfg, JSON.stringify({ userID: 'u', oauthAccount: { accountUuid: 'acct' },
      autoCompactOffer: { acct: { 'claude-opus-5-5': { eligibleLoggedAt: 5 } }, other: { 'claude-x': { eligibleLoggedAt: 6, escCount: 1 } } } }))
    answerAutoCompactOffer(cfg, ['claude-fable-5-1', ''], 99)
    const keep = { choice: 'keep', tokens: 1_000_000 }
    expect(read()).toEqual({ userID: 'u', oauthAccount: { accountUuid: 'acct' }, autoCompactOffer: {
      acct: { 'claude-opus-5-5': { eligibleLoggedAt: 5, resolved: keep }, 'claude-fable-5-1': { eligibleLoggedAt: 99, resolved: keep } },
      other: { 'claude-x': { eligibleLoggedAt: 6, escCount: 1, resolved: keep } } } })
  })

  it("leaves an answer already given alone and writes nothing when there is nothing to answer", () => {
    const answered = { oauthAccount: { accountUuid: 'acct' }, autoCompactOffer: { acct: { m: { eligibleLoggedAt: 1, resolved: { choice: 'accept', tokens: 400_000 } } } } }
    fs.writeFileSync(cfg, JSON.stringify(answered))
    const before = fs.statSync(cfg).mtimeMs
    answerAutoCompactOffer(cfg, ['m'])
    expect(read()).toEqual(answered)
    expect(fs.statSync(cfg).mtimeMs).toBe(before)
  })

  it('never creates or breaks a missing or unreadable file', () => {
    answerAutoCompactOffer(cfg, ['m'])
    expect(fs.existsSync(cfg)).toBe(false)
    fs.writeFileSync(cfg, '{ not json')
    expect(() => answerAutoCompactOffer(cfg, ['m'])).not.toThrow()
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{ not json')
  })
})

describe('a unit at work', () => {
  let root: string, genio: string, player: string, home: Home, ctx: AppCtx, task: Task
  let data: ((d: string) => void)[], written: string[], submit: ReturnType<typeof vi.fn>, wakes: { enqueue: ReturnType<typeof vi.fn> }
  const preflight: ClaudeRunner = async args => ({ code: 0, stdout: args[0] === '--version' ? '2.1.301' : JSON.stringify({ loggedIn: true, configDirectory: genio }) })

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unit-stalls-'))
    genio = claudeHomeDir(root)
    player = path.join(root, 'player-claude')
    fs.mkdirSync(player, { recursive: true })
    fs.mkdirSync(genio, { recursive: true })
    fs.writeFileSync(path.join(player, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct' }, projects: {} }))
    fs.writeFileSync(path.join(genio, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct' }, projects: {} }))
    vi.stubEnv('CLAUDE_CONFIG_DIR', player)
    configureClaudeHome({ dir: genio, executable: () => process.execPath, warn: () => {}, runner: preflight })
    home = new Home(root); home.ensure()
    const worktree = path.join(root, 'worktrees', 'world', 'unit')
    fs.mkdirSync(worktree, { recursive: true })
    fs.mkdirSync(home.taskDir('unit'), { recursive: true })
    fs.writeFileSync(home.briefFile('unit'), '# Mission')
    task = { id: 'unit', kind: 'ship', title: 'Unit', project: 'world', wksp: 'main', state: 'exited', harness: 'claude', model: 'claude-opus-5-5',
      worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 0, automaticRelaunches: 0, inbox: { seq: 0, acked: 0, rings: 0 } } as Task
    fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
    data = []
    written = []
    submit = vi.fn(async () => true)
    wakes = { enqueue: vi.fn() }
    const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'claude')!, command: 'fake-claude' }
    const hc = { home, crew: undefined as any, wakes, decisions: { list: () => [] } }
    ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
      settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined }, notifier: { sfx: () => {} },
      terminals: { get: () => ({ alive: true }), lastOutputAt: () => undefined, tail: () => '› Genio ping waiting: list …',
        create: vi.fn(() => ({ id: 't-1', alive: true })), submit, kill: vi.fn(), write: (_id: string, d: string) => { written.push(d) },
        onData: (_id: string, fn: (d: string) => void) => { data.push(fn); return () => { data = data.filter(f => f !== fn) } }, onExit: vi.fn() },
      dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release: vi.fn(), check: async () => {} })), record: vi.fn() },
    } as unknown as AppCtx
    hc.crew = createCrewService(() => ctx, home)
  })
  afterEach(() => {
    vi.useRealTimers()
    configureClaudeHome(undefined)
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const launch = async () => expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
  const emit = (d: string) => { for (const f of data) f(d) }

  it("starts with the offer answered in Genio's home only, keeping the automatic window", async () => {
    await launch()
    const offers = JSON.parse(fs.readFileSync(path.join(genio, '.claude.json'), 'utf8')).autoCompactOffer.acct
    expect(offers['claude-opus-5-5']).toMatchObject({ resolved: { choice: 'keep', tokens: 1_000_000 } })
    expect(offers['claude-fable-5-1']).toMatchObject({ resolved: { choice: 'keep' } })
    expect(JSON.parse(fs.readFileSync(path.join(player, '.claude.json'), 'utf8'))).not.toHaveProperty('autoCompactOffer')
  })

  it('answers the offer on screen once per appearance, after it settles, then rings for a waiting ping', async () => {
    await launch()
    vi.useFakeTimers()
    fs.mkdirSync(home.taskStateFile(task.id, '.inbox'), { recursive: true })
    fs.writeFileSync(path.join(home.taskStateFile(task.id, '.inbox'), '001.msg'), `schema=genio-task-inbox.v1\nat=${new Date().toISOString()}\n--\nhi\n`)
    emit(OFFER_TAILS[0])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(written).toEqual([]) // keys are refused while the offer is still drawing
    emit(OFFER_TAILS[0]) // a redraw restarts the wait
    await vi.advanceTimersByTimeAsync(1_900)
    expect(written).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(written).toEqual(['\r'])
    // its lingering redraws are the same appearance
    emit(OFFER_TAILS[1])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(written).toEqual(['\r'])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][1]).toContain('Genio ping waiting')
    // a later turn end that shows it again is a new appearance
    await vi.advanceTimersByTimeAsync(10_000)
    emit(OFFER_LOWER_FIRST)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(written).toEqual(['\r', '\x1b'])
  })

  it('a ping left typed but not submitted becomes one clear stale signal per ping', async () => {
    await launch()
    submit.mockResolvedValue(false)
    expect(await ctx.main.crew.send(task.id, 'answer: Blue')).toMatchObject({ ok: true })
    expect(await ctx.main.crew.ring(task.id)).toBe(true)
    expect(wakes.enqueue).toHaveBeenCalledOnce()
    expect(wakes.enqueue.mock.calls[0][0]).toMatchObject({ kind: 'stale', taskId: 'unit',
      reason: expect.stringContaining('ping #1 was typed into the unit\'s terminal but not submitted'), lines: ['| › Genio ping waiting: list …'] })
    await ctx.main.crew.send(task.id, 'second')
    expect(wakes.enqueue).toHaveBeenCalledOnce() // the oldest unread ping is still #1
    submit.mockResolvedValue(true)
    fs.renameSync(path.join(home.taskStateFile(task.id, '.inbox'), '001.msg'), path.join(home.taskStateFile(task.id, '.inbox'), 'handled', '001.msg'))
    await ctx.main.crew.ring(task.id)
    expect(wakes.enqueue).toHaveBeenCalledOnce()
  })

  it("an idle Claude unit confirms the submit by its prompt-submit hook; one in mid-turn queues it", async () => {
    await launch()
    const started = home.taskStateFile(task.id, '.turn-started'), ended = home.taskStateFile(task.id, '.turn-ended')
    fs.writeFileSync(started, '1'); fs.utimesSync(started, 1_000, 1_000)
    fs.writeFileSync(ended, '2'); fs.utimesSync(ended, 2_000, 2_000)
    let confirm!: (since: string) => boolean
    submit.mockImplementation(async (_id: string, _text: string, _key: string, c: (since: string) => boolean) => { confirm = c; return true })
    await ctx.main.crew.ring(task.id)
    expect(confirm('')).toBe(false)
    expect(confirm('Genio ping waiting')).toBe(false)
    fs.utimesSync(started, 3_000, 3_000)
    expect(confirm('')).toBe(true)
    fs.utimesSync(ended, 4_000, 4_000)
    fs.utimesSync(started, 5_000, 5_000) // a turn is running
    await ctx.main.crew.ring(task.id)
    expect(confirm('')).toBe(true)
  })
})
