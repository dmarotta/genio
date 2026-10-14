import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FleetSnapshot, GenioEvent, Task, TerminalInfo } from '../src/shared/types'
import type { AppCtx } from '../src/main/services'
import { Home } from '../src/main/home'
import * as git from '../src/main/git'
import { createProjectsService, normalisedProjectPath, uniqueProjectName } from '../src/main/projects'
import { projectFromArgv, projectSnapshot, routeProjectEvent, terminalProject } from '../src/main/project-windows'
import { ACHIEVEMENTS } from '../src/main/stats'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-window-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
function registry() {
  const home = new Home(path.join(root, 'base')); home.ensure()
  return createProjectsService(() => ({ main: { home }, ledger: { record() {} } }) as unknown as AppCtx)
}
function folder(relative: string) {
  const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true }); return dir
}

describe('opening folders', () => {
  it('normalizes Windows paths without folding POSIX case, and suffixes colliding names', () => {
    expect(normalisedProjectPath('C:/Games/One/../Game/', 'win32')).toBe(normalisedProjectPath('c:\\games\\game', 'win32'))
    expect(normalisedProjectPath('/Games/One', 'linux')).not.toBe(normalisedProjectPath('/games/one', 'linux'))
    expect(uniqueProjectName('C:/games/game', ['Game', 'game-2'])).toBe('game-3')
  })
  it('registers non-git folders Offline, detects nested engines and keeps repeated opens idempotent', async () => {
    const dir = folder('game')
    fs.mkdirSync(path.join(dir, 'nested', 'ProjectSettings'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nested', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0')
    const svc = registry()
    const first = await svc.openFolder(dir)
    expect(first.registered).toBe(true)
    expect(first.project).toMatchObject({ gitRepo: false, defaultBranch: '', mode: 'local-only', forge: 'none', engine: 'unity', engineRoot: 'nested' })
    expect(first.project.remote).toBeUndefined()
    expect((await svc.openFolder(path.join(dir, '.'))).registered).toBe(false)
    expect(svc.list()).toHaveLength(1)
    expect(await svc.sync(first.project.name)).toMatchObject({ ok: false, message: expect.stringContaining('needs a git repo') })
    expect(await svc.push(first.project.name)).toMatchObject({ ok: false, message: expect.stringContaining('needs a git repo') })
    expect(svc.update(first.project.name, { mode: 'direct-PR', remote: 'bad' })).toMatchObject({ mode: 'local-only', remote: undefined })
  })
  it('resolves the git top, reuses it from a subfolder, and refreshes a newly initialized folder', async () => {
    const dir = folder('game'); const nested = folder('game/nested')
    const svc = registry(); const first = await svc.openFolder(dir)
    await git.initRepo(dir, 'main')
    await git.git(dir, ['remote', 'add', 'origin', 'https://github.com/test/game.git'])
    const opened = await svc.openFolder(nested)
    expect(opened.registered).toBe(false)
    expect(opened.project).toMatchObject({ name: first.project.name, gitRepo: true, mode: 'direct-PR', defaultBranch: 'main' })
    expect(normalisedProjectPath(opened.project.path)).toBe(normalisedProjectPath(dir))
    expect(svc.list()).toHaveLength(1)
  })
  it('serializes concurrent registrations and distinguishes folders with equal names', async () => {
    const a = folder('a/game'); const b = folder('b/game'); const svc = registry()
    const result = await Promise.all([svc.openFolder(a), svc.openFolder(b), svc.openFolder(a)])
    expect(result.map(r => r.project.name)).toEqual(['game', 'game-2', 'game'])
    expect(svc.list()).toHaveLength(2)
  })
  it('rejects missing folders and files without registering them', async () => {
    const svc = registry(); fs.writeFileSync(path.join(root, 'file'), '')
    await expect(svc.openFolder(path.join(root, 'missing'))).rejects.toThrow()
    await expect(svc.openFolder(path.join(root, 'file'))).rejects.toThrow('folder')
    expect(svc.list()).toEqual([])
  })
})

describe('CLI entry', () => {
  it('uses each launch working directory for relative folders and skips the development entry', () => {
    expect(projectFromArgv(['electron', '.', '.'], root, true)).toBe(root)
    expect(projectFromArgv(['electron', 'app', '../game'], root, true)).toBe(path.resolve(root, '../game'))
    expect(projectFromArgv(['Genio.exe', '.'], root, false)).toBe(root)
    expect(projectFromArgv(['Genio.exe', 'folder with spaces'], root, false)).toBe(path.join(root, 'folder with spaces'))
    expect(projectFromArgv(['electron', '.'], root, true)).toBeUndefined()
    expect(projectFromArgv(['Genio.exe', '--inspect=9229'], root, false)).toBeUndefined()
    expect(projectFromArgv(['Genio.exe', '--', '-folder'], root, false)).toBe(path.join(root, '-folder'))
  })
  it('covers both entry points with feature-tagged achievements', () => {
    expect(ACHIEVEMENTS.find(a => a.id === 'project-window-open')?.feature).toBe('project-window')
    expect(ACHIEVEMENTS.find(a => a.id === 'project-cli-open')?.feature).toBe('project-cli')
  })
})

describe('window routing', () => {
  const binding = { project: 'one', wksp: 'ally-one' }
  const tasks = [{ id: 'task-one', project: 'one', terminalId: 'term-one' }, { id: 'task-two', project: 'two' }] as Task[]
  const snapshot = { tasks, projects: [{ name: 'one', path: path.resolve('game') }, { name: 'two', path: path.resolve('game-two') }], backlog: [], decisions: [], wksps: [{ name: 'main' }, { name: 'ally-one' }], allies: [{ name: 'ally-one' }, { name: 'ally-two' }] } as unknown as FleetSnapshot
  it('broadcasts global events and sends project events only to their project and Hub', () => {
    const global = { type: 'settings', settings: {} } as GenioEvent
    expect(routeProjectEvent(global, binding, snapshot)).toBe(global)
    const event = { type: 'task', task: tasks[1] } as GenioEvent
    expect(routeProjectEvent(event, binding, snapshot)).toBeUndefined()
    expect(routeProjectEvent(event, undefined, snapshot)).toBe(event)
    expect(routeProjectEvent({ type: 'task', task: tasks[0] }, binding, snapshot)).toBeTruthy()
    expect(routeProjectEvent({ type: 'chat-delta', wksp: 'main', id: 'm', text: 'private' }, binding, snapshot)).toBeUndefined()
    expect(routeProjectEvent({ type: 'permission', request: { wksp: 'ally-two' } } as GenioEvent, binding, snapshot)).toBeUndefined()
  })
  it('keeps chat traffic off the Hub and builds the snapshot only for events that route by it', () => {
    const chat = { type: 'chat', message: { wksp: 'ally-one' } } as GenioEvent
    expect(routeProjectEvent(chat, undefined, snapshot)).toBeUndefined()
    expect(routeProjectEvent({ type: 'chat-delta', wksp: 'ally-one', id: 'm', text: 'x' }, undefined, snapshot)).toBeUndefined()
    expect(routeProjectEvent({ type: 'generation', wksp: 'ally-one', id: 'g', active: true }, undefined, snapshot)).toBeUndefined()
    expect(routeProjectEvent(chat, binding, snapshot)).toBe(chat)
    let built = 0
    const lazy = (): FleetSnapshot => { built++; return snapshot }
    expect(routeProjectEvent(chat, binding, lazy)).toBe(chat)
    expect(routeProjectEvent({ type: 'wksp', wksp: { name: 'ally-one' } } as GenioEvent, binding, lazy)).toBeTruthy()
    expect(built).toBe(0)
    expect(routeProjectEvent({ type: 'status', event: { taskId: 'task-one' } } as GenioEvent, binding, lazy)).toBeTruthy()
    expect(built).toBe(1)
  })
  it('scopes pending unit counts on both snapshots and events, including clearing the count', () => {
    const pending = { ...snapshot, pendingUnits: ['one', 'two', 'one'] }
    expect(projectSnapshot(pending, binding).pendingUnits).toEqual(['one', 'one'])
    expect(routeProjectEvent({ type: 'pending-units', projects: pending.pendingUnits }, binding, pending)).toEqual({ type: 'pending-units', projects: ['one', 'one'] })
    expect(routeProjectEvent({ type: 'pending-units', projects: ['two'] }, binding, pending)).toEqual({ type: 'pending-units', projects: [] })
  })
  it('scopes snapshots and resolves terminal ownership by task or a path boundary', () => {
    expect(projectSnapshot(snapshot, binding).tasks).toEqual([tasks[0]])
    expect(projectSnapshot(snapshot, binding).wksps.map(m => m.name)).toEqual(['ally-one'])
    expect(terminalProject({ id: 'term-one', cwd: root } as TerminalInfo, snapshot)).toBe('one')
    expect(terminalProject({ id: 'shell', cwd: path.resolve('game-two/child') } as TerminalInfo, snapshot)).toBe('two')
    expect(terminalProject({ id: 'shell', cwd: path.resolve('game-other') } as TerminalInfo, snapshot)).toBeUndefined()
    expect(routeProjectEvent({ type: 'terminal-removed', id: 'term-one' }, binding, snapshot, 'one')).toBeTruthy()
    expect(routeProjectEvent({ type: 'terminal-removed', id: 'term-two' }, binding, snapshot, 'two')).toBeUndefined()
  })
})
