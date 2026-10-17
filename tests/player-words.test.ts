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
  MERGE_CHOICE_OPTIONS, approvesMerge, isStandingApproval, isStandingRevoke, mergeChoiceApproval, verifyPlayerWords, type MergeTarget
} from '../src/main/player-words'
import { STANDING_HOURS, noteStandingWords, standingApprovals } from '../src/main/standing-approvals'
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

describe('verifyPlayerWords: only the player\'s own words count (spend and generation)', () => {
  it('matches a verbatim quote of a real player message, normalizing case, whitespace and quote marks', () => {
    const chat = [genio('Want a boat texture?'), player('Yes — please  MAKE the boat texture, it’s needed')]
    const r = verifyPlayerWords(chat, "please make the boat texture, it's needed", 'asset')
    expect(r).toMatchObject({ ok: true, messageId: chat[1].id, at: chat[1].ts })
  })

  it('rejects words that only appear in Genio\'s text, a unit\'s relayed text, tool or system output', () => {
    const chat = [genio('make the boat texture'), msg('system', 'make the boat texture', at(1)), msg('wake', 'make the boat texture', at(2)),
      msg('system', 'make the boat texture', at(3), { from: 'genio' })]
    const r = verifyPlayerWords(chat, 'make the boat texture', 'asset')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("not in any of the player's own messages")
  })

  it('ignores queued, unsent and slash-command player messages', () => {
    const chat = [player('make the boat texture', 1), player('/save', 2)]
    chat[0].queue = 'queued'
    expect(verifyPlayerWords(chat, 'make the boat texture', 'asset').ok).toBe(false)
    expect(verifyPlayerWords(chat, '/save', 'asset').ok).toBe(false)
  })

  it('needs a substantial quote unless it is the whole message', () => {
    const chat = [player('ok so that looks fine to me')]
    const short = verifyPlayerWords(chat, 'ok', 'spend')
    expect(!short.ok && short.reason).toContain('too short')
    expect(verifyPlayerWords([player('yes')], 'yes', 'spend').ok).toBe(true)
  })

  it('checks the purpose and the message time', () => {
    expect(verifyPlayerWords([player('replace the old boat texture')], 'replace the old boat texture', 'overwrite').ok).toBe(true)
    const none = verifyPlayerWords([player('the boat texture looks off')], 'the boat texture looks off', 'overwrite')
    expect(!none.ok && none.reason).toContain('does not say to replace the existing file')
    expect(verifyPlayerWords([player("don't replace the boat texture")], "don't replace the boat texture", 'overwrite').ok).toBe(false)
    const old = verifyPlayerWords([player('yes run it', -90)], 'yes run it', 'spend', { after: at(-60), what: 'the quote' })
    expect(!old.ok && old.reason).toContain('predates the quote')
  })
})

describe('merge approvals the player gives themselves', () => {
  it('recognizes standing approvals and revocations', () => {
    for (const text of ['keep merging everything', 'merge everything that finishes', 'land everything as they come', 'merge all you can']) expect(isStandingApproval(text), text).toBe(true)
    for (const text of ['merge everything', 'merge the settings one', 'should you keep merging everything?']) expect(isStandingApproval(text), text).toBe(false)
    for (const text of ['stop', 'stop merging', "don't merge anything else", 'revoke that']) expect(isStandingRevoke(text), text).toBe(true)
    expect(isStandingRevoke('merge the settings one')).toBe(false)
  })

  it('counts only the player\'s approving click on the merge choice, after the ready signal; a chat answer never counts', () => {
    const choice = (patch: Partial<Decision>): Decision => ({ id: 'ch-1', key: 'merge:u-settings', wksp: 'main', question: 'Merge now?', options: MERGE_CHOICE_OPTIONS, source: 'genio',
      urgency: 'normal', createdAt: at(1), resolvedAt: at(3), answer: 'Merge now', answeredVia: 'ui', action: { kind: 'merge-approval', task: 'u-settings' }, ...patch })
    expect(mergeChoiceApproval([choice({})], settings)?.id).toBe('ch-1')
    expect(mergeChoiceApproval([choice({ answer: 'Not yet' })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ resolvedAt: at(-1) })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ answeredVia: 'chat' })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ answeredVia: 'chat', answerMessage: 'm1', answer: 'yes' })], settings)).toBeUndefined()
    expect(mergeChoiceApproval([choice({ action: { kind: 'merge-approval', task: 'u-audio' } })], settings)).toBeUndefined()
    expect(approvesMerge('no, not yet')).toBe(false)
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

describe('the unit page buttons are the player\'s own action', () => {
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
    expect(mergeApprovalLabel({ kind: 'prompt', at: READY })).toBe('Merged by you (Allow once)')
    expect(mergeApprovalLabel({ kind: 'mode', at: READY })).toBe('Merged by Genio in YOLO')
    expect(mergeApprovalLabel(undefined)).toBeUndefined()
  })
})
