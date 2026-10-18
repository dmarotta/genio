import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Home } from '../src/main/home'
import { claudeProjectName } from '../src/main/claude-home'
import { legacyPath, migrateWorkspaces, modernPath, restoreWorkspaces, rewriteLegacyPaths } from '../src/main/workspaces-migration'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })

let dir: string, root: string, repo: string, playerClaude: string, wt: string
const warnings: string[] = []
const opts = () => ({ warn: (m: string) => warnings.push(m), playerClaude })
const write = (p: string, text: string): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const fwd = (p: string): string => p.replace(/\\/g, '/')

beforeEach(() => {
  warnings.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-ws-'))
  root = path.join(dir, '.genio')
  playerClaude = path.join(dir, 'player-claude')
  repo = path.join(dir, 'game')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  write(path.join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init')
  wt = path.join(root, 'wksps', 'game', 'worktrees', 'game', 'u1')
  fs.mkdirSync(path.dirname(wt), { recursive: true })
  git(repo, 'worktree', 'add', '-q', '-b', 'u1', wt)

  const oldBase = path.join(root, 'wksps', 'game')
  write(path.join(root, 'data', 'allies.json'), JSON.stringify([{ name: 'game', home: oldBase }]))
  write(path.join(root, 'data', 'projects.json'), JSON.stringify([{ name: 'game', path: repo }]))
  write(path.join(oldBase, 'state', 'tasks.json'), JSON.stringify([{ id: 'u1', state: 'ready', worktree: wt, briefPath: path.join(oldBase, 'data', 'u1', 'brief.md') }]))
  write(path.join(oldBase, 'state', 'u1.claude-settings.json'), JSON.stringify({ dir: fwd(wt) }))
  write(path.join(oldBase, 'state', 'u1.mcp-config.json'), JSON.stringify({ cwd: wt }))
  write(path.join(oldBase, 'data', 'u1', 'brief.md'), `worktree at ${fwd(wt)}`)
  write(path.join(oldBase, 'data', 'plans.json'), JSON.stringify([{ step: { worktree: wt } }]))
  // Genio's own Claude home keeps a conversation keyed by the worktree folder and by the ally folder.
  const projects = path.join(root, 'claude-home', 'projects')
  write(path.join(projects, claudeProjectName(wt), 's1.jsonl'), '{}')
  write(path.join(projects, claudeProjectName(oldBase), 's2.jsonl'), '{}')
  write(path.join(root, 'claude-home', '.claude.json'), JSON.stringify({ projects: { [fwd(wt)]: { hasTrustDialogAccepted: true } } }))
  // A conversation that exists only in the player's own folder.
  write(path.join(playerClaude, 'projects', claudeProjectName(path.join(root, 'wksps', 'art')), 'p1.jsonl'), '{}')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('workspaces migration', () => {
  it('moves wksps/ to workspaces/, repairs paths and git worktrees, and keeps conversations', () => {
    const r = migrateWorkspaces(root, opts())
    expect(r.status).toBe('done')
    expect(fs.existsSync(path.join(root, 'wksps'))).toBe(false)
    const nwt = path.join(root, 'workspaces', 'game', 'worktrees', 'game', 'u1')
    expect(fs.existsSync(path.join(nwt, 'a.txt'))).toBe(true)
    // git works in the moved worktree and lists it at its new place
    expect(git(nwt, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(fwd(nwt))
    // stored absolute paths (backslash and slash forms, JSON-escaped or not) point into workspaces/
    const newBase = path.join(root, 'workspaces', 'game')
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data', 'allies.json'), 'utf8'))[0].home).toBe(newBase)
    const task = JSON.parse(fs.readFileSync(path.join(newBase, 'state', 'tasks.json'), 'utf8'))[0]
    expect(task.worktree).toBe(nwt)
    expect(task.briefPath).toBe(path.join(newBase, 'data', 'u1', 'brief.md'))
    expect(fs.readFileSync(path.join(newBase, 'state', 'u1.claude-settings.json'), 'utf8')).toContain(fwd(nwt))
    expect(fs.readFileSync(path.join(newBase, 'state', 'u1.mcp-config.json'), 'utf8')).not.toMatch(/wksps/)
    expect(fs.readFileSync(path.join(newBase, 'data', 'u1', 'brief.md'), 'utf8')).toBe(`worktree at ${fwd(nwt)}`)
    expect(fs.readFileSync(path.join(newBase, 'data', 'plans.json'), 'utf8')).not.toMatch(/wksps/)
    expect(fs.readFileSync(path.join(root, 'claude-home', '.claude.json'), 'utf8')).toContain(fwd(nwt))
    // conversations are copied under the new folder names; the originals stay
    const projects = path.join(root, 'claude-home', 'projects')
    expect(fs.existsSync(path.join(projects, claudeProjectName(nwt), 's1.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(projects, claudeProjectName(newBase), 's2.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(projects, claudeProjectName(path.join(root, 'wksps', 'game', 'worktrees', 'game', 'u1')), 's1.jsonl'))).toBe(true)
    // the player's own Claude folder is only reported, never touched
    if (r.status === 'done') expect(r.manifest.playerFolderSessions).toHaveLength(1)
    expect(fs.readdirSync(path.join(playerClaude, 'projects'))).toEqual([claudeProjectName(path.join(root, 'wksps', 'art'))])
    expect(warnings).toEqual([])
  })

  it('is idempotent', () => {
    migrateWorkspaces(root, opts())
    const before = fs.readFileSync(path.join(root, 'data', 'allies.json'), 'utf8')
    expect(migrateWorkspaces(root, opts()).status).toBe('none')
    expect(fs.readFileSync(path.join(root, 'data', 'allies.json'), 'utf8')).toBe(before)
  })

  it('resumes an interrupted run at the repair phase', () => {
    migrateWorkspaces(root, opts())
    const file = path.join(root, 'data', 'allies.json')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('workspaces', 'wksps'))
    const manifestFile = path.join(root, 'backups', 'workspaces-migration', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    fs.writeFileSync(manifestFile, JSON.stringify({ ...m, phase: 'renamed' }))
    expect(migrateWorkspaces(root, opts()).status).toBe('done')
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/wksps/)
  })

  it('restores the checkpoint: folder, records and git registrations', () => {
    const before = fs.readFileSync(path.join(root, 'data', 'allies.json'), 'utf8')
    const taskBefore = fs.readFileSync(path.join(root, 'wksps', 'game', 'state', 'tasks.json'), 'utf8')
    migrateWorkspaces(root, opts())
    expect(restoreWorkspaces(root).ok).toBe(true)
    expect(fs.existsSync(path.join(root, 'workspaces'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'data', 'allies.json'), 'utf8')).toBe(before)
    expect(fs.readFileSync(path.join(root, 'wksps', 'game', 'state', 'tasks.json'), 'utf8')).toBe(taskBefore)
    expect(git(wt, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(fwd(wt))
    // a restored base is not migrated again behind the player's back
    expect(migrateWorkspaces(root, opts()).status).toBe('none')
    expect(fs.existsSync(path.join(root, 'wksps'))).toBe(true)
  })

  it('stops with one warning and deletes nothing when workspaces/ already exists', () => {
    write(path.join(root, 'workspaces', 'keep.txt'), 'x')
    const r = migrateWorkspaces(root, opts())
    expect(r.status).toBe('blocked')
    migrateWorkspaces(root, opts())
    expect(warnings).toHaveLength(1)
    expect(fs.existsSync(path.join(root, 'workspaces', 'keep.txt'))).toBe(true)
    expect(fs.existsSync(wt)).toBe(true)
  })

  it('waits while a unit is running', () => {
    const tasks = path.join(root, 'wksps', 'game', 'state', 'tasks.json')
    write(tasks, JSON.stringify([{ id: 'u1', state: 'working', pid: 4242, worktree: wt }]))
    expect(migrateWorkspaces(root, { ...opts(), pidAlive: () => true }).status).toBe('deferred')
    expect(fs.existsSync(path.join(root, 'wksps'))).toBe(true)
    expect(migrateWorkspaces(root, { ...opts(), pidAlive: () => false }).status).toBe('done')
  })

  it('does nothing for a new install, which creates workspaces/', () => {
    const fresh = path.join(dir, 'fresh')
    const home = new Home(fresh, 'main')
    home.ensure()
    expect(migrateWorkspaces(fresh, opts()).status).toBe('none')
    expect(home.workspaceHome('art')).toBe(path.join(path.resolve(fresh), 'workspaces', 'art'))
  })

  it('reads the old path form for a record that could not be rewritten', () => {
    migrateWorkspaces(root, opts())
    expect(modernPath(root, wt)).toBe(path.join(root, 'workspaces', 'game', 'worktrees', 'game', 'u1'))
    expect(modernPath(root, path.join(root, 'workspaces', 'game'))).toBe(path.join(root, 'workspaces', 'game'))
    expect(modernPath(root, path.join(root, 'wksps', 'gone'))).toBe(path.join(root, 'wksps', 'gone'))
    expect(modernPath(root, undefined)).toBeUndefined()
    expect(legacyPath(root, path.join(root, 'workspaces', 'game', 'worktrees'))).toBe(path.join(root, 'wksps', 'game', 'worktrees'))
    expect(legacyPath(root, path.join(root, 'worktrees', 'x'))).toBe(path.join(root, 'worktrees', 'x'))
  })

  it('rewrites only whole wksps segments in every slash style', () => {
    const win = 'C:\\Users\\p\\.genio'
    const text = `${win}\\wksps\\a, C:/Users/p/.genio/wksps/b, "C:\\\\Users\\\\p\\\\.genio\\\\wksps\\\\c", ${win}\\wksps-old, /home/x/.genio/wksps/d`
    const out = rewriteLegacyPaths(text, win)
    expect(out).toBe(`C:\\Users\\p\\.genio\\workspaces\\a, C:/Users/p/.genio/workspaces/b, "C:\\\\Users\\\\p\\\\.genio\\\\workspaces\\\\c", ${win}\\wksps-old, /home/x/.genio/workspaces/d`)
  })
})
