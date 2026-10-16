import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Decision, Engine, EngineDetection, Project } from '../src/shared/types'
import type { AppCtx } from '../src/main/services'
import { Home } from '../src/main/home'
import { renderBrief, type BriefInput } from '../src/main/brief'
import { createToolRegistry } from '../src/main/wksp-tools'
import { answerEngineChoice, declareEngineRoot, projectEngineSummary, surfaceEngineAmbiguity } from '../src/main/engine-facts'
import { engineAmbiguityChoice, engineBriefLine, engineEnv, engineFacts, engineProposalChoice, engineSummaryLine, KEEP_DETECTING } from '../src/shared/engine-summary'

const brief: BriefInput = {
  taskId: 'fix-jump-a1', kind: 'ship', project: 'avalon', worktree: 'C:\\w', branch: 'genio/fix-jump-a1', baseBranch: 'main',
  mode: 'local-only', intent: 'Fix the double jump', statusFile: 'C:\\s.status', inboxDir: 'C:\\s.inbox', taskDataDir: 'C:\\d', engine: 'unity'
}
const engineNotes = (b: string): string => b.slice(b.indexOf('# Engine notes'), b.indexOf('# Definition of done')).trim()

const detection = (over: Partial<EngineDetection> = {}): EngineDetection => ({
  candidates: [{ engine: 'unity', root: 'client', strength: 'strong' }, { engine: 'unity', root: 'tools/LevelEditor', strength: 'strong' }],
  ambiguous: true, declared: false, scannedAt: '2026-10-14T00:00:00Z', ...over
})
const twoUnity = { engine: 'unity' as Engine, engineRoot: 'client', detected: detection() }

describe('unit brief and environment', () => {
  it('opens Engine notes with the engine, version and root', () => {
    const line = engineBriefLine(engineFacts({ engine: 'unity', engineRoot: 'FoundersOfAvalonUnity', detected: detection({
      candidates: [{ engine: 'unity', root: 'FoundersOfAvalonUnity', strength: 'strong', version: '6000.0.23f1' }], ambiguous: false, version: '6000.0.23f1'
    }) }))
    expect(engineNotes(renderBrief({ ...brief, engineLine: line }))).toMatchInlineSnapshot(`
      "# Engine notes

      - Project engine: Unity 6000.0.23f1 at FoundersOfAvalonUnity/ (detected). Run engine commands there.
      - Engine: Unity. genio-unity (the unity skill under Tools, also in GENIO_UNITY) is the only way to compile, test, import, build, play, send editor commands and read the console. It targets only your own copy (GENIO_UNITY_PROJECT) or your leased Play slot and keeps a record of every run in GENIO_UNITY_RUNS.
      - Never start Unity.exe, Unity Hub or the \`unity\` CLI yourself. Never open, read or write the main project folder, never read an editor's Pipeline token and never save the player's scenes.
      - Never commit Library/, Temp/ or Logs/. Keep .meta files paired with their assets.
      - Binary assets (textures, audio, models, scenes) may be tracked with Git LFS: never rewrite or re-encode assets you were not asked to touch.
      - Scene/prefab/level files merge badly: keep edits to them minimal and focused."
    `)
  })

  it('spells out the root, declarations, other candidates and code projects', () => {
    expect(engineBriefLine(engineFacts({ engine: 'godot', engineRoot: '' }))).toBe('- Project engine: Godot at the repository root (detected). Run engine commands there.')
    expect(engineBriefLine(engineFacts({ ...twoUnity, detected: detection({ declared: true, ambiguous: false, version: '6000.0.1f1' }) })))
      .toBe('- Project engine: Unity 6000.0.1f1 at client/ (set in .genio/project.json). Run engine commands there. Also found: Unity at tools/LevelEditor/. Stay in the root above unless the mission names another.')
    expect(engineBriefLine(engineFacts({ engine: 'other' }))).toBe('- Project engine: none detected; treat this as a code project.')
  })

  it('exports GENIO_ENGINE and GENIO_ENGINE_ROOT for every engine', () => {
    expect(engineEnv({ engine: 'unity', engineRoot: 'Game\\' })).toEqual({ GENIO_ENGINE: 'unity', GENIO_ENGINE_ROOT: 'Game' })
    expect(engineEnv({ engine: 'godot', engineRoot: '' })).toEqual({ GENIO_ENGINE: 'godot', GENIO_ENGINE_ROOT: '.' })
    expect(engineEnv({ engine: 'bevy', engineRoot: 'game' })).toEqual({ GENIO_ENGINE: 'bevy', GENIO_ENGINE_ROOT: 'game' })
    expect(engineEnv({ engine: 'other', engineRoot: '../escape' })).toEqual({ GENIO_ENGINE: 'other', GENIO_ENGINE_ROOT: '.' })
    expect(engineEnv({ engine: undefined as unknown as Engine })).toEqual({ GENIO_ENGINE: 'other', GENIO_ENGINE_ROOT: '.' })
  })
})

describe('engineSummary for the project listing', () => {
  it('reads entries before and after their first scan', () => {
    expect(engineSummaryLine(engineFacts({ engine: 'unity', engineRoot: 'Game' }))).toBe('Unity at Game/ (detected).')
    expect(engineSummaryLine(engineFacts({ engine: 'other' }))).toBe('No game engine detected; Genio treats this as a code project.')
    expect(projectEngineSummary({ name: 'x', engine: 'unity', detected: detection({ candidates: [], ambiguous: false, version: '6000.1.0f1' }) } as unknown as Project))
      .toBe('Unity 6000.1.0f1 at the repository root (detected).')
  })

  it('spells out candidates, ambiguity and an ignored declaration', () => {
    expect(engineSummaryLine(engineFacts(twoUnity))).toBe(
      'Unity at client/ (detected). Also found: Unity at tools/LevelEditor/. Ambiguous: the top candidates tie, so the pick above is only the alphabetical tie-break. Ask the player which one to use and pin it with world_engine_root.'
    )
    const webAndUnity = { engine: 'unity' as Engine, engineRoot: 'unity', detected: detection({
      candidates: [{ engine: 'unity', root: 'unity', strength: 'strong' }, { engine: 'web', root: '', strength: 'medium' }], ambiguous: false,
      warning: 'Ignored .genio/project.json: no game engine marker in "docs".'
    }) }
    expect(engineSummaryLine(engineFacts(webAndUnity))).toBe('Unity at unity/ (detected). Also found: Web at the repository root. Ignored .genio/project.json: no game engine marker in "docs".')
  })
})

describe('engine root declaration', () => {
  let dir: string, ctx: AppCtx, projects: Project[], decisions: Decision[]
  const project = (): Project => projects[0]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-declare-'))
    for (const root of ['client', 'tools/LevelEditor']) {
      fs.mkdirSync(path.join(dir, root, 'ProjectSettings'), { recursive: true })
      fs.writeFileSync(path.join(dir, root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.23f1\n')
    }
    fs.mkdirSync(path.join(dir, 'docs'))
    projects = [{ name: 'game', path: dir, ...twoUnity } as unknown as Project]
    decisions = []
    const decisionsSvc = {
      list: () => decisions,
      open: vi.fn((d: Partial<Decision>) => { const x = { id: `ch-${decisions.length}`, createdAt: 'now', ...d } as Decision; decisions.push(x); return x })
    }
    const hc = { home: { name: 'main' }, decisions: decisionsSvc, wksp: { say: vi.fn() } }
    ctx = {
      main: hc, homes: new Map([['main', hc]]), home: (name: string) => { if (name !== 'main') throw new Error('unknown'); return hc },
      allies: { list: () => [] }, ledger: { record: vi.fn() },
      projects: { list: () => projects, get: (name: string) => projects.find(p => p.name === name), rescan: vi.fn(async () => []) }
    } as unknown as AppCtx
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const declared = (): unknown => JSON.parse(fs.readFileSync(path.join(dir, '.genio', 'project.json'), 'utf8'))

  it('refuses without the player\'s words and for the Bot', async () => {
    await expect(declareEngineRoot(ctx, { world: 'game', root: 'client', actor: 'genio' })).rejects.toThrow('player_words')
    await expect(declareEngineRoot(ctx, { world: 'game', root: 'client', playerWords: '  ', actor: 'genio' })).rejects.toThrow('player_words')
    await expect(declareEngineRoot(ctx, { world: 'game', root: 'client', playerWords: 'use client', actor: 'bot' })).rejects.toThrow('Bot')
    expect(fs.existsSync(path.join(dir, '.genio'))).toBe(false)
  })

  it('refuses roots outside the project or without an engine marker', async () => {
    const words = { world: 'game', playerWords: 'pin it', actor: 'genio' as const }
    for (const root of ['../elsewhere', 'C:/Windows', '/etc', 'client/../..']) {
      await expect(declareEngineRoot(ctx, { ...words, root })).rejects.toThrow('inside the project')
    }
    await expect(declareEngineRoot(ctx, { ...words, root: 'docs' })).rejects.toThrow('no game engine marker')
    await expect(declareEngineRoot(ctx, { ...words, root: 'missing' })).rejects.toThrow('does not exist')
    await expect(declareEngineRoot(ctx, { ...words, root: '' })).rejects.toThrow('no game engine marker')
    expect(fs.existsSync(path.join(dir, '.genio', 'project.json'))).toBe(false)
  })

  it('writes .genio/project.json, keeps other keys and rescans', async () => {
    fs.mkdirSync(path.join(dir, '.genio'))
    fs.writeFileSync(path.join(dir, '.genio', 'project.json'), '\uFEFF{ "note": "kept" }')
    const message = await declareEngineRoot(ctx, { world: 'game', root: '.\\tools\\LevelEditor\\', playerWords: 'use the level editor', actor: 'genio' })
    expect(declared()).toEqual({ note: 'kept', engineRoot: 'tools/LevelEditor' })
    expect(ctx.projects.rescan).toHaveBeenCalledWith('game')
    expect(message).toContain('Pinned Unity at tools/LevelEditor/ in .genio/project.json')
    expect(message).toContain('Detection still reports Unity at client/')
    ctx.projects.rescan = vi.fn(async () => { projects[0] = { ...project(), engineRoot: 'tools/LevelEditor' }; return projects })
    expect(await declareEngineRoot(ctx, { world: 'game', root: 'tools/LevelEditor', playerWords: 'yes that one', actor: 'genio' })).not.toContain('Detection still reports')
  })

  it('the chat tool requires the player\'s own words and refuses the Bot', async () => {
    const home = new Home(path.join(dir, 'home'))
    const said: { id: string; wksp: string; role: 'player' | 'genio'; text: string; ts: string }[] = [{ id: 'g1', wksp: 'main', role: 'genio', text: 'use client', ts: new Date().toISOString() }]
    Object.assign(ctx.main.wksp, { history: () => said })
    const tool = (role: 'genio' | 'bot') => createToolRegistry(() => ctx, home, role).find(t => t.name === 'world_engine_root')!
    expect(await tool('genio').invoke({ world: 'game', root: 'client' })).toMatchObject({ isError: true })
    // Words only Genio wrote are not the player's instruction.
    expect(await tool('genio').invoke({ world: 'game', root: 'client', player_words: 'use client' })).toMatchObject({ isError: true })
    said.push({ id: 'p1', wksp: 'main', role: 'player', text: 'use client', ts: new Date().toISOString() })
    expect(await tool('bot').invoke({ world: 'game', root: 'client', player_words: 'use client' })).toMatchObject({ isError: true })
    expect(fs.existsSync(path.join(dir, '.genio', 'project.json'))).toBe(false)
    const ok = await tool('genio').invoke({ world: 'game', root: 'client', player_words: 'use client' })
    expect(ok.isError).toBeUndefined()
    expect(declared()).toEqual({ engineRoot: 'client' })
  })

  it('surfaces an ambiguity once as a choice and pins the picked root', async () => {
    surfaceEngineAmbiguity(ctx)
    surfaceEngineAmbiguity(ctx)
    expect(decisions).toHaveLength(1)
    const d = decisions[0]
    expect(d).toMatchObject({
      project: 'game', key: 'engine-root:unity@client|unity@tools/LevelEditor',
      options: ['Unity at client/', 'Unity at tools/LevelEditor/', KEEP_DETECTING], recommendation: 'Unity at client/',
      action: { kind: 'engine-root', project: 'game', roots: { 'Unity at client/': 'client', 'Unity at tools/LevelEditor/': 'tools/LevelEditor' } }
    })
    // answered (resolved) choices still count: the same ambiguity never asks twice
    d.resolvedAt = 'now'
    surfaceEngineAmbiguity(ctx)
    expect(decisions).toHaveLength(1)
    expect(await answerEngineChoice(ctx, d, KEEP_DETECTING)).toBeUndefined()
    expect(fs.existsSync(path.join(dir, '.genio', 'project.json'))).toBe(false)
    expect(await answerEngineChoice(ctx, d, 'Unity at tools/LevelEditor/')).toContain('Pinned Unity at tools/LevelEditor/')
    expect(declared()).toEqual({ engineRoot: 'tools/LevelEditor' })
  })

  it('asks once about a retired manual root, before the ambiguity, and either answer settles the proposal', async () => {
    const update = vi.fn((name: string, patch: Partial<Project>) => { projects[0] = { ...project(), ...patch }; if (!patch.engineProposal) delete projects[0].engineProposal; return projects[0] })
    Object.assign(ctx.projects, { update })
    projects[0] = { ...project(), engineProposal: { engine: 'unity', engineRoot: 'tools/LevelEditor', declarable: true, notedAt: 'now' } }
    surfaceEngineAmbiguity(ctx)
    surfaceEngineAmbiguity(ctx)
    expect(decisions).toHaveLength(1)
    const d = decisions[0]
    expect(d).toMatchObject({
      project: 'game', key: 'engine-proposal:unity@tools/LevelEditor', question: 'game was set to Unity at tools/LevelEditor/ by hand. Should Genio keep working there?',
      options: ['Pin Unity at tools/LevelEditor/', KEEP_DETECTING], recommendation: 'Pin Unity at tools/LevelEditor/',
      action: { kind: 'engine-root', project: 'game', roots: { 'Pin Unity at tools/LevelEditor/': 'tools/LevelEditor' } }
    })
    expect(d.context).toContain('Genio does not write it unless you pick it')
    expect(fs.existsSync(path.join(dir, '.genio'))).toBe(false)
    expect(await answerEngineChoice(ctx, d, KEEP_DETECTING)).toBeUndefined()
    expect(update).toHaveBeenCalledWith('game', { engineProposal: undefined })
    expect(fs.existsSync(path.join(dir, '.genio'))).toBe(false)
    // With the proposal settled, the tie asks next.
    d.resolvedAt = 'now'
    surfaceEngineAmbiguity(ctx)
    expect(decisions.map(x => x.key)).toEqual(['engine-proposal:unity@tools/LevelEditor', 'engine-root:unity@client|unity@tools/LevelEditor'])
    expect(await answerEngineChoice(ctx, d, 'Pin Unity at tools/LevelEditor/')).toContain('Pinned Unity at tools/LevelEditor/')
    expect(declared()).toEqual({ engineRoot: 'tools/LevelEditor' })
    // A proposal no declaration can restore is only noted, never asked.
    expect(engineProposalChoice({ name: 'g', ...twoUnity, engineProposal: { engine: 'godot', engineRoot: '', declarable: false, notedAt: 'now' } })).toBeUndefined()
  })

  it('asks nothing for declared, unambiguous or unscanned projects', () => {
    expect(engineAmbiguityChoice({ name: 'g', ...twoUnity, detected: detection({ declared: true }) })).toBeUndefined()
    expect(engineAmbiguityChoice({ name: 'g', ...twoUnity, detected: detection({ ambiguous: false }) })).toBeUndefined()
    expect(engineAmbiguityChoice({ name: 'g', engine: 'unity', engineRoot: 'client' })).toBeUndefined()
    projects = [{ name: 'plain', path: dir, engine: 'unity', engineRoot: 'client' } as Project]
    surfaceEngineAmbiguity(ctx)
    expect(decisions).toHaveLength(0)
  })
})
