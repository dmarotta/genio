import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AppCtx } from '../src/main/services'
import type { Task } from '../src/shared/types'
import { playerSources, sourceUnit } from '../src/main/player-sources'

// Disposable repositories only; the picker reads git, never Genio's own copies.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true }).trim()
let scratch: string, repo: string, data: string, tasks: Task[], engine: string
const ctx = () => ({
  projects: { get: (name: string) => name === 'game' ? { name: 'game', path: repo, engine, engineRoot: '' } : undefined },
  homes: new Map([['main', { crew: { list: () => tasks } }]]),
  main: { home: { data } }
}) as unknown as AppCtx

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-sources-'))); repo = path.join(scratch, 'game'); data = path.join(scratch, 'data')
  engine = 'unity'; tasks = []
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', 'develop'); git(repo, 'branch', 'dani/tutorial')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/fog', path.join(scratch, 'game-fog'))
  git(repo, 'worktree', 'add', '-q', '-b', 'genio/lairs-ai', path.join(scratch, 'unit-lairs'))
  // A Genio slot copy registered as a worktree is never a source.
  git(repo, 'worktree', 'add', '-q', '--detach', path.join(data, 'play-pools', 'abc', 'slot-1'))
  fs.writeFileSync(path.join(scratch, 'unit-lairs', 'new.txt'), 'x'); fs.writeFileSync(path.join(scratch, 'unit-lairs', 'a.txt'), 'changed')
  tasks = [
    { id: 'lairs-1', title: 'Lairs AI', project: 'game', worktree: path.join(scratch, 'unit-lairs'), state: 'working' },
    { id: 'old-2', title: 'Old', project: 'game', worktree: path.join(scratch, 'gone'), state: 'cleaned' },
    { id: 'other-3', title: 'Other project', project: 'other', worktree: path.join(scratch, 'game-fog'), state: 'working' }
  ] as Task[]
})
afterEach(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

it('lists main, worktrees, units by name and branches without a checkout', async () => {
  const sources = await playerSources(ctx(), 'game')
  expect(sources.slice(0, 3).map(s => [s.group, s.label, s.branch])).toEqual([
    ['main', 'Main checkout', 'main'],
    ['worktree', 'game-fog', 'feat/fog'],
    ['unit', 'Lairs AI', 'genio/lairs-ai']
  ])
  // Same commit date: their order is git's; only the set matters here.
  expect(sources.slice(3).map(s => [s.group, s.label]).sort()).toEqual([['branch', 'dani/tutorial'], ['branch', 'develop']])
  const main = sources.find(s => s.group === 'main')!, unit = sources.find(s => s.group === 'unit')!, branch = sources.find(s => s.id === 'branch:develop')!
  expect(main).toMatchObject({ dirty: 0, source: { path: path.resolve(repo) } })
  expect(main.head).toMatch(/^[0-9a-f]{40}$/)
  expect(unit).toMatchObject({ id: 'unit:lairs-1', task: 'lairs-1', dirty: 2 })
  expect(branch.source).toEqual({ ref: 'develop' })
  expect(sources.some(s => 'path' in s.source && s.source.path.includes('play-pools'))).toBe(false)
  // Branches checked out somewhere are offered as that checkout, not again as commits.
  expect(sources.filter(s => s.group === 'branch').map(s => s.label)).not.toContain('feat/fog')
})

it('names the unit a source plays, and refuses projects without a supported engine', async () => {
  expect(sourceUnit(ctx(), 'game', { path: path.join(scratch, 'unit-lairs') })?.id).toBe('lairs-1')
  expect(sourceUnit(ctx(), 'game', { path: path.join(scratch, 'game-fog') })).toBeUndefined()
  expect(sourceUnit(ctx(), 'game', { ref: 'develop' })).toBeUndefined()
  engine = 'godot'
  await expect(playerSources(ctx(), 'game')).rejects.toThrow('Unity')
  await expect(playerSources(ctx(), 'missing')).rejects.toThrow('Unknown')
})
