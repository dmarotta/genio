import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { removeHandler() {}, handle: (name: string, fn: any) => handlers.set(name, fn) }, BrowserWindow: {}, dialog: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/accounts', () => ({ listAccounts: async () => [] }))
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import type { ChatMessage, Decision, GenioEvent, Task } from '../src/shared/types'
import {
  MERGE_CHOICE_OPTIONS, approvesMerge, isStandingApproval, isStandingRevoke, mergeChoiceApproval, verifyDiscardWords, verifyMergeWords, verifyPlayerWords, type DiscardTarget,
  type MergeTarget
} from '../src/main/player-words'
import { STANDING_HOURS, noteStandingWords, standingApprovals } from '../src/main/standing-approvals'
import { createToolRegistry } from '../src/main/wksp-tools'
import { registerIpc } from '../src/main/ipc'
import { bus } from '../src/main/bus'
import { mergeApprovalLabel } from '../src/shared/merge-approval'

const READY = '2026-10-16T10:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(READY) + min * 60_000).toISOString()
let seq = 0
const msg = (role: ChatMessage['role'], text: string, ts: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${++seq}`, wksp: 'main', role, text, ts, ...extra })
const player = (text: string, min = 5): ChatMessage => msg('player', text, at(min))
const genio = (text: string, min = 4): ChatMessage => msg('genio', text, at(min))

const settings: MergeTarget = { id: 'u-settings', title: 'Settings page redesign', branch: 'genio/settings-page', readyAt: READY, createdAt: at(-60) }
const audio: MergeTarget = { id: 'u-audio', title: 'Audio mixer levels', branch: 'genio/audio', readyAt: READY, createdAt: at(-60) }

describe('verifyPlayerWords: only the player\'s own words count', () => {
  it('matches a verbatim quote of a real player message, normalizing case, whitespace and quote marks', () => {
    const chat = [genio('Want me to discard it?'), player('Yes — please  DISCARD the settings work, it’s broken')]
    const r = verifyPlayerWords(chat, "please discard the settings work, it's broken", 'discard')
    expect(r).toMatchObject({ ok: true, messageId: chat[1].id, at: chat[1].ts })
  })

  it('rejects words that only appear in Genio\'s text, a unit\'s relayed text, tool or system output', () => {
    const chat = [genio('discard the settings work'), msg('system', 'discard the settings work', at(1)), msg('wake', 'discard the settings work', at(2)),
      msg('system', 'discard the settings work', at(3), { from: 'genio' })]
    const r = verifyPlayerWords(chat, 'discard the settings work', 'discard')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("not in any of the player's own messages")
  })

  it('ignores queued, unsent and slash-command player messages', () => {
    const chat = [player('discard the settings work', 1), player('/save', 2)]
    chat[0].queue = 'queued'
    expect(verifyPlayerWords(chat, 'discard the settings work', 'discard').ok).toBe(false)
    expect(verifyPlayerWords(chat, '/save', 'settings').ok).toBe(false)
  })

  it('needs a substantial quote unless it is the whole message', () => {
    const chat = [player('ok so that looks fine to me')]
    const short = verifyPlayerWords(chat, 'ok', 'spend')
    expect(!short.ok && short.reason).toContain('too short')
    expect(verifyPlayerWords([player('yes')], 'yes', 'spend').ok).toBe(true)
  })

  it('checks the purpose: discard must say discard, not a question, not negated', () => {
    expect(verifyPlayerWords([player('throw that work away')], 'throw that work away', 'discard').ok).toBe(true)
    const q = verifyPlayerWords([player('should I delete the settings work?')], 'should I delete the settings work?', 'discard')
    expect(!q.ok && q.reason).toContain('is a question')
    expect(verifyPlayerWords([player("don't delete the settings work")], "don't delete the settings work", 'discard').ok).toBe(false)
    const none = verifyPlayerWords([player('the settings work looks off')], 'the settings work looks off', 'discard')
    expect(!none.ok && none.reason).toContain('does not ask to remove this unit')
  })

  it('checks relaunch words and the message time', () => {
    expect(verifyPlayerWords([player('respawn the audio unit')], 'respawn the audio unit', 'relaunch').ok).toBe(true)
    expect(verifyPlayerWords([player('the audio unit is stuck')], 'the audio unit is stuck', 'relaunch').ok).toBe(false)
    const old = verifyPlayerWords([player('respawn the audio unit', -90)], 'respawn the audio unit', 'relaunch', { after: audio.createdAt, what: 'this unit' })
    expect(!old.ok && old.reason).toContain('predates this unit')
  })
})

describe('verifyMergeWords: explicit, recent and about this work', () => {
  it('accepts a clear merge naming the work by title word, id or branch', () => {
    for (const text of ['merge the settings one', 'yes, merge u-settings', 'Looks good, land the settings fix', 'go ahead and merge genio/settings-page']) {
      expect(verifyMergeWords([player(text)], text, settings, [audio])).toMatchObject({ ok: true })
    }
  })

  it('rejects assistant text, even when it quotes a merge instruction', () => {
    const chat = [genio('merge the settings one'), player('thanks')]
    expect(verifyMergeWords(chat, 'merge the settings one', settings, [audio]).ok).toBe(false)
  })

  it('rejects questions and tentative remarks', () => {
    for (const text of ['merge the settings one?', 'can you merge the settings one', 'should we merge the settings one?', 'maybe merge the settings one',
      'what I am saying is that maybe you should recheck the code that allows you to merge so freely']) {
      const r = verifyMergeWords([player(text)], text, settings, [audio])
      expect(r.ok, text).toBe(false)
    }
    const r = verifyMergeWords([player('can you merge the settings one?')], 'can you merge the settings one?', settings)
    expect(!r.ok && r.reason).toContain('is a question')
  })

  it('rejects a design decision on its own', () => {
    for (const text of ['go with 3', 'use the blue settings layout']) {
      const r = verifyMergeWords([genio('Settings page redesign (u-settings) has three layouts; which one?'), player(text)], text, settings)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.reason).toContain('design pick')
    }
  })

  it('rejects negated, deferred and descriptive mentions of merging', () => {
    for (const text of ["don't merge the settings one yet", 'merge the settings one later', 'either auto loot on or I clearly said you can merge stuff, that how it should work']) {
      expect(verifyMergeWords([genio('u-settings is ready'), player(text)], text, settings).ok, text).toBe(false)
    }
  })

  it('rejects approval given before the unit reported ready', () => {
    const r = verifyMergeWords([player('merge the settings one', -5)], 'merge the settings one', settings, [audio])
    expect(!r.ok && r.reason).toContain('came before this unit reported ready')
  })

  it('resolves "merge it" only as a direct reply to Genio\'s message about that unit', () => {
    const direct = [genio('Settings page redesign (u-settings) is ready: genio/settings-page.'), player('yes merge it')]
    expect(verifyMergeWords(direct, 'yes merge it', settings, [audio])).toMatchObject({ ok: true, messageId: direct[1].id })
    const notDirect = [genio('Settings page redesign (u-settings) is ready.'), player('what changed?', 5), genio('The layout.', 6), player('ok merge it', 7)]
    expect(verifyMergeWords(notDirect, 'ok merge it', settings, [audio]).ok).toBe(false)
    const ambiguous = [genio('u-settings and u-audio are both ready.'), player('merge it')]
    expect(verifyMergeWords(ambiguous, 'merge it', settings, [audio]).ok).toBe(false)
    const both = [genio('u-settings and u-audio are both ready.'), player('merge both')]
    expect(verifyMergeWords(both, 'merge both', settings, [audio]).ok).toBe(true)
    expect(verifyMergeWords(both, 'merge both', audio, [settings]).ok).toBe(true)
    const other = [player('merge u-audio')]
    expect(verifyMergeWords(other, 'merge u-audio', settings, [audio])).toMatchObject({ ok: false, reason: expect.stringContaining('names other work') })
  })

  it('accepts "merge everything" for work that was ready and reports standing words as standing', () => {
    expect(verifyMergeWords([player('merge everything')], 'merge everything', settings, [audio]).ok).toBe(true)
    const standing = verifyMergeWords([player('keep merging everything')], 'keep merging everything', settings, [audio])
    expect(standing).toMatchObject({ ok: false, standing: true })
  })

  it('recognizes standing approvals and revocations', () => {
    for (const text of ['keep merging everything', 'merge everything that finishes', 'land everything as they come', 'merge all you can']) expect(isStandingApproval(text), text).toBe(true)
    for (const text of ['merge everything', 'merge the settings one', 'should you keep merging everything?']) expect(isStandingApproval(text), text).toBe(false)
    for (const text of ['stop', 'stop merging', "don't merge anything else", 'revoke that']) expect(isStandingRevoke(text), text).toBe(true)
    expect(isStandingRevoke('merge the settings one')).toBe(false)
  })

  it('counts an approving merge-choice answer from the UI, or a verified chat answer, after the ready signal', () => {
    const choice = (patch: Partial<Decision>): Decision => ({ id: 'ch-1', key: 'merge:u-settings', wksp: 'main', question: 'Merge now?', options: MERGE_CHOICE_OPTIONS, source: 'genio',
      urgency: 'normal', createdAt: at(1), resolvedAt: at(3), answer: 'Merge now', answeredVia: 'ui', action: { kind: 'merge-approval', task: 'u-settings' }, ...patch })
    expect(mergeChoiceApproval([choice({})], settings)?.id).toBe('ch-1')
    expect(mergeChoiceApproval([choice({ answer: 'Not yet' })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ resolvedAt: at(-1) })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ answeredVia: 'chat' })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ answeredVia: 'chat', answerMessage: 'm1', answer: 'yes' })], settings)?.id).toBe('ch-1')
    expect(mergeChoiceApproval([choice({ action: { kind: 'merge-approval', task: 'u-audio' } })], settings)).toBeUndefined()
    expect(approvesMerge('no, not yet')).toBe(false)
  })
})

describe('verifyDiscardWords: any plain words to get rid of that unit', () => {
  const boat: DiscardTarget = { id: 'u-boat', title: 'Fishing boat', branch: 'genio/fishing-boat', kind: 'modeller', createdAt: at(-60) }
  const others: DiscardTarget[] = [{ ...settings, kind: 'build' }, { ...audio, kind: 'build' }]
  const check = (text: string, chat: ChatMessage[] = [player(text)], target = boat, rest = others) => verifyDiscardWords(chat, text, target, rest)

  it('accepts the messages it used to refuse, typos and all', () => {
    for (const text of ['you can kill the modl unit without merging', 'ok kill modelling unit', 'I said kill modelling unit of the boart withoug merge']) {
      expect(check(text), text).toMatchObject({ ok: true })
    }
  })

  it('accepts any plain removal words that point at it', () => {
    for (const text of ['remove the boat unit', 'get rid of u-boat', 'drop the fishing boat', 'scrap the boat model', 'clear the boat unit', 'trash the modeller',
      'stop and remove the boat unit', 'nuke genio/fishing-boat', 'Discard the boat work', 'delete everything', 'can you remove the boat unit please']) {
      expect(check(text), text).toMatchObject({ ok: true })
    }
  })

  it('accepts "forget it" or "kill it" only as a reply to Genio\'s message about that unit', () => {
    expect(check('forget it, kill it', [genio('Fishing boat (u-boat) is stuck on the hull.'), player('forget it, kill it')])).toMatchObject({ ok: true })
    expect(check('kill it', [genio('u-boat and u-audio are both stuck.'), player('kill it')]).ok).toBe(false)
    expect(check('kill it').ok).toBe(false)
  })

  it('rejects a question', () => {
    for (const text of ['should I delete the boat unit?', 'why did you kill the boat unit?', 'is it ok to remove the boat unit?']) {
      const r = check(text)
      expect(!r.ok && r.reason, text).toContain('is a question')
    }
  })

  it('rejects a message only about merging or keeping it, and a negated one', () => {
    for (const text of ["don't merge the boat unit", 'hold the boat unit', 'keep the boat unit', "don't kill the boat unit", 'drop the merge of the boat unit']) {
      const r = check(text)
      expect(r.ok, text).toBe(false)
    }
    const r = check("don't merge it, hold it")
    expect(!r.ok && r.reason).toBe(`the player's message "don't merge it, hold it" does not ask to remove a unit`)
  })

  it('rejects a message about a different unit', () => {
    expect(check('kill the settings unit')).toMatchObject({ ok: false, reason: expect.stringContaining('is about u-settings, not u-boat') })
    expect(check('remove u-audio')).toMatchObject({ ok: false, reason: expect.stringContaining('is about u-audio, not u-boat') })
    // two Modellers: "the modelling unit" no longer says which
    const twin: DiscardTarget = { id: 'u-tower', title: 'Watch tower', kind: 'modeller', createdAt: at(-60) }
    expect(check('ok kill modelling unit', undefined, boat, [...others, twin]).ok).toBe(false)
  })

  it('keeps rejecting words the player did not write, or wrote before the unit existed', () => {
    expect(check('kill the boat unit', [genio('kill the boat unit')])).toMatchObject({ ok: false, reason: expect.stringContaining("not in any of the player's own messages") })
    expect(check('kill the boat unit', [player('kill the boat unit', -90)])).toMatchObject({ ok: false, reason: expect.stringContaining('was sent before u-boat existed') })
  })
})

describe('standing merge approvals', () => {
  let ctx: AppCtx
  const allyHome = { name: 'game', isMain: false } as Home
  beforeEach(() => {
    ctx = { allies: { list: () => [{ name: 'game', projects: ['game'] }] }, projects: { list: () => [{ name: 'game' }] }, ledger: { record: vi.fn() } } as unknown as AppCtx
  })

  it('records one from a real player message, shows it, expires it and revokes it on "stop merging" or one click', () => {
    const events: GenioEvent[] = []
    const off = bus.onEvent(ev => { if (ev.type === 'standing-approvals') events.push(ev) })
    try {
      const m = msg('player', 'keep merging everything', at(0), { wksp: 'game' })
      const receipt = noteStandingWords(ctx, allyHome, m)
      expect(receipt).toContain('Standing merge approval recorded for game until')
      const store = standingApprovals(ctx)
      const a = store.active('game')!
      expect(a).toMatchObject({ project: 'game', wksp: 'game', messageId: m.id, text: 'keep merging everything' })
      expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(STANDING_HOURS * 3_600_000)
      expect(store.active('game', Date.parse(a.expiresAt) + 1)).toBeUndefined()
      expect(ctx.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'approval.standing', project: 'game', data: expect.objectContaining({ id: a.id, messageId: m.id }) }))
      expect(events.at(-1)).toMatchObject({ approvals: [expect.objectContaining({ id: a.id })] })

      expect(noteStandingWords(ctx, allyHome, msg('player', 'stop merging', at(10), { wksp: 'game' }))).toContain('revoked')
      expect(store.active('game')).toBeUndefined()
      expect(ctx.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'approval.revoked', data: expect.objectContaining({ id: a.id, by: 'words' }) }))

      noteStandingWords(ctx, allyHome, msg('player', 'merge everything that finishes', at(20), { wksp: 'game' }))
      const b = store.active('game')!
      expect(store.revoke(b.id)).toMatchObject({ id: b.id })
      expect(store.list()).toHaveLength(0)
      expect(events.at(-1)).toMatchObject({ approvals: [] })
    } finally { off() }
  })

  it('ignores Genio\'s text, questions and ordinary player messages', () => {
    expect(noteStandingWords(ctx, allyHome, msg('genio', 'keep merging everything', at(0)))).toBeUndefined()
    expect(noteStandingWords(ctx, allyHome, msg('player', 'should you keep merging everything?', at(0)))).toBeUndefined()
    expect(noteStandingWords(ctx, allyHome, msg('player', 'merge the settings one', at(0)))).toBeUndefined()
    expect(standingApprovals(ctx).list()).toHaveLength(0)
  })
})

describe('the tools enforce it', () => {
  let ctx: AppCtx, home: Home, root: string, chat: ChatMessage[], decisions: Decision[]
  let task: Task, other: Task
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-words-'))
    home = new Home(root)
    chat = []
    decisions = []
    task = { id: 'u-settings', kind: 'ship', title: 'Settings page redesign', branch: 'genio/settings-page', project: 'game', mode: 'local-only', state: 'ready',
      readyAt: READY, createdAt: at(-60), relaunches: 0 } as Task
    other = { ...task, id: 'u-audio', title: 'Audio mixer levels', branch: 'genio/audio' }
    const tasks = () => [task, other]
    const hc = {
      home,
      crew: { get: (id: string) => tasks().find(t => t.id === id), list: tasks,
        merge: vi.fn(async () => ({ ok: true, message: 'Landed.' })), cleanup: vi.fn(async () => ({ ok: true, message: 'despawned' })),
        control: vi.fn(async () => ({ ok: true, message: 'relaunched' })) },
      backlog: { list: () => [], get: () => undefined },
      decisions: { list: () => decisions, get: (id: string) => decisions.find(d => d.id === id), resolve: vi.fn(), open: vi.fn((d: Partial<Decision>) => ({ ...d, id: 'ch-new' })) },
      wksp: { history: () => chat, post: vi.fn(), say: vi.fn() }
    }
    ctx = { appRoot: process.cwd(), main: hc, homes: new Map([['main', hc]]), home: () => hc,
      settings: { get: () => ({}) }, allies: { list: () => [] }, away: { state: () => ({ mode: 'online' }) },
      projects: { list: () => [{ name: 'game' }], get: (name: string) => ({ name, path: root, yolo: false }) },
      forge: { view: vi.fn() }, ledger: { record: vi.fn() }, stats: { unlock: vi.fn() }
    } as unknown as AppCtx
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); handlers.clear() })
  const tool = (name: string, role: 'genio' | 'bot' = 'genio') => createToolRegistry(() => ctx, home, role).find(t => t.name === name)!
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map(c => c.text).join('\n')

  it('merge refuses without real approval and says what is missing', async () => {
    const none = await tool('merge').invoke({ task: 'u-settings' })
    expect(none.isError).toBe(true)
    expect(text(none)).toContain('no player message approves merging u-settings')
    expect(text(none)).toContain('Merge button')
    chat.push(genio('merge the settings one'))
    const forged = await tool('merge').invoke({ task: 'u-settings', player_words: 'merge the settings one' })
    expect(text(forged)).toContain("not in any of the player's own messages")
    chat.push(player('go with 3'))
    expect(text(await tool('merge').invoke({ task: 'u-settings', player_words: 'go with 3' }))).toContain('design pick')
    expect(ctx.main.crew.merge).not.toHaveBeenCalled()
  })

  it('merge on the player\'s word records a specific approval with the message', async () => {
    const m = player('yes, merge the settings one')
    chat.push(genio('Settings page redesign (u-settings) is ready.'), m)
    const r = await tool('merge').invoke({ task: 'u-settings', player_words: 'merge the settings one' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toContain('Merged on your word: "yes, merge the settings one"')
    expect(ctx.main.crew.merge).toHaveBeenCalledWith('u-settings', expect.objectContaining({ kind: 'specific', messageId: m.id, messageAt: m.ts, words: 'yes, merge the settings one' }))
  })

  it('merge under Auto-loot needs no words and records autoloot; the Bot merges only that way', async () => {
    expect(await tool('merge', 'bot').invoke({ task: 'u-settings', player_words: 'merge the settings one' })).toMatchObject({ isError: true })
    chat.push(player('merge the settings one'))
    expect(await tool('merge', 'bot').invoke({ task: 'u-settings', player_words: 'merge the settings one' })).toMatchObject({ isError: true })
    standingApprovals(ctx).record({ project: 'game', wksp: 'main', messageId: 'm0', text: 'keep merging everything' })
    expect(await tool('merge', 'bot').invoke({ task: 'u-settings' })).toMatchObject({ isError: true })
    expect(ctx.main.crew.merge).not.toHaveBeenCalled()
    task.yolo = true
    expect((await tool('merge', 'bot').invoke({ task: 'u-settings' })).isError).toBeUndefined()
    expect(ctx.main.crew.merge).toHaveBeenLastCalledWith('u-settings', expect.objectContaining({ kind: 'autoloot' }))
    expect((await tool('merge').invoke({ task: 'u-settings' })).isError).toBeUndefined()
    expect(ctx.main.crew.merge).toHaveBeenLastCalledWith('u-settings', expect.objectContaining({ kind: 'autoloot' }))
  })

  it('merge under a standing approval logs its id', async () => {
    const a = standingApprovals(ctx).record({ project: 'game', wksp: 'main', messageId: 'm-standing', text: 'keep merging everything' })
    const r = await tool('merge').invoke({ task: 'u-settings' })
    expect(text(r)).toContain(`standing approval ${a.id}`)
    expect(ctx.main.crew.merge).toHaveBeenCalledWith('u-settings', expect.objectContaining({ kind: 'standing', standingId: a.id, messageId: 'm-standing' }))
    standingApprovals(ctx).revoke(a.id)
    expect(await tool('merge').invoke({ task: 'u-settings' })).toMatchObject({ isError: true })
  })

  it('a "Merge now?" choice opens without pinging the unit; the player\'s answer approves the merge', async () => {
    expect(text(await tool('choice_open').invoke({ question: 'Merge now?', merge_task: 'u-settings' }))).toContain('approves merging u-settings')
    expect(ctx.main.decisions.open).toHaveBeenCalledWith(expect.objectContaining({ options: MERGE_CHOICE_OPTIONS, action: { kind: 'merge-approval', task: 'u-settings' } }))
    expect(ctx.main.decisions.open).not.toHaveBeenCalledWith(expect.objectContaining({ taskId: expect.anything() }))
    const d: Decision = { id: 'ch-1', key: 'merge:u-settings', wksp: 'main', question: 'Merge now?', options: MERGE_CHOICE_OPTIONS, source: 'genio', urgency: 'normal',
      createdAt: at(1), action: { kind: 'merge-approval', task: 'u-settings' } }
    decisions.push(d)
    // A chat answer the player never typed is refused; their real reply is accepted with its message id.
    expect(await tool('choice_resolve').invoke({ id: 'ch-1', answer: 'Merge now' })).toMatchObject({ isError: true })
    expect(ctx.main.decisions.resolve).not.toHaveBeenCalled()
    const reply = player('yes', 2)
    chat.push(reply)
    expect((await tool('choice_resolve').invoke({ id: 'ch-1', answer: 'yes' })).isError).toBeUndefined()
    expect(ctx.main.decisions.resolve).toHaveBeenCalledWith('ch-1', 'yes', expect.objectContaining({ origin: { via: 'chat', chat: 'main', message: reply.id } }))
    Object.assign(d, { resolvedAt: at(2), answer: 'yes', answeredVia: 'chat', answerMessage: reply.id })
    const r = await tool('merge').invoke({ task: 'u-settings' })
    expect(r.isError).toBeUndefined()
    expect(ctx.main.crew.merge).toHaveBeenCalledWith('u-settings', expect.objectContaining({ kind: 'specific', choiceId: 'ch-1', words: 'yes', messageId: reply.id }))
  })

  it('force despawn needs the player\'s own words to get rid of that unit, and says in one sentence what is missing', async () => {
    expect(text(await tool('despawn').invoke({ task: 'u-settings', force: true, player_words: 'discard it' }))).toContain("not in any of the player's own messages")
    chat.push(player('should I discard the settings work?'))
    expect(text(await tool('despawn').invoke({ task: 'u-settings', force: true, player_words: 'should I discard the settings work?' })))
      .toBe('force despawn refused: the player\'s message "should I discard the settings work?" is a question, not an instruction.')
    chat.push(player('the settings work looks wrong'))
    expect(text(await tool('despawn').invoke({ task: 'u-settings', force: true, player_words: 'the settings work looks wrong' }))).toContain('does not ask to remove a unit')
    chat.push(player('kill the audio unit'))
    expect(text(await tool('despawn').invoke({ task: 'u-settings', force: true, player_words: 'kill the audio unit' }))).toContain('is about u-audio, not u-settings')
    expect(await tool('despawn', 'bot').invoke({ task: 'u-settings', force: true, player_words: 'the settings work looks wrong' })).toMatchObject({ isError: true })
    expect(ctx.main.crew.cleanup).not.toHaveBeenCalled()
    chat.push(player('ok kill the setings unit without merging'))
    expect((await tool('despawn').invoke({ task: 'u-settings', force: true, player_words: 'ok kill the setings unit without merging' })).isError).toBeUndefined()
    expect(ctx.main.crew.cleanup).toHaveBeenCalledWith('u-settings', true, 'words')
  })

  it('despawn without force still refuses unlanded work and lists it', async () => {
    const list = 'Refusing to despawn u-settings: unlanded work (1 uncommitted change(s) in the worktree). Only the player can authorise discarding it.\nUncommitted:\n   M src/a.ts'
    vi.mocked(ctx.main.crew.cleanup).mockResolvedValueOnce({ ok: false, message: list })
    const r = await tool('despawn').invoke({ task: 'u-settings' })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe(`despawn refused: ${list}`)
    expect(ctx.main.crew.cleanup).toHaveBeenCalledWith('u-settings', false, undefined)
  })

  it('relaunching a held unit uses the same verifier; an ordinary relaunch does not need words', async () => {
    expect((await tool('control').invoke({ task: 'u-settings', action: 'relaunch' })).isError).toBeUndefined()
    task.automaticRelaunches = 1
    const held = await tool('control').invoke({ task: 'u-settings', action: 'relaunch' })
    expect(text(held)).toContain('held after its automatic relaunch')
    chat.push(player('the settings unit is stuck'))
    expect(await tool('control').invoke({ task: 'u-settings', action: 'relaunch', player_words: 'the settings unit is stuck' })).toMatchObject({ isError: true })
    expect(ctx.main.crew.control).toHaveBeenCalledTimes(1)
    chat.push(player('respawn the settings unit'))
    expect((await tool('control').invoke({ task: 'u-settings', action: 'relaunch', player_words: 'respawn the settings unit' })).isError).toBeUndefined()
    expect(ctx.main.crew.control).toHaveBeenCalledTimes(2)
  })

  it('the Merge button is a direct player action: IPC records ui-button with no words', async () => {
    registerIpc(() => ctx)
    expect(await handlers.get('genio:mergeTask')!({ sender: { id: 1 } }, 'u-settings')).toMatchObject({ ok: true })
    expect(ctx.main.crew.merge).toHaveBeenCalledWith('u-settings', { kind: 'ui-button', at: expect.any(String) })
  })

  it('the Discard click is a direct player action: IPC discards with the click as its word', async () => {
    registerIpc(() => ctx)
    expect(await handlers.get('genio:cleanupTask')!({ sender: { id: 1 } }, 'u-settings', true)).toMatchObject({ ok: true })
    expect(ctx.main.crew.cleanup).toHaveBeenCalledWith('u-settings', true, 'click')
  })
})

describe('approval labels', () => {
  it('say who merged it, in the player\'s words', () => {
    expect(mergeApprovalLabel({ kind: 'autoloot', at: READY })).toBe('Merged by Auto-loot')
    expect(mergeApprovalLabel({ kind: 'specific', at: READY, words: 'merge the settings one' })).toBe('Merged on your word: "merge the settings one"')
    expect(mergeApprovalLabel({ kind: 'standing', at: READY, words: 'keep merging everything' })).toBe('Merged on your standing word: "keep merging everything"')
    expect(mergeApprovalLabel({ kind: 'ui-button', at: READY })).toBe('Merged by you (Merge button)')
    expect(mergeApprovalLabel(undefined)).toBeUndefined()
  })
})
