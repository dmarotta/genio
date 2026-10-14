import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  archiveCodexThreads, archiveUnitThreads, manifestFile, MAX_ARCHIVE_ATTEMPTS, pendingFile, retryPendingArchives, scheduleUnitArchive, unarchiveCodexThread,
  type ArchiveEntry, type PendingArchive
} from '../src/main/codex-archive'
import { codexRolloutState } from '../src/main/codex-session'

// Only temp Codex homes: the fake CLI moves rollouts the way `codex archive` does.
const FAKE = path.join(__dirname, 'fixtures', 'fake-codex.mjs')
let root: string, codexHome: string, data: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-archive-'))
  codexHome = path.join(root, 'codex')
  data = path.join(root, 'data')
  fs.mkdirSync(codexHome, { recursive: true })
  vi.stubEnv('CODEX_HOME', codexHome)
  vi.stubEnv('GENIO_CODEX_BIN', FAKE)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

function thread(id: string, cwd: string): string {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '14')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-14T10:00:00Z' } }) + '\n')
  return file
}
const live = (id: string, open = true): void => {
  const marker = path.join(codexHome, `live-${id}`)
  if (open) fs.writeFileSync(marker, '')
  else fs.rmSync(marker)
}
const manifest = (): ArchiveEntry[] => fs.existsSync(manifestFile(data)) ? fs.readFileSync(manifestFile(data), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const pending = (): PendingArchive[] => fs.existsSync(pendingFile(data)) ? JSON.parse(fs.readFileSync(pendingFile(data), 'utf8')) : []
const calls = (): string[] => fs.existsSync(path.join(codexHome, 'fake-calls.jsonl'))
  ? fs.readFileSync(path.join(codexHome, 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(l => { const c = JSON.parse(l); return `${c.command} ${c.id}` }) : []

it("archives every thread of a despawned unit's worktree, and only those, with a manifest entry each", async () => {
  thread('a1', '/worktrees/unit')
  thread('a2', '/worktrees/unit')
  thread('other', '/worktrees/unit-b')
  const r = await archiveUnitThreads('/worktrees/unit', { dataDir: data, codexHome, task: 'unit' })
  expect(r.archived.sort()).toEqual(['a1', 'a2'])
  expect(r.pending).toEqual([])
  expect(await codexRolloutState('a1', codexHome)).toBe('archived')
  expect(await codexRolloutState('other', codexHome)).toBe('live')
  expect(manifest().map(e => [e.action, e.id, e.task, e.cwd]).sort()).toEqual([['archive', 'a1', 'unit', '/worktrees/unit'], ['archive', 'a2', 'unit', '/worktrees/unit']])
  expect(path.resolve(manifest()[0].codexHome)).toBe(path.resolve(codexHome))
  expect(pending()).toEqual([])
  // A second despawn pass finds nothing left to archive and never calls Codex again.
  expect(await archiveUnitThreads('/worktrees/unit', { dataDir: data, codexHome, task: 'unit' })).toEqual({ archived: [], pending: [], skipped: [] })
  expect(calls().sort()).toEqual(['archive a1', 'archive a2'])
})

it('keeps a thread Codex refuses (still live or open) in the retry list and archives it once it is free', async () => {
  thread('busy', '/unit')
  live('busy')
  const first = await archiveCodexThreads(['busy'], { dataDir: data, codexHome, task: 'unit', cwd: '/unit' })
  expect(first).toEqual({ archived: [], pending: ['busy'], skipped: [] })
  expect(await codexRolloutState('busy', codexHome)).toBe('live')
  expect(pending()).toMatchObject([{ id: 'busy', task: 'unit', cwd: '/unit', attempts: 1 }])
  expect(manifest()).toEqual([])
  expect((await retryPendingArchives(data)).pending).toEqual(['busy'])
  expect(pending()[0].attempts).toBe(2)
  live('busy', false)
  expect((await retryPendingArchives(data)).archived).toEqual(['busy'])
  expect(pending()).toEqual([])
  expect(manifest()).toMatchObject([{ action: 'archive', id: 'busy', task: 'unit', cwd: '/unit' }])
})

it('lets a thread kept open in the Codex app be after the attempt cap', async () => {
  thread('open', '/unit')
  live('open')
  for (let i = 0; i < MAX_ARCHIVE_ATTEMPTS; i++) await archiveCodexThreads(['open'], { dataDir: data, codexHome })
  expect(pending()).toEqual([])
  expect(await codexRolloutState('open', codexHome)).toBe('live')
})

it('skips threads already archived elsewhere, unknown ids and invalid ids without calling Codex', async () => {
  thread('done', '/unit')
  await archiveCodexThreads(['done'], { dataDir: data, codexHome })
  const r = await archiveCodexThreads(['done', 'never-existed', '--last'], { dataDir: data, codexHome })
  expect(r).toEqual({ archived: [], pending: [], skipped: ['done', 'never-existed'] })
  expect(calls()).toEqual(['archive done'])
})

it('reports a missing Codex CLI as pending, never as archived', async () => {
  thread('t1', '/unit')
  const cli = vi.fn(async () => ({ code: 127, stdout: '', stderr: 'Codex CLI is not installed' }))
  expect(await archiveCodexThreads(['t1'], { dataDir: data, codexHome, cli })).toEqual({ archived: [], pending: ['t1'], skipped: [] })
  expect(cli).toHaveBeenCalledWith(['archive', 't1'], path.resolve(codexHome))
  expect(manifest()).toEqual([])
})

it('unarchives before a resume, records it, and stops a pending retry from hiding the resumed thread', async () => {
  thread('back', '/unit')
  await archiveCodexThreads(['back'], { dataDir: data, codexHome, task: 'unit', cwd: '/unit' })
  expect(await codexRolloutState('back', codexHome)).toBe('archived')
  expect(await unarchiveCodexThread('back', { dataDir: data, codexHome, task: 'unit', cwd: '/unit' })).toBe(true)
  expect(await codexRolloutState('back', codexHome)).toBe('live')
  expect(manifest().map(e => e.action)).toEqual(['archive', 'unarchive'])

  thread('queued', '/unit')
  live('queued')
  await archiveCodexThreads(['queued'], { dataDir: data, codexHome })
  expect(await unarchiveCodexThread('queued', { dataDir: data, codexHome })).toBe(true)
  expect(pending()).toEqual([])
  live('queued', false)
  expect(await retryPendingArchives(data)).toEqual({ archived: [], pending: [], skipped: [] })
  expect(await codexRolloutState('queued', codexHome)).toBe('live')
  // A live thread needs no unarchive; a failing unarchive reports false so the caller starts fresh.
  expect(calls().filter(c => c.startsWith('unarchive'))).toEqual(['unarchive back'])
  await archiveCodexThreads(['queued'], { dataDir: data, codexHome })
  expect(await unarchiveCodexThread('queued', { dataDir: data, codexHome, cli: async () => ({ code: 1, stdout: '', stderr: 'failed' }) })).toBe(false)
})

it('schedules the despawn archive after the process had time to exit, then retries what Codex refused', async () => {
  vi.useFakeTimers()
  thread('u1', '/unit')
  live('u1')
  scheduleUnitArchive('/unit', { dataDir: data, codexHome, task: 'unit' }, [1_000, 2_000])
  expect(calls()).toEqual([])
  await vi.advanceTimersByTimeAsync(1_000)
  await vi.waitFor(() => expect(pending()).toHaveLength(1))
  live('u1', false)
  await vi.advanceTimersByTimeAsync(2_000)
  await vi.waitFor(() => expect(manifest()).toMatchObject([{ action: 'archive', id: 'u1', task: 'unit' }]))
  expect(pending()).toEqual([])
})
