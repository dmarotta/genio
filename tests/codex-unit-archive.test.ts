import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
vi.mock('../src/main/unithooks', () => ({ installUnitHooks: async () => ({}) }))
import { Home } from '../src/main/home'
import { createCrewService } from '../src/main/crew'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import { manifestFile } from '../src/main/codex-archive'
import { codexRolloutState } from '../src/main/codex-session'
import * as git from '../src/main/git'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { CODEX_UNIT_MODEL } from '../src/shared/unit-model-policy'

// A Codex unit end to end through the Squad, against a temp CODEX_HOME and the fake Codex CLI.
const FAKE = path.join(__dirname, 'fixtures', 'fake-codex.mjs')
let root: string, codexHome: string, home: Home, ctx: AppCtx, task: Task
beforeEach(() => {
  vi.useFakeTimers()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-unit-'))
  codexHome = path.join(root, 'codex')
  fs.mkdirSync(codexHome)
  vi.stubEnv('CODEX_HOME', codexHome)
  vi.stubEnv('GENIO_CODEX_BIN', FAKE)
  home = new Home(path.join(root, 'base')); home.ensure()
  const worktree = path.join(home.root, 'worktrees', 'world', 'unit')
  fs.mkdirSync(worktree, { recursive: true })
  fs.mkdirSync(home.taskDir('unit'), { recursive: true })
  fs.writeFileSync(home.briefFile('unit'), '# Mission')
  task = { id: 'unit', kind: 'scout', project: 'world', wksp: 'main', state: 'exited', harness: 'codex', model: CODEX_UNIT_MODEL,
    worktree, branch: 'genio/unit', briefPath: home.briefFile('unit'), relaunches: 0, automaticRelaunches: 0 } as Task
  fs.writeFileSync(home.tasksFile, JSON.stringify([task]))
  const adapter = { ...BUILTIN_HARNESSES.find(h => h.id === 'codex')!, command: 'fake-unit' }
  const hc = { home, crew: undefined as any, decisions: { list: () => [] } }
  ctx = { appRoot: path.join(root, 'missing-bundle'), main: hc, home: () => hc, homes: new Map([['main', hc]]),
    settings: { get: () => ({}), harness: () => adapter }, projects: { get: () => undefined },
    terminals: { get: () => undefined, list: () => [], lastOutputAt: () => undefined, create: vi.fn(() => ({ id: 'term', alive: true })),
      submit: vi.fn(async () => {}), kill: vi.fn(), onData: () => () => {}, onExit: vi.fn() },
    dispatch: { reserve: vi.fn(async () => ({ loadout: {}, listed: vi.fn(), release: vi.fn(), check: async () => {} })), record: vi.fn() }
  } as unknown as AppCtx
  hc.crew = createCrewService(() => ctx, home)
  vi.spyOn(git, 'repoTop').mockResolvedValue('')
})
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function thread(id: string, cwd: string): void {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '14')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-14T10:00:00Z' } }) + '\n')
}
const manifest = (): any[] => fs.existsSync(manifestFile(home.data)) ? fs.readFileSync(manifestFile(home.data), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []

it("archives the unit's Codex threads after despawn, never another unit's", async () => {
  thread('unit-thread', task.worktree)
  thread('other-thread', path.join(home.root, 'worktrees', 'world', 'other'))
  expect(await ctx.main.crew.cleanup(task.id)).toMatchObject({ ok: true })
  expect(ctx.main.crew.get(task.id)?.state).toBe('cleaned')
  // Nothing yet: the unit's process gets time to exit first.
  expect(await codexRolloutState('unit-thread', codexHome)).toBe('live')
  await vi.advanceTimersByTimeAsync(5_000)
  await vi.waitFor(() => expect(manifest()).toMatchObject([{ action: 'archive', id: 'unit-thread', task: 'unit', cwd: task.worktree }]))
  expect(await codexRolloutState('unit-thread', codexHome)).toBe('archived')
  expect(await codexRolloutState('other-thread', codexHome)).toBe('live')
})

it('does not archive anything for a despawned unit of another runtime', async () => {
  thread('unit-thread', task.worktree)
  ctx.main.crew.update(task.id, { harness: 'gemini' })
  expect(await ctx.main.crew.cleanup(task.id)).toMatchObject({ ok: true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(await codexRolloutState('unit-thread', codexHome)).toBe('live')
  expect(manifest()).toEqual([])
})

it('resumes an archived unit thread by unarchiving it first', async () => {
  thread('unit-thread', task.worktree)
  fs.mkdirSync(path.join(codexHome, 'archived_sessions'))
  const name = 'rollout-2026-10-14T10-00-00-unit-thread.jsonl'
  fs.renameSync(path.join(codexHome, 'sessions', '2026', '10', '14', name), path.join(codexHome, 'archived_sessions', name))
  expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
  expect(await codexRolloutState('unit-thread', codexHome)).toBe('live')
  expect(ctx.terminals.create).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['resume', 'unit-thread']) }))
  expect(ctx.main.crew.get(task.id)?.codexSessionId).toBe('unit-thread')
  expect(manifest()).toMatchObject([{ action: 'unarchive', id: 'unit-thread', task: 'unit' }])
})

it('starts fresh when an archived thread cannot be restored', async () => {
  fs.mkdirSync(path.join(codexHome, 'archived_sessions'))
  fs.writeFileSync(path.join(codexHome, 'archived_sessions', 'rollout-2026-10-14T10-00-00-stuck.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'stuck', cwd: task.worktree } }) + '\n')
  vi.stubEnv('GENIO_CODEX_BIN', path.join(root, 'no-such-codex.mjs'))
  expect(await ctx.main.crew.control(task.id, 'relaunch', undefined, true)).toMatchObject({ ok: true })
  const args = (ctx.terminals.create as any).mock.calls[0][0].args as string[]
  expect(args).not.toContain('resume')
  expect(args).not.toContain('stuck')
})
