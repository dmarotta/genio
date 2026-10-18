import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexRolloutState, discoverCodexSession, findCodexSessions } from '../src/main/codex-session'

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-codex-session-')) })
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

function session(id: string, cwd: string, timestamp = '2026-10-13T10:00:00Z', archived = false): string {
  const dir = archived ? path.join(home, 'archived_sessions') : path.join(home, 'sessions', '2026', '10', '13')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-10-13T10-00-00-${id}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp } }) + '\n')
  return file
}

it('finds the unit session even when another unit was active more recently', async () => {
  session('own', '/worktrees/unit-a')
  session('other', '/worktrees/unit-b', '2026-10-13T11:00:00Z')
  session('child', '/worktrees/unit-a/child', '2026-10-13T12:00:00Z')
  expect(await discoverCodexSession('/worktrees/unit-a', home)).toBe('own')
  expect(await discoverCodexSession('/worktrees/unit', home)).toBeUndefined()
})

it('normalizes Windows separators, casing and trailing separators', async () => {
  session('own', 'C:\\Users\\Player\\worktrees\\unit-a')
  expect(await discoverCodexSession('c:/users/player/worktrees/unit-a/', home)).toBe('own')
})

it('discovers the newest matching session but keeps a verified remembered session', async () => {
  const old = session('old', '/unit', '2026-10-13T09:00:00Z')
  session('new', '/unit')
  session('foreign', '/other', '2026-10-13T12:00:00Z')
  fs.utimesSync(old, new Date(), new Date()) // Activity does not change session creation order.
  expect(await discoverCodexSession('/unit', home)).toBe('new')
  expect(await discoverCodexSession('/unit', home, 'old')).toBe('old')
  expect(await discoverCodexSession('/unit', home, 'foreign')).toBe('new')
  expect(await discoverCodexSession('/unit', home, 'missing')).toBe('new')
})

it('ignores malformed or incomplete headers and never reads later metadata as ownership', async () => {
  const bad = session('bad', '/unit')
  fs.writeFileSync(bad, '{"type":"session_meta","payload":')
  const later = session('later', '/unit')
  fs.writeFileSync(later, '{}\n' + JSON.stringify({ type: 'session_meta', payload: { id: 'later', cwd: '/unit' } }))
  const invalid = session('invalid', '/unit')
  fs.writeFileSync(invalid, JSON.stringify({ type: 'session_meta', payload: { id: '--last', cwd: '/unit' } }))
  expect(await discoverCodexSession('/unit', home, 'bad')).toBeUndefined()
  session('valid', '/unit')
  expect(await discoverCodexSession('/unit', home)).toBe('valid')
})

it('uses CODEX_HOME and handles a missing session directory without resuming elsewhere', async () => {
  vi.stubEnv('CODEX_HOME', home)
  expect(await discoverCodexSession('/unit')).toBeUndefined()
  session('own', '/unit')
  expect(await discoverCodexSession('/unit')).toBe('own')
  expect(await discoverCodexSession('/missing', home, 'own')).toBeUndefined()
})

it('discovers archived sessions too, so a resume can unarchive them', async () => {
  session('old', '/unit', '2026-10-13T09:00:00Z')
  session('archived', '/unit', '2026-10-13T11:00:00Z', true)
  session('foreign', '/other', '2026-10-13T12:00:00Z', true)
  expect(await discoverCodexSession('/unit', home)).toBe('archived')
  expect(await discoverCodexSession('/unit', home, 'old')).toBe('old')
  const all = await findCodexSessions('/unit', home)
  expect(all.map(s => [s.id, s.archived]).sort()).toEqual([['archived', true], ['old', false]])
})

it('tells where a thread rollout lives now', async () => {
  session('live', '/unit')
  session('gone-by', '/unit', undefined, true)
  expect(await codexRolloutState('live', home)).toBe('live')
  expect(await codexRolloutState('gone-by', home)).toBe('archived')
  expect(await codexRolloutState('missing', home)).toBe('missing')
  expect(await codexRolloutState('live', path.join(home, 'nowhere'))).toBe('missing')
})

it('reads large metadata headers with UTF-8 paths and ignores transcript content', async () => {
  const file = session('large', '/unit-世界')
  fs.writeFileSync(file, JSON.stringify({
    type: 'session_meta', timestamp: '2026-10-13T10:00:00Z',
    payload: { instructions: '世界'.repeat(20_000), session_id: 'large', cwd: '/unit-世界' }
  }) + '\r\nnot valid metadata\n')
  expect(await discoverCodexSession('/unit-世界', home)).toBe('large')
})
