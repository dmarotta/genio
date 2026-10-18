import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { blenderCacheDir, LIST_TTL_MS, listBlenders, pickModellerBlender } from '../resources/unit-skills/genio/lib/blender-path.mjs'
import { bytecodeEnv, runBlender } from '../resources/unit-skills/genio/skills/blender/scripts/blender.mjs'
import * as kernel from '../resources/unit-skills/genio/skills/blender/scripts/modeller.mjs'
import type { Manifest, StepDone, StepFailed } from '../resources/unit-skills/genio/skills/blender/scripts/modeller.mjs'
import { readModellerLive } from '../src/main/modeller-live'

const run = promisify(execFile)
const scripts = path.resolve('resources/unit-skills/genio/skills/blender/scripts')
const cli = path.join(scripts, 'modeller.mjs')
const fixtures = path.resolve('tests/fixtures/modeller')
const fake = { prefix: [path.join(fixtures, 'fake-blender.mjs')] }
// a unit started with references runs these tests too: its own must not reach the reviews
delete process.env.GENIO_REFERENCES
const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const root = fs.mkdtempSync(path.join(process.env.GENIO_BLENDER_TEST_SCRATCH ?? os.tmpdir(), 'genio-modeller-test-'))
// Dense test models leave megabytes of snapshots and GLBs: a loaded machine needs more than the default 10 s.
afterAll(() => fs.rmSync(root, { recursive: true, force: true }), 60000)

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
    // a declared symmetry axis for the text review; none clears it
    expect(await kernel.init({ dataDir, model: 'tower', symmetry: 'x', cwd: src })).toMatchObject({ checks: { budget: 8000, symmetry: 'x' } })
    expect(await kernel.init({ dataDir, model: 'tower', symmetry: 'none', cwd: src })).toMatchObject({ checks: { symmetry: null } })
    await expect(kernel.init({ dataDir, model: 'tower', symmetry: 'z' as 'x', cwd: src })).rejects.toThrow(/symmetry is x/)
  })

  it('starts a model\'s lib.py from the template of its kind, with the kind\'s symmetry, never over a lib of the agent\'s', async () => {
    const pin = { path: process.execPath, version: '4.2.1' }
    const lib = path.join(src, '.genio', 'modeller', 'car', 'lib.py')
    const car = await kernel.init({ dataDir, model: 'car', blender: pin, kind: 'vehicle', cwd: src })
    expect(car).toMatchObject({ ok: true, existing: false, checks: { symmetry: 'x' }, template: { kind: 'vehicle', lib, written: true } })
    expect(fs.readFileSync(lib, 'utf8')).toBe(fs.readFileSync(path.join(kernel.TEMPLATES, 'vehicle.py'), 'utf8'))
    fs.writeFileSync(lib, 'PLAN = None\n')
    expect(await kernel.init({ dataDir, model: 'car', kind: 'vehicle', cwd: src })).toMatchObject({ existing: true, template: { lib, written: false } })
    expect(fs.readFileSync(lib, 'utf8')).toBe('PLAN = None\n')
    // a symmetry given wins over the kind's
    expect(await kernel.init({ dataDir, model: 'shed', blender: pin, kind: 'building', symmetry: 'y', cwd: src })).toMatchObject({ checks: { symmetry: 'y' }, template: { kind: 'building', written: true } })
    // without a kind, init writes nothing in the worktree, as before
    const plain = await kernel.init({ dataDir, model: 'plain', blender: pin, cwd: src })
    expect(plain.template).toBeUndefined()
    expect(plain.checks.symmetry).toBeNull()
    expect(fs.existsSync(path.join(src, '.genio', 'modeller', 'plain'))).toBe(false)
    await expect(kernel.init({ dataDir, model: 'odd', blender: pin, kind: 'spaceship' as 'vehicle', cwd: src })).rejects.toThrow(/kind is vehicle, building, prop, weapon, character/)
    expect(fs.readdirSync(kernel.TEMPLATES).sort()).toEqual(Object.keys(kernel.KINDS).map((k) => `${k}.py`).sort())
  })

  it('names the player\'s references in every step\'s review and hands back their image files', async () => {
    await fakeModel()
    const refs = fs.mkdtempSync(path.join(root, 'refs-'))
    fs.writeFileSync(path.join(refs, 'front.png'), 'png')
    fs.writeFileSync(path.join(refs, 'references.json'), JSON.stringify([
      { file: 'front.png', type: 'image', note: 'front view', bytes: 3, source: 'chat image front.png', addedAt: '' },
      { file: 'notes.md', type: 'text', bytes: 1, source: 'inline text', addedAt: '' }
    ]))
    const line = 'References: front.png (front view); notes.md. Compare the sheet with them and say what still differs.'
    const first = done(await step(script('s01_top.py', 'Top', '# part: Top', '# review: Changes: 1 added (Top)'), { references: refs }))
    expect(first.review).toEqual(['Changes: 1 added (Top)', line])
    expect(first.references).toEqual([path.join(refs, 'front.png')])
    // the receipt keeps Blender's own review
    expect(JSON.parse(fs.readFileSync(first.receipt, 'utf8')).review).toEqual(['Changes: 1 added (Top)'])
    const b = await kernel.batch({ dataDir, model: 'tower', runner: fake, gapMs: 0, references: refs, scripts: [script('s02_lamp.py', 'Lamp', '# part: Lamp', '# review: Changes: 1 added (Lamp)')] })
    expect(b.steps[0].review).toEqual(['Changes: 1 added (Lamp)', line])
    expect(b.references).toEqual([path.join(refs, 'front.png')])
    // without references nothing is added
    const plain = done(await step(script('s03_roof.py', 'Roof', '# part: Roof', '# review: Changes: 1 added (Roof)'), { references: path.join(root, 'none') }))
    expect(plain.review).toEqual(['Changes: 1 added (Roof)'])
    expect(plain.references).toBeUndefined()
  })

  it('returns the text review and hands it the parts of the step before', async () => {
    await fakeModel()
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    const first = done(await step(script('s01_top.py', 'Top', '# part: Top', '# review: Changes: 1 added (Top)')))
    expect(first.review).toEqual(['Changes: 1 added (Top)'])
    // no parent: every part is new, and the review has printed nothing before
    expect(receipt(first)).toMatchObject({ previous: [], seen: null })
    const lamp = done(await step(script('s02_lamp.py', 'Lamp', '# part: Lamp', '# review: Changes: 1 added (Lamp)', '# review: Floating: Lamp (0.32 m from Top)')))
    expect(lamp.review).toEqual(['Changes: 1 added (Lamp)', 'Floating: Lamp (0.32 m from Top)'])
    // what the parent's review printed: its items are counts while they stand
    expect(receipt(lamp)).toMatchObject({ review: lamp.review, previous: [{ name: 'Top', triangles: 12 }], seen: receipt(first).review_seen })
    // a batch: its first step compares with the head, later ones with the step before (inside Blender)
    const b = await kernel.batch({ dataDir, model: 'tower', runner: fake, gapMs: 0, scripts: [
      script('s03_a.py', 'A', '# part: A', '# review: Changes: 1 added (A)'), script('s04_b.py', 'B', '# part: B', '# review: Changes: 1 added (B)')
    ] })
    expect(b.steps.map((s) => s.review)).toEqual([['Changes: 1 added (A)'], ['Changes: 1 added (B)']])
    const stored = (id: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'tower', 'steps', id, 'receipt.json'), 'utf8'))
    expect(stored(b.steps[0].id).previous.map((x: { name: string }) => x.name)).toEqual(['Top', 'Lamp'])
    // an amend compares with the replaced step's parent
    done(await step(script('s05_c.py', 'C', '# part: C'), { amend: true }))
    expect(stored(manifest().branches.main.head!).previous.map((x: { name: string }) => x.name)).toEqual(['Top', 'Lamp', 'A'])
    expect(stored(manifest().branches.main.head!).seen).toEqual(stored(b.steps[0].id).review_seen)
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

  it('runs the lib.py next to the step scripts before each step, and replays every step with the lib it ran with', async () => {
    await fakeModel()
    const lib = (caption: string, ...helpers: string[]) => fs.writeFileSync(path.join(src, 'lib.py'), [`"""${caption}"""`, ...helpers.map((h) => `# def: ${h}`)].join('\n'))
    // without a lib, a helper written for an earlier step is unknown (the village wrote join() 12 times)
    expect(failed(await step(script('s01_walls.py', 'Walls', '# use: cottage', '# part: Walls')))).toMatchObject({ kind: 'error', error: "NameError: name 'cottage' is not defined" })
    lib('v1', 'cottage')
    const walls = done(await step(script('s01_walls.py', 'Walls', '# use: cottage', '# part: Walls')))
    expect(walls).toMatchObject({ id: 's001', lib: path.join(dataDir, 'tower', 'steps', 's001', 'lib.py') })
    expect(manifest().steps[0].files).toMatchObject({ script: 'steps/s001/script.py', lib: 'steps/s001/lib.py' })
    done(await step(script('s02_roof.py', 'Roof', '# use: cottage', '# part: Roof')))
    // the lib changes: the next steps run with the new one, the earlier ones keep their copy
    lib('v2', 'fence')
    for (let i = 3; i <= 7; i++) done(await step(script(`s0${i}.py`, `Part ${i}`, '# use: fence', `# part: P${i}`)))
    expect(fs.readFileSync(path.join(dataDir, 'tower', 'steps', 's002', 'lib.py'), 'utf8')).toContain('v1')
    expect(fs.readFileSync(path.join(dataDir, 'tower', 'steps', 's007', 'lib.py'), 'utf8')).toContain('v2')
    expect(manifest().steps.filter((s) => s.files.blend).map((s) => s.id)).toEqual(['s003', 's004', 's005', 's006', 's007'])
    // revert to a pruned step: s001 and s002 replay with lib v1 (lib v2 no longer has cottage), the new step runs with v2
    await kernel.revert({ dataDir, model: 'tower', to: 's002' })
    const gate = done(await step(script('s08_gate.py', 'Gate', '# use: fence', '# part: Gate')))
    expect(JSON.parse(fs.readFileSync(gate.receipt, 'utf8'))).toMatchObject({ replayed: 2, base: null })
    expect(snapshot(gate.blend!).scripts).toEqual(['Walls + lib v1', 'Roof + lib v1', 'Gate + lib v2'])
    // a branch from a pruned step, and materialize, replay the same way
    await kernel.branch({ dataDir, model: 'tower', name: 'alt', from: 's001' })
    const alt = done(await step(script('s09_alt.py', 'Alt', '# part: Alt')))
    expect(snapshot(alt.blend!).scripts).toEqual(['Walls + lib v1', 'Alt + lib v2'])
    const rebuilt = await kernel.materialize({ dataDir, model: 'tower', step: 's002', runner: fake })
    expect(snapshot(rebuilt.blend).scripts).toEqual(['Walls + lib v1', 'Roof + lib v1'])
    // an error in the lib names the lib's line; the failure keeps the lib it ran with
    fs.appendFileSync(path.join(src, 'lib.py'), '\n# fake: error')
    const broken = failed(await step(script('s10.py', 'Broken lib', '# part: X')))
    expect(broken).toMatchObject({ kind: 'error', error: 'RuntimeError: fake lib failure', trace: ['lib.py:2: raise RuntimeError'], head: 's009' })
    expect(fs.readFileSync(path.join(path.dirname(broken.script), 'lib.py'), 'utf8')).toContain('# fake: error')
    // no lib.py next to the script: none runs
    fs.rmSync(path.join(src, 'lib.py'))
    const plain = done(await step(script('s10.py', 'Plain', '# part: Y')))
    expect(plain.lib).toBeNull()
    expect(manifest().steps.at(-1)!.files.lib).toBeNull()
    expect(snapshot(plain.blend!).scripts.at(-1)).toBe('Plain')
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

  it('runs a batch of five in one Blender, landing each step while it runs, in order and spaced out, with one sheet', async () => {
    await fakeModel()
    const files = ['Body shell', 'Front wheels', 'Rear wheels', 'Rear wing', 'Cockpit'].map((part, i) => script(`s0${i + 1}_${part.split(' ')[0].toLowerCase()}.py`, `Now adding the ${part.toLowerCase()}`, `# part: ${part}`))
    // Watch the manifest as the live view does: each step must appear on its own, before the batch ends.
    const heads: string[] = []
    let lastDoneWhenFirstLanded: boolean | undefined
    let watching = true
    const watch = (async () => {
      while (watching) {
        try {
          const h = manifest().branches.main.head
          if (h && heads.at(-1) !== h) heads.push(h)
          if (h && lastDoneWhenFirstLanded === undefined) lastDoneWhenFirstLanded = fs.existsSync(path.join(dataDir, 'tower', 'steps', '.pending-s005', 'receipt.json')) || fs.existsSync(path.join(dataDir, 'tower', 'steps', 's005'))
        } catch { /* not written yet */ }
        await new Promise((r) => setTimeout(r, 20))
      }
    })()
    process.env.FAKE_BLENDER_STEP_MS = '200'
    let r: kernel.BatchDone
    try { r = await kernel.batch({ dataDir, model: 'tower', scripts: files, runner: fake, timeout: 20 }) } finally {
      delete process.env.FAKE_BLENDER_STEP_MS
      watching = false
      await watch
    }
    if (heads.at(-1) !== manifest().branches.main.head) heads.push(manifest().branches.main.head!)
    expect(r).toMatchObject({ ok: true, head: 's005', failure: null, not_run: [] })
    expect(r.steps.map((s) => [s.id, s.n, s.caption, s.triangles])).toEqual([
      ['s001', 1, 'Now adding the body shell', 12], ['s002', 2, 'Now adding the front wheels', 24], ['s003', 3, 'Now adding the rear wheels', 36],
      ['s004', 4, 'Now adding the rear wing', 48], ['s005', 5, 'Now adding the cockpit', 60]
    ])
    expect(heads).toEqual(['s001', 's002', 's003', 's004', 's005'])
    // the first step landed while Blender was still working on the last
    expect(lastDoneWhenFirstLanded).toBe(false)
    const m = manifest()
    expect(m.steps.map((s) => [s.id, s.parent])).toEqual([['s001', null], ['s002', 's001'], ['s003', 's002'], ['s004', 's003'], ['s005', 's004']])
    expect(m.next).toBe(6)
    // each step has its own snapshot, GLB and receipt; only the last renders the sheet and view
    for (const s of m.steps) expect(s.files).toMatchObject({ blend: `steps/${s.id}/model.blend`, glb: `steps/${s.id}/model.glb`, receipt: `steps/${s.id}/receipt.json` })
    expect(m.steps.map((s) => [s.files.sheet, s.files.view])).toEqual([[null, null], [null, null], [null, null], [null, null], ['steps/s005/sheet.png', 'steps/s005/view.png']])
    expect(r.sheet).toBe(path.join(dataDir, 'tower', 'steps', 's005', 'sheet.png'))
    expect(snapshot(path.join(dataDir, 'tower', 'steps', 's003', 'model.blend')).parts).toEqual(['Body shell', 'Front wheels', 'Rear wheels'])
    const receipts = m.steps.map((s) => JSON.parse(fs.readFileSync(path.join(dataDir, 'tower', s.files.receipt), 'utf8')))
    // one Blender ran them all: the receipts share its log
    expect(receipts.map((x) => x.batch_index)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(receipts.map((x) => x.log)).size).toBe(1)
    // steps land at least the publish gap apart, so each change shows
    const at = m.steps.map((s) => Date.parse(s.t))
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(kernel.PUBLISH_GAP_MS - 20)
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('renders every sheet on request and takes a folder or a batch file', async () => {
    await fakeModel()
    const folder = fs.mkdtempSync(path.join(src, 'batch-'))
    for (const [f, part] of [['s10_roof.py', 'Roof'], ['s2_deck.py', 'Deck'], ['s1_legs.py', 'Legs']]) fs.writeFileSync(path.join(folder, f), `"""Adding ${part}"""\n# part: ${part}\n`)
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a step')
    fs.writeFileSync(path.join(folder, 'lib.py'), '"""Helpers, run before each step"""\n')
    expect(kernel.batchScripts(folder).map((s) => path.basename(s.script))).toEqual(['s1_legs.py', 's2_deck.py', 's10_roof.py'])
    const r = await kernel.batch({ dataDir, model: 'tower', scripts: folder, everySheet: true, runner: fake, timeout: 20, gapMs: 0 })
    expect(r.steps.map((s) => [s.name, s.sheet !== null])).toEqual([['legs', true], ['deck', true], ['roof', true]])
    fs.writeFileSync(path.join(folder, 'batch.json'), JSON.stringify({ steps: [{ script: 's2_deck.py', name: 'deck-again' }, 's10_roof.py'] }))
    expect(kernel.batchScripts(path.join(folder, 'batch.json'))).toEqual([{ script: path.join(folder, 's2_deck.py'), name: 'deck-again' }, { script: path.join(folder, 's10_roof.py') }])
    fs.writeFileSync(path.join(folder, 'bad.json'), '{"nope": 1}')
    expect(() => kernel.batchScripts(path.join(folder, 'bad.json'))).toThrow(/is not a batch/)
    await expect(kernel.batch({ dataDir, model: 'tower', scripts: [path.join(folder, 'missing.py')], runner: fake })).rejects.toThrow(/No step script/)
  })

  it('stops a batch at a failing script: earlier steps stay, the failure is recorded, the rest did not run', async () => {
    await fakeModel()
    const files = [
      script('s01_body.py', 'Body', '# part: Body'), script('s02_wheels.py', 'Wheels', '# part: Wheels'),
      script('s03_wing.py', 'Wing', '# fake: error'), script('s04_cockpit.py', 'Cockpit', '# part: Cockpit'), script('s05_decals.py', 'Decals', '# part: Decals')
    ]
    const r = await kernel.batch({ dataDir, model: 'tower', scripts: files, runner: fake, timeout: 20, gapMs: 0 })
    expect(r).toMatchObject({ ok: false, head: 's002', steps: [{ id: 's001' }, { id: 's002' }] })
    expect(r.failure).toMatchObject({ ok: false, kind: 'error', id: 's003', name: 'wing', head: 's002', error: 'RuntimeError: fake failure', recovered: { head: 's002', intact: true } })
    expect(r.not_run).toEqual([{ name: 'cockpit', script: files[3] }, { name: 'decals', script: files[4] }])
    expect(r.message).toMatch(/2 of 5 steps landed; s003 \(wing\) failed.*Not run: cockpit, decals\./)
    const m = manifest()
    expect(m.steps.map((s) => s.id)).toEqual(['s001', 's002'])
    expect(m.next).toBe(3)
    expect(m.failures).toMatchObject([{ id: 's003', kind: 'error', parent: 's002', branch: 'main' }])
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'failed'))).toEqual([expect.stringMatching(/^s003-error-\d+$/)])
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
    // a crash mid-batch: the step before it stays and the next batch continues from there
    const crash = await kernel.batch({ dataDir, model: 'tower', scripts: [script('s03_wing.py', 'Wing', '# part: Wing'), script('s04_boom.py', 'Boom', '# fake: crash'), files[3]], runner: fake, timeout: 20, gapMs: 0 })
    expect(crash).toMatchObject({ ok: false, head: 's003', failure: { kind: 'crash', id: 's004' }, not_run: [{ name: 'cockpit' }] })
    // a hang is stopped by the per-step watchdog, not after the whole batch's time
    const started = Date.now()
    const hang = await kernel.batch({ dataDir, model: 'tower', scripts: [script('s04_hang.py', 'Hanging', '# fake: hang'), files[3]], runner: fake, timeout: 1, gapMs: 0 })
    expect(Date.now() - started).toBeLessThan(10000)
    expect(hang).toMatchObject({ ok: false, steps: [], failure: { kind: 'hang', id: 's004', head: 's003' } })
    const next = done(await step(files[3]))
    expect(next).toMatchObject({ id: 's004', parent: 's003' })
    expect(snapshot(next.blend!).parts).toEqual(['Body', 'Wheels', 'Wing', 'Cockpit'])
  })

  it('reverts and branches per step after a batch', async () => {
    await fakeModel()
    await kernel.batch({ dataDir, model: 'tower', scripts: ['Body', 'Wheels', 'Wing', 'Cockpit'].map((p, i) => script(`s0${i + 1}.py`, p, `# part: ${p}`)), runner: fake, timeout: 20, gapMs: 0 })
    expect((await kernel.revert({ dataDir, model: 'tower', to: 's002' })).steps.map((s) => s.id)).toEqual(['s001', 's002'])
    const spoiler = done(await step(script('s03_spoiler.py', 'Spoiler', '# part: Spoiler')))
    expect(spoiler).toMatchObject({ id: 's005', parent: 's002' })
    expect(snapshot(spoiler.blend!).parts).toEqual(['Body', 'Wheels', 'Spoiler'])
    const alt = await kernel.branch({ dataDir, model: 'tower', name: 'alt', from: 's003' })
    expect(alt.steps.map((s) => s.id)).toEqual(['s001', 's002', 's003'])
  })

  it('numbers steps by their place on the branch: step N of M survives failed attempts, amends, reverts and branches', async () => {
    await fakeModel()
    const live = () => {
      const l = readModellerLive(path.join(dataDir), () => '')!
      return { of: `step ${l.steps.at(-1)!.n} of ${l.steps.length}`, n: l.steps.map((s) => s.n), failure: l.failure?.n ?? null }
    }
    await kernel.batch({ dataDir, model: 'tower', scripts: ['A', 'B', 'C', 'D'].map((p) => script(`${p}.py`, p, `# part: ${p}`)), runner: fake, timeout: 20, gapMs: 0 })
    expect(live()).toEqual({ of: 'step 4 of 4', n: [1, 2, 3, 4], failure: null })
    failed(await step(script('bad.py', 'Bad', '# fake: error')))
    expect(live()).toEqual({ of: 'step 4 of 4', n: [1, 2, 3, 4], failure: 5 })
    done(await step(script('d2.py', 'D again', '# part: D2'), { amend: true }))
    expect(live()).toMatchObject({ of: 'step 4 of 4', failure: null })
    await kernel.revert({ dataDir, model: 'tower', to: 's002' })
    expect(live()).toMatchObject({ of: 'step 2 of 2', n: [1, 2] })
    // ids keep counting across amends and reverts (this one used to read "step 6 of 3")
    expect(done(await step(script('e.py', 'E', '# part: E')))).toMatchObject({ id: 's006' })
    expect(live()).toMatchObject({ of: 'step 3 of 3', n: [1, 2, 3] })
    failed(await step(script('bad2.py', 'Bad', '# fake: crash')))
    expect(live()).toMatchObject({ of: 'step 3 of 3', failure: 4 })
    await kernel.branch({ dataDir, model: 'tower', name: 'alt', from: 's001' })
    expect(live()).toMatchObject({ of: 'step 1 of 1', n: [1] })
  })

  it('publishes a step as soon as its GLB is exported, before the sheet, and completes it from the receipt', async () => {
    await fakeModel()
    done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    // The fake Blender holds the sheet until the kernel made the step the head with its GLB in place.
    const roof = done(await step(script('s02_roof.py', 'Roof', '# part: Roof', '# fake: wait-publish')))
    const receipt = JSON.parse(fs.readFileSync(roof.receipt, 'utf8'))
    expect(receipt).toMatchObject({ ok: true, id: 's002', sheet_after_publish: true, triangles: 24, parent: 's001' })
    expect(receipt.stage).toBeUndefined()
    // the agent still gets the sheet, and the entry is complete
    for (const f of [roof.sheet!, roof.blend!, roof.glb!]) expect(fs.existsSync(f)).toBe(true)
    const m = manifest()
    expect(m.steps[1]).toMatchObject({ id: 's002', triangles: 24, objects: 2, files: { blend: 'steps/s002/model.blend', sheet: 'steps/s002/sheet.png', view: 'steps/s002/view.png' } })
    expect(m.steps[1].blend_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps', 's002')).sort()).toEqual(['model.blend', 'model.glb', 'receipt.json', 'script.py', 'sheet.png', 'view.png'])
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
  })

  it('keeps a published step when its sheet fails or Blender stops after the export', async () => {
    await fakeModel()
    done(await step(script('s01_legs.py', 'Legs', '# part: Legs')))
    const noSheet = done(await step(script('s02_deck.py', 'Deck', '# part: Deck', '# fake: sheet-error')))
    expect(noSheet).toMatchObject({ id: 's002', sheet: null, triangles: 24 })
    expect(noSheet.warnings).toEqual([expect.stringMatching(/review sheet failed.*published without it/)])
    expect(fs.existsSync(noSheet.blend!)).toBe(true)
    // Blender dies right after the export: the step stays the head, without snapshot or sheet
    const crashed = done(await step(script('s03_roof.py', 'Roof', '# part: Roof', '# fake: crash-after-glb')))
    expect(crashed).toMatchObject({ id: 's003', parent: 's002', caption: 'Roof', sheet: null, blend: null })
    expect(fs.existsSync(crashed.glb!)).toBe(true)
    expect(crashed.warnings).toEqual([expect.stringMatching(/Blender stopped \(exit code 3\) after this step reached the live view.*replays its script/)])
    const m = manifest()
    expect(m.branches.main.head).toBe('s003')
    expect(m.failures).toEqual([])
    expect(m.steps[2]).toMatchObject({ files: { glb: 'steps/s003/model.glb', blend: null, sheet: null, script: 'steps/s003/script.py' }, warnings: 1 })
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'steps')).filter((f) => f.startsWith('.'))).toEqual([])
    // the next step rebuilds s003's snapshot by replaying its script
    const rail = done(await step(script('s04_rail.py', 'Rail', '# part: Rail')))
    expect(JSON.parse(fs.readFileSync(rail.receipt, 'utf8'))).toMatchObject({ replayed: 1 })
    expect(snapshot(rail.blend!).parts).toEqual(['Legs', 'Deck', 'Roof', 'Rail'])
    // a fix after review is a normal new head step
    const fix = done(await step(script('s05_rail_fix.py', 'Fixing the rail', '# remove: Rail', '# part: Better rail')))
    expect(fix).toMatchObject({ id: 's005', parent: 's004' })
    expect(manifest().branches.main.head).toBe('s005')
    // Blender stops during the checks: the snapshot is saved before them, so the next step need not replay
    const slow = done(await step(script('s06_dome.py', 'Dome', '# part: Dome', '# fake: crash-after-blend')))
    expect(slow).toMatchObject({ id: 's006', sheet: null, blend: path.join(dataDir, 'tower', 'steps', 's006', 'model.blend') })
    expect(slow.warnings).toEqual([expect.stringMatching(/Blender stopped \(exit code 3\).*no text review or review sheet; its snapshot is kept/)])
    const spire = done(await step(script('s07_spire.py', 'Spire', '# part: Spire')))
    expect(JSON.parse(fs.readFileSync(spire.receipt, 'utf8'))).toMatchObject({ replayed: 0, base: slow.blend })
  })

  it('hands each step its parent\'s pair results, and runs one check of every pair before an export', async () => {
    await fakeModel()
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    const top = done(await step(script('s01_top.py', 'Top', '# part: Top')))
    // no parent: every pair is examined
    expect(receipt(top)).toMatchObject({ pairs: null, checks: { pairs: { full: true } } })
    const lamp = done(await step(script('s02_lamp.py', 'Lamp', '# part: Lamp', '# review: Changes: 1 added (Lamp)')))
    // the parent's pair results, with its pass-through pairs, so only pairs with a changed part are examined
    expect(receipt(lamp)).toMatchObject({ pairs: { full: true, contacts: [], pierces: [] }, checks: { pairs: { full: false } } })
    // the export's starting point: one check of every pair, kept in the receipt, run once
    const checked = await kernel.materialize({ dataDir, model: 'tower', runner: fake })
    expect(checked).toMatchObject({ id: 's002', replayed: 0, review: ['Full check: Top, Lamp'], warnings: [] })
    expect(receipt(lamp)).toMatchObject({ review: ['Changes: 1 added (Lamp)'], full_check: { review: ['Full check: Top, Lamp'], warnings: [] } })
    const logs = fs.readdirSync(path.join(dataDir, 'tower', 'logs')).length
    expect(await kernel.materialize({ dataDir, model: 'tower', runner: fake })).toMatchObject({ review: ['Full check: Top, Lamp'] })
    expect(fs.readdirSync(path.join(dataDir, 'tower', 'logs'))).toHaveLength(logs)
    // a step checked in full already returns its own review
    expect(await kernel.materialize({ dataDir, model: 'tower', step: 's001', runner: fake })).toMatchObject({ id: 's001', replayed: 0, review: [], warnings: [] })
  })

  it('lists a warning at the step that brings it, counts the ones still standing and keeps them all in the receipt', async () => {
    await fakeModel()
    const pass = 'Parts passing through each other: Bank 1 / Stream 1 (0.20 m inside, 0.05 m out).'
    const size = 'Size differs from the expected size: z 0.48 m (expected 1.00).'
    const first = done(await step(script('s01_base.py', 'Base', '# part: Base', `# warn: ${pass}`, `# warn: ${size}`)))
    expect(first).toMatchObject({ warnings: [pass, size], known_warnings: 0 })
    // the same two again: the agent reads neither, and learns two still stand
    const same = done(await step(script('s02_bridge.py', 'Bridge', '# part: Bridge', `# warn: ${pass}`, `# warn: ${size}`)))
    expect(same).toMatchObject({ warnings: [], known_warnings: 2 })
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    expect(receipt(same).warnings).toEqual([pass, size])
    expect(manifest().steps[1].warnings).toBe(2)
    // the player's live view still lists every check of the head step
    expect(readModellerLive(dataDir, () => '')!.checks).toEqual([pass, size])
    // and every review item, also those the agent now reads as a count
    fs.writeFileSync(same.receipt, JSON.stringify({ ...receipt(same), review: ['Changes: none', 'Floating: 1 known'], review_full: ['Changes: none', 'Floating: Lamp (0.32 m from Top)'] }))
    expect(readModellerLive(dataDir, () => '')!.checks).toEqual([pass, size, 'Floating: Lamp (0.32 m from Top)'])
    // a changed warning is new; one that went away is simply gone
    const grown = size.replace('0.48', '0.90')
    const changed = done(await step(script('s03_tower.py', 'Tower', '# part: Tower', `# warn: ${grown}`)))
    expect(changed).toMatchObject({ warnings: [grown], known_warnings: 0 })
    // "previous step" is the parent on the branch: an amend compares with the replaced step's parent,
    // a branch with the step it starts from
    const amended = done(await step(script('s03_tower_again.py', 'Tower again', '# part: Tower', `# warn: ${pass}`, `# warn: ${grown}`), { amend: true }))
    expect(amended).toMatchObject({ parent: 's002', warnings: [grown], known_warnings: 1 })
    await kernel.branch({ dataDir, model: 'tower', name: 'alt', from: 's001' })
    expect(done(await step(script('s02_alt.py', 'Alt', '# part: Alt', `# warn: ${pass}`)))).toMatchObject({ parent: 's001', warnings: [], known_warnings: 1 })
    // a batch: each step against the one before it
    const b = await kernel.batch({ dataDir, model: 'tower', runner: fake, gapMs: 0, scripts: [
      script('s03_a.py', 'A', '# part: A', `# warn: ${pass}`, `# warn: ${size}`),
      script('s04_b.py', 'B', '# part: B', `# warn: ${pass}`, `# warn: ${size}`)
    ] })
    expect(b.steps.map((s) => [s.warnings, s.known_warnings])).toEqual([[[size], 1], [[], 2]])
    expect(b).toMatchObject({ warnings: [], known_warnings: 2 })
  })

  it('measures each run in its receipt: the agent\'s time before it, script and lib bytes, amends, reruns and split phases', async () => {
    await fakeModel()
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    await new Promise((r) => setTimeout(r, 150))
    const legsFile = script('s01_legs.py', 'Legs', '# part: Legs')
    const legs = done(await step(legsFile))
    const first = receipt(legs)
    // the agent's time since init returned (writing the first script), beside Blender's own phases
    expect(first.agent_ms).toBeGreaterThanOrEqual(140)
    expect(first).toMatchObject({ script_bytes: fs.statSync(legsFile).size, lib_bytes: 0, lib_changed: false, amend: false, rerun_of: null, warnings_new: 0 })
    expect(first.phases_ms).toEqual({ think: first.agent_ms, blender: first.wall_ms, export: 2, checks: 3, sheet: 4 })
    expect(first.timings_ms.start).toBeGreaterThanOrEqual(0)
    // a lib appears (changed), and the same step again is a rerun of it
    fs.writeFileSync(path.join(src, 'lib.py'), '"""Helpers"""\n# def: crate\n')
    const again = done(await step(script('s01_legs.py', 'Legs again', '# part: Legs'), { amend: true }))
    expect(receipt(again)).toMatchObject({ lib_bytes: fs.statSync(path.join(src, 'lib.py')).size, lib_changed: true, amend: true, rerun_of: { id: legs.id } })
    expect(receipt(done(await step(script('s02_deck.py', 'Deck', '# part: Deck'))))).toMatchObject({ lib_changed: false, amend: false, rerun_of: null })
    // a failed run is measured in the manifest, and its fixed script is a rerun of it
    failed(await step(script('s03_roof.py', 'Roof', '# fake: error')))
    expect(manifest().failures.at(-1)).toMatchObject({ id: 's004', amend: false, rerun_of: null, lib_changed: false, script_bytes: expect.any(Number), agent_ms: expect.any(Number) })
    expect(receipt(done(await step(script('s03_roof.py', 'Roof', '# part: Roof'))))).toMatchObject({ id: 's004', rerun_of: { id: 's004', failed: 'error' } })
    // a batch's later steps follow the first with no agent time
    const b = await kernel.batch({ dataDir, model: 'tower', runner: fake, gapMs: 0, scripts: [script('s04_a.py', 'A', '# part: A'), script('s05_b.py', 'B', '# part: B')] })
    const stored = (id: string) => JSON.parse(fs.readFileSync(path.join(dataDir, 'tower', 'steps', id, 'receipt.json'), 'utf8'))
    expect(b.steps.map((s) => stored(s.id).agent_ms)).toEqual([expect.any(Number), 0])
    expect(stored(b.steps[0].id).agent_gap).toBeUndefined()
    // past ten minutes the agent's time is a gap (a respawn, a wait for the player)
    const m = manifest()
    m.returned_at = new Date(Date.now() - kernel.AGENT_GAP_MS - 60000).toISOString()
    fs.writeFileSync(path.join(dataDir, 'tower', 'manifest.json'), JSON.stringify(m))
    const late = receipt(done(await step(script('s06_c.py', 'C', '# part: C'))))
    expect(late).toMatchObject({ agent_gap: true })
    expect(late.agent_ms).toBeGreaterThan(kernel.AGENT_GAP_MS)
    // Blender stopped after the export: killed after landing, with the timings it had
    const killed = receipt(done(await step(script('s07_dome.py', 'Dome', '# part: Dome', '# fake: crash-after-glb'))))
    expect(killed).toMatchObject({ killed_after_landing: 'exit code 3', phases_ms: { export: 2, checks: 0, sheet: 0 } })
  })

  it('sums up a model\'s run: steps, runs, amends, failures, agent and Blender time, phases, sizes and open review lines', async () => {
    await fakeModel()
    const files = [script('s01_legs.py', 'Legs', '# part: Legs', '# review: Floating: Legs'), script('s02_deck.py', 'Deck', '# part: Deck')]
    for (const f of files) done(await step(f))
    done(await step(script('s02_deck.py', 'Deck', '# part: Deck', '# review: Z-fighting: Deck / Legs'), { amend: true }))
    failed(await step(script('s03_roof.py', 'Roof', '# fake: error')))
    done(await step(script('s03_roof.py', 'Roof', '# part: Roof', '# review: Changes: 1 added (Roof)', '# review: Floating: Roof')))
    const r = await kernel.report({ dataDir, model: 'tower' })
    expect(r).toMatchObject({ ok: true, model: 'tower', head: 's004', steps: 3, runs: 5, amends: 1, reruns: 2, failures: { error: 1 }, killed: 0, agent_gaps: 0, triangles: 36, budget: null })
    expect(r.timeline.map((x) => [x.id, x.outcome])).toEqual([['s001', 'step'], ['s002', 'replaced'], ['s003', 'step'], ['s004', 'error'], ['s004', 'step']])
    expect(r.agent_ms).toMatchObject({ n: 5 })
    expect(r.blender_ms.n).toBe(5)
    expect(r.blender_ms.median).toBeLessThanOrEqual(r.blender_ms.p90!)
    // the four landed steps' phases (the failure's receipt has its script only), and their review items
    expect(r.blender_phases_ms).toMatchObject({ export: 8, checks: 12, sheet: 16, script: 5 })
    expect(r.review.new).toEqual({ Fake: 4 })
    // the head's open review lines, its changes left out
    expect(r.open_review).toEqual(['Floating: Roof'])
    const bytes = r.timeline.reduce((n, x) => n + x.script_bytes, 0)
    expect(r.script_kb).toBe(Math.round(bytes / 102.4) / 10)
    expect(r.first_step_s).toBeGreaterThanOrEqual(0)
    expect(r.wall_s).toBeGreaterThanOrEqual(r.first_step_s!)
    // a receipt from before the measures: its script's size still counts
    const old = path.join(dataDir, 'tower', 'steps', 's001', 'receipt.json')
    const before = JSON.parse(fs.readFileSync(old, 'utf8'))
    delete before.script_bytes
    delete before.agent_ms
    fs.writeFileSync(old, JSON.stringify(before))
    expect((await kernel.report({ dataDir, model: 'tower' })).timeline[0]).toMatchObject({ script_bytes: fs.statSync(files[0]).size, agent_ms: null })
    // and through the CLI
    const out = await run(process.execPath, [cli, 'report', 'tower', '--data', dataDir], { cwd: src })
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, steps: 3, runs: 5 })
  })

  it('starts Blender on every core for a step or replay that bakes, and reports its bakes', async () => {
    await fakeModel()
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    const legs = done(await step(script('s01_legs.py', 'Legs', '# part: Legs', '# part: Deck')))
    expect(receipt(legs).threads).toBe(Math.min(4, os.availableParallelism()))
    expect(legs.bakes).toBeUndefined()
    const paintFile = script('s02_paint.py', 'Painting it', "p.uv_atlas()", "p.camo('Armor', 'red')", "p.weathering('Steel')", 'p.bake_maps(size=2048)')
    const paint = done(await step(paintFile))
    expect(receipt(paint)).toMatchObject({ threads: os.availableParallelism(), bakes: [{ parts: 2, size: 2048, bakes: 2 }] })
    expect(paint.bakes).toEqual([expect.objectContaining({ parts: 2, size: 2048, threads: os.availableParallelism() })])
    // an explicit thread count wins
    expect(receipt(done(await step(script('s03_paint.py', 'Again', 'p.bake_maps()'), { threads: 2 }))).threads).toBe(2)
    // replaying a bake (rebuilding a pruned snapshot) bakes too, so it gets every core
    const plain = script('s04_rail.py', 'Rail', '# part: Rail')
    expect(kernel.planThreads({ replay: [paintFile], steps: [{ script: plain }] })).toBe(os.availableParallelism())
    expect(kernel.planThreads({ replay: [], steps: [{ script: plain }, { script: null }] })).toBeUndefined()
    expect(kernel.planThreads({ replay: [paintFile], steps: [] }, 3)).toBe(3)
    // a bake in a lib.py counts too
    expect(kernel.planThreads({ replay: [{ script: plain, lib: paintFile }], steps: [] })).toBe(os.availableParallelism())
    expect(kernel.planThreads({ replay: [], steps: [{ script: plain, lib: paintFile }] })).toBe(os.availableParallelism())
  })

  it('warms the bytecode cache once per Blender binary, never for one that is not Blender', async () => {
    await fakeModel()
    // tests pin Node: init starts no warm-up for it
    expect(kernel.warmMarker(manifest().blender)).toBeNull()
    const marker = path.join(dataDir, 'cache', 'warm-test')
    expect(await kernel.warm({ dataDir, model: 'tower', runner: fake, marker })).toMatchObject({ ok: true, blender: '4.2.1', warmed: true })
    expect(fs.readFileSync(marker, 'utf8')).toBe('fake')
    expect(await kernel.warm({ dataDir, model: 'tower', runner: fake, marker })).toMatchObject({ ok: true, warmed: false })
    // a Blender's marker names that exact binary: an upgrade in place warms again
    const exe = path.join(path.parse(src).root, 'Blender', process.platform === 'win32' ? 'blender.exe' : 'blender')
    const pin = { path: exe, size: 0, mtimeMs: 1 }
    const at = kernel.warmMarker(pin)!
    expect(path.dirname(at)).toBe(bytecodeEnv(exe).PYTHONPYCACHEPREFIX)
    expect(kernel.warmMarker(pin)).toBe(at)
    expect(kernel.warmMarker({ ...pin, size: 1 })).not.toBe(at)
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

  it('reuses the installed list until a listed binary changes, the list ages out or a fresh search is asked for', () => {
    const env = { GENIO_BLENDER_CACHE: fs.mkdtempSync(path.join(root, 'cache-')) }
    const file = path.join(env.GENIO_BLENDER_CACHE, 'blenders.json')
    const real = listBlenders({ env })
    expect(fs.existsSync(file)).toBe(true)
    // An entry only the cache knows: a search would drop it (it is in no tier and not a real Blender).
    const exe = path.join(env.GENIO_BLENDER_CACHE, process.platform === 'win32' ? 'blender.exe' : 'blender')
    fs.writeFileSync(exe, '')
    const st = fs.statSync(exe)
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'))
    const plant = (at = Date.now()) => fs.writeFileSync(file, JSON.stringify({ ...cached, at, list: [{ path: exe, version: [9, 9, 9], size: st.size, mtimeMs: Math.round(st.mtimeMs) }, ...cached.list] }))
    const planted = { path: exe, version: [9, 9, 9] }
    plant()
    expect(listBlenders({ env })).toEqual([planted, ...real])
    expect(listBlenders({ env, fresh: true })).toEqual(real)
    plant(Date.now() - LIST_TTL_MS - 1)
    expect(listBlenders({ env })).toEqual(real)
    plant()
    fs.writeFileSync(exe, 'changed')
    expect(listBlenders({ env })).toEqual(real)
  }, 60000)
})

describe('Blender bytecode cache', () => {
  it('shares compiled Python between runs unless the folder is too deep for Windows paths', async () => {
    const exe = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe'
    const short = 'C:\\Users\\player\\AppData\\Local\\Temp\\genio-blender\\pyc'
    expect(bytecodeEnv(exe, short, 'win32')).toEqual({ PYTHONPYCACHEPREFIX: short })
    const deep = `C:\\${'x'.repeat(80)}\\pyc`
    expect(bytecodeEnv(exe, deep, 'win32')).toEqual({ PYTHONDONTWRITEBYTECODE: '1' })
    expect(bytecodeEnv('/usr/bin/blender', `/${'x'.repeat(200)}`, 'linux')).toEqual({ PYTHONPYCACHEPREFIX: `/${'x'.repeat(200)}` })
    expect(bytecodeEnv('/usr/bin/blender', undefined, 'linux')).toEqual({ PYTHONPYCACHEPREFIX: path.join(blenderCacheDir(), 'pyc') })
    // the run gets the folder, and an inherited "write no bytecode" does not cancel it
    const probe = path.join(root, 'env-probe.mjs')
    fs.writeFileSync(probe, "console.log(JSON.stringify({ prefix: process.env.PYTHONPYCACHEPREFIX ?? null, off: process.env.PYTHONDONTWRITEBYTECODE ?? null }))\n")
    const saved = process.env.PYTHONDONTWRITEBYTECODE
    process.env.PYTHONDONTWRITEBYTECODE = '1'
    try {
      const r = await runBlender({ blender: process.execPath, prefix: [probe], script: 'none.py', scratch: path.join(root, 'logs'), timeout: 30 })
      const want = bytecodeEnv(process.execPath)
      expect(JSON.parse(r.tail.trim())).toEqual({ prefix: want.PYTHONPYCACHEPREFIX ?? null, off: want.PYTHONDONTWRITEBYTECODE ?? null })
    } finally {
      if (saved === undefined) delete process.env.PYTHONDONTWRITEBYTECODE
      else process.env.PYTHONDONTWRITEBYTECODE = saved
    }
  })
})

const installed = listBlenders()
const blender = pickModellerBlender(installed)

interface GlbJson { meshes: { primitives: { indices?: number; attributes: { POSITION: number } }[] }[]; accessors: { count: number }[]; materials?: { name: string }[]; images?: unknown[] }
const glbJson = (file: string): GlbJson => {
  const bytes = fs.readFileSync(file)
  return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)))
}
/** Triangles in a GLB's JSON chunk. */
function glbTriangles(file: string): number {
  const json = glbJson(file)
  return json.meshes.flatMap((m) => m.primitives).reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0)
}
const pngSize = (file: string): [number, number] => {
  const b = fs.readFileSync(file)
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}
/** An 8-bit RGB or RGBA PNG as rows of [r, g, b], top row first. */
function pngPixels(file: string): number[][][] {
  const b = fs.readFileSync(file)
  const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)]
  const bpp = { 2: 3, 6: 4 }[b[25]]!
  expect(b[24]).toBe(8)
  const idat: Buffer[] = []
  for (let at = 8; at < b.length; at += 12 + b.readUInt32BE(at)) if (b.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + b.readUInt32BE(at)))
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * bpp, rows: number[][][] = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c)
      line[i] = (line[i] + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][filter]) & 255
    }
    rows.push(Array.from({ length: w }, (_, x) => [line[x * bpp], line[x * bpp + 1], line[x * bpp + 2]]))
    prev = line
  }
  return rows
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
    // the text review caught the roof posts poking through the roof, and the fix step cleared it
    expect(steps[4].review.join('\n')).toMatch(/Deep overlap: Roof \/ Roof post 1 \(/)
    expect(last.review.join('\n')).not.toMatch(/Roof post \d \(|Roof \/ Roof post/)
    expect(last.review[0]).toBe('Changes: 7 changed (Ladder rail 1, Ladder rail 2, Ladder rungs, Roof post 1, Roof post 2, Roof post 3 and 1 more)')
    // a few short lines on every step
    for (const s of steps) {
      expect(s.review.length).toBeLessThanOrEqual(5)
      for (const l of s.review) expect(l.length).toBeLessThan(240)
    }
    // the pass-through pairs are the review's, never a warning as well
    expect(steps.flatMap((s) => s.warnings).join('\n')).not.toMatch(/passing through/)
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

  it('paints with the presets and bakes every part in one joined bake per map, object space intact', async () => {
    await cmd('init', 'crates', '--target', 'web')
    const s1 = path.join(src, 's01_crates.py')
    fs.writeFileSync(s1, [
      '"""Three crates and a post"""',
      "crate = p.material('Armor', '#556b2f', rough=0.7)",
      "steel = p.material('Steel', '#4a4d52', rough=0.4, metal=0.9)",
      'for i in range(3):',
      "    p.box(f'Crate {i + 1}', (1, 1, 1), loc=(i * 1.2 - 1.2, 0, 0.5), mat=crate, bevel=0.05)",
      "p.cylinder('Post', 0.1, 2, loc=(0, 0.8, 1), mat=steel)"
    ].join('\n'))
    const built = await cmd('step', 'crates', s1)
    const s2 = path.join(src, 's02_paint.py')
    fs.writeFileSync(s2, [
      '"""Painting it: digital camo and weathering, baked at 128 px"""',
      "print('atlas', p.uv_atlas())",
      "p.camo('Armor', 'digital', seed=3)",
      "count = len(bpy.data.materials['Armor'].node_tree.nodes)",
      "p.camo('Armor', 'digital', seed=3)",
      "assert len(bpy.data.materials['Armor'].node_tree.nodes) == count, 'camo() again stacked nodes'",
      "p.weathering('Steel', wear=1.0, dirt=0.5)",
      '# Object space on the post: red = object z / 4 + 0.5, where world z would read higher.',
      "probe = p.material('Probe', '#000000')",
      'nt = probe.node_tree',
      "bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')",
      "z = nt.nodes.new('ShaderNodeSeparateXYZ')",
      "nt.links.new(nt.nodes.new('ShaderNodeTexCoord').outputs['Object'], z.inputs[0])",
      "red = nt.nodes.new('ShaderNodeMath')",
      "red.operation = 'MULTIPLY_ADD'",
      'red.inputs[1].default_value, red.inputs[2].default_value = 0.25, 0.5',
      "nt.links.new(z.outputs['Z'], red.inputs[0])",
      "rgb = nt.nodes.new('ShaderNodeCombineColor')",
      'nt.links.new(red.outputs[0], rgb.inputs[0])',
      "nt.links.new(rgb.outputs[0], bsdf.inputs['Base Color'])",
      "post = p.part('Post')",
      'post.data.materials[0] = probe',
      'p.bake_maps(size=128, samples=1)',
      "assert not [o for o in bpy.data.objects if o.name.startswith('genio bake copy')], 'the joined copy stayed'",
      "assert not [o for o in p.export_objects() if o.hide_render], 'parts stayed hidden'",
      "assert {s.material.name for o in p.export_objects() for s in o.material_slots} == {'Baked'}",
      "img = bpy.data.images['Baked_basecolor']",
      'assert img.packed_file and tuple(img.size) == (128, 128)',
      '# the post\'s bottom cap is at object z = -1 (red 0.25); world z = 0 would give 0.5',
      'cap = min(post.data.polygons, key=lambda f: f.center.z)',
      'uv = post.data.uv_layers.active.data',
      'u, v = (sum(uv[i].uv[k] for i in cap.loop_indices) / cap.loop_total for k in (0, 1))',
      'px = img.pixels[(int(v * 128) * 128 + int(u * 128)) * 4]',
      'srgb = lambda c: 1.055 * c ** (1 / 2.4) - 0.055',
      "assert abs(px - srgb(0.25)) < 0.06, f'post cap red {px:.3f}: object space would be {srgb(0.25):.3f}, world {srgb(0.5):.3f}'"
    ].join('\n'))
    const painted = await cmd('step', 'crates', s2)
    expect(painted).toMatchObject({
      ok: true, triangles: built.triangles, objects: 4,
      bakes: [{ parts: 4, materials: 2, size: 128, samples: 1, device: 'CPU', bakes: 2, threads: os.availableParallelism(), material: 'Baked' }]
    })
    // one Cycles bake per map for all four parts, never one per part
    const receipt = JSON.parse(fs.readFileSync(painted.receipt, 'utf8'))
    expect(fs.readFileSync(receipt.log, 'utf8').match(/Baking map saved to internal image/g)).toHaveLength(2)
    // the GLB ships one material and the two packed maps
    const json = glbJson(painted.glb)
    expect(json.materials?.map((m) => m.name)).toEqual(['Baked'])
    expect(json.images).toHaveLength(2)
  }, 300000)

  it('builds the watchtower as one batch in one Blender, the same as step by step', async () => {
    await cmd('init', 'reference', '--target', 'unity')
    const steps: StepDone[] = []
    for (const file of fs.readdirSync(tower).sort()) steps.push(await cmd('step', 'reference', path.join(tower, file)))
    await cmd('init', 'batched', '--target', 'unity')
    const started = Date.now()
    const r = await cmd('batch', 'batched', tower)
    const ms = Date.now() - started
    expect(r).toMatchObject({ ok: true, head: 's007', failure: null })
    expect(r.steps.map((s: { id: string; name: string; sheet: string | null }) => [s.id, s.name, s.sheet !== null])).toEqual([
      ['s001', 'legs', false], ['s002', 'bracing', false], ['s003', 'deck', false], ['s004', 'railing', false], ['s005', 'roof', false], ['s006', 'ladder', false], ['s007', 'fix', true]
    ])
    expect(r.steps[6].triangles).toBe(2802)
    expect(r.steps.map((s: { review: string[] }) => s.review)).toEqual(steps.map((s) => s.review))
    expect(pngSize(r.sheet)).toEqual([1024, 1024])
    for (const s of r.steps) expect(fs.existsSync(s.glb)).toBe(true)
    // one Blender start for seven steps, plus the 0.6 s landing gaps
    expect(ms).toBeLessThan(120000)
    // every sheet: the review camera never leaks into the next step
    await cmd('init', 'sheets', '--target', 'unity')
    const every = await cmd('batch', 'sheets', path.join(tower, 's01_legs.py'), path.join(tower, 's02_bracing.py'), '--every-sheet')
    expect(every).toMatchObject({ ok: true, head: 's002' })
    expect(every.steps.map((s: { sheet: string | null }) => s.sheet !== null)).toEqual([true, true])
    expect(every.warnings.join('\n')).not.toMatch(/camera|Not in Export/)
    expect(every.steps[1].triangles).toBe(r.steps[1].triangles)
  }, 300000)

  it('removes and rebuilds parts without crashing, and draws the top view as a plan view', async () => {
    await cmd('init', 'yard', '--target', 'web')
    const write = (name: string, ...lines: string[]) => {
      const file = path.join(src, name)
      fs.writeFileSync(file, lines.join('\n'))
      return file
    }
    // red at +X (the model's left), green at +Y (its back); the grey crates come and go
    expect(await cmd('step', 'yard', write('s01_yard.py',
      '"""A yard: base, a red block east, a green block north, two crates"""',
      "grey = p.material('Grey', '#808080')",
      "p.box('Base', (2, 2, 0.2), loc=(0, 0, 0.1), mat=grey)",
      "p.box('East', (0.4, 0.4, 0.4), loc=(0.8, 0, 0.4), mat=p.material('Red', '#ff1010'))",
      "p.box('North', (0.4, 0.4, 0.4), loc=(0, 0.8, 0.4), mat=p.material('Green', '#10ff10'))",
      "p.box('Crate', (0.3, 0.3, 0.3), loc=(-0.6, -0.6, 0.35), mat=grey)",
      "p.box('Spare', (0.3, 0.3, 0.3), loc=(-0.6, 0.4, 0.35), mat=grey)"
    ))).toMatchObject({ ok: true, objects: 5 })
    // the ship's crash: parts removed, then the export walked the view layer's stale list
    const removed = await cmd('step', 'yard', write('s02_remove.py', '"""Dropping the spare crate"""', "p.remove('Spare')", "p.box('Crate 2', (0.3, 0.3, 0.3), loc=(-0.6, 0.4, 0.35))"))
    expect(removed).toMatchObject({ ok: true, objects: 5 })
    // a part made again under its own name removes the old one the same way
    expect(await cmd('step', 'yard', write('s03_rebuild.py', '"""A bigger crate"""', "p.box('Crate', (0.4, 0.4, 0.4), loc=(-0.6, -0.6, 0.4))"))).toMatchObject({ ok: true, objects: 5 })
    // a script that removes objects itself, and the UV atlas walking the layer after a remove
    expect(await cmd('step', 'yard', write('s04_raw.py', '"""Clearing the crates"""', "bpy.data.objects.remove(bpy.data.objects['Crate 2'])"))).toMatchObject({ ok: true, objects: 4 })
    const last = await cmd('step', 'yard', write('s05_atlas.py', '"""Unwrapping"""', "p.remove('Crate')", 'p.uv_atlas()'))
    expect(last).toMatchObject({ ok: true, objects: 3 })

    // Sheet cells, top-down: 3/4 view, front / side, top. Where are the red and green blocks?
    const px = pngPixels(last.sheet)
    const half = px.length / 2
    const centroid = (cell: [number, number], test: (c: number[]) => boolean) => {
      let x = 0, y = 0, n = 0
      for (let r = 0; r < half; r++) for (let c = 0; c < half; c++) {
        if (c < 130 && r > half - 130) continue // the axis marker's corner
        const v = px[cell[0] * half + r][cell[1] * half + c]
        if (test(v)) { x += c; y += r; n++ }
      }
      expect(n).toBeGreaterThan(50)
      return { x: x / n / half - 0.5, y: 0.5 - y / n / half } // -0.5..0.5, +y up
    }
    const red = (c: number[]) => c[0] > 120 && c[1] < 0.5 * c[0] && c[2] < 0.5 * c[0]
    const green = (c: number[]) => c[1] > 120 && c[0] < 0.5 * c[1] && c[2] < 0.5 * c[1]
    // top: a plan view, +X right and +Y up
    expect(centroid([1, 1], red).x).toBeGreaterThan(0.15)
    expect(centroid([1, 1], green).y).toBeGreaterThan(0.15)
    // front, from -Y: +X right; side, from +X: +Y (the back) right
    expect(centroid([0, 1], red).x).toBeGreaterThan(0.15)
    expect(centroid([1, 0], green).x).toBeGreaterThan(0.15)
    // the top view's axis marker: X red to the right of its origin, Y green above it
    const marker = (test: (c: number[]) => boolean) => {
      let x = 0, y = 0, n = 0
      for (let r = half - 120; r < half; r++) for (let c = 0; c < 120; c++) if (test(px[half + r][half + c])) { x += c; y += half - r; n++ }
      return { x: x / n, y: y / n, n }
    }
    const mx = marker(red), my = marker(green)
    expect(mx.n).toBeGreaterThan(50)
    expect(my.n).toBeGreaterThan(50)
    expect(mx.x - my.x).toBeGreaterThan(20)
    expect(my.y - mx.y).toBeGreaterThan(20)
    // the 3/4 view the live view shows has no marker
    const view = pngPixels(last.sheet.replace(/sheet\.png$/, 'view.png'))
    expect(view.slice(-120).flatMap((row) => row.slice(0, 120)).filter(red)).toEqual([])
  }, 300000)

  it('runs lib.py before every step and replays with the lib each step ran with', async () => {
    await cmd('init', 'shed', '--target', 'web')
    const dir = fs.mkdtempSync(path.join(src, 'shed-'))
    const write = (name: string, ...lines: string[]) => {
      fs.writeFileSync(path.join(dir, name), lines.join('\n'))
      return path.join(dir, name)
    }
    const lib = (size: number) => write('lib.py', '"""Shed helpers"""', `def crate(name, x, size=${size}):`, "    return p.box(name, (size, size, size), loc=(x, 0, size / 2), mat=p.material('Crate wood', '#8a5a33'))")
    lib(0.4)
    const first = await cmd('step', 'shed', write('s01_crates.py', '"""Two crates"""', "crate('Crate 1', 0)", "crate('Crate 2', 1)"))
    expect(first).toMatchObject({ ok: true, objects: 2, bounds: { max: [1.2, 0.2, 0.4] } })
    expect(fs.readFileSync(first.lib, 'utf8')).toContain('size=0.4')
    lib(0.8)
    expect(await cmd('step', 'shed', write('s02_crate.py', '"""A big crate"""', "crate('Crate 3', 2.5)"))).toMatchObject({ ok: true, objects: 3, bounds: { max: [2.9, 0.4, 0.8] } })
    // forget s001's snapshot, as retention does: a branch from it replays s001 with the lib it ran with
    const file = path.join(dataDir, 'shed', 'manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest
    fs.rmSync(path.join(dataDir, 'shed', m.steps[0].files.blend!))
    m.steps[0].files.blend = null
    fs.writeFileSync(file, JSON.stringify(m))
    await cmd('branch', 'shed', 'low', '--from', 's001')
    const replayed = await cmd('step', 'shed', write('s03_low.py', '"""One more crate"""', "assert abs(p.bounds([p.part('Crate 1')])[1].z - 0.4) < 1e-6, 'replayed with the new lib'", "crate('Crate 4', -1.5)"))
    expect(replayed).toMatchObject({ ok: true, parent: 's001', objects: 3, bounds: { min: [-1.9, -0.4, 0], max: [1.2, 0.4, 0.8] } })
    expect(JSON.parse(fs.readFileSync(replayed.receipt, 'utf8')).timings_ms.replay).toBeGreaterThan(0)
    // an error inside a lib helper names the lib's line after the script's
    write('lib.py', '"""Shed helpers"""', 'def crate(name, x):', '    return p.box(name, 1)')
    const broken = await cmd('step', 'shed', write('s04_broken.py', '"""Broken"""', "crate('Crate 5', 3)"))
    expect(broken).toMatchObject({ ok: false, kind: 'error' })
    expect(broken.trace.slice(0, 2)).toEqual(["script.py:2: crate('Crate 5', 3)", 'lib.py:3: return p.box(name, 1)'])
  }, 300000)

  it('reviews each step in a few lines of text: changes, floating parts, deep overlaps, z-fighting and symmetry', async () => {
    await cmd('init', 'table', '--target', 'web', '--symmetry', 'x')
    const defects = path.join(fixtures, 'defects')
    const steps: StepDone[] = []
    for (const file of fs.readdirSync(defects).sort()) steps.push(await cmd('step', 'table', path.join(defects, file)))
    const [clean, flawed, fixed, moved] = steps
    // a clean model: what changed, and nothing else
    expect(clean.review).toEqual(['Changes: 5 added (Leg back L, Leg back R, Leg front L, Leg front R, Top)'])
    // one known defect of each kind, each named once, in a line of its own
    expect(flawed.review).toEqual([
      'Changes: 4 added (Block, Decal, Handle L, Lamp)',
      'Floating: Lamp (0.32 m from Top)',
      'Deep overlap: Block / Top (40 % of Block inside)',
      'Z-fighting: Decal / Top (0.09 m² at 0, -0.2, 1)',
      'Symmetry: Handle L has no Handle R; no mirror twin in x: Lamp',
      'Materials: none on Block, Decal, Handle L, Lamp'
    ])
    expect(flawed.review.join('\n').length).toBeLessThan(300)
    // information only: the step landed, and nothing of the review is repeated as a warning
    expect(flawed.ok).toBe(true)
    expect(flawed.warnings.join('\n')).not.toMatch(/Lamp|Block|Handle/)
    expect(fixed.review).toEqual(['Changes: 4 removed (Block, Decal, Handle L, Lamp)'])
    // the leg was made again without its wood
    expect(moved.review).toEqual(['Changes: 1 moved (Leg front L)', 'Symmetry: Leg front R is 0.05 m off the mirror of Leg front L', 'Materials: none on Leg front L'])
    // the receipt keeps the review, in full too (nothing was known yet), and each part's box for the next step's comparison
    const receipt = JSON.parse(fs.readFileSync(flawed.receipt, 'utf8'))
    expect(receipt).toMatchObject({ review: flawed.review, review_full: flawed.review, review_new: { Floating: 1, 'Deep overlap': 1, 'Z-fighting': 1, Symmetry: 2, Materials: 1 } })
    expect(receipt.parts.find((x: { name: string }) => x.name === 'Block').box).toEqual([[-0.1, 0.15, 0.92], [0.1, 0.35, 1.12]])

    // the sheet labels the flagged parts (orange) beside the model; view.png, the live view's, stays clean
    const orange = (c: number[]) => c[0] > 230 && c[1] > 115 && c[1] < 165 && c[2] > 70 && c[2] < 115
    const sheet = pngPixels(flawed.sheet!)
    expect(sheet.flat().filter(orange).length).toBeGreaterThan(400)
    expect(pngPixels(flawed.sheet!.replace(/sheet\.png$/, 'view.png')).flat().filter(orange)).toEqual([])
  }, 300000)

  it('checks only pairs with a changed part, as a full check would, and freezes finished parts exactly', async () => {
    await cmd('init', 'desk', '--target', 'web', '--symmetry', 'x')
    const defects = path.join(fixtures, 'defects')
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    await cmd('step', 'desk', path.join(defects, 's01_table.py'))
    const flawed: StepDone = await cmd('step', 'desk', path.join(defects, 's02_defects.py'))
    // the lamp raised the model: a new size changes every tolerance, so every pair was examined
    expect(receipt(flawed).checks.pairs).toMatchObject({ full: true, changed: null })
    const write = (name: string, ...lines: string[]) => {
      fs.writeFileSync(path.join(src, name), lines.join('\n'))
      return path.join(src, name)
    }
    // one part moves: only its pairs are examined; the floating lamp and the sunk block carry over,
    // and every item the last review printed is a count, but the z-fighting that moved
    const slid: StepDone = await cmd('step', 'desk', write('s03_decal.py', '"""Sliding the decal back"""', "p.part('Decal').location.y -= 0.05"))
    const zf = 'Z-fighting: Decal / Top (0.09 m² at 0, -0.25, 1)'
    expect(slid.review).toEqual(['Changes: 1 moved (Decal)', 'Floating: 1 known', 'Deep overlap: 1 known', zf, 'Symmetry: 2 known', 'Materials: 1 known'])
    expect(receipt(slid).review_full).toEqual(['Changes: 1 moved (Decal)', flawed.review[1], flawed.review[2], zf, ...flawed.review.slice(4)])
    const checks = receipt(slid).checks
    expect(checks.pairs).toMatchObject({ full: false, changed: ['Decal'], stopped: { pierces: false, z_fighting: false } })
    expect(checks.pairs.z_fighting.map((z: string[]) => z.slice(0, 2))).toEqual([['Top', 'Decal']])
    // the snapshot is saved before the checks and the sheet
    const order = Object.keys(receipt(slid).timings_ms)
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('checks'))
    expect(pngSize(slid.sheet!)).toEqual([1024, 1024])
    // the export's check of every pair says the same, every item in full
    expect(await cmd('materialize', 'desk')).toMatchObject({ ok: true, id: slid.id, review: receipt(slid).review_full })
    // freezing keeps the shipped shape to the bit: nothing changed, every pair carries over
    const round: StepDone = await cmd('step', 'desk', write('s04_block.py', '"""Rounding the block"""', "p.subsurf(p.part('Block'), 1)"))
    expect(round.review[0]).toBe('Changes: 1 changed (Block)')
    const frozen: StepDone = await cmd('step', 'desk', write('s05_freeze.py', '"""Freezing the block"""',
      "assert [o.name for o in p.freeze('Block')] == ['Block'] and not p.part('Block').modifiers",
      'assert p.freeze() == []'))
    expect(frozen).toMatchObject({ ok: true, triangles: round.triangles })
    expect(receipt(frozen).review_full).toEqual(['Changes: none', ...receipt(round).review_full.slice(1)])
    expect(frozen.review.slice(1).every((l) => / \d+ known$/.test(l))).toBe(true)
    expect(receipt(frozen).checks.pairs).toMatchObject({ full: false, changed: [] })
    const block = (s: StepDone) => receipt(s).parts.find((x: { name: string }) => x.name === 'Block')
    expect(block(frozen).base_triangles).toBe(block(round).triangles)
  }, 300000)

  it('says each review item once, then counts it; p.intended silences an overlap; size, triangles, materials and bake lines', async () => {
    await cmd('init', 'boat', '--target', 'web', '--size', '2x6x2', '--budget', '30000')
    const receipt = (s: StepDone) => JSON.parse(fs.readFileSync(s.receipt, 'utf8'))
    const write = (name: string, ...lines: string[]) => {
      fs.writeFileSync(path.join(src, name), lines.join('\n'))
      return path.join(src, name)
    }
    const hull: StepDone = await cmd('step', 'boat', write('s01_hull.py', '"""A hull with a keel sunk into it"""',
      "wood = p.material('Wood', '#8a5a33')",
      "p.box('Hull', (2, 4, 1), loc=(0, 0, 1), mat=wood)",
      "p.box('Keel', (0.2, 3, 1.2), loc=(0, 0, 0.6), mat=wood)"))
    const keel = 'Deep overlap: Keel / Hull (58 % of Keel inside)'
    expect(hull.review).toEqual(['Changes: 2 added (Hull, Keel)', keel, 'Size: 4 m long (brief 6 m, 67 %); 1.5 m tall (brief 2 m, 75 %)'])
    // the keel line once, then a count beside a new item; a changed size again; a dense part, a part
    // without a material, two woods alike
    const mast: StepDone = await cmd('step', 'boat', write('s02_mast.py', '"""A mast with a flag and a brass ball"""',
      "mast = p.cylinder('Mast', 0.08, 2.5, loc=(0, 0, 2.75), mat=p.material('Mast wood', '#8a5a33'))",
      "p.box('Flag', (0.02, 0.6, 0.4), loc=(0, 0.35, 3.7))",
      "p.sphere('Ball', 0.15, loc=(0, 0, 4.1), subdiv=6, mat=p.material('Brass', '#c8a040', metal=1.0))"))
    expect(mast.review).toEqual([
      'Changes: 3 added (Ball, Flag, Mast)',
      'Deep overlap: Flag / Mast (0.4 m inside, 0.09 m out); 1 known',
      'Size: 4.25 m tall (brief 2 m, 212 %); 1 known',
      'Triangles: 21k of 30k; Ball 20k (100 %)',
      'Materials: none on Flag; Mast wood and Wood look the same'
    ])
    expect(receipt(mast)).toMatchObject({ review_new: { 'Deep overlap': 1, Size: 1, Triangles: 2, Materials: 2 }, review_known: { 'Deep overlap': 1, Size: 1 } })
    expect(receipt(mast).review_full.slice(1, 3)).toEqual([
      'Deep overlap: Flag / Mast (0.4 m inside, 0.09 m out); Keel / Hull (58 % of Keel inside)',
      'Size: 4 m long (brief 6 m, 67 %); 4.25 m tall (brief 2 m, 212 %)'
    ])
    // the keel is meant to sit in the hull: its line goes for good, while the rest stands as counts
    const meant: StepDone = await cmd('step', 'boat', write('s03_meant.py', '"""The keel sits in the hull on purpose; the flag gets the wood"""',
      "assert p.intended('Hull', 'Keel') == [('Hull', 'Keel')]",
      "p.part('Flag').data.materials.append(bpy.data.materials['Wood'])"))
    expect(meant.review).toEqual(['Changes: none', 'Deep overlap: 1 known', 'Size: 2 known', 'Triangles: 2 known', 'Materials: 1 known'])
    expect(receipt(meant).review_full[1]).toBe('Deep overlap: Flag / Mast (0.4 m inside, 0.09 m out)')
    // paint that is not baked yet, and parts without UVs for the bake (the woods no longer look alike)
    const paint: StepDone = await cmd('step', 'boat', write('s04_paint.py', '"""Camo on the wood, not baked yet"""', "p.camo('Wood', 'woodland')"))
    expect(paint.review).toEqual(['Changes: none', 'Deep overlap: 1 known', 'Size: 2 known', 'Triangles: 2 known', 'Bake: paint on Wood ships only after p.bake_maps; no UVs on Ball, Flag, Hull, Keel and 1 more (p.uv_atlas)'])
    // the export's check of every pair keeps the intended pair out too
    const full = await cmd('materialize', 'boat')
    expect(full.review.join('\n')).not.toMatch(/Keel \/ Hull/)
    expect(full.review).toEqual(receipt(paint).review_full)
  }, 300000)

  it('adds close-ups of the changed parts to a dense model\'s sheet', async () => {
    await cmd('init', 'orb', '--target', 'web')
    const write = (name: string, ...lines: string[]) => {
      fs.writeFileSync(path.join(src, name), lines.join('\n'))
      return path.join(src, name)
    }
    const planet: StepDone = await cmd('step', 'orb', write('s01_planet.py', '"""A dense planet"""', "p.sphere('Planet', 5, loc=(0, 0, 5), subdiv=7, mat=p.material('Rock', '#808080'))"))
    expect(planet.triangles).toBe(81920)
    // every part is new: the sheet's four views show them all
    expect(pngSize(planet.sheet!)).toEqual([1024, 1024])
    const beacon: StepDone = await cmd('step', 'orb', write('s02_beacon.py', '"""A red beacon on its front"""', "p.box('Beacon', (0.6, 0.6, 0.6), loc=(0, -5.1, 5), mat=p.material('Red', '#ff1010'))"))
    expect(pngSize(beacon.sheet!)).toEqual([1536, 1024])
    expect(JSON.parse(fs.readFileSync(beacon.receipt, 'utf8')).closeup).toEqual(['Beacon'])
    // the third column: two close-ups, each filled by the beacon far more than the whole-model views are
    const px = pngPixels(beacon.sheet!)
    const red = (c: number[]) => c[0] > 120 && c[1] < 0.5 * c[0] && c[2] < 0.5 * c[0]
    const share = (row: number, col: number) => {
      let n = 0
      for (let r = 0; r < 512; r++) for (let c = 0; c < 512; c++) if (red(px[row * 512 + r][col * 512 + c])) n++
      return n / 512 / 512
    }
    expect(share(0, 2)).toBeGreaterThan(0.05)
    expect(share(1, 2)).toBeGreaterThan(0.05)
    expect(share(0, 0)).toBeLessThan(0.01)
    // view.png, the live view's, stays the 3/4 view alone
    expect(pngSize(beacon.sheet!.replace(/sheet\.png$/, 'view.png'))).toEqual([512, 512])
  }, 300000)

  it('joins, drops, mirrors, rings and lofts parts', async () => {
    await cmd('init', 'helpers', '--target', 'web')
    const file = path.join(src, 's01_helpers.py')
    fs.writeFileSync(file, [
      '"""Every new helper once, checked from inside Blender"""',
      'import bmesh, math',
      'from mathutils import Vector',
      "stone, wood = p.material('Stone', '#9a9a94'), p.material('Wood', '#8a5a33')",
      'near = lambda a, b: (Vector(a) - Vector(b)).length < 1e-5',
      'world = lambda ob: sorted(tuple(round(c, 4) for c in ob.matrix_world @ v.co) for v in ob.data.vertices)',
      '# join: as they ship (the bevel applied), both materials, the first part\'s origin; a child stays put',
      "a = p.box('A', (1, 1, 1), loc=(3, 0, 0.5), mat=stone, bevel=0.05)",
      "b = p.box('B', (1, 1, 1), loc=(4, 0, 0.5), mat=wood)",
      "c = p.box('C', (1, 1, 1), loc=(5, 0, 0.5), mat=stone)",
      "kid = p.parent(p.box('Kid', (0.2, 0.2, 0.2), loc=(4, 0, 1.2), mat=wood), b)",
      'shipped = p.stats([a, b, c])[\'triangles\']',
      "wall = p.join('Wall', [a, 'B', c])",
      "assert not {'A', 'B', 'C'} & set(bpy.data.objects.keys())",
      "assert [m.name for m in wall.data.materials] == ['Stone', 'Wood'] and not wall.modifiers",
      "assert p.stats([wall])['triangles'] == shipped and sum(f.material_index == 1 for f in wall.data.polygons) == 6",
      'bpy.context.view_layer.update()',
      'assert near(wall.matrix_world.translation, (3, 0, 0.5)) and kid.parent == wall and near(kid.matrix_world.translation, (4, 0, 1.2))',
      '# drop: on the ground, on a box, on the tip of a cone (rays from both sides)',
      "crate = p.box('Crate', (0.4, 0.4, 0.4), loc=(-3, 0, 2))",
      'assert abs(p.drop(crate) + 1.8) < 1e-5 and abs(p.bounds([crate])[0].z) < 1e-5',
      "base = p.box('Base', (2, 2, 1), loc=(-3, 3, 0.5))",
      "top = p.box('Top', (0.4, 0.4, 0.4), loc=(-3.2, 3.1, 3))",
      'p.drop(top, on=base)',
      'assert abs(p.bounds([top])[0].z - 1) < 1e-5',
      "p.cone('Spire', 1, 2, loc=(-3, -3, 1), segments=8)",
      "cap = p.box('Cap', (1, 1, 0.2), loc=(-3, -3, 5))",
      "p.drop(cap, on='Spire', gap=0.01)",
      'assert abs(p.bounds([cap])[0].z - 2.01) < 1e-5, p.bounds([cap])[0].z',
      '# mirror_pair: the twin across x = 0 with its child, named by side, facing outwards',
      "arm = p.box('Arm L', (0.6, 0.2, 0.2), loc=(1.5, 0.5, 2), rot=(0.3, 0.2, 0.4), mat=wood)",
      "hand = p.parent(p.sphere('Hand L', 0.15, loc=(1.9, 0.6, 2.1)), arm)",
      'twin = p.mirror_pair(arm)',
      "hand_r = bpy.data.objects['Hand R']",
      'bpy.context.view_layer.update()',
      "assert twin.name == 'Arm R' and hand_r.parent == twin and twin.matrix_world.determinant() > 0",
      'for one, other in ((arm, twin), (hand, hand_r)):',
      '    assert world(other) == sorted((-x, y, z) for x, y, z in world(one)), other.name',
      '    m = other.matrix_world',
      '    assert all((m.to_3x3().inverted().transposed() @ f.normal).dot(m @ f.center - m.translation) > 0 for f in other.data.polygons), other.name',
      "house = p.box('House', (2, 2, 2), loc=(0, -4, 1), rot=(0, 0, math.pi / 2))",
      "window = p.parent(p.box('Window L', (0.3, 0.1, 0.3), loc=(0, -3.1, 1.2)), house)",
      'twin = p.mirror_pair(window)',
      'bpy.context.view_layer.update()',
      "assert twin.name == 'Window R' and near(twin.matrix_world.translation, (0, -4.9, 1.2)), twin.matrix_world.translation",
      'try:',
      "    p.mirror_pair(p.box('Mast', (0.1, 0.1, 1), loc=(1, 0, 0.5)))",
      'except ValueError as e:',
      "    assert 'no side' in str(e)",
      'else:',
      "    raise AssertionError('Mast has no side')",
      "p.remove('Mast')",
      '# ring: joined round a centre, or apart round another axis',
      "fence = p.ring(p.box('Post', (0.1, 0.1, 0.6), loc=(6, 5, 0.3), mat=wood), 8, center=(6, 4))",
      'lo, hi = p.bounds([fence])',
      "assert fence.name == 'Post' and p.stats([fence])['triangles'] == 8 * 12 and near((lo + hi) / 2, (6, 4, 0.3))",
      "spokes = p.ring(p.beam('Spoke', (6, 8, 1), (6, 8, 1.5), 0.05), 4, center=(6, 8, 1), axis='Y', join=False)",
      "assert [s.name for s in spokes] == ['Spoke_1', 'Spoke_2', 'Spoke_3', 'Spoke_4']",
      'assert abs(p.bounds([spokes[2]])[0].z - 0.5) < 1e-5',
      "arc = p.ring(p.box('Crenel', (0.2, 0.2, 0.2), loc=(7, 0, 3)), 3, center=(6, 0), arc=180, join=False)",
      'bpy.context.view_layer.update()',
      'assert near(arc[1].matrix_world.translation, (6, 1, 3)) and near(arc[2].matrix_world.translation, (5, 0, 3))',
      '# loft: a closed hull from three sections and a tip, and an open sail',
      'loop = ((1, 0.5), (0.8, 0), (-0.8, 0), (-1, 0.5))',
      "hull = p.loft('Hull', [[(x * w, y, z) for x, z in loop] for y, w in ((-1, 0.3), (0, 0.5), (1, 0.4))] + [[(0, 1.5, 0.4)]], loc=(0, -7, 0), mat=wood)",
      'bm = bmesh.new()',
      'bm.from_mesh(hull.data)',
      'assert all(e.is_manifold for e in bm.edges) and len(bm.faces) == 13 and bm.calc_volume(signed=True) > 0',
      'bm.free()',
      "sail = p.loft('Sail', [[(x, -7, 1) for x in (-0.5, 0, 0.5)], [(x, -7.2, 2) for x in (-0.4, 0, 0.4)]], closed=False)",
      'assert len(sail.data.polygons) == 2',
      'try:',
      "    p.loft('Bad', [[(0, 0, 0), (1, 0, 0), (0, 1, 0)], [(0, 0, 1), (1, 0, 1)]])",
      'except ValueError as e:',
      "    assert 'same number of points' in str(e)",
      'else:',
      "    raise AssertionError('uneven sections')"
    ].join('\n'))
    const r = await cmd('step', 'helpers', file)
    if (!r.ok) throw new Error(`${r.error}\n${r.trace.join('\n')}`)
    // Wall, Kid, Crate, Base, Top, Spire, Cap, Arm L/R, Hand L/R, House, Window L/R, Post, 4 spokes, 3 crenels, Hull, Sail
    expect(r.objects).toBe(24)
    expect(r.warnings.join('\n')).not.toMatch(/inwards|Negative scale|\.00\d/)
  }, 300000)

  it('builds every hard-surface kit helper, panel seams baked as a mask, and the plan with its blockout and Plan line', async () => {
    const kit = path.join(fixtures, 'kit')
    // Each script asserts inside Blender; a failed assertion fails its step.
    const step = async (model: string, file: string): Promise<StepDone> => {
      const r = await cmd('step', model, path.join(kit, file))
      if (!r.ok) throw new Error(`${file}: ${r.error}\n${r.trace.join('\n')}`)
      return r
    }
    for (const model of ['shapes', 'details', 'planned', 'seams']) await cmd('init', model, '--target', 'web')
    expect((await step('shapes', 's01_shapes.py')).warnings.join('\n')).not.toMatch(/inwards|non-manifold/)
    expect((await step('details', 's02_details.py')).warnings.join('\n')).not.toMatch(/inwards|non-manifold/)
    // the blockout is the plan: the review has nothing to say about it, until a part strays from its plan or goes
    expect((await step('planned', 's03_plan.py')).review).toEqual(['Changes: 12 added (Ball, Dish, Engine L, Engine R, Hull, Mast and 6 more)'])
    const off = await step('planned', 's04_plan_off.py')
    expect(off.review).toEqual(['Changes: 1 moved (Tower), 1 removed (Ball)', 'Plan: Tower at x 0.5 (plan 0); not built: Ball'])
    expect(JSON.parse(fs.readFileSync(off.receipt, 'utf8')).review_new).toEqual({ Plan: 2 })
    await step('seams', 's05_bake.py')
  }, 300000)

  it('rebuilds the starship on the kit: its whole plan in step 1, no raw bmesh, and the Plan line catches planted errors', async () => {
    await cmd('init', 'starship', '--target', 'web', '--size', '13x30x7.5', '--symmetry', 'x', '--budget', '400000')
    const ship = path.join(fixtures, 'starship')
    const files = fs.readdirSync(ship).sort()
    expect(files).toEqual(['lib.py', 's01_blockout.py', 's02_saucer.py', 's03_plating.py', 's04_hull.py', 's05_neck.py'])
    // the kit makes the geometry: no raw bmesh anywhere, and the lib is data (the plan, layout, profiles), no helpers
    for (const f of files) expect(fs.readFileSync(path.join(ship, f), 'utf8')).not.toMatch(/bmesh|^def /m)
    const steps: StepDone[] = []
    for (const f of files.slice(1)) steps.push(await cmd('step', 'starship', path.join(ship, f), '--timeout', '180'))
    expect(steps.map((s) => s.ok)).toEqual([true, true, true, true, true])
    // step 1 is p.blockout(PLAN): every planned part at once
    expect(steps[0]).toMatchObject({ objects: 9, review: ['Changes: 9 added (Bridge module, Engineering hull, Lower dome, Nacelle L, Nacelle R, Neck and 3 more)'] })
    // the parts built later keep to the plan: the review never needs a Plan, Floating, Deep overlap or Symmetry line
    for (const s of steps) expect(s.review.join('\n')).not.toMatch(/^(Plan|Floating|Deep overlap|Symmetry):/m)
    expect(steps[4].triangles).toBeGreaterThan(90000)
    // planted errors: a nacelle a metre inboard, its twin short, a pylon gone
    const planted = path.join(src, 's06_planted.py')
    fs.writeFileSync(planted, ['"""Planting errors against the plan"""', "p.part('Nacelle L').location.x -= 1.0", "p.part('Nacelle R').scale.y = 0.8", "p.remove('Pylon L')"].join('\n'))
    const off: StepDone = await cmd('step', 'starship', planted)
    const line = 'Plan: Nacelle L at x 2.5 (plan 3.5); Nacelle R 12.48 m long (plan 15.6 m); not built: Pylon L'
    expect(off.review).toContain(line)
    // the next step counts them while they stand
    const idle = path.join(src, 's07_idle.py')
    fs.writeFileSync(idle, '"""Looking at the plan again"""\n')
    expect((await cmd('step', 'starship', idle)).review).toContain('Plan: 3 known')
  }, 300000)

  it('gives every model kind a template whose plan blocks out clean in one step', async () => {
    for (const kind of Object.keys(kernel.KINDS) as (keyof typeof kernel.KINDS)[]) {
      const started = await cmd('init', kind, '--target', 'web', '--kind', kind)
      expect(started).toMatchObject({ template: { kind, written: true }, checks: { symmetry: kernel.KINDS[kind].symmetry ?? null } })
      const first = path.join(path.dirname(started.template.lib), 's01_blockout.py')
      fs.writeFileSync(first, `"""Blocking out the ${kind} from its plan"""\np.blockout(PLAN)\n`)
      const r: StepDone = await cmd('step', kind, first)
      expect(r.review).toEqual([expect.stringMatching(/^Changes: \d+ added \(/)])
      expect(r.warnings).toEqual([])
    }
  }, 300000)
})
