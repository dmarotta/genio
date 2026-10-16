import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { createBacklogService } from '../src/main/backlog'
import * as git from '../src/main/git'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { squadOutcome, squadState } from '../src/shared/squad-display'

let root: string, repo: string, home: Home, hc: HomeCtx, ctx: AppCtx
let terminal: { id: string; alive: boolean } | undefined
let listed: { id: string; taskId?: string; alive: boolean; kind: string }[]

async function commit(dir: string, file: string, text: string, message: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), text)
  expect((await git.commitAll(dir, message)).code).toBe(0)
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-cleanup-'))
  repo = path.join(root, 'repo')
  await git.initRepo(repo, 'main')
  await git.git(repo, ['config', 'user.email', 't@t'])
  await git.git(repo, ['config', 'user.name', 't'])
  await commit(repo, 'readme.md', 'world\n', 'init')
  home = new Home(path.join(root, 'home')); home.ensure()
  terminal = undefined
  listed = []
  hc = { home, decisions: { list: () => [] } } as unknown as HomeCtx
  ctx = { home: () => hc, homes: new Map([['main', hc]]), main: hc,
    projects: { get: () => ({ name: 'world', path: repo, defaultBranch: 'main' }) },
    settings: { get: () => ({}) },
    terminals: { get: (id: string) => (terminal?.id === id ? terminal : undefined), list: () => listed, kill: vi.fn(), lastOutputAt: () => undefined },
    dispatch: { record: vi.fn() }, ledger: { record: vi.fn() }, stats: { award: vi.fn() }, notifier: { sfx: vi.fn() }
  } as unknown as AppCtx
  hc.backlog = createBacklogService(() => ctx, home)
  hc.crew = createCrewService(() => ctx, home)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

/** A ready Offline Build with one landed-to-be commit, registered like spawn does. */
async function readyUnit(id: string, kind: Task['kind'] = 'ship'): Promise<Task> {
  const worktree = path.join(root, 'worktrees', id)
  expect((await git.addWorktree(repo, worktree, `genio/${id}`, 'main', true)).code).toBe(0)
  if (kind === 'ship') await commit(worktree, `${id}.txt`, 'work\n', `Add ${id}`)
  const quest = hc.backlog.add({ title: id, project: 'world', kind })
  hc.backlog.markInFlight(quest.id, id)
  const task = { id, kind, title: id, project: 'world', wksp: 'main', mode: 'local-only', harness: 'test', state: kind === 'ship' ? 'ready' : 'working',
    worktree, branch: `genio/${id}`, baseBranch: 'main', backlogId: quest.id, briefPath: home.briefFile(id), relaunches: 0,
    createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T09:00:00Z', inbox: { seq: 0, acked: 0, rings: 0 }, statusOffset: 0 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([...hc.crew.list(), task]))
  hc.crew = createCrewService(() => ctx, home)
  return task
}

describe('post-merge cleanup', () => {
  it('treats a worktree folder that is already gone as clean: lands, despawns and settles the quest', async () => {
    const t = await readyUnit('gone')
    fs.rmSync(t.worktree, { recursive: true, force: true })
    const r = await hc.crew.merge(t.id)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Despawned gone')
    const after = hc.crew.get(t.id)!
    expect(after).toMatchObject({ state: 'cleaned', outcome: 'merged' })
    expect(after.landedCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(squadOutcome(after)).toBe('merged')
    expect(hc.backlog.get(t.backlogId!)?.state).toBe('done')
    expect(await git.branchExists(repo, t.branch)).toBe(false)
    expect((await git.git(repo, ['worktree', 'list', '--porcelain'])).stdout).not.toContain('gone')
  }, 60_000)

  it('records the approval behind the merge on the task and in the ledger', async () => {
    const t = await readyUnit('approved')
    const approval = { kind: 'specific' as const, at: '2026-10-13T09:30:00Z', words: 'merge the approved one', messageId: 'p-1', messageAt: '2026-10-13T09:29:00Z' }
    expect((await hc.crew.merge(t.id, approval)).ok).toBe(true)
    expect(hc.crew.get(t.id)).toMatchObject({ state: 'cleaned', mergeApproval: approval })
    expect(ctx.ledger.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'task.merged', task: t.id, data: expect.objectContaining({ via: 'local', approval }) }))
  }, 60_000)

  it('treats a leftover folder git no longer knows ("not a working tree") as clean and leaves its files alone', async () => {
    const t = await readyUnit('stray')
    fs.rmSync(t.worktree, { recursive: true, force: true })
    await git.pruneWorktrees(repo)
    fs.mkdirSync(t.worktree, { recursive: true })
    fs.writeFileSync(path.join(t.worktree, 'notes.txt'), 'mine')
    expect(await git.isWorktreeOf(repo, t.worktree)).toBe(false)
    const r = await hc.crew.merge(t.id)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Left the unregistered folder')
    expect(hc.crew.get(t.id)?.state).toBe('cleaned')
    expect(fs.readFileSync(path.join(t.worktree, 'notes.txt'), 'utf8')).toBe('mine')
  }, 60_000)

  it('lists the exact uncommitted files, keeps them, and still settles the landed unit', async () => {
    const t = await readyUnit('dirty')
    fs.writeFileSync(path.join(t.worktree, 'late-edit.txt'), 'not committed')
    const r = await hc.crew.merge(t.id)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('Despawn deferred, nothing was discarded')
    expect(r.message).toContain('?? late-edit.txt')
    expect(fs.readFileSync(path.join(t.worktree, 'late-edit.txt'), 'utf8')).toBe('not committed')
    const after = hc.crew.get(t.id)!
    expect(after.state).toBe('merged')
    expect(squadState(after)).toBe('DONE')
    expect(hc.crew.capacityUsed('world')).toBe(0)
    expect(hc.backlog.get(t.backlogId!)?.state).toBe('done')
  }, 60_000)

  it('lists the exact unlanded commits and never discards them without force', async () => {
    const t = await readyUnit('ahead')
    expect((await hc.crew.merge(t.id)).ok).toBe(true)
    // A merged unit whose copy is gone, but whose branch got one more commit afterwards.
    const extra = path.join(root, 'extra')
    expect((await git.git(repo, ['worktree', 'add', '-b', 'genio/ahead2', extra, 'main'])).code).toBe(0)
    await commit(extra, 'later.txt', 'more\n', 'Late follow-up commit')
    const t2 = { ...t, id: 'ahead2', branch: 'genio/ahead2', worktree: path.join(root, 'missing'), state: 'merged' } as Task
    fs.writeFileSync(home.tasksFile, JSON.stringify([...hc.crew.list(), t2]))
    hc.crew = createCrewService(() => ctx, home)
    const r = await hc.crew.cleanup('ahead2')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Unlanded commits:\n {2}[0-9a-f]+ Late follow-up commit/)
    expect(await git.branchExists(repo, 'genio/ahead2')).toBe(true)
    expect(hc.crew.get('ahead2')?.state).toBe('merged')
  }, 60_000)

  it('closes the shells opened from the unit page before removing the copy, and leaves other terminals alone', async () => {
    const t = await readyUnit('shells')
    listed = [
      { id: 'shell-mine', taskId: t.id, alive: true, kind: 'shell' },
      { id: 'shell-other', taskId: 'other-unit', alive: true, kind: 'shell' },
      { id: 'shell-plain', alive: true, kind: 'shell' }
    ]
    const r = await hc.crew.merge(t.id)
    expect(r.ok).toBe(true)
    expect(hc.crew.get(t.id)?.state).toBe('cleaned')
    expect(ctx.terminals.kill).toHaveBeenCalledWith('shell-mine')
    expect(ctx.terminals.kill).not.toHaveBeenCalledWith('shell-other')
    expect(ctx.terminals.kill).not.toHaveBeenCalledWith('shell-plain')
  }, 60_000)

  it('lets an exited Recon without a report be despawned, but not one that is still running', async () => {
    const t = await readyUnit('recon', 'scout')
    terminal = { id: 'pty', alive: true }
    hc.crew.update(t.id, { terminalId: 'pty' })
    expect((await hc.crew.cleanup(t.id)).message).toContain('report has not been written')
    terminal.alive = false
    hc.crew.update(t.id, { state: 'exited', stateReason: 'recalled' })
    const r = await hc.crew.cleanup(t.id)
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('recon ended without a report') })
    expect(hc.crew.get(t.id)?.state).toBe('cleaned')
    expect(fs.existsSync(t.worktree)).toBe(false)
  }, 60_000)
})

describe('Squad done history persistence', () => {
  it('stamps finish time and outcome once, keeps them through despawn and a restart, and clears them on respawn', async () => {
    const t = await readyUnit('history')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-13T10:00:00Z'))
      hc.crew.update(t.id, { state: 'exited', stateReason: 'unit process exited (code 1) without a final status' })
      vi.setSystemTime(new Date('2026-10-13T11:00:00Z'))
      hc.crew.update(t.id, { state: 'cleaned' })
      const restored = createCrewService(() => ctx, home).get(t.id)!
      expect(restored).toMatchObject({ state: 'cleaned', finishedAt: '2026-10-13T10:00:00.000Z', outcome: 'exited abnormally' })
      expect(squadOutcome(restored)).toBe('exited abnormally')
      hc.crew.update(t.id, { state: 'working' })
      expect(hc.crew.get(t.id)).not.toHaveProperty('finishedAt')
      expect(hc.crew.get(t.id)).not.toHaveProperty('outcome')
      vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
      hc.crew.update(t.id, { state: 'merged', landedAt: '2026-10-13T12:00:00.000Z' })
      expect(hc.crew.get(t.id)).toMatchObject({ finishedAt: '2026-10-13T12:00:00.000Z', outcome: 'merged' })
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})
