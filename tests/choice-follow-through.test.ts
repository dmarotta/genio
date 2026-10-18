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
import { createSupervisor } from '../src/main/supervisor'
import { ensureProjectBase, startProjectBase } from '../src/main/ctx'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import { answerChoice } from '../src/main/wksp-tools'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'

let root: string, ctx: AppCtx, home: Home, hc: HomeCtx
let say: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T10:00:00Z'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-follow-through-'))
  const mainHome = new Home(root); mainHome.ensure()
  home = new Home(path.join(root, 'workspaces', 'world'), 'world', mainHome); home.ensure()
  say = vi.fn()
  hc = { home, wksp: { prepareProjectOpen: vi.fn(), wakeProject: vi.fn(), deliverWakes: vi.fn(), stop: vi.fn(), say,
    info: () => ({ queued: 0, activity: 'idle' }) } } as unknown as HomeCtx
  const main = { home: mainHome, wksp: { deliverWakes: vi.fn(), say: vi.fn() } } as unknown as HomeCtx
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, id: 'test', enabled: true, command: 'fake-unit' }
  const ally = { name: 'world', projects: ['world'], scope: 'world', home: home.root }
  ctx = { appRoot: path.join(root, 'no-bundle'), main, home: (name: string) => name === 'main' ? main : hc,
    homes: new Map([['main', main], ['world', hc]]),
    settings: { get: () => ({ usageMode: 'save' }), harness: () => adapter },
    allies: { list: () => [ally] }, projects: { get: () => ({ name: 'world', path: root, capacity: 2, gitRepo: true }) },
    terminals: { get: () => undefined, lastOutputAt: () => undefined, create: vi.fn(), onData: () => () => {}, onExit: vi.fn(), kill: vi.fn() },
    dispatch: { capacity: () => ({ cap: 2, used: 0 }), quotaWait: () => undefined },
    notifier: { sfx() {}, notify() {} }, ledger: { record() {} }, stats: { award() {} }, away: { state: () => ({ mode: 'online' }) }
  } as unknown as AppCtx
  for (const base of [main, hc]) {
    base.crew = createCrewService(() => ctx, base.home)
    base.backlog = createBacklogService(() => ctx, base.home)
    base.decisions = createDecisionService(() => ctx, base.home)
    base.wakes = createWakeService(() => ctx, base.home)
    base.supervisor = createSupervisor(() => ctx, base.home)
  }
})
afterEach(() => {
  for (const base of ctx.homes.values()) base.supervisor.stop()
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function unit(id: string, state: Task['state'], kind: Task['kind'] = 'scout'): Task {
  const worktree = path.join(root, 'worktrees', id)
  fs.mkdirSync(worktree, { recursive: true }); fs.mkdirSync(home.taskDir(id), { recursive: true })
  fs.writeFileSync(home.briefFile(id), '# Mission')
  const task = { id, kind, title: `Investigate ${id}`, project: 'world', wksp: 'world', state, mode: 'local-only', harness: 'test',
    worktree, briefPath: home.briefFile(id), reportPath: path.join(home.taskDir(id), 'report.md'), branch: `genio/${id}`, relaunches: 0,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', inbox: { seq: 0, acked: 0 }, statusOffset: 0 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([...hc.crew.list(), task]))
  hc.crew = createCrewService(() => ctx, home)
  return task
}

const answers = () => hc.wakes.recent(0).filter(w => w.kind === 'answer')

describe('a player answer wakes the owning chat', () => {
  it('delivers a finished Recon\'s answer once as an urgent event, with one receipt', async () => {
    unit('recon', 'done')
    const d = hc.decisions.openForTask('recon', 'next', 'Build the fix the report proposes?', 'genio',
      { options: ['Build the fix', 'Leave it'], recommendation: 'Build the fix', project: 'world' })
    const r = await answerChoice(ctx, d.id, 'Build the fix')
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('Genio follows through') })
    expect(d.answer).toBe('Build the fix')
    expect(hc.crew.unreadInbox('recon')).toHaveLength(0) // a finished unit is not pinged
    const [w] = answers()
    expect(answers()).toHaveLength(1)
    expect(w).toMatchObject({ routine: false, taskId: 'recon' })
    expect(w.reason).toBe(`Player answered choice ${d.id} [next] on Recon "Investigate recon": Build the fix`)
    expect(w.lines.join('\n')).toContain('Options: Build the fix | Leave it')
    expect(w.lines.join('\n')).toContain('Recommendation: Build the fix')
    expect(w.lines.join('\n')).toContain('report: ')
    expect(w.lines.join('\n')).toContain('Follow through now')
    expect(hc.wksp.deliverWakes).toHaveBeenCalled()
    expect(say).toHaveBeenCalledExactlyOnceWith('Answered: Build the fix the report proposes?\n\nBuild the fix', 'system')
    // answered again, redelivered, or reloaded: still one event and one receipt
    expect((await answerChoice(ctx, d.id, 'Leave it')).message).toBe('already answered')
    expect(hc.decisions.deliverAnswers('world')).toBe(0)
    expect(createDecisionService(() => ctx, home).get(d.id)?.followUp).toBe('delivered')
    expect(answers()).toHaveLength(1)
    expect(say).toHaveBeenCalledOnce()
    // urgent: drained right away, unlike a routine-only batch
    expect(hc.wakes.drain().text).toContain(`answer: {recon} Player answered choice ${d.id}`)
  })

  it('tells the chat a live unit already has the answer', async () => {
    unit('live', 'needs-decision', 'ship')
    const d = hc.decisions.openForTask('live', 'scene', 'May I close the test scene?', 'unit', { project: 'world' })
    expect((await answerChoice(ctx, d.id, 'Close it')).message).toContain('pinged the unit')
    expect(hc.crew.unreadInbox('live')).toHaveLength(1)
    expect(answers()[0].lines.join('\n')).toContain('The unit was pinged with this answer')
  })

  it('pins a picked engine root itself and tells the chat to deploy nothing', async () => {
    fs.mkdirSync(path.join(root, 'client', 'ProjectSettings'), { recursive: true })
    fs.writeFileSync(path.join(root, 'client', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n')
    Object.assign(ctx.projects, { rescan: vi.fn(async () => []) })
    const d = hc.decisions.open({ question: 'Which game?', options: ['Unity at client/', 'Keep detecting automatically'], project: 'world', key: 'engine-root:x',
      action: { kind: 'engine-root', project: 'world', roots: { 'Unity at client/': 'client' } } })
    await answerChoice(ctx, d.id, 'Unity at client/')
    expect(answers()[0].lines.join('\n')).toContain('deploy nothing')
    await vi.waitFor(() => expect(say).toHaveBeenCalledWith(expect.stringContaining('Pinned Unity at client/'), 'system'))
    expect(JSON.parse(fs.readFileSync(path.join(root, '.genio', 'project.json'), 'utf8'))).toEqual({ engineRoot: 'client' })
  })

  it('skips the wake for an answer typed into the owning chat, but not one typed elsewhere', async () => {
    unit('recon', 'done')
    const own = hc.decisions.openForTask('recon', 'a', 'First?', 'genio', { project: 'world' })
    await answerChoice(ctx, own.id, 'Yes', { via: 'chat', chat: 'world' })
    expect(own.followUp).toBeUndefined()
    expect(answers()).toHaveLength(0)
    const other = hc.decisions.openForTask('recon', 'b', 'Second?', 'genio', { project: 'world' })
    await answerChoice(ctx, other.id, 'No', { via: 'chat', chat: 'main' })
    expect(other.followUp).toBe('delivered')
    expect(answers()).toHaveLength(1)
  })

  it('survives a restart: an answer the chat never received is delivered once on project open', async () => {
    unit('recon', 'done')
    const d = hc.decisions.openForTask('recon', 'next', 'Build it?', 'genio', { project: 'world' })
    // answered while the project chat was not wired (window closed, app shutting down)
    createDecisionService(() => { throw new Error('not wired') }, home).resolve(d.id, 'Build it', { origin: { via: 'ui' } })
    hc.decisions = createDecisionService(() => ctx, home)
    expect(hc.decisions.get(d.id)).toMatchObject({ answer: 'Build it', followUp: 'pending' })
    expect(answers()).toHaveLength(0)
    await ensureProjectBase(ctx, 'world')
    await startProjectBase(ctx, 'world', 'world')
    expect(answers()).toHaveLength(1)
    expect(hc.wakes.pending().map(w => w.kind)).toContain('answer')
    expect(hc.wksp.wakeProject).toHaveBeenCalledOnce()
    expect(createDecisionService(() => ctx, home).get(d.id)?.followUp).toBe('delivered')
    // a crash after queueing but before the flag was saved never doubles the event
    hc.decisions.get(d.id)!.followUp = 'pending'
    expect(hc.decisions.deliverAnswers('world')).toBe(1)
    expect(answers()).toHaveLength(1)
  })
})

describe('a finished Recon is never silently parked', () => {
  const parked = () => hc.wakes.recent(0).filter(w => w.reason.includes("needs the player's call"))

  function finishRecon(id = 'recon'): void {
    unit(id, 'working')
    hc.crew.appendStatus(id, 'done: report ready')
    hc.supervisor.poke()
    expect(hc.crew.get(id)?.state).toBe('done')
  }

  it('surfaces it once after its done event was handled and nothing followed', () => {
    finishRecon()
    vi.advanceTimersByTime(5 * 60_000)
    hc.supervisor.poke()
    expect(parked()).toHaveLength(0) // the done event is still pending
    hc.wakes.ack(Math.max(...hc.wakes.pending().map(w => w.seq)))
    vi.setSystemTime(Date.now() + 60_000)
    hc.supervisor.poke()
    expect(parked()).toHaveLength(0) // the chat still has time to act on it
    vi.setSystemTime(Date.now() + 2 * 60_000)
    hc.supervisor.poke()
    expect(parked()).toHaveLength(1)
    expect(parked()[0]).toMatchObject({ kind: 'check', taskId: 'recon', routine: false })
    hc.supervisor.poke()
    expect(parked()).toHaveLength(1)
    expect(hc.crew.get('recon')?.reconParkedAt).toBeTruthy()
  })

  it('stays quiet once a choice or a follow-up quest was filed', () => {
    finishRecon()
    hc.decisions.openForTask('recon', 'next', 'Build the fix?', 'genio', { project: 'world' })
    hc.wakes.ack(Math.max(...hc.wakes.pending().map(w => w.seq)))
    vi.setSystemTime(Date.now() + 10 * 60_000)
    hc.supervisor.poke()
    expect(parked()).toHaveLength(0)

    finishRecon('second')
    hc.backlog.add({ title: 'Build the fix', project: 'world' })
    hc.wakes.ack(Math.max(...hc.wakes.pending().map(w => w.seq)))
    vi.setSystemTime(Date.now() + 10 * 60_000)
    hc.supervisor.poke()
    expect(parked()).toHaveLength(0)
  })
})
