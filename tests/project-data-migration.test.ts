import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, shell: {} }))
vi.mock('../src/main/secrets', () => ({ getSecret: () => undefined }))
import { Home } from '../src/main/home'
import { migrateProjectData } from '../src/main/project-data-migration'
import { createCrewService } from '../src/main/crew'
import { createBacklogService } from '../src/main/backlog'
import { createDecisionService } from '../src/main/decisions'
import { createWakeService } from '../src/main/wakes'
import { createSupervisor } from '../src/main/supervisor'
import type { AppCtx, HomeCtx } from '../src/main/services'
import type { Ally, BacklogItem, Decision, Task, Wake } from '../src/shared/types'
import { readJson, writeJson, writeText } from '../src/main/util'

let main: Home
const ts = '2026-10-01T12:00:00.000Z'
beforeEach(() => {
  main = new Home(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-project-migration-')))
  main.ensure()
  writeJson(main.projectsFile, [{ name: 'one' }, { name: 'two' }])
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(main.root, { recursive: true, force: true }) })

function task(id: string, project = 'one', home = main): Task {
  return { id, title: id, kind: 'ship', workspace: home.name, project, mode: 'local-only',
    worktree: home.worktreeFor(project, id), briefPath: home.briefFile(id), branch: `genio/${id}`,
    baseBranch: 'main', branchPrefix: 'genio/', state: 'working', harness: 'codex',
    statusOffset: 0, relaunches: 2, sessionHint: 'legacy-session', codexSessionId: 'verified-session',
    inbox: { seq: 3, acked: 1, rings: 2 }, createdAt: ts, updatedAt: ts }
}
function quest(id: string, project?: string): BacklogItem {
  return { id, title: id, project, state: 'queued', priority: 'normal', kind: 'ship',
    dependsOn: [], tags: [], notes: 'original intent', createdAt: ts, updatedAt: ts }
}
function decision(id: string, extra: Partial<Decision> = {}): Decision {
  return { id, key: 'default', workspace: 'main', question: 'Choose a path', source: 'unit',
    options: ['A', 'B'], urgency: 'normal', createdAt: ts, ...extra }
}
function wake(seq: number, taskId: string): Wake {
  return { seq, ts, taskId, workspace: 'main', kind: 'signal', reason: 'needs attention', lines: ['unchanged'], routine: false }
}
function owner(project = 'one'): Home {
  const ally = readJson<Ally[]>(main.alliesFile, []).find(a => !a.retiredAt && a.projects.length === 1 && a.projects[0] === project)!
  return new Home(ally.home, ally.name, main)
}
function checkpoint(): string { return path.join(main.state, 'project-data-migration-v1.json') }

describe('per-project data migration', () => {
  it('preserves units, linked quests, holds, answers, deferred decisions and unrelated global records', () => {
    const t = { ...task('old'), backlogId: 'linked', statusOffset: 17,
      validation: { id: 'validation', state: 'running', steps: [], round: 2, startedAt: ts } } as Task
    writeJson(main.tasksFile, [t, task('other', 'two'), task('unknown', 'removed')])
    const linked = { ...quest('linked'), taskId: 'old', state: 'held', dependsOn: ['other-quest'],
      hold: { reason: 'keep waiting', since: ts, until: '2027-01-01' }, answer: 'my exact answer' } as BacklogItem
    writeJson(main.backlogFile, [linked, quest('other-quest', 'two'), quest('unassigned')])
    writeJson(main.decisionsFile, [decision('task-choice', { taskId: 'old', until: '2027-01-01' }),
      decision('quest-choice', { backlogId: 'linked', answer: 'A', resolvedAt: ts }), decision('global')])
    const preserved = [main.chatFile, main.workspaceFile, main.playerFile, main.playerSharedFile, main.loreFile,
      main.settingsFile, main.statsFile, path.join(main.data, 'secrets.json'), path.join(main.data, 'done-archive.md')]
    for (const file of preserved) writeText(file, `original ${path.basename(file)}`)
    migrateProjectData(main)
    const target = owner()
    expect(readJson(target.tasksFile, [])).toEqual([{ ...t, workspace: target.name, storageRoot: main.root }])
    expect(readJson(target.backlogFile, [])).toEqual([{ ...linked, project: 'one' }])
    expect(readJson<Decision[]>(target.decisionsFile, [])).toMatchObject([
      { id: 'task-choice', taskId: 'old', workspace: target.name, project: 'one', until: '2027-01-01' },
      { id: 'quest-choice', backlogId: 'linked', answer: 'A', resolvedAt: ts }
    ])
    expect(readJson<Task[]>(main.tasksFile, []).map(t => t.id)).toEqual(['unknown'])
    expect(readJson<BacklogItem[]>(main.backlogFile, []).map(q => q.id)).toEqual(['unassigned'])
    expect(readJson<Decision[]>(main.decisionsFile, []).map(d => d.id)).toEqual(['global'])
    expect(readJson<Task[]>(owner('two').tasksFile, []).map(t => t.id)).toEqual(['other'])
    expect(fs.readFileSync(path.join(target.data, 'backlog.md'), 'utf8')).toContain('Player answer: my exact answer')
    expect(fs.readFileSync(path.join(main.data, 'backlog.md'), 'utf8')).not.toContain('linked')
    for (const file of preserved) expect(fs.readFileSync(file, 'utf8')).toBe(`original ${path.basename(file)}`)
    const plan = readJson<any>(checkpoint(), {})
    expect(plan.completedAt).toBeTruthy()
    expect(JSON.parse(plan.writes.find((w: any) => w.file === path.relative(main.root, main.tasksFile)).before)).toEqual([t, task('other', 'two'), task('unknown', 'removed')])
  })

  it('reuses existing project bases, separates multi-world records and avoids retired or orphaned base names', () => {
    const existing = new Home(main.workspaceHome('one'), 'one', main); existing.ensure()
    const multi = new Home(main.workspaceHome('multi'), 'multi', main); multi.ensure()
    const retired = new Home(main.workspaceHome('two'), 'two', main); retired.ensure()
    const orphan = new Home(main.workspaceHome('two-2'), 'two-2', main); orphan.ensure()
    writeJson(main.alliesFile, [
      { name: 'one', projects: ['one'], scope: 'one scope', charter: 'existing', home: existing.root },
      { name: 'multi', projects: ['one', 'two'], scope: 'multi', home: multi.root },
      { name: 'two', projects: ['two'], home: retired.root, retiredAt: ts }
    ])
    writeJson(existing.tasksFile, [task('existing', 'one', existing)])
    writeJson(existing.backlogFile, [quest('scoped')])
    writeJson(multi.tasksFile, [task('multi-unit', 'two', multi)])
    writeJson(retired.tasksFile, [task('archived', 'two', retired)])
    writeText(existing.chatFile, 'keep existing chat')
    writeText(existing.workspaceFile, 'keep existing provider session')
    migrateProjectData(main)
    expect(owner().root).toBe(existing.root)
    expect(owner('two').name).toBe('two-3')
    expect(readJson<BacklogItem[]>(existing.backlogFile, [])).toMatchObject([{ id: 'scoped', project: 'one' }])
    expect(readJson<Task[]>(owner('two').tasksFile, [])).toMatchObject([{ id: 'multi-unit', storageRoot: multi.root }])
    expect(readJson(multi.tasksFile, [])).toEqual([])
    expect(readJson<Task[]>(retired.tasksFile, []).map(t => t.id)).toEqual(['archived'])
    expect(fs.readFileSync(existing.chatFile, 'utf8')).toBe('keep existing chat')
    expect(fs.readFileSync(existing.workspaceFile, 'utf8')).toBe('keep existing provider session')
  })

  it('transfers wake acknowledgements without swallowing pending events or reusing source sequences', () => {
    writeJson(main.tasksFile, [task('old')])
    writeText(main.wakesFile, [wake(1, 'old'), wake(2, 'old'), wake(3, 'old')].map(w => JSON.stringify(w)).join('\n'))
    writeJson(main.wakesAckFile, { through: 1, at: ts, events: { 3: ts } })
    const existing = new Home(main.workspaceHome('one'), 'one', main); existing.ensure()
    writeJson(main.alliesFile, [{ name: 'one', projects: ['one'], home: existing.root }])
    writeText(existing.wakesFile, JSON.stringify({ ...wake(8, 'existing'), workspace: existing.name }))
    writeJson(existing.wakesAckFile, { through: 7 })
    migrateProjectData(main)
    const targetWakes = createWakeService(() => ({} as AppCtx), owner())
    expect(targetWakes.pending().map(w => w.seq)).toEqual([8, 10])
    expect(targetWakes.recent(0).filter(w => w.ackedAt).map(w => w.seq)).toEqual([9, 11])
    const sourceWakes = createWakeService(() => ({} as AppCtx), main)
    expect(sourceWakes.pending()).toEqual([])
    expect(sourceWakes.enqueue({ kind: 'check', reason: 'new global event' }).seq).toBe(4)
    expect(sourceWakes.pending()).toHaveLength(1)
  })

  it('replays an interrupted transaction exactly once and never overwrites later project work', () => {
    writeJson(main.tasksFile, [task('old')])
    writeJson(main.backlogFile, [quest('quest', 'one')])
    const rename = fs.renameSync.bind(fs)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(main.workspaceHome('one'), 'state', 'tasks.json')) throw new Error('interrupted write')
      rename(from, to)
    })
    expect(() => migrateProjectData(main)).toThrow('interrupted write')
    expect(readJson<any>(checkpoint(), {}).completedAt).toBeUndefined()
    spy.mockRestore()
    migrateProjectData(main)
    const target = owner()
    expect(readJson<Task[]>(target.tasksFile, []).map(t => t.id)).toEqual(['old'])
    expect(readJson(main.tasksFile, [])).toEqual([])
    expect(readJson<BacklogItem[]>(target.backlogFile, []).map(q => q.id)).toEqual(['quest'])
    writeJson(target.tasksFile, [task('new', 'one', target)])
    const completed = fs.readFileSync(checkpoint())
    migrateProjectData(main)
    expect(fs.readFileSync(checkpoint())).toEqual(completed)
    expect(readJson<Task[]>(target.tasksFile, []).map(t => t.id)).toEqual(['new'])
  })

  it.each(['malformed', 'collision'])('stops on %s records without changing authoritative data', reason => {
    writeJson(main.tasksFile, [task('old')])
    if (reason === 'malformed') writeText(main.backlogFile, '{broken JSON')
    else {
      const existing = new Home(main.workspaceHome('one'), 'one', main); existing.ensure()
      writeJson(main.alliesFile, [{ name: 'one', projects: ['one'], home: existing.root }])
      writeJson(existing.tasksFile, [task('old', 'one', existing)])
    }
    const original = fs.readFileSync(main.tasksFile)
    expect(() => migrateProjectData(main)).toThrow()
    expect(fs.readFileSync(main.tasksFile)).toEqual(original)
    expect(fs.existsSync(checkpoint())).toBe(false)
  })

  it('refuses replay over a changed file and retains its backup for recovery', () => {
    writeJson(main.tasksFile, [task('old')])
    const rename = fs.renameSync.bind(fs)
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === main.tasksFile) throw new Error('interrupted write')
      rename(from, to)
    })
    expect(() => migrateProjectData(main)).toThrow('interrupted write')
    spy.mockRestore()
    const backup = fs.readFileSync(checkpoint())
    writeJson(main.tasksFile, [task('manually-added')])
    expect(() => migrateProjectData(main)).toThrow('changed after its backup')
    expect(readJson<Task[]>(main.tasksFile, []).map(t => t.id)).toEqual(['manually-added'])
    expect(fs.readFileSync(checkpoint())).toEqual(backup)
  })

  it('rejects checkpoint paths outside the base before replaying any write', () => {
    writeJson(main.tasksFile, [task('old')])
    const original = fs.readFileSync(main.tasksFile, 'utf8')
    writeJson(checkpoint(), { version: 1, startedAt: ts, writes: [
      { file: path.relative(main.root, main.tasksFile), before: original, after: '[]' },
      { file: '../outside.json', before: null, after: '[]' }
    ] })
    expect(() => migrateProjectData(main)).toThrow('outside the base')
    expect(fs.readFileSync(main.tasksFile, 'utf8')).toBe(original)
  })

  it('uses original status, inbox, report and validation paths when supervising migrated units', async () => {
    const t = { ...task('old'), reportPath: main.reportFile('old') }
    writeJson(main.tasksFile, [t])
    writeText(t.briefPath, '# Original brief')
    writeText(t.reportPath, 'original report')
    writeText(main.validationLog(t.id), 'original validation')
    writeText(main.taskStateFile(t.id, '.inbox/0003.msg'), 'header\n--\noriginal pending ping')
    writeText(main.statusFile(t.id), 'working: legacy session continues\n')
    migrateProjectData(main)
    const target = owner(); target.ensure()
    const hc = { home: target, workspace: { deliverWakes: vi.fn() } } as unknown as HomeCtx
    const ctx = { main: { home: main }, home: () => hc, homes: new Map([[target.name, hc]]),
      settings: { get: () => ({ signalGraceSeconds: 30, usageMode: 'balanced' }) },
      terminals: { get: () => ({ alive: true }), lastOutputAt: () => Date.now() }
    } as unknown as AppCtx
    hc.crew = createCrewService(() => ctx, target)
    hc.backlog = createBacklogService(() => ctx, target)
    hc.decisions = createDecisionService(() => ctx, target)
    hc.wakes = createWakeService(() => ctx, target)
    expect(await hc.crew.readFile('old', 'brief')).toBe('# Original brief')
    expect(await hc.crew.readFile('old', 'report')).toBe('original report')
    expect(await hc.crew.readFile('old', 'validation')).toBe('original validation')
    expect(await hc.crew.readFile('old', 'inbox')).toContain('original pending ping')
    expect(target.taskStateFile('old', '.turn-ended')).toBe(main.taskStateFile('old', '.turn-ended'))
    expect(target.taskStateFile('new', '.inbox')).toBe(path.join(target.state, 'new.inbox'))
    hc.crew.appendStatus('old', 'done: ready in branch genio/old')
    createSupervisor(() => ctx, target).poke()
    expect(hc.crew.get('old')).toMatchObject({ workspace: target.name, state: 'ready', worktree: t.worktree,
      briefPath: t.briefPath, sessionHint: t.sessionHint, codexSessionId: t.codexSessionId, relaunches: 2 })
    expect(hc.wakes.pending()).toMatchObject([{ workspace: target.name, taskId: 'old', lines: ['done: ready in branch genio/old'] }])
    expect(fs.existsSync(path.join(target.state, 'old.status'))).toBe(false)
  })
})
