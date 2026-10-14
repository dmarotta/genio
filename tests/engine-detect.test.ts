import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { compareCandidates, detectProject, scanCandidates } from '../src/main/engine-detect'
import { createProjectsService, engineChangeNotice, engineProposalNotice, refreshEngine } from '../src/main/projects'
import { bus } from '../src/main/bus'
import { Home } from '../src/main/home'
import { readWorldMetadata } from '../src/main/world-metadata'
import type { AppCtx } from '../src/main/services'
import type { EngineCandidate, Project } from '@shared/types'
import { engineSummary } from '@shared/engine'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-detect-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })
const put = (rel: string, value = '') => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
const unity = (at: string, version = '6000.0.23f1') => put(`${at ? at + '/' : ''}ProjectSettings/ProjectVersion.txt`, `m_EditorVersion: ${version}\nm_EditorVersionWithRevision: ${version} (abc)\n`)
const pkg = (at: string, deps: Record<string, string>, scripts: Record<string, string> = {}) =>
  put(`${at ? at + '/' : ''}package.json`, JSON.stringify({ scripts, dependencies: deps }))
const roots = (cs: EngineCandidate[]) => cs.map(c => `${c.engine}@${c.root}`)
const project = (patch: Partial<Project> = {}): Project => ({
  name: 'game', path: root, defaultBranch: 'main', engine: 'other', commands: {},
  mode: 'local-only', yolo: false, forge: 'none', branchPrefix: 'genio/', managed: false, addedAt: '', ...patch
})

// The Recon's synthetic layouts (appendix F): what v2 picks and what it reports.
it('two Unity projects: the alphabetical one wins and the tie is flagged', async () => {
  unity('client'); unity('tools/LevelEditor')
  const d = await detectProject(root)
  expect(d).toMatchObject({ engine: 'unity', engineRoot: 'client', detected: { ambiguous: false, declared: false, version: '6000.0.23f1' } })
  expect(roots(d.detected.candidates)).toEqual(['unity@client', 'unity@tools/LevelEditor'])
  unity('editor')
  const tie = await detectProject(root)
  expect(tie).toMatchObject({ engineRoot: 'client', detected: { ambiguous: true } })
})

it('Godot and Unity side by side: alphabetical by root, flagged ambiguous', async () => {
  put('b-godot/project.godot'); unity('a-unity')
  const d = await detectProject(root)
  expect(d).toMatchObject({ engine: 'unity', engineRoot: 'a-unity', detected: { ambiguous: true } })
  expect(roots(d.detected.candidates)).toEqual(['unity@a-unity', 'godot@b-godot'])
})

it('a strong nested marker beats a medium one at the root', async () => {
  pkg('', { three: '*' }); unity('unity')
  const d = await detectProject(root)
  expect(d).toMatchObject({ engine: 'unity', engineRoot: 'unity', detected: { ambiguous: false } })
  expect(roots(d.detected.candidates)).toEqual(['unity@unity', 'web@'])
})

it('finds nested Bevy, web, Defold, GameMaker and MonoGame games with commands that run from the checkout', async () => {
  put('Cargo.toml', '[workspace]\nmembers = ["game"]\n')
  put('game/Cargo.toml', '[package]\nname = "g"\n[dependencies]\nbevy = { version = "0.14.2", features = ["dynamic_linking"] }\n')
  expect(await detectProject(root)).toMatchObject({ engine: 'bevy', engineRoot: 'game', detected: { version: '0.14.2' }, commands: { run: 'cargo run --manifest-path "game/Cargo.toml"' } })
  fs.rmSync(path.join(root, 'game'), { recursive: true }); fs.rmSync(path.join(root, 'Cargo.toml'))
  pkg('web', { three: '^0.160.0' }, { dev: 'vite', build: 'vite build' })
  expect(await detectProject(root)).toMatchObject({ engine: 'web', engineRoot: 'web', commands: { setup: 'npm --prefix "web" install', run: 'npm --prefix "web" run dev', build: 'npm --prefix "web" run build' } })
  put('games/defold/game.project')
  expect(await detectProject(root)).toMatchObject({ engine: 'defold', engineRoot: 'games/defold' })
  put('gm/Game.yyp', '{"MetaData":{"IDEVersion":"2024.8.1.171"}}')
  expect(await detectProject(root)).toMatchObject({ engine: 'gamemaker', engineRoot: 'gm', detected: { version: '2024.8.1.171' } })
  fs.rmSync(path.join(root, 'gm'), { recursive: true }); fs.rmSync(path.join(root, 'games'), { recursive: true }); fs.rmSync(path.join(root, 'web'), { recursive: true })
  put('src/Game/Game.csproj', '<Project><ItemGroup><PackageReference Include="MonoGame.Framework.DesktopGL" /></ItemGroup></Project>')
  expect(await detectProject(root)).toMatchObject({ engine: 'monogame', engineRoot: 'src/Game', commands: { run: 'dotnet run --project "src/Game"' } })
})

it('finds strong markers to depth 3, medium ones to depth 2 and weak ones only at the root', async () => {
  unity('games/client/unity')
  expect(await detectProject(root)).toMatchObject({ engine: 'unity', engineRoot: 'games/client/unity' })
  fs.rmSync(path.join(root, 'games'), { recursive: true })
  pkg('a/b/c', { phaser: '*' })
  put('lua/main.lua')
  expect((await detectProject(root)).detected.candidates).toEqual([])
  put('main.lua')
  expect(await detectProject(root)).toMatchObject({ engine: 'love2d', engineRoot: '', commands: { run: 'love .' } })
  pkg('a/b', { phaser: '*' })
  expect(await detectProject(root)).toMatchObject({ engine: 'web', engineRoot: 'a/b' })
})

it('reads engine versions from Godot, Unreal and Bevy project files', async () => {
  put('project.godot', 'config_version=5\n[application]\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n')
  expect((await detectProject(root)).detected.version).toBe('4.3')
  fs.rmSync(path.join(root, 'project.godot'))
  put('Shooter/Shooter.uproject', '{ "FileVersion": 3, "EngineAssociation": "5.4" }')
  expect(await detectProject(root)).toMatchObject({ engine: 'unreal', engineRoot: 'Shooter', detected: { version: '5.4' } })
  // A source build's association is a GUID, not a version.
  put('Shooter/Shooter.uproject', '{ "EngineAssociation": "{1A2B3C4D-0000-0000-0000-000000000000}" }')
  expect((await detectProject(root)).detected.version).toBeUndefined()
})

it('orders candidates strongest, then shallowest, then alphabetically', () => {
  const c = (engine: EngineCandidate['engine'], root: string, strength: EngineCandidate['strength']): EngineCandidate => ({ engine, root, strength })
  const list = [c('web', '', 'medium'), c('love2d', '', 'weak'), c('unity', 'b/x', 'strong'), c('godot', 'z', 'strong'), c('unity', 'a', 'strong'), c('bevy', 'a', 'medium')]
  expect(roots([...list].sort(compareCandidates))).toEqual(['unity@a', 'godot@z', 'unity@b/x', 'web@', 'bevy@a', 'love2d@'])
})

it('never follows symbolic links or junctions', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-detect-outside-'))
  try {
    fs.mkdirSync(path.join(outside, 'ProjectSettings'))
    fs.writeFileSync(path.join(outside, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n')
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction')
    expect((await detectProject(root)).detected.candidates).toEqual([])
    // Declaring the link does not escape the checkout either.
    put('.genio/project.json', JSON.stringify({ engineRoot: 'linked' }))
    expect(await detectProject(root)).toMatchObject({ engine: 'other', detected: { declared: false, warning: expect.stringMatching(/leaves the repository/) } })
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

it('honours a valid .genio/project.json declaration and ignores an invalid one with a warning', async () => {
  unity('client'); unity('tools/LevelEditor')
  put('.genio/project.json', '\uFEFF' + JSON.stringify({ engineRoot: 'tools/LevelEditor' }))
  const declared = await detectProject(root)
  expect(declared).toMatchObject({ engine: 'unity', engineRoot: 'tools/LevelEditor', detected: { declared: true, ambiguous: false } })
  expect(roots(declared.detected.candidates)).toEqual(['unity@tools/LevelEditor', 'unity@client'])
  // A declared root may sit deeper than the scan or in a skipped folder.
  put('deep/er/than/scan/project.godot')
  put('.genio/project.json', JSON.stringify({ engineRoot: './deep/er/than/scan/' }))
  expect(await detectProject(root)).toMatchObject({ engine: 'godot', engineRoot: 'deep/er/than/scan', detected: { declared: true } })
  for (const [value, why] of [['docs', /no game engine marker/], ['../elsewhere', /leaves the repository/], ['C:/Games', /leaves the repository/], ['missing', /does not exist/]] as const) {
    if (value === 'docs') fs.mkdirSync(path.join(root, 'docs'))
    put('.genio/project.json', JSON.stringify({ engineRoot: value }))
    expect(await detectProject(root)).toMatchObject({ engine: 'unity', engineRoot: 'client', detected: { declared: false, warning: expect.stringMatching(why) } })
  }
  put('.genio/project.json', '{ not json')
  expect((await detectProject(root)).detected.warning).toMatch(/not valid JSON/)
  fs.rmSync(path.join(root, '.genio'), { recursive: true })
  expect(await detectProject(root)).toMatchObject({ engineRoot: 'client', detected: { declared: false } })
  expect((await detectProject(root)).detected.warning).toBeUndefined()
})

it('a refresh records what it found and fills only unset commands on an engine change', async () => {
  const p = project({ commands: { build: 'make game' } })
  expect(await refreshEngine(p)).toMatchObject({ engine: 'other', commands: { build: 'make game' }, detected: { candidates: [] } })
  put('game/project.godot')
  const moved = await refreshEngine(p)
  expect(moved).toMatchObject({ engine: 'godot', engineRoot: 'game' })
  expect(moved.commands).toEqual({ build: 'make game', run: 'godot --path "game"' })
  expect(engineChangeNotice(p, moved)).toBe(`game: no game engine → ${engineSummary('godot', 'game')}.`)
  // Unchanged engine: the player's later edits are never refilled.
  expect((await refreshEngine({ ...moved, commands: {} })).commands).toEqual({})
  unity('a-unity')
  const next = await refreshEngine(moved)
  expect(next).toMatchObject({ engine: 'unity', engineRoot: 'a-unity' })
  expect(roots(next.detected!.candidates)).toEqual(['unity@a-unity', 'godot@game'])
})

it('migration: a manual engine equal to detection goes silently, a differing one is kept once as a proposal', async () => {
  unity('client'); unity('tools/LevelEditor')
  const equal = await refreshEngine(project({ engine: 'unity', engineRoot: 'client', engineSource: 'manual', engineRootSource: 'manual' }))
  expect(equal).toMatchObject({ engine: 'unity', engineRoot: 'client' })
  expect(equal).not.toHaveProperty('engineProposal')
  expect(equal).not.toHaveProperty('engineSource')
  expect(equal).not.toHaveProperty('engineRootSource')
  // A manual root detection does not pick: kept as a declaration the player can ask Genio to write.
  const kept = await refreshEngine(project({ engine: 'unity', engineRoot: 'tools/LevelEditor', engineSource: 'auto', engineRootSource: 'manual' }))
  expect(kept).toMatchObject({ engine: 'unity', engineRoot: 'client', engineProposal: { engine: 'unity', engineRoot: 'tools/LevelEditor', declarable: true } })
  expect(engineProposalNotice(kept)).toBe('game: You had set Unity at ./tools/LevelEditor by hand; Genio now infers the engine and uses Unity 6000.0.23f1 at ./client. To keep yours, ask Genio to pin it in .genio/project.json { "engineRoot": "tools/LevelEditor" }; Genio never writes it into the repository on its own.')
  // Never written into the repository.
  expect(fs.existsSync(path.join(kept.path, '.genio'))).toBe(false)
  // Once: the next refresh keeps it without proposing again, and drops it when detection agrees.
  const again = await refreshEngine(kept)
  expect(again.engineProposal).toBe(kept.engineProposal)
  put('.genio/project.json', JSON.stringify({ engineRoot: 'tools/LevelEditor' }))
  const pinned = await refreshEngine(again)
  expect(pinned).toMatchObject({ engineRoot: 'tools/LevelEditor', detected: { declared: true } })
  expect(pinned).not.toHaveProperty('engineProposal')
  // A manual engine no marker backs cannot be declared, only noted.
  const godot = await refreshEngine(project({ engine: 'godot', engineRoot: '', engineSource: 'manual' }))
  expect(godot.engineProposal).toMatchObject({ engine: 'godot', engineRoot: '', declarable: false })
  expect(engineProposalNotice(godot)).not.toMatch(/project\.json/)
  const none = await refreshEngine(project({ engine: 'other', engineSource: 'manual' }))
  expect(none.engineProposal).toMatchObject({ engine: 'other', declarable: false })
})

it('migration notifies the player once and a dismissed proposal stays gone', async () => {
  const home = new Home(path.join(root, 'home'))
  const records: unknown[] = []
  const ctx = { main: { home }, ledger: { record(r: unknown) { records.push(r) } } } as unknown as AppCtx
  const toast = vi.spyOn(bus, 'toast').mockImplementation(() => undefined)
  fs.mkdirSync(path.join(root, 'folder'))
  put('folder/client/project.godot')
  const svc = createProjectsService(() => ctx)
  const { project: opened } = await svc.openFolder(path.join(root, 'folder'))
  // An entry saved by the retired picker: Unity by hand.
  const file = home.projectsFile
  fs.writeFileSync(file, JSON.stringify([{ ...opened, engine: 'unity', engineRoot: '', engineSource: 'manual' }]))
  const restarted = createProjectsService(() => ctx)
  toast.mockClear()
  await restarted.refreshRemotes()
  expect(restarted.get(opened.name)).toMatchObject({ engine: 'godot', engineRoot: 'client', engineProposal: { engine: 'unity', declarable: false } })
  expect(toast).toHaveBeenCalledTimes(1)
  expect(toast).toHaveBeenCalledWith('warn', 'Engine set by hand retired', expect.stringMatching(/You had set Unity at the repository root by hand/))
  expect(records).toContainEqual(expect.objectContaining({ event: 'project.engine_changed', data: expect.objectContaining({ proposal: expect.objectContaining({ engine: 'unity' }) }) }))
  toast.mockClear()
  await restarted.rescan(opened.name)
  expect(toast).not.toHaveBeenCalled()
  expect(restarted.update(opened.name, { engineProposal: undefined })).not.toHaveProperty('engineProposal')
  await restarted.rescan(opened.name)
  expect(restarted.get(opened.name)).not.toHaveProperty('engineProposal')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).not.toHaveProperty('engineSource')
  expect(fs.existsSync(path.join(root, 'folder', '.genio'))).toBe(false)
})

it('a new project is scaffolded for its engine but not pinned to it', async () => {
  const home = new Home(path.join(root, 'home'))
  const ctx = { main: { home }, ledger: { record() {} } } as unknown as AppCtx
  const svc = createProjectsService(() => ctx)
  const created = await svc.create({ name: 'space-goblins', engine: 'godot' })
  expect(fs.readFileSync(path.join(created.path, '.gitignore'), 'utf8')).toMatch(/\.godot\//)
  expect(created).toMatchObject({ engine: 'other', engineRoot: '' })
  expect(created).not.toHaveProperty('engineSource')
  fs.writeFileSync(path.join(created.path, 'project.godot'), '')
  expect((await svc.rescan('space-goblins'))[0]).toMatchObject({ engine: 'godot', engineRoot: '' })
})

it('Rescan re-detects one project, toasts the change and keeps edits made during the scan', async () => {
  const home = new Home(path.join(root, 'home'))
  const ctx = { main: { home }, ledger: { record() {} } } as unknown as AppCtx
  const toast = vi.spyOn(bus, 'toast').mockImplementation(() => undefined)
  fs.mkdirSync(path.join(root, 'folder'))
  const svc = createProjectsService(() => ctx)
  const { project: opened } = await svc.openFolder(path.join(root, 'folder'))
  expect(opened.detected).toMatchObject({ candidates: [], ambiguous: false, declared: false })
  await expect(svc.rescan('nope')).rejects.toThrow('Unknown project')
  put('folder/Game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.23f1\n')
  const [rescanned] = await svc.rescan(opened.name)
  expect(rescanned).toMatchObject({ engine: 'unity', engineRoot: 'Game', detected: { version: '6000.0.23f1' } })
  expect(svc.get(opened.name)).toMatchObject({ engine: 'unity', engineRoot: 'Game' })
  expect(toast).toHaveBeenCalledWith('info', 'Project engine changed', `${opened.name}: no game engine → Unity 6000.0.23f1 at ./Game.`)
  toast.mockClear()
  await svc.rescan(opened.name)
  expect(toast).not.toHaveBeenCalled()
  // Only detection writes what the scan found.
  expect(svc.update(opened.name, { detected: undefined }).detected).toMatchObject({ candidates: [{ engine: 'unity', root: 'Game' }] })
  put('folder/.genio/project.json', JSON.stringify({ engineRoot: 'Docs' }))
  await svc.rescan()
  expect(toast).toHaveBeenCalledWith('warn', 'Engine declaration ignored', expect.stringMatching(/engineRoot "Docs"/))
  // Startup refresh and Sync report the change too.
  fs.rmSync(path.join(root, 'folder', 'Game'), { recursive: true })
  expect(await svc.refreshRemotes(opened.name)).toEqual([`${opened.name}: Unity at ./Game → no game engine.`])
  expect((await readWorldMetadata(svc.get(opened.name))).engineVersion).toBeUndefined()
})

it('reports the detected version of non-Unity engines as project metadata', async () => {
  put('project.godot', 'config/features=PackedStringArray("4.2")\n')
  const p = await refreshEngine(project())
  expect((await readWorldMetadata(p)).engineVersion).toBe('4.2')
})

it('scans a 10k-folder tree without stalling the main process', async () => {
  for (let a = 0; a < 25; a++) for (let b = 0; b < 20; b++) for (let c = 0; c < 20; c++) fs.mkdirSync(path.join(root, `a${a}`, `b${b}`, `c${c}`), { recursive: true })
  let worst = 0, last = performance.now()
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 2)
  try {
    last = performance.now()
    await scanCandidates(root)
  } finally {
    clearInterval(timer)
  }
  expect(worst).toBeLessThan(50)
}, 120_000)
