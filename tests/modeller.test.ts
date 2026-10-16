import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { listBlenders, pickModellerBlender } from '../resources/unit-skills/genio/lib/blender-path.mjs'
import * as kernel from '../resources/unit-skills/genio/skills/blender/scripts/modeller.mjs'
import type { Manifest, StepDone, StepFailed } from '../resources/unit-skills/genio/skills/blender/scripts/modeller.mjs'

const run = promisify(execFile)
const scripts = path.resolve('resources/unit-skills/genio/skills/blender/scripts')
const cli = path.join(scripts, 'modeller.mjs')
const fixtures = path.resolve('tests/fixtures/modeller')
const fake = { prefix: [path.join(fixtures, 'fake-blender.mjs')] }
const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const root = fs.mkdtempSync(path.join(process.env.GENIO_BLENDER_TEST_SCRATCH ?? os.tmpdir(), 'genio-modeller-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let dataDir = ''
let src = ''
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  src = fs.mkdtempSync(path.join(root, 'src-'))
})

/** A fake step script: its docstring is the caption, `# part:` lines add parts. */
function script(name: string, caption: string | null, ...lines: string[]): string {
  const file = path.join(src, name)
  fs.writeFileSync(file, [caption === null ? '' : `"""${caption}"""`, ...lines].join('\n'))
  return file
}
const manifest = (model = 'tower'): Manifest => JSON.parse(fs.readFileSync(path.join(dataDir, model, 'manifest.json'), 'utf8'))
const snapshot = (file: string): { parts: string[]; scripts: string[] } => JSON.parse(fs.readFileSync(file).subarray(4).toString('utf8'))
const done = (r: StepDone | StepFailed): StepDone => {
  if (!r.ok) throw new Error(`step failed: ${r.kind} ${r.error}`)
  return r
}
const failed = (r: StepDone | StepFailed): StepFailed => {
  if (r.ok) throw new Error(`step ${r.id} should have failed`)
  return r
}
async function fakeModel(model = 'tower'): Promise<void> {
  await kernel.init({ dataDir, model, blender: { path: process.execPath, version: '4.2.1' }, cwd: src })
}
const step = (file: string, extra: Partial<Parameters<typeof kernel.step>[0]> = {}) => kernel.step({ dataDir, model: 'tower', script: file, runner: fake, timeout: 20, ...extra })

// Each fake step is a Node process; a busy machine needs more than the default 5 s per test.
describe('Modeller kernel with a fake Blender', { timeout: 60000 }, () => {
  it('pins the Blender per model, keeps init idempotent and refuses data inside the worktree', async () => {
    const first = await kernel.init({ dataDir, model: 'tower', blender: { path: process.execPath, version: '4.2.1' }, target: 'unity', budget: 5000, size: '4x4x10', cwd: src })
    expect(first).toMatchObject({ ok: true, existing: false, blender: '4.2.1', target: 'unity', checks: { budget: 5000, size: [4, 4, 10] }, branch: 'main', head: null })
    expect(manifest().blender).toMatchObject({ path: process.execPath, version: '4.2.1' })
    const again = await kernel.init({ dataDir, model: 'tower', budget: 8000, cwd: src })
    expect(again).toMatchObject({ existing: true, blender: '4.2.1', checks: { budget: 8000, size: [4, 4, 10] } })
    await expect(kernel.init({ dataDir: path.join(src, 'data'), model: 'tower', blender: { path: process.execPath, version: '4.2.1' }, cwd: src })).rejects.toThrow(/outside the project/)
    await expect(kernel.init({ dataDir, model: '../escape', cwd: src })).rejects.toThrow(/Model name/)
  })

  it('runs a multi-step sequence: snapshots, GLBs, sheets, receipts and a manifest outside the worktree', async () => {
    await fakeModel()
    const legs = done(await step(script('s01_legs.py', 'Raising four legs', '# part: Leg 1', '# part: Leg 2')))
    expect(legs).toMatchObject({ id: 's001', n: 1, name: 'legs', caption: 'Raising four legs', parent: null, triangles: 24, objects: 2, warnings: [] })
    const deck = done(await step(script('s02_deck.py', 'Laying the deck', '# part: Deck')))
    expect(deck).toMatchObject({ id: 's002', parent: 's001', triangles: 36 })
    // the second step ran on the first step's snapshot
    expect(snapshot(deck.blend!)).toEqual({ parts: ['Leg 1', 'Leg 2', 'Deck'], scripts: ['Raising four legs', 'Laying the deck'] })
    for (const f of [deck.blend!, deck.glb!, deck.sheet!, deck.receipt]) expect(fs.existsSync(f)).toBe(true)
    expect(fs.readFileSync(deck.blend!).subarray(0, 4)).toEqual(ZSTD)
    expect(path.relative(src, deck.blend!).startsWith('..')).toBe(true)
    const receipt = JSON.parse(fs.readFileSync(deck.receipt, 'utf8'))
    expect(receipt).toMatchObject({ ok: true, id: 's002', caption: 'Laying the deck', triangles: 36, vertices: 24, parent: 's001', branch: 'main', bounds: { dimensions: [1, 1, 1] } })
    expect(receipt.t).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(fs.readFileSync(path.join(dataDir, 'tower', 'steps', 's002', 'script.py'), 'utf8')).toContain('# part: Deck')
    const m = manifest()
    expect(m.steps.map((s) => [s.id, s.caption, s.triangles])).toEqual([['s001', 'Raising four legs', 24], ['s002', 'Laying the deck', 36]])
    expect(m.branches.main.head).toBe('s002')
    expect(m.steps[1].files).toMatchObject({ blend: 'steps/s002/model.blend', glb: 'steps/s002/model.glb', sheet: 'steps/s002/sheet.png', receipt: 'steps/s002/receipt.json' })
    const nameless = done(await step(script('s03_rail.py', null, '# part: Rail')))
    expect(nameless.caption).toBe('rail')
    expect(nameless.warnings[0]).toMatch(/docstring/)
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('reverts to step N and branches from a step without losing either line', async () => {
    await fakeModel()
    for (const [i, part] of ['Legs', 'Deck', 'Roof'].entries()) done(await step(script(`s0${i + 1}_${part}.py`, `Adding ${part}`, `# part: ${part}`)))
    const reverted = await kernel.revert({ dataDir, model: 'tower', to: 2 })
    expect(reverted).toMatchObject({ head: 's002', reverted: 's003' })
    expect(reverted.steps.map((s) => s.id)).toEqual(['s001', 's002'])
    const flat = done(await step(script('s04_flat.py', 'A flat roof', '# part: Flat roof')))
    expect(flat).toMatchObject({ id: 's004', parent: 's002' })
    expect(snapshot(flat.blend!).parts).toEqual(['Legs', 'Deck', 'Flat roof'])
    await expect(kernel.revert({ dataDir, model: 'tower', to: 's003' })).rejects.toThrow(/not on branch main.*branch tower <name> --from s003/)

    const tall = await kernel.branch({ dataDir, model: 'tower', name: 'tall', from: 's001' })
    expect(tall).toMatchObject({ branch: 'tall', head: 's001', branches: { main: { head: 's004' }, tall: { head: 's001', from: 's001' } } })
    const stilts = done(await step(script('s05_stilts.py', 'Tall stilts', '# part: Stilts')))
    expect(stilts).toMatchObject({ id: 's005', parent: 's001', branch: 'tall' })
    expect(snapshot(stilts.blend!).parts).toEqual(['Legs', 'Stilts'])
    await expect(kernel.branch({ dataDir, model: 'tower', name: 'tall' })).rejects.toThrow(/already exists/)
    const back = await kernel.switchBranch({ dataDir, model: 'tower', name: 'main' })
    expect(back.steps.map((s) => s.id)).toEqual(['s001', 's002', 's004'])
    expect(manifest().history.map((h) => h.op)).toEqual(['revert', 'branch', 'switch'])
  })

  it('amends the head in place: the replacement runs on the head\'s parent', async () => {
    await fakeModel()
    done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    done(await step(script('s02_roof.py', 'Roof', '# part: Roof')))
    const fixed = done(await step(script('s02_roof_fixed.py', 'Roof, fixed', '# part: Better roof'), { amend: true, name: 'roof' }))
    expect(fixed).toMatchObject({ id: 's003', parent: 's001', name: 'roof' })
    expect(snapshot(fixed.blend!).parts).toEqual(['Legs', 'Better roof'])
    expect(manifest().steps.find((s) => s.id === 's002')?.superseded_by).toBe('s003')
  })

  it('keeps the last five snapshots per branch and replays pruned ones from their scripts', async () => {
    await fakeModel()
    for (let i = 1; i <= 8; i++) done(await step(script(`s${i}_p${i}.py`, `Part ${i}`, `# part: P${i}`)))
    const m = manifest()
    expect(m.steps.filter((s) => s.files.blend).map((s) => s.id)).toEqual(['s004', 's005', 's006', 's007', 's008'])
    expect(fs.existsSync(path.join(dataDir, 'tower', 'steps', 's001', 'model.blend'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'tower', 'steps', 's001', 'model.glb'))).toBe(true)
    // a branch from a pruned step replays s001..s002 from scratch
    await kernel.branch({ dataDir, model: 'tower', name: 'alt', from: 's002' })
    const alt = done(await step(script('alt.py', 'Alternative', '# part: Alt')))
    const receipt = JSON.parse(fs.readFileSync(alt.receipt, 'utf8'))
    expect(receipt).toMatchObject({ replayed: 2, base: null })
    expect(snapshot(alt.blend!).parts).toEqual(['P1', 'P2', 'Alt'])
    // a reverted head on a kept snapshot opens it directly
    await kernel.switchBranch({ dataDir, model: 'tower', name: 'main' })
    await kernel.revert({ dataDir, model: 'tower', to: 's006' })
    const next = done(await step(script('next.py', 'Next', '# part: Next')))
    expect(JSON.parse(fs.readFileSync(next.receipt, 'utf8'))).toMatchObject({ replayed: 0, base: path.join(dataDir, 'tower', 'steps', 's006', 'model.blend') })
    // materialize rebuilds a pruned snapshot on demand, identical to the original state
    const rebuilt = await kernel.materialize({ dataDir, model: 'tower', step: 's003', runner: fake })
    expect(rebuilt.replayed).toBe(3)
    expect(snapshot(rebuilt.blend)).toEqual({ parts: ['P1', 'P2', 'P3'], scripts: ['Part 1', 'Part 2', 'Part 3'] })
    expect(manifest().steps.find((s) => s.id === 's003')?.files.blend).toBe('steps/s003/model.blend')
    await kernel.keep({ dataDir, model: 'tower', step: 's003' })
    done(await step(script('more.py', 'More', '# part: More')))
    expect(manifest().steps.find((s) => s.id === 's003')?.files.blend).toBe('steps/s003/model.blend')
  })

  it('recovers from a hang, a crash and a script error at the last good snapshot', async () => {
    await fakeModel()
    const good = done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    const started = Date.now()
    const hang = failed(await step(script('s02_hang.py', 'Hanging', '# fake: hang'), { timeout: 1 }))
    expect(Date.now() - started).toBeLessThan(10000)
    expect(hang).toMatchObject({ kind: 'hang', id: 's002', head: 's001', recovered: { head: 's001', snapshot: good.blend, intact: true } })
    expect(hang.message).toMatch(/ran past 1 s.*stays at s001/)
    expect(fs.readFileSync(hang.script, 'utf8')).toContain('# fake: hang')
    const crash = failed(await step(script('s02_crash.py', 'Crashing', '# fake: crash')))
    expect(crash).toMatchObject({ kind: 'crash', head: 's001' })
    const error = failed(await step(script('s02_error.py', 'Raising', '# fake: error')))
    expect(error).toMatchObject({ kind: 'error', error: 'RuntimeError: fake failure', trace: ['script.py:2: raise RuntimeError'] })
    const m = manifest()
    expect(m.failures.map((f) => f.kind)).toEqual(['hang', 'crash', 'error'])
    expect(m.steps.map((s) => s.id)).toEqual(['s001'])
    expect(m.next).toBe(2)
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'failed'))).toHaveLength(3)
    // no partial outputs survive a failure, and the next step continues from s001
    for (const dir of fs.readdirSync(path.join(dataDir, 'tower', 'failed'))) expect(fs.readdirSync(path.join(dataDir, 'tower', 'failed', dir)).every((f) => ['script.py', 'receipt.json', 'plan.json'].includes(f))).toBe(true)
    const deck = done(await step(script('s02_deck.py', 'Deck', '# part: Deck')))
    expect(deck).toMatchObject({ id: 's002', parent: 's001' })
    expect(snapshot(deck.blend!).parts).toEqual(['Legs', 'Deck'])
  })

  it('forgets a damaged snapshot after a failure and rebuilds it by replay', async () => {
    await fakeModel()
    done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    const head = done(await step(script('s02_deck.py', 'Deck', '# part: Deck')))
    fs.appendFileSync(head.blend!, 'garbage')
    const crash = failed(await step(script('s03_crash.py', 'Crashing', '# fake: crash')))
    expect(crash.recovered).toMatchObject({ head: 's002', snapshot: null, intact: false })
    expect(fs.existsSync(head.blend!)).toBe(false)
    const roof = done(await step(script('s03_roof.py', 'Roof', '# part: Roof')))
    expect(JSON.parse(fs.readFileSync(roof.receipt, 'utf8'))).toMatchObject({ replayed: 1 })
    expect(snapshot(roof.blend!).parts).toEqual(['Legs', 'Deck', 'Roof'])
  })

  it('locks a model against concurrent commands, and steals a stale lock', async () => {
    await fakeModel()
    const lock = path.join(dataDir, 'tower', '.lock')
    fs.writeFileSync(lock, String(process.pid))
    await expect(step(script('s01.py', 'One', '# part: A'))).rejects.toThrow(/Another Modeller command/)
    fs.writeFileSync(lock, '2147483646')
    done(await step(script('s01.py', 'One', '# part: A')))
    expect(fs.existsSync(lock)).toBe(false)
  })

  it('refuses to step when the pinned Blender changed', async () => {
    await fakeModel()
    const file = path.join(dataDir, 'tower', 'manifest.json')
    const m = manifest()
    m.blender.size += 1
    fs.writeFileSync(file, JSON.stringify(m))
    await expect(step(script('s01.py', 'One', '# part: A'))).rejects.toThrow(/pinned Blender changed from 4\.2\.1.*--repin/)
    m.blender.path = path.join(src, 'gone', 'blender.exe')
    fs.writeFileSync(file, JSON.stringify(m))
    await expect(step(script('s01.py', 'One', '# part: A'))).rejects.toThrow(/pinned Blender 4\.2\.1 is gone/)
  })

  it('serves status, revert and branch through the CLI', async () => {
    await fakeModel()
    done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    done(await step(script('s02_deck.py', 'Deck', '# part: Deck')))
    const cmd = (...args: string[]) => run(process.execPath, [cli, ...args, '--data', dataDir], { cwd: src })
    const status = JSON.parse((await cmd('status', 'tower')).stdout)
    expect(status).toMatchObject({ ok: true, head: 's002', steps: [{ id: 's001', caption: 'Legs', snapshot: true }, { id: 's002' }] })
    expect(JSON.parse((await cmd('revert', 'tower', 's001')).stdout)).toMatchObject({ head: 's001' })
    expect(JSON.parse((await cmd('branch', 'tower', 'wide', '--from', 's002')).stdout)).toMatchObject({ branch: 'wide', head: 's002' })
    await expect(cmd('frobnicate', 'tower')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage: modeller.mjs') })
    await expect(cmd('revert', 'tower', 's099')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('No step s099') })
  })

  it('derives step names and the data folder', () => {
    expect(kernel.stepName('C:/w/.genio/modeller/tower/s03_deck.py')).toBe('deck')
    expect(kernel.stepName('07-roof fix.py')).toBe('roof-fix')
    expect(kernel.modellerDataDir({ GENIO_MODELLER_DATA: path.join(root, 'm') })).toBe(path.join(root, 'm'))
    expect(kernel.modellerDataDir({ GENIO_BLENDER_SCRATCH: path.join(root, 'unit', 'blender') })).toBe(path.join(root, 'unit', 'modeller'))
  })
})

describe('Modeller Blender choice', () => {
  const b = (version: string) => ({ path: `C:/Blender ${version}/blender.exe`, version: version.split('.').map(Number) })
  it('prefers 4.2 LTS over a newer 5.x, else the newest 4.2-or-later', () => {
    expect(pickModellerBlender([b('5.2.1'), b('4.2.1')])?.path).toBe('C:/Blender 4.2.1/blender.exe')
    expect(pickModellerBlender([b('5.2.1'), b('4.2.3'), b('4.2.1')])?.path).toBe('C:/Blender 4.2.3/blender.exe')
    expect(pickModellerBlender([b('5.2.1'), b('4.5.0')])?.path).toBe('C:/Blender 5.2.1/blender.exe')
    expect(pickModellerBlender([b('4.1.0'), b('3.6.5')])).toBeNull()
    expect(pickModellerBlender([])).toBeNull()
  })
})

const installed = listBlenders()
const blender = pickModellerBlender(installed)

/** Triangles in a GLB's JSON chunk. */
function glbTriangles(file: string): number {
  const bytes = fs.readFileSync(file)
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as { meshes: { primitives: { indices?: number; attributes: { POSITION: number } }[] }[]; accessors: { count: number }[] }
  return json.meshes.flatMap((m) => m.primitives).reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0)
}
const pngSize = (file: string): [number, number] => {
  const b = fs.readFileSync(file)
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

describe.skipIf(!blender)(`Modeller with Blender ${blender?.version.join('.') ?? '(none)'}`, () => {
  const cmd = async (...args: string[]) => {
    const r = await run(process.execPath, [cli, ...args, '--data', dataDir], { cwd: src, timeout: 240000, env: { ...process.env, GENIO_BLENDER: '' } }).catch((e: { code: number; stdout: string; stderr: string }) => e)
    if (!r.stdout) throw new Error(`modeller.mjs ${args.join(' ')} failed: ${r.stderr}`)
    return JSON.parse(r.stdout)
  }
  const tower = path.join(fixtures, 'watchtower')

  it('builds the seven-step watchtower, reviews it, reverts, branches and recovers from a hang', async () => {
    expect(await cmd('init', 'watchtower', '--target', 'unity')).toMatchObject({ ok: true, blender: blender!.version.join('.') })
    const steps: StepDone[] = []
    for (const file of fs.readdirSync(tower).sort()) steps.push(await cmd('step', 'watchtower', path.join(tower, file)))
    expect(steps.map((s) => [s.ok, s.id, s.name])).toEqual([[true, 's001', 'legs'], [true, 's002', 'bracing'], [true, 's003', 'deck'], [true, 's004', 'railing'], [true, 's005', 'roof'], [true, 's006', 'ladder'], [true, 's007', 'fix']])
    expect(steps[4].caption).toBe('Now adding the roof: corner posts, a pyramid of shingles and a finial')
    const last = steps[6]
    // evaluated counts, and a GLB that carries the modifier results (array, bevel, boolean)
    expect(last.triangles).toBe(2802)
    expect(glbTriangles(last.glb!)).toBe(2802)
    expect(pngSize(last.sheet!)).toEqual([1024, 1024])
    expect(last.bounds!.dimensions[2]).toBeGreaterThan(10)
    // the review caught the roof posts poking through the roof, and the fix step cleared it
    expect(steps[4].warnings.join('\n')).toMatch(/Roof post 1 \/ Roof/)
    expect(last.warnings.join('\n')).not.toMatch(/Roof post/)
    const receipt = JSON.parse(fs.readFileSync(last.receipt, 'utf8'))
    expect(receipt).toMatchObject({ schema: 'genio.modeller-step.v1', id: 's007', caption: expect.stringMatching(/^Fixing review notes/), vertices: expect.any(Number), checks: { ground: { ok: true }, budget: { triangles: 2802 } } })
    expect(receipt.checks.pierces.length).toBeGreaterThan(0)

    // snapshots are compressed (zstd) and much smaller than an uncompressed save
    const blend = last.blend!
    expect(fs.readFileSync(blend).subarray(0, 4)).toEqual(ZSTD)
    const plain = path.join(root, `plain-${Date.now()}.blend`)
    const save = path.join(src, 'save.py')
    fs.writeFileSync(save, `import bpy\nbpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(plain)}, copy=True, compress=False)\n`)
    await run(process.execPath, [path.join(scripts, 'blender.mjs'), '--script', save, '--blend', blend, '--scratch', path.join(root, 'logs'), '--timeout', '120'], { cwd: src, env: { ...process.env, GENIO_BLENDER: blender!.path, GENIO_STATUS_FILE: '' } })
    expect(fs.statSync(plain).size / fs.statSync(blend).size).toBeGreaterThan(4)

    // retention: the first two snapshots were pruned; a branch from s002 replays them in Blender
    const status = await cmd('status', 'watchtower')
    expect(status.steps.map((s: { snapshot: boolean }) => s.snapshot)).toEqual([false, false, true, true, true, true, true])
    expect(await cmd('branch', 'watchtower', 'bare', '--from', 's002')).toMatchObject({ branch: 'bare', head: 's002' })
    const steep = path.join(src, 's03_steep_roof.py')
    fs.writeFileSync(steep, `"""A steep roof straight on the bracing"""\nimport math\np.cone('Roof', 2.4, 3.0, (0, 0, 7.5), mat=p.material('Shingles', '#8c2f1f'), segments=4, rot=(0, 0, math.pi / 4))\n`)
    const branched = await cmd('step', 'watchtower', steep)
    expect(branched).toMatchObject({ ok: true, id: 's008', parent: 's002', branch: 'bare', triangles: 368 + 6 })

    // revert on main, then continue from s005
    await cmd('switch', 'watchtower', 'main')
    expect(await cmd('revert', 'watchtower', 's005')).toMatchObject({ head: 's005' })
    const again = await cmd('step', 'watchtower', steep)
    expect(again).toMatchObject({ ok: true, parent: 's005', triangles: 2374 })

    // a hung script is killed by the watchdog; the model stays at the last good step
    const hang = path.join(src, 'hang.py')
    fs.writeFileSync(hang, '"""Hanging on purpose"""\nwhile True:\n    pass\n')
    const hung = await cmd('step', 'watchtower', hang, '--timeout', '3')
    expect(hung).toMatchObject({ ok: false, kind: 'hang', head: 's009', recovered: { intact: true } })
    // a script error comes back with the agent's own line
    const boom = path.join(src, 'boom.py')
    fs.writeFileSync(boom, '"""Breaking on purpose"""\nx = 1\np.part("Nope")\n')
    const broken = await cmd('step', 'watchtower', boom)
    expect(broken).toMatchObject({ ok: false, kind: 'error', head: 's009' })
    expect(broken.error).toMatch(/No part named 'Nope'/)
    expect(broken.trace[0]).toBe('script.py:3: p.part("Nope")')
    const after = await cmd('step', 'watchtower', path.join(tower, 's06_ladder.py'))
    expect(after).toMatchObject({ ok: true, parent: 's009' })
  }, 300000)
})
