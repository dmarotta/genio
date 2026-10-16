import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/git', () => ({ baseRef: async () => 'main', statusPorcelain: async () => [], hasRemote: async () => true, fetch: async () => ({ code: 0 }),
  aheadBehind: async () => ({ ahead: 1, behind: 0 }), isAncestor: async () => true, diff: async () => '', diffStat: async () => ' assets/models/tower.glb | Bin 0 -> 2048 bytes',
  push: vi.fn(async () => ({ code: 0, stdout: '', stderr: 'pushed' })) }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))
vi.mock('../src/main/gauntlet-unity', () => ({ runUnityGate: vi.fn() }))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { runUnityGate } from '../src/main/gauntlet-unity'
import { createGauntlet } from '../src/main/gauntlet'
import { Home } from '../src/main/home'
import { engineHints, modellerDoneLines, renderBrief, type BriefInput } from '../src/main/brief'
import { placementTarget } from '../src/main/asset-placement'
import { modellerReport, pruneModellerData, unitClaims } from '../src/main/modeller-landing'
import { claimConflict, claimsMeet, holdsClaims, modelScriptsDir } from '../src/shared/modeller'
import type { AppCtx } from '../src/main/services'
import type { StatusEvent, Task } from '../src/shared/types'

let tmp: string | undefined
const mk = (prefix: string): string => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
afterEach(() => { vi.clearAllMocks(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined })

/** One model with one step in a unit's modeller data dir, laid out as the kernel writes it. */
function model(dataDir: string, name = 'tower'): string {
  const dir = path.join(dataDir, name), step = path.join(dir, 'steps', 's001')
  fs.mkdirSync(step, { recursive: true })
  for (const f of ['model.blend', 'model.glb', 'sheet.png', 'view.png', 'script.py']) fs.writeFileSync(path.join(step, f), f.repeat(100))
  fs.writeFileSync(path.join(step, 'receipt.json'), JSON.stringify({ warnings: ['Lowest point is 0.2 m above the ground'] }))
  fs.mkdirSync(path.join(dir, 'steps', '.pending-s002'), { recursive: true })
  const files = { script: 'steps/s001/script.py', blend: 'steps/s001/model.blend', glb: 'steps/s001/model.glb', sheet: 'steps/s001/sheet.png', view: 'steps/s001/view.png', receipt: 'steps/s001/receipt.json' }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'genio.modeller.v1', model: name, branch: 'main', branches: { main: { head: 's001' } }, updated: '2026-10-16T12:00:00Z',
    steps: [{ id: 's001', n: 1, parent: null, caption: 'Raising four timber legs', triangles: 120, objects: 4, warnings: 1, blend_sha256: 'abc', files }] }))
  return dir
}

const unit = (p: Partial<Task>): Task => ({ id: 'a', kind: 'ship', project: 'world', modeller: true, state: 'working', title: 'Tower', createdAt: '2026-10-16T10:00:00Z', ...p }) as Task

describe('claims', () => {
  it('meet on the same file, case and slashes aside, or a folder holding it', () => {
    expect(claimsMeet('Assets/Models/Tower.fbx', 'assets\\models\\tower.fbx')).toBe(true)
    expect(claimsMeet('.genio/modeller/tower/', '.genio/modeller/tower/s01_legs.py')).toBe(true)
    expect(claimsMeet('./ArtSource/3D/tower.blend', 'ArtSource/3D/tower.blend')).toBe(true)
    expect(claimsMeet('Assets/Models/tower.fbx', 'Assets/Models/tower-02.fbx')).toBe(false)
    expect(claimsMeet('.genio/modeller/tower/', '.genio/modeller/towers/')).toBe(false)
  })

  it('are held by a Modeller until it lands or is despawned, only within its project', () => {
    expect(['working', 'ready', 'exited', 'failed'].every(state => holdsClaims(unit({ state: state as Task['state'] })))).toBe(true)
    expect(holdsClaims(unit({ state: 'merged' })) || holdsClaims(unit({ state: 'cleaned' })) || holdsClaims(unit({ modeller: false }))).toBe(false)
    const holder = unit({ id: 'holder', claims: ['assets/models/tower.glb'] })
    expect(claimConflict(['Assets/Models/Tower.glb'], 'world', [holder])).toMatchObject({ path: 'Assets/Models/Tower.glb', holder: { id: 'holder' } })
    expect(claimConflict(['Assets/Models/Tower.glb'], 'world', [holder], 'holder')).toBeUndefined()
    expect(claimConflict(['Assets/Models/Tower.glb'], 'other-world', [holder])).toBeUndefined()
    expect(claimConflict(['Assets/Models/Tower.glb'], 'world', [{ ...holder, state: 'merged' }])).toBeUndefined()
  })

  it('come from the deploy, each model\'s script folder and the unit\'s claim notes; never outside the project', () => {
    const data = mk('genio-claims-')
    model(data, 'tower')
    const note = (text: string, key = 'claim'): StatusEvent => ({ kind: 'note', key, text, fields: {} }) as StatusEvent
    const claims = unitClaims(['assets/models/tower.glb'], data, [note('assets/models/tower.glb ArtSource/3D/tower.blend'), note('`C:/elsewhere/x.fbx`, ../up.fbx'), note('assets/x.png', 'other')])
    expect(claims).toEqual(['assets/models/tower.glb', modelScriptsDir('tower'), 'ArtSource/3D/tower.blend'])
  })
})

describe('step data', () => {
  it('a despawn keeps manifests, renders, receipts and scripts and drops snapshots, GLBs and staging', () => {
    const data = mk('genio-prune-')
    const dir = model(data)
    const r = pruneModellerData(data)
    expect(r.files).toBe(3)
    const step = path.join(dir, 'steps', 's001')
    expect(fs.readdirSync(step).sort()).toEqual(['receipt.json', 'script.py', 'sheet.png', 'view.png'])
    expect(fs.existsSync(path.join(dir, 'steps', '.pending-s002'))).toBe(false)
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    expect(m.steps[0]).toMatchObject({ blend_sha256: null, files: { blend: null, glb: null, view: 'steps/s001/view.png', script: 'steps/s001/script.py' } })
    expect(pruneModellerData(data).files).toBe(0)
  })

  it('the Gauntlet report shows the head step and its checks as information', () => {
    const data = mk('genio-report-')
    expect(modellerReport(data)).toContain('No model step found')
    model(data)
    const report = modellerReport(data)
    expect(report).toContain("No checks for Modellers (the player's choice)")
    expect(report).toContain('step 1 "Raising four timber legs", 120 triangles, 4 parts')
    expect(report).toContain('- Lowest point is 0.2 m above the ground')
  })
})

describe('Modeller brief', () => {
  const base: BriefInput = {
    taskId: 'tower-a1', kind: 'ship', project: 'game', worktree: 'C:\\w\\tower-a1', branch: 'genio/tower-a1', baseBranch: 'main', mode: 'no-mistakes',
    intent: 'a low-poly wooden watchtower', statusFile: 'C:\\s\\tower-a1.status', inboxDir: 'C:\\s\\tower-a1.inbox', taskDataDir: 'C:\\d\\tower-a1', engine: 'unity'
  }

  it('Unity: FBX, its Unity-generated .meta committed with it, the axis check, .blend outside Assets, claims, LFS and no review step', () => {
    const done = modellerDoneLines({ engine: 'unity', engineRoot: 'Game', locate: 'C:\\skills\\fal\\scripts\\fal.mjs', claims: ['Game/Assets/Models/tower.fbx'] })
    const b = renderBrief({ ...base, modeller: 'You are a Modeller.', modellerDone: done, engineHints: engineHints('unity') })
    const dod = b.slice(b.indexOf('# Definition of done'))
    expect(b.indexOf('# Modeller')).toBeLessThan(b.indexOf('# Definition of done'))
    expect(dod).toContain('node "C:/skills/fal/scripts/fal.mjs" locate --world . --kind model --name <model>.fbx --engine unity --engine-root Game')
    expect(dod).toContain('--target unity --fmt fbx')
    expect(dod).toContain('Bake Axis Conversion')
    expect(dod).toContain('the model\'s `.meta` is part of the change')
    expect(dod).toContain('Never hand-write one: import with `genio-unity import`')
    expect(dod).toContain('commit the model without a `.meta` and say in your done line that it appears on the first Unity import')
    expect(dod).toContain('Commit exactly: the export and its `.meta`')
    expect(dod).not.toContain('Never create a `.meta` file')
    expect(dod).toContain('`Game/ArtSource/3D/`')
    expect(dod).toContain('never under `Assets/`')
    expect(dod).toContain('`Game/Assets/Models/tower.fbx`')
    expect(dod).toContain('note [key=claim]: <path>')
    expect(dod).toContain('filter=lfs')
    expect(dod).toContain('When you judge the model done, export its head step')
    expect(dod).toContain('merges your branch as with any Build')
    expect(dod).not.toMatch(/accept/i)
    expect(dod).toContain('without running checks')
    expect(dod).not.toContain('Gauntlet findings')
    expect(b).toContain('Keep .meta files paired')
    expect(b).not.toContain('Never create .meta files')
  })

  it('Godot and web get GLB with no Unity lines; an ordinary Build brief is unchanged', () => {
    const godot = modellerDoneLines({ engine: 'godot', engineRoot: '.', locate: '/f/fal.mjs' }).join('\n')
    expect(godot).toContain('--target godot --fmt glb')
    expect(godot).toContain('`ArtSource/3D/`')
    expect(godot).not.toMatch(/Bake Axis|Assets\/|\.meta/)
    expect(modellerDoneLines({ engine: 'web', locate: '/f/fal.mjs' }).join('\n')).toContain('--target web --fmt glb')
    const plain = renderBrief(base)
    expect(plain).not.toContain('Modeller delivery')
    expect(plain).toContain('Genio then runs the Gauntlet')
    expect(engineHints('unity')).toContain('Keep .meta files paired')
  })
})

describe('.blend placement', () => {
  it('is allowed under an ArtSource folder only, never under Unity Assets', () => {
    const root = mk('genio-blend-')
    const unity = { path: root, engine: 'unity' as const, engineRoot: '' }
    expect(placementTarget(unity, 'ArtSource/3D/tower.blend')).toBe(path.join(root, 'ArtSource/3D/tower.blend'))
    expect(placementTarget({ ...unity, engine: 'godot' }, 'artsource/tower.blend')).toBe(path.join(root, 'artsource/tower.blend'))
    expect(() => placementTarget(unity, 'Models/tower.blend')).toThrow(/ArtSource/)
    expect(() => placementTarget(unity, 'Assets/ArtSource/tower.blend')).toThrow(/outside Unity Assets/)
    expect(() => placementTarget(unity, 'ArtSource/tower.blend1')).toThrow(/Only generated media/)
  })
})

describe('Gauntlet for a Modeller', () => {
  it('runs no checks and no review: sync, the model report, push and PR', async () => {
    const root = mk('genio-gauntlet-modeller-')
    const home = new Home(root); home.ensure()
    const worktree = path.join(root, 'copy'), world = path.join(root, 'world')
    for (const dir of [worktree, world]) fs.mkdirSync(dir, { recursive: true })
    model(path.join(home.taskDir('unit'), 'modeller'))
    const briefPath = path.join(root, 'brief.md')
    fs.writeFileSync(briefPath, "## Player's intent\n\na low-poly wooden watchtower\n\n## Genio spec\n\nnone\n")
    const task = { id: 'unit', kind: 'ship', modeller: true, project: 'world', worktree, branch: 'genio/unit', baseBranch: 'main', title: 'Watchtower', briefPath } as Task
    const project = { name: 'world', path: world, engine: 'unity', engineRoot: '', commands: { lint: 'exit 1', build: 'exit 1', test: 'exit 1' } } as any
    const crew = { get: () => task, update: vi.fn((_id, patch) => Object.assign(task, patch)), send: vi.fn(), bump: vi.fn(), registerPr: vi.fn(async () => ({ ok: true, message: 'registered' })) }
    const createPr = vi.fn(async (_wt: string, _pr: { body: string }) => ({ ok: true, url: 'https://github.com/o/r/pull/7', message: '' }))
    const ctx = { appRoot: root, home: () => ({ crew }), projects: { get: () => project }, settings: { get: () => ({ validationMaxRounds: 3 }) },
      terminals: { scrollback: () => '' }, forge: { available: () => true, createPr } } as unknown as AppCtx
    expect(await createGauntlet(() => ctx, home).run('unit')).toMatchObject({ ok: true })
    const steps = task.validation!.steps
    expect(steps.map(s => s.name)).toEqual(['sync', 'model', 'push', 'pr'])
    expect(steps.find(s => s.name === 'model')).toMatchObject({ state: 'skipped', output: expect.stringContaining('120 triangles') })
    expect(task.validation!.state).toBe('passed')
    expect(query).not.toHaveBeenCalled()
    expect(runUnityGate).not.toHaveBeenCalled()
    expect(createPr.mock.calls[0][1].body).toContain('| model | skipped |')
    expect(crew.registerPr).toHaveBeenCalledWith('unit', 'https://github.com/o/r/pull/7')
  })
})
