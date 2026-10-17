import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import type { AppCtx } from '../src/main/services'
import { Home } from '../src/main/home'
import { createProjectsService } from '../src/main/projects'
import { createToolRegistry } from '../src/main/wksp-tools'
import { git } from '../src/main/git'
import { SETUP_STEPS, applySetupAction, atOpening, openSetup, readSetup, setupFile, type SetupFacts, type SetupState } from '../src/main/project-setup'

const NOW = '2026-10-17T10:00:00.000Z'
/** Every step open, or done where listed. */
const facts = (done: string[] = []): SetupFacts =>
  Object.fromEntries(SETUP_STEPS.map(s => [s.id, { done: done.includes(s.id), fact: '', applies: s.id !== 'unity' }])) as SetupFacts
const online = { now: NOW, online: true }

describe('setup steps and state', () => {
  it('starts on a new folder with its first open step, and stays out of an existing project', () => {
    const first = atOpening(undefined, true, facts(), online)
    expect(first.line).toBe('Setup: new project; next: git repo.')
    expect(first.state).toMatchObject({ new: true, startedAt: NOW, skipped: [], ignoredOpens: 0 })
    expect(atOpening(undefined, false, facts(), online)).toEqual({ state: undefined })
  })

  it('ticks steps from facts and names skips on the next opening', () => {
    let s = atOpening(undefined, true, facts(), online).state!
    s = applySetupAction(s, 'skip', facts(['git']), { now: NOW })
    expect(s.skipped).toEqual(['pitch'])
    expect(atOpening(s, true, facts(['git', 'engine']), online).line).toBe('Setup: reopened; next: how work lands; skipped: the game in a sentence.')
    expect(atOpening(s, true, facts(['git', 'pitch']), online).line).toBe('Setup: reopened; next: engine.')
  })

  it('stops without a word after two unanswered openings in a row, and an answer resets the count', () => {
    let s = atOpening(undefined, true, facts(), online).state!
    const second = atOpening(s, true, facts(), online)
    expect(second.line).toBe('Setup: reopened; next: git repo.')
    s = second.state!
    expect(s.ignoredOpens).toBe(1)
    // a step done between openings is an answer
    const answered = atOpening(s, true, facts(['git']), online)
    expect(answered.state).toMatchObject({ ignoredOpens: 0 })
    const third = atOpening(s, true, facts(), online)
    expect(third.line).toBeUndefined()
    expect(third.state).toMatchObject({ stoppedAt: NOW })
    expect(atOpening(third.state, true, facts(), online)).toEqual({ state: third.state })
  })

  it('asks nothing and counts nothing while the player is away', () => {
    const s = atOpening(undefined, true, facts(), { now: NOW, online: false })
    expect(s.line).toBeUndefined()
    expect(s.state).toMatchObject({ startedAt: NOW, ignoredOpens: 0 })
    expect(atOpening(s.state, true, facts(), online).line).toBe('Setup: new project; next: git repo.')
  })

  it('stop ends setup, resume brings it back with skipped steps re-asked, and finishing needs no open step', () => {
    let s: SetupState = atOpening(undefined, true, facts(), online).state!
    s = applySetupAction(s, 'skip', facts(), { now: NOW, step: 'art' })
    s = applySetupAction(s, 'stop', facts(), { now: NOW })
    expect(atOpening(s, true, facts(), online).line).toBeUndefined()
    expect(() => applySetupAction(s, 'skip', facts(), { now: NOW })).toThrow('not running')
    s = applySetupAction(s, 'resume', facts(), { now: NOW })
    expect(s).toMatchObject({ skipped: [], stoppedAt: undefined })
    expect(atOpening(s, true, facts(['git']), online).line).toBe('Setup: new project; next: the game in a sentence.')
    const all = SETUP_STEPS.map(x => x.id)
    const finished = atOpening(s, true, facts(all), online)
    expect(finished.state).toMatchObject({ finishedAt: NOW })
    expect(finished.line).toBeUndefined()
  })
})

describe('opening a folder and project_init', () => {
  let root: string
  let ctx: AppCtx
  let home: Home
  let said: ChatMessage[]
  const unlock = vi.fn()
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-setup-'))
    home = new Home(path.join(root, 'home'))
    home.ensure()
    said = []
    unlock.mockReset()
    const hc = { home, backlog: { list: () => [] }, crew: { list: () => [] }, wksp: { history: () => said } }
    const c = {
      main: hc, homes: new Map([['main', hc]]), home: () => hc, allies: { list: () => [] }, ledger: { record() {} },
      toolchain: { has: () => true }, away: { state: () => ({ mode: 'online', held: [] }) }, stats: { unlock }
    } as unknown as AppCtx
    c.projects = createProjectsService(() => c)
    ctx = c
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  const player = (text: string): void => { said.push({ id: `p${said.length}`, wksp: 'main', role: 'player', text, ts: new Date().toISOString() } as ChatMessage) }
  const tool = (name: string, role: 'genio' | 'bot' = 'genio') => createToolRegistry(() => ctx, home, role).find(t => t.name === name)!

  it('writes nothing into a new folder on its first open and asks the git step', async () => {
    const dir = path.join(root, 'space-goblins')
    fs.mkdirSync(dir)
    const { project } = await ctx.projects.openFolder(dir)
    expect(openSetup(ctx, project.name, home.state)).toBe('Setup: new project; next: git repo.')
    expect(fs.readdirSync(dir)).toEqual([])
    expect(readSetup(setupFile(home.state))).toMatchObject({ new: true })
  })

  it('starts the git repo only on the player\'s yes, keeping their own files', async () => {
    const dir = path.join(root, 'space-goblins')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine')
    fs.writeFileSync(path.join(dir, '.gitignore'), 'keep-me/\n')
    const { project } = await ctx.projects.openFolder(dir)
    expect(openSetup(ctx, project.name, home.state)).toBe('Setup: new project; next: git repo.')
    const init = { world: project.name, engine: 'unity', pitch: 'Goblins in space.' }
    expect(await tool('project_init').invoke({ ...init, player_words: 'yes' })).toMatchObject({ isError: true })
    player('no, not yet')
    expect(await tool('project_init').invoke({ ...init, player_words: 'no, not yet' })).toMatchObject({ isError: true })
    player('should you start a git repo?')
    expect(await tool('project_init').invoke({ ...init, player_words: 'should you start a git repo?' })).toMatchObject({ isError: true })
    player('yes, start it')
    expect(await tool('project_init', 'bot').invoke({ ...init, player_words: 'yes, start it' })).toMatchObject({ isError: true })
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false)
    const r = await tool('project_init').invoke({ ...init, player_words: 'yes, start it' })
    expect(r.isError).toBeUndefined()
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('keep-me/\n')
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('- Pitch: Goblins in space.')
    expect((await git(dir, ['log', '--oneline'])).stdout.trim().split('\n')).toHaveLength(1)
    expect((await git(dir, ['status', '--porcelain'])).stdout.trim()).toBe('')
    expect(ctx.projects.get(project.name)).toMatchObject({ gitRepo: true, defaultBranch: 'main', description: 'Goblins in space.' })
    expect(await tool('project_init').invoke({ ...init, player_words: 'yes, start it' })).toMatchObject({ isError: true })
    // git and the pitch are ticked: the next opening asks once about the engine
    expect(openSetup(ctx, project.name, home.state)).toBe('Setup: reopened; next: engine.')
  }, 60_000)

  it('remembers skip and stop across a restart, and the Bot cannot change setup', async () => {
    const dir = path.join(root, 'space-goblins')
    fs.mkdirSync(dir)
    const { project } = await ctx.projects.openFolder(dir)
    openSetup(ctx, project.name, home.state)
    expect(await tool('project_setup', 'bot').invoke({ world: project.name, action: 'skip' })).toMatchObject({ isError: true })
    const skipped = JSON.parse(((await tool('project_setup').invoke({ world: project.name, action: 'skip' })).content[0] as { text: string }).text)
    expect(skipped).toMatchObject({ status: 'running', next: { id: 'pitch' }, skipped: ['git repo'] })
    // a restart: a fresh service reads the same registry and setup file
    ctx.projects = createProjectsService(() => ctx)
    expect(openSetup(ctx, project.name, home.state)).toBe('Setup: reopened; next: the game in a sentence; skipped: git repo.')
    await tool('project_setup').invoke({ world: project.name, action: 'stop' })
    ctx.projects = createProjectsService(() => ctx)
    expect(openSetup(ctx, project.name, home.state)).toBeUndefined()
    expect(readSetup(setupFile(home.state))?.stoppedAt).toBeTruthy()
  })

  it('finishes setup once its first work exists, earning Character Creation', async () => {
    const dir = path.join(root, 'space-goblins')
    fs.mkdirSync(dir)
    const { project } = await ctx.projects.openFolder(dir)
    openSetup(ctx, project.name, home.state)
    for (const step of ['git', 'pitch', 'engine', 'landing', 'art', 'design', 'spend']) await tool('project_setup').invoke({ world: project.name, action: 'skip', step })
    expect(unlock).not.toHaveBeenCalled()
    Object.assign(ctx.main.backlog, { list: () => [{ id: 'q1', project: project.name }] })
    const done = JSON.parse(((await tool('project_setup').invoke({ world: project.name })).content[0] as { text: string }).text)
    expect(done.status).toBe('finished')
    expect(unlock).toHaveBeenCalledWith('project-setup')
  })

  it('changes the delivery mode only on the player\'s words', async () => {
    const dir = path.join(root, 'space-goblins')
    fs.mkdirSync(dir)
    const { project } = await ctx.projects.openFolder(dir)
    await ctx.projects.init(project.name, {})
    expect(await tool('world_update').invoke({ world: project.name, mode: 'no-mistakes' })).toMatchObject({ isError: true })
    player('switch to hardcore please')
    expect(await tool('world_update', 'bot').invoke({ world: project.name, mode: 'no-mistakes', player_words: 'switch to hardcore please' })).toMatchObject({ isError: true })
    expect((await tool('world_update').invoke({ world: project.name, mode: 'no-mistakes', player_words: 'switch to hardcore please' })).isError).toBeUndefined()
    expect(ctx.projects.get(project.name)).toMatchObject({ mode: 'no-mistakes', modeSource: 'manual' })
  }, 60_000)
})
