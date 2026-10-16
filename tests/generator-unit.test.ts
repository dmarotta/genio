import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/git', () => ({ baseRef: async () => 'main', statusPorcelain: async () => [], hasRemote: async () => true, fetch: async () => ({ code: 0 }),
  aheadBehind: async () => ({ ahead: 1, behind: 0 }), isAncestor: async () => true, diff: async () => '', diffStat: async () => '',
  changedFiles: vi.fn(async () => ['Assets/Art/hero.png', 'Assets/Art/hero.png.meta', '.genio/provenance/Assets/Art/hero.png.json', '.genio/spend.jsonl']),
  push: vi.fn(async () => ({ code: 0, stdout: '', stderr: 'pushed' })) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
vi.mock('../src/main/gauntlet-unity', () => ({ runUnityGate: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { runUnityGate } from '../src/main/gauntlet-unity'
import * as git from '../src/main/git'
import { createGauntlet } from '../src/main/gauntlet'
import { Home } from '../src/main/home'
import { generatorBrief, renderBrief, type BriefInput } from '../src/main/brief'
import { generatorReport } from '../src/main/modeller-landing'
import { createBacklogService } from '../src/main/backlog'
import { claimConflict, claimHolderKind, holdsClaims, modellerCanvas } from '../src/shared/modeller'
import { squadBadge, squadTone, unitKindTone } from '../src/shared/squad-display'
import { unitKindLabel } from '../src/renderer/src/lib/vocab'
import type { AppCtx } from '../src/main/services'
import type { Task, TaskState } from '../src/shared/types'

let tmp: string | undefined
const mk = (prefix: string): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
afterEach(() => { vi.clearAllMocks(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined })

const unit = (p: Partial<Task>): Task => ({ id: 'a', kind: 'ship', project: 'world', generator: true, state: 'working', title: 'Hero art', createdAt: '2026-10-16T10:00:00Z', ...p }) as Task

describe('Generator claims', () => {
  it('are held like a Modeller\'s and refuse a path either kind already holds', () => {
    expect(['working', 'ready', 'exited', 'failed'].every(state => holdsClaims(unit({ state: state as TaskState })))).toBe(true)
    expect(holdsClaims(unit({ state: 'merged' })) || holdsClaims(unit({ state: 'cleaned' })) || holdsClaims(unit({ generator: false }))).toBe(false)
    const generator = unit({ id: 'gen', claims: ['Assets/Audio/'] })
    const modeller = unit({ id: 'mod', generator: undefined, modeller: true, claims: ['Assets/Models/tower.glb'] })
    expect(claimConflict(['assets/audio/door.wav'], 'world', [generator, modeller])).toMatchObject({ path: 'assets/audio/door.wav', holder: { id: 'gen' } })
    expect(claimConflict(['Assets/Models/tower.glb'], 'world', [generator, modeller])).toMatchObject({ holder: { id: 'mod' } })
    expect(claimConflict(['Assets/Audio/door.wav'], 'world', [generator], 'gen')).toBeUndefined()
    expect(claimHolderKind(generator)).toBe('Generator')
    expect(claimHolderKind(modeller)).toBe('Modeller')
  })

  it('never give a Generator the Modeller canvas', () => {
    expect(modellerCanvas(unit({}))).toBe(false)
    expect(modellerCanvas(unit({ generator: undefined, modeller: true }))).toBe(true)
  })
})

describe('Generator quests', () => {
  it('carry the flag on Build quests only, never together with the Modeller flag', () => {
    const root = mk('genio-generator-quests-')
    const home = new Home(root); home.ensure()
    const ctx = { homes: new Map(), projects: { get: () => undefined }, ledger: { record: () => undefined } } as unknown as AppCtx
    const backlog = createBacklogService(() => ctx, home)
    expect(backlog.add({ title: 'Make hero art', project: 'world', generator: true, claims: ['Assets/Art/hero.png'] })).toMatchObject({ generator: true, claims: ['Assets/Art/hero.png'] })
    expect(backlog.add({ title: 'Look into audio', project: 'world', kind: 'scout', generator: true, claims: ['x'] })).not.toHaveProperty('generator')
    const both = backlog.add({ title: 'A tower model', project: 'world', modeller: true, generator: true })
    expect(both.modeller).toBe(true)
    expect(both).not.toHaveProperty('generator')
  })
})

describe('Generator brief', () => {
  const base: BriefInput = {
    taskId: 'sfx-a1', kind: 'ship', project: 'game', worktree: 'C:\\w\\sfx-a1', branch: 'genio/sfx-a1', baseBranch: 'main', mode: 'no-mistakes',
    intent: 'a door creak and a coin pickup sound', statusFile: 'C:\\s\\sfx-a1.status', inboxDir: 'C:\\s\\sfx-a1.inbox', taskDataDir: 'C:\\d\\sfx-a1', engine: 'unity'
  }
  const rules = generatorBrief('C:\\skills\\genio', 'C:\\d\\sfx-a1', { engine: 'unity', engineRoot: 'Game', claims: ['Game/Assets/Audio/door.wav'] })

  it('covers the jobs, spending only under the player approval, a helper per job, sound steps, the Art Bible, paths, takes, .meta, provenance and checking results', () => {
    expect(rules).toContain('one or more jobs; each is its own file or set')
    // No default budget: paid calls need the player's approval, asked for with a spend question.
    expect(rules).toContain('you spend money only under the spend grant the player approved')
    expect(rules).toContain('there is no default budget')
    expect(rules).not.toMatch(/USD 0\.50|--budget <usd>/)
    expect(rules).toContain('needs-decision [key=spend] with spend_usd')
    expect(rules).toContain('no USD and no approval')
    expect(rules).toContain('node "C:/skills/genio/skills/imagegen-codex/scripts/codex-image.mjs"')
    expect(rules).toContain("Codex images on the player's ChatGPT plan")
    expect(rules).toContain('textures, 3D, audio and music with FAL, `node "C:/skills/genio/skills/fal/scripts/fal.mjs"`')
    expect(rules).toContain('motions (and custom rigged characters) with Uthana, `node "C:/skills/genio/skills/uthana/scripts/uthana.mjs"`')
    expect(rules).toContain('(fal.mjs, sound.mjs FAL steps, uthana.mjs)')
    expect(rules).not.toContain('if the uthana helper is available')
    expect(rules).toContain('`C:/skills/genio/skills/assets/SKILL.md`')
    expect(rules).toContain('node "C:/skills/genio/skills/sound/scripts/sound.mjs"')
    expect(rules).toMatch(/trim, loop, fade, normalize/)
    expect(rules).toContain('Art Bible: when the project has one, the helpers apply it automatically')
    expect(rules).toContain('--type <asset type>')
    expect(rules).toContain('locate --world . --kind <image|audio|model|animation|video> --name <file> --engine unity --engine-root Game')
    expect(rules).toContain('`Game/Assets/Audio/door.wav`')
    expect(rules).toContain('A path another Generator or Modeller holds is a `blocked` line')
    expect(rules).toContain('`C:/d/sfx-a1/takes/`, outside the worktree. Only the take you choose goes into the project; never commit the others.')
    expect(rules).toContain('`.meta`, which `genio-unity import` generates')
    expect(rules).toContain('If Unity cannot run for you, commit the asset without it and say so in your final note.')
    expect(rules).toContain('`.genio/provenance/`')
    expect(rules).toContain('`.genio/spend.jsonl`')
    expect(rules).toContain('open the file and look at it')
    expect(rules).toContain('never claim quality from metadata alone')
    expect(rules).toContain('Finish like any Build')
    expect(rules).not.toMatch(/accept/i)
    expect(rules.length).toBeLessThan(5000)
  })

  it('renders as its own section before the Definition of done, which skips checks like a Modeller\'s', () => {
    const b = renderBrief({ ...base, generator: rules })
    expect(b.indexOf('# Generator')).toBeGreaterThan(b.indexOf('# Engine notes'))
    expect(b.indexOf('# Generator')).toBeLessThan(b.indexOf('# Definition of done'))
    expect(b).not.toContain('# Modeller')
    const dod = b.slice(b.indexOf('# Definition of done'))
    expect(dod).toContain('Commit the chosen assets with their provenance')
    expect(dod).toContain('without running checks (Generators skip them, like Modellers)')
    expect(dod).not.toContain('Gauntlet findings')
    const offline = renderBrief({ ...base, mode: 'local-only', generator: rules })
    expect(offline).toContain('# Generator')
    expect(offline).toContain('Append `done: ready in branch genio/sfx-a1` and stop. Genio lands it after approval.')
    expect(renderBrief(base)).not.toContain('# Generator')
  })
})

describe('Gauntlet for a Generator', () => {
  it('runs no checks and no review: sync, the asset report, push and PR', async () => {
    const root = mk('genio-gauntlet-generator-')
    const home = new Home(root); home.ensure()
    const worktree = path.join(root, 'copy'), world = path.join(root, 'world')
    for (const dir of [worktree, world]) fs.mkdirSync(dir, { recursive: true })
    const briefPath = path.join(root, 'brief.md')
    fs.writeFileSync(briefPath, "## Player's intent\n\nhero portrait\n\n## Genio spec\n\nnone\n")
    const task = { id: 'unit', kind: 'ship', generator: true, project: 'world', worktree, branch: 'genio/unit', baseBranch: 'main', title: 'Hero art', briefPath } as Task
    const project = { name: 'world', path: world, engine: 'unity', engineRoot: '', commands: { lint: 'exit 1', build: 'exit 1', test: 'exit 1' } } as any
    const crew = { get: () => task, update: vi.fn((_id, patch) => Object.assign(task, patch)), send: vi.fn(), bump: vi.fn(), registerPr: vi.fn(async () => ({ ok: true, message: 'registered' })) }
    const createPr = vi.fn(async (_wt: string, _pr: { body: string }) => ({ ok: true, url: 'https://github.com/o/r/pull/8', message: '' }))
    const ctx = { appRoot: root, home: () => ({ crew }), projects: { get: () => project }, settings: { get: () => ({ validationMaxRounds: 3 }) },
      terminals: { scrollback: () => '' }, forge: { available: () => true, createPr } } as unknown as AppCtx
    expect(await createGauntlet(() => ctx, home).run('unit')).toMatchObject({ ok: true })
    const steps = task.validation!.steps
    expect(steps.map(s => s.name)).toEqual(['sync', 'assets', 'push', 'pr'])
    const report = steps.find(s => s.name === 'assets')!
    expect(report).toMatchObject({ state: 'skipped', output: expect.stringContaining('No checks for Generators') })
    expect(report.output).toContain('2 file(s) delivered, 2 provenance or spend file(s) under .genio/')
    expect(report.output).toContain('- Assets/Art/hero.png.meta')
    expect(git.changedFiles).toHaveBeenCalledWith(worktree, 'main', 'HEAD')
    expect(task.validation!.state).toBe('passed')
    expect(query).not.toHaveBeenCalled()
    expect(runUnityGate).not.toHaveBeenCalled()
    expect(createPr.mock.calls[0][1].body).toContain('| assets | skipped |')
  })

  it('the report says so when the branch changes nothing', () => {
    expect(generatorReport([])).toContain('The branch changes no files.')
  })
})

describe('Generator color and label', () => {
  const states: [Partial<Task>, string, string][] = [
    [{ state: 'spawning' }, 'WORKING', 'magenta'],
    [{ state: 'working' }, 'WORKING', 'magenta'],
    [{ state: 'needs-decision' }, 'WORKING', 'magenta'],
    [{ state: 'blocked' }, 'WORKING', 'magenta'],
    [{ state: 'paused' }, 'WORKING', 'magenta'],
    [{ state: 'validating' }, 'WORKING', 'magenta'],
    [{ state: 'ready', validation: { state: 'running' } as Task['validation'] }, 'WORKING', 'magenta'],
    [{ state: 'ready' }, 'READY TO MERGE', 'volt'],
    [{ state: 'merged' }, 'MERGED', 'volt'],
    [{ state: 'done' }, 'DONE', 'volt'],
    [{ state: 'failed' }, 'FAILED', 'alert'],
    [{ state: 'exited', stateReason: 'exited with code 1' }, 'EXITED ABNORMALLY', 'alert'],
    [{ state: 'cleaned' }, 'DONE', 'volt']
  ]
  it.each(states)('%o shows %s in %s', (patch, label, tone) => {
    expect(squadBadge(unit(patch))).toEqual({ label, tone })
  })

  it('is magenta at work, distinct from Modeller orange, Recon violet and Build blue, and named Generator', () => {
    expect(squadTone(unit({}))).toBe('magenta')
    expect(squadTone(unit({ generator: undefined }))).toBe('blue')
    expect(squadTone(unit({ generator: undefined, modeller: true }))).toBe('orange')
    expect(squadTone(unit({ kind: 'scout' }))).toBe('violet')
    expect(unitKindTone(unit({ state: 'ready' }))).toBe('magenta')
    expect(unitKindLabel(unit({}))).toBe('Generator')
    expect(unitKindLabel(unit({ kind: 'scout' }))).toBe('Recon')
    expect(unitKindLabel(unit({ modeller: true }))).toBe('Modeller')
    expect(unitKindLabel(unit({ generator: undefined }))).toBe('Build')
  })

  it('has its own palette token, distinct from the other unit colors', () => {
    const theme = fs.readFileSync(path.join(__dirname, '../src/renderer/src/styles/theme.css'), 'utf8')
    const token = (name: string): string | undefined => theme.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase()
    const magenta = token('magenta')
    expect(magenta).toMatch(/^#[0-9a-f]{6}$/)
    for (const other of ['orange', 'violet', 'volt', 'alert', 'amber', 'neon']) expect(token(other)).not.toBe(magenta)
    expect(theme).toContain('.chip.magenta')
  })
})
