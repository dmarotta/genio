import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCodexCli } from '../src/main/codex-archive'
import { codexRolloutState } from '../src/main/codex-session'
import { claudeProjectName } from '../src/main/claude-home'
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import { listVisibleCodexThreads, migrationScope, planMigration, readManifest, runMigration, undoMigration, type MigrationScope } from '../src/main/session-migration'

// Temp CODEX_HOME and Claude folders with fake fixtures only; the fake Codex CLI moves rollouts like `codex archive`.
const FAKE = path.join(__dirname, 'fixtures', 'fake-codex.mjs')
let root: string, scope: MigrationScope, base: string, player: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-session-migration-'))
  base = path.join(root, 'genio-base')
  player = path.join(root, 'player-repo')
  vi.stubEnv('GENIO_CODEX_BIN', FAKE)
  scope = {
    genioRoots: [base],
    genioPrefixes: [path.join(root, 'genio-e2e-')],
    liveCwds: [],
    liveSessionIds: [],
    codexHome: path.join(root, 'codex'),
    claudeDir: path.join(root, 'claude'),
    genioClaudeDir: path.join(base, 'claude-home'),
    manifestFile: path.join(base, 'data', 'session-migration.json')
  }
  fs.mkdirSync(scope.codexHome, { recursive: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function thread(id: string, cwd: string, originator = 'codex-tui'): void {
  const dir = path.join(scope.codexHome, 'sessions', '2026', '10', '13')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `rollout-2026-10-13T10-00-00-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd, originator } }) + '\n')
}
function claudeFolder(cwd: string, sessions: string[]): string {
  const dir = path.join(scope.claudeDir, 'projects', claudeProjectName(cwd))
  fs.mkdirSync(dir, { recursive: true })
  for (const s of sessions) fs.writeFileSync(path.join(dir, `${s}.jsonl`), JSON.stringify({ type: 'user', cwd, sessionId: s }) + '\n')
  return dir
}
/** What the Codex app would list: every thread still under sessions/. */
const visible = async (home: string): Promise<string[]> =>
  (fs.readdirSync(path.join(home, 'sessions'), { recursive: true }) as string[]).filter(f => f.endsWith('.jsonl')).map(f => path.basename(f, '.jsonl').replace('rollout-2026-10-13T10-00-00-', ''))

const unit = (n: string): string => path.join(base, 'worktrees', 'world', n)

it("selects Genio's sessions by where they ran and never the player's own", async () => {
  thread('unit-a', unit('a'))
  thread('data-run', path.join(base, 'data', 'recon-x'))
  thread('e2e-run', path.join(root, 'genio-e2e-abc'))
  thread('chat', player, 'genio_chat')
  thread('player-own', player)
  thread('player-lookalike', path.join(root, 'genio-base-backup'))
  claudeFolder(unit('a'), ['s1', 's2'])
  claudeFolder(player, ['p1'])
  // Same folder name family, but a transcript ran outside Genio: the folder is the player's.
  const mixed = claudeFolder(unit('m'), ['g1'])
  fs.writeFileSync(path.join(mixed, 'p2.jsonl'), JSON.stringify({ cwd: player }) + '\n')

  const plan = await planMigration(scope)
  expect(plan.codex.map(c => c.id).sort()).toEqual(['chat', 'data-run', 'e2e-run', 'unit-a'])
  expect(plan.claude.map(c => c.name)).toEqual([claudeProjectName(unit('a'))])
  expect(plan.claude[0]).toMatchObject({ sessions: 2, to: path.join(scope.genioClaudeDir, 'projects', claudeProjectName(unit('a'))) })
  expect(plan.skipped).toEqual([])
})

it('skips anything live: running units, current chat sessions, live Claude sessions', async () => {
  thread('running-unit', unit('live'))
  thread('chat-now', player, 'genio_chat')
  thread('done-unit', unit('done'))
  claudeFolder(unit('live'), ['x'])
  claudeFolder(path.join(base), ['chat-session'])
  claudeFolder(unit('done'), ['y'])
  scope.liveCwds = [unit('live')]
  scope.liveSessionIds = ['chat-now', 'chat-session']

  const plan = await planMigration(scope)
  expect(plan.codex.map(c => c.id)).toEqual(['done-unit'])
  expect(plan.claude.map(c => c.name)).toEqual([claudeProjectName(unit('done'))])
  expect(plan.skipped.map(s => s.key).sort()).toEqual(['claude:' + claudeProjectName(base), 'claude:' + claudeProjectName(unit('live')), 'codex:chat-now', 'codex:running-unit'].sort())

  const r = await runMigration(scope, undefined, { listVisible: visible })
  expect(r).toMatchObject({ ok: true, archived: 1, moved: 1 })
  expect(await codexRolloutState('running-unit', scope.codexHome)).toBe('live')
  expect(await codexRolloutState('chat-now', scope.codexHome)).toBe('live')
  expect(fs.existsSync(path.join(scope.claudeDir, 'projects', claudeProjectName(unit('live'))))).toBe(true)
  expect(r.skipped.filter(s => s.reason === 'running now')).toHaveLength(4)
})

it('archives a pilot first, then the rest, and records every item in the manifest', async () => {
  for (const n of ['a', 'b', 'c']) thread(`unit-${n}`, unit(n))
  const from = claudeFolder(unit('a'), ['s1'])
  const listVisible = vi.fn(visible)

  const r = await runMigration(scope, undefined, { listVisible })
  expect(r).toMatchObject({ ok: true, archived: 3, moved: 1 })
  // before, after the pilot; nothing more
  expect(listVisible).toHaveBeenCalledTimes(2)
  for (const n of ['a', 'b', 'c']) expect(await codexRolloutState(`unit-${n}`, scope.codexHome)).toBe('archived')
  const to = path.join(scope.genioClaudeDir, 'projects', claudeProjectName(unit('a')))
  expect(fs.existsSync(from)).toBe(false)
  expect(fs.existsSync(path.join(to, 's1.jsonl'))).toBe(true)

  const m = readManifest(scope.manifestFile)
  expect(m.items.map(i => [i.kind, i.id])).toEqual([
    ['codex-archive', 'unit-a'], ['codex-archive', 'unit-b'], ['codex-archive', 'unit-c'],
    ['claude-move', claudeProjectName(unit('a'))]
  ])
  expect(m.items[0]).toMatchObject({ codexHome: scope.codexHome, to: path.join(scope.codexHome, 'archived_sessions', 'rollout-2026-10-13T10-00-00-unit-a.jsonl') })
  expect(m.items[3]).toMatchObject({ from, to, mode: 'folder' })
  // Shared history files are never touched: none were created.
  expect(fs.existsSync(path.join(scope.claudeDir, 'history.jsonl'))).toBe(false)
})

it('aborts the Codex part when the pilot still shows in the thread list', async () => {
  for (const n of ['a', 'b']) thread(`unit-${n}`, unit(n))
  claudeFolder(unit('a'), ['s1'])
  // A Codex whose list ignores archiving: the pilot never leaves.
  const stuck = ['unit-a', 'unit-b']
  const r = await runMigration(scope, undefined, { listVisible: async () => stuck })
  expect(r.ok).toBe(false)
  expect(r.aborted).toMatch(/still lists it/)
  expect(r.archived).toBe(1)
  expect(await codexRolloutState('unit-b', scope.codexHome)).toBe('live')
  // The pilot is in the manifest, so Undo can restore it.
  expect(readManifest(scope.manifestFile).items.filter(i => i.kind === 'codex-archive').map(i => i.id)).toEqual(['unit-a'])
  // Claude folders do not depend on Codex.
  expect(r.moved).toBe(1)
})

it('archives nothing when the thread list cannot be read', async () => {
  thread('unit-a', unit('a'))
  const r = await runMigration(scope, undefined, { listVisible: async () => { throw new Error('no codex') } })
  expect(r).toMatchObject({ ok: false, archived: 0 })
  expect(await codexRolloutState('unit-a', scope.codexHome)).toBe('live')
})

it('leaves a thread Codex refuses (open in the app) and touches only confirmed keys', async () => {
  thread('unit-a', unit('a'))
  thread('unit-open', unit('open'))
  thread('unit-unconfirmed', unit('later'))
  fs.writeFileSync(path.join(scope.codexHome, 'live-unit-open'), '')
  const r = await runMigration(scope, ['codex:unit-a', 'codex:unit-open'], { listVisible: visible })
  expect(r.archived).toBe(1)
  expect(r.skipped).toEqual([expect.objectContaining({ reason: 'open in Codex' })])
  expect(await codexRolloutState('unit-open', scope.codexHome)).toBe('live')
  expect(await codexRolloutState('unit-unconfirmed', scope.codexHome)).toBe('live')
})

it('merges into a folder Genio already has, and Undo restores everything', async () => {
  thread('unit-a', unit('a'))
  const from = claudeFolder(base, ['old-chat'])
  const to = path.join(scope.genioClaudeDir, 'projects', claudeProjectName(base))
  fs.mkdirSync(to, { recursive: true })
  fs.writeFileSync(path.join(to, 'new-chat.jsonl'), '{}\n')
  const moveOnly = claudeFolder(unit('b'), ['s1'])

  expect(await runMigration(scope, undefined, { listVisible: visible })).toMatchObject({ ok: true, archived: 1, moved: 2 })
  expect(fs.readdirSync(to).sort()).toEqual(['new-chat.jsonl', 'old-chat.jsonl'])

  const u = await undoMigration(scope.manifestFile, { cli: runCodexCli })
  expect(u).toMatchObject({ ok: true, restored: 3 })
  expect(await codexRolloutState('unit-a', scope.codexHome)).toBe('live')
  expect(fs.readdirSync(from)).toEqual(['old-chat.jsonl'])
  // Genio's own newer conversation stays in Genio's folder.
  expect(fs.readdirSync(to)).toEqual(['new-chat.jsonl'])
  expect(fs.readdirSync(moveOnly)).toEqual(['s1.jsonl'])
  expect(readManifest(scope.manifestFile).items.every(i => i.restoredAt)).toBe(true)
  // A second Undo has nothing left to do.
  expect(await undoMigration(scope.manifestFile)).toMatchObject({ ok: true, restored: 0 })
})

it('Undo never overwrites a folder the player has again', async () => {
  const from = claudeFolder(unit('a'), ['s1'])
  await runMigration(scope, undefined, { listVisible: visible })
  // Claude recreated the folder with the same session name meanwhile.
  fs.mkdirSync(from, { recursive: true })
  fs.writeFileSync(path.join(from, 's1.jsonl'), 'player copy\n')
  const u = await undoMigration(scope.manifestFile)
  expect(u.ok).toBe(false)
  expect(fs.readFileSync(path.join(from, 's1.jsonl'), 'utf8')).toBe('player copy\n')
  expect(readManifest(scope.manifestFile).items[0].restoredAt).toBeUndefined()
})

it("keeps Claude folders in place when Genio's own Claude folder is unavailable", async () => {
  claudeFolder(unit('a'), ['s1'])
  scope.genioClaudeDir = ''
  const plan = await planMigration(scope)
  expect(plan.claude).toEqual([])
  expect(plan.skipped).toEqual([expect.objectContaining({ reason: "Genio's own Claude folder is unavailable" })])
})

it("builds the scope from Genio's registries: bases, unit worktrees, chat ids and the live Claude registry", async () => {
  vi.stubEnv('CODEX_HOME', scope.codexHome)
  vi.stubEnv('CLAUDE_CONFIG_DIR', scope.claudeDir)
  const home = new Home(base); home.ensure()
  const allyHome = path.join(root, 'elsewhere', 'ally-base')
  fs.mkdirSync(path.dirname(home.wkspFile), { recursive: true })
  fs.writeFileSync(home.wkspFile, JSON.stringify({ providers: { active: 'codex', ids: { claude: 'claude-chat', codex: 'codex-chat' } } }))
  fs.mkdirSync(path.join(scope.claudeDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(scope.claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'registry-live', cwd: unit('registry') }))
  const tasks = [
    { id: 'run', state: 'working', worktree: unit('run'), terminalId: 'term-run', codexSessionId: 'codex-run' },
    { id: 'old', state: 'exited', worktree: unit('old'), terminalId: 'term-old' }
  ]
  const ctx = {
    main: { home }, homes: new Map([['main', { home, crew: { list: () => tasks } }]]),
    allies: { list: () => [{ name: 'ally', home: allyHome }] },
    terminals: { get: (id: string) => ({ alive: id === 'term-run' }) }
  } as unknown as AppCtx
  const s = migrationScope(ctx)
  expect(s.genioRoots).toEqual(expect.arrayContaining([home.root, allyHome, unit('run'), unit('old')]))
  expect(s.liveCwds).toEqual([unit('run'), unit('registry')])
  expect(s.liveSessionIds.sort()).toEqual(['claude-chat', 'codex-chat', 'codex-run', 'registry-live'])
  expect(s).toMatchObject({ codexHome: scope.codexHome, claudeDir: scope.claudeDir, manifestFile: path.join(home.data, 'session-migration.json') })

  thread('codex-chat', player, 'genio_chat')
  thread('ally-thread', path.join(allyHome, 'worktrees', 'w', 'u'))
  claudeFolder(unit('registry'), ['other'])
  claudeFolder(unit('old'), ['done'])
  const plan = await planMigration(s)
  expect(plan.codex.map(c => c.id)).toEqual(['ally-thread'])
  expect(plan.claude.map(c => c.name)).toEqual([claudeProjectName(unit('old'))])
  expect(plan.skipped.map(x => x.key).sort()).toEqual(['claude:' + claudeProjectName(unit('registry')), 'codex:codex-chat'])
})

it('reads the visible thread list through the app-server, page by page, without starting a thread', async () => {
  const calls: { method: string; params: any }[] = []
  const pages: Record<string, any> = { '': { data: [{ id: 't1' }, { id: 't2' }], nextCursor: 'p2' }, p2: { data: [{ id: 't3' }], nextCursor: null } }
  const closed = vi.fn()
  const ids = await listVisibleCodexThreads(scope.codexHome, () => ({
    request: async (method, params: any) => { calls.push({ method, params }); return method === 'thread/list' ? pages[params.cursor ?? ''] : {} },
    notify: () => undefined,
    close: closed
  }))
  expect(ids).toEqual(['t1', 't2', 't3'])
  expect(calls.map(c => c.method)).toEqual(['initialize', 'thread/list', 'thread/list'])
  expect(calls[1].params).toMatchObject({ useStateDbOnly: true, archived: false })
  expect(closed).toHaveBeenCalled()
})
