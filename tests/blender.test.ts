import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { findBlender } from '../resources/unit-skills/genio/lib/blender-path.mjs'

const run = promisify(execFile)
type GlbPrimitive = { indices?: number; attributes: Record<string, number>; targets?: unknown[] }
/** Primitives, triangles, morph targets, skins and mesh names from a GLB's JSON chunk. */
function glbSummary(bytes: Buffer) {
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as { meshes: { name: string; primitives: GlbPrimitive[] }[]; accessors: { count: number }[]; skins?: unknown[] }
  const primitives = json.meshes.flatMap(m => m.primitives)
  return {
    primitives: primitives.length,
    triangles: primitives.reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0),
    morphTargets: Math.max(0, ...primitives.map(p => p.targets?.length ?? 0)),
    skins: json.skins?.length ?? 0,
    jointed: primitives.every(p => 'JOINTS_0' in p.attributes),
    meshNames: json.meshes.map(m => m.name)
  }
}
const modifierFixture = path.resolve('tests/fixtures/blender/modifiers.py')
const scripts = path.resolve('resources/unit-skills/genio/skills/blender/scripts')
const runner = path.join(scripts, 'blender.mjs')
const helper = path.join(scripts, 'genio_bpy.py')
const blender = findBlender()
const scratch = fs.mkdtempSync(path.join(process.env.GENIO_BLENDER_TEST_SCRATCH ?? os.tmpdir(), 'genio-blender-test-'))
const world = path.join(scratch, 'world')
fs.mkdirSync(world)
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

async function batch(script: string, args: string[] = [], options: string[] = []) {
  return run(process.execPath, [runner, '--script', script, '--scratch', path.join(scratch, 'logs'), ...options, '--', ...args], {
    cwd: world, env: { ...process.env, GENIO_BLENDER: blender ?? '', GENIO_TASK_ID: 'blender-test', GENIO_STATUS_FILE: path.join(scratch, 'unit.status') }, timeout: 120000
  })
}

describe.skipIf(!blender)('Blender batch integration (local executable)', () => {
  it('exports a cube, validates, converts both ways, renders and parses the GLB', async () => {
    const build = path.join(scratch, 'cube.py')
    fs.writeFileSync(build, `import bpy, sys, json, os\nimport genio_bpy as g\nbpy.ops.wm.read_factory_settings(use_empty=True)\nc = bpy.data.collections.new('Export')\nbpy.context.scene.collection.children.link(c)\nbpy.ops.mesh.primitive_cube_add(size=2, location=(0,0,1))\no = bpy.context.object\nfor old in list(o.users_collection): old.objects.unlink(o)\nc.objects.link(o)\ng.apply_transforms()\ng.export('cube.fbx', target='unity', fmt='fbx')\nbpy.ops.wm.save_as_mainfile(filepath=os.path.abspath('cube.blend'))\n`)
    const result = await batch(build, [], ['--world', world, '--provenance', 'cube.fbx'])
    const receipt = JSON.parse(result.stdout)
    expect(fs.existsSync(receipt.log)).toBe(true)
    expect(fs.readFileSync(path.join(scratch, 'unit.status'), 'utf8')).toContain(`note [key=genio-blender-run]: ${path.basename(receipt.log)}`)
    const record = JSON.parse(fs.readFileSync(path.join(world, '.genio/provenance/cube.fbx.json'), 'utf8'))
    expect(record).toMatchObject({ schema: 'genio.provenance.v1', provider: 'blender', script: { path: build }, blend: null })
    expect(record.script.sha256).toMatch(/^[a-f0-9]{64}$/)
    await batch(helper, ['validate', 'cube.fbx', '--out', 'report.json'])
    const report = JSON.parse(fs.readFileSync(path.join(world, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ mesh_count: 1, triangles: 12 })
    for (const dimension of report.dimensions) expect(dimension).toBeCloseTo(2, 5)
    expect(report.meshes[0]).toMatchObject({ has_uv: true, non_manifold_edges: 0, flipped_faces: 0, loose_vertices: 0 })
    await batch(helper, ['convert', 'cube.fbx', 'cube.glb', '--target', 'web'])
    const model = glbSummary(fs.readFileSync(path.join(world, 'cube.glb')))
    expect(model.triangles).toBe(12)
    expect(model.primitives).toBe(1)
    await batch(helper, ['convert', 'cube.glb', 'roundtrip.fbx', '--target', 'godot'])
    await batch(helper, ['validate', 'roundtrip.fbx', '--out', 'roundtrip.json'])
    expect(JSON.parse(fs.readFileSync(path.join(world, 'roundtrip.json'), 'utf8')).triangles).toBe(12)
    await batch(helper, ['preview', 'cube.blend', path.join(scratch, 'preview.png')])
    expect(fs.readFileSync(path.join(scratch, 'preview.png')).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await batch(helper, ['export', 'cube.blend', 'from-blend.glb', '--target', 'web', '--fmt', 'glb'], ['--blend', 'cube.blend', '--world', world, '--provenance', 'from-blend.glb'])
    const fromBlend = JSON.parse(fs.readFileSync(path.join(world, '.genio/provenance/from-blend.glb.json'), 'utf8'))
    expect(fromBlend.blend.sha256).toMatch(/^[a-f0-9]{64}$/)
  }, 120000)

  it('fails on Python exceptions and preserves their error in scratch logs', async () => {
    const status = path.join(scratch, 'unit.status')
    const before = fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : ''
    const script = path.join(scratch, 'fail.py')
    fs.writeFileSync(script, 'raise RuntimeError("intentional test failure")')
    await expect(batch(script)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('intentional test failure') })
    expect(fs.existsSync(status) ? fs.readFileSync(status, 'utf8') : '').toBe(before)
  }, 30000)

  it('reports broken geometry and protects rigs from destructive cleanup', async () => {
    const script = path.join(scratch, 'diagnostics.py')
    fs.writeFileSync(script, `import bpy, bmesh\nimport genio_bpy as g\nbpy.ops.wm.read_factory_settings(use_empty=True)\nc = bpy.data.collections.new('Export')\nbpy.context.scene.collection.children.link(c)\nbpy.ops.mesh.primitive_cube_add()\no = bpy.context.object\nc.objects.link(o)\nbm = bmesh.new()\nbm.from_mesh(o.data)\nbmesh.ops.reverse_faces(bm, faces=list(bm.faces))\nbm.verts.new((5,5,5))\nbm.to_mesh(o.data)\nbm.free()\no.scale = (2,2,2)\nr = g.validate()['meshes'][0]\nassert r['flipped_faces'] == 6, r\nassert r['loose_vertices'] == 1, r\nassert r['unapplied_scale'], r\ng.apply_transforms()\nassert not g.validate()['meshes'][0]['unapplied_scale']\ng.decimate(0.5)\nassert g.validate()['triangles'] < 12\nbpy.ops.object.armature_add()\nc.objects.link(bpy.context.object)\ntry: g.apply_transforms()\nexcept ValueError: pass\nelse: raise AssertionError('rig must be protected')\ntry: g.export('missing.glb', fmt='glb')\nexcept TypeError: pass\nelse: raise AssertionError('target must be explicit')\ng.export('rig.fbx', target='unity', fmt='fbx')\n`)
    await batch(script)
  }, 30000)

  async function modifierScenario(scenario: string) {
    await batch(modifierFixture, [scenario, `${scenario}.json`])
    const facts = JSON.parse(fs.readFileSync(path.join(world, `${scenario}.json`), 'utf8'))
    expect(facts.scene_restored).toBe(true)
    expect(facts.evaluated_triangles).toBeGreaterThan(facts.base_triangles)
    return { facts, glb: glbSummary(fs.readFileSync(path.join(world, `${scenario}.glb`))) }
  }

  it('ships bevel and array modifier results, and validates the evaluated mesh', async () => {
    const { facts, glb } = await modifierScenario('bevel-array')
    expect(facts.validation).toMatchObject({ schema: 'genio.blender-validation.v2', triangles: facts.evaluated_triangles, vertices: facts.evaluated_vertices, base_triangles: facts.base_triangles })
    expect(facts.validation.meshes[0]).toMatchObject({ modifiers_applied: true, unapplied_modifiers: [] })
    // Array count 3 along X of a 2 m cube: the bounds must include every copy.
    expect(facts.validation.dimensions[0]).toBeCloseTo(6, 5)
    expect(glb).toMatchObject({ triangles: facts.evaluated_triangles, meshNames: ['Tower'] })
    await batch(helper, ['validate', 'bevel-array.fbx', '--out', 'bevel-array-fbx.json'])
    expect(JSON.parse(fs.readFileSync(path.join(world, 'bevel-array-fbx.json'), 'utf8')).triangles).toBe(facts.evaluated_triangles)
    await batch(helper, ['export', 'bevel-array.blend', 'bevel-array-cli.glb', '--target', 'web', '--fmt', 'glb'])
    expect(glbSummary(fs.readFileSync(path.join(world, 'bevel-array-cli.glb'))).triangles).toBe(facts.evaluated_triangles)
    await batch(helper, ['export', 'bevel-array.blend', 'bevel-array-base.glb', '--target', 'web', '--fmt', 'glb', '--keep-modifiers'])
    expect(glbSummary(fs.readFileSync(path.join(world, 'bevel-array-base.glb'))).triangles).toBe(facts.base_triangles)
    await batch(helper, ['validate', 'bevel-array.blend', '--out', 'bevel-array-base.json', '--keep-modifiers'])
    expect(JSON.parse(fs.readFileSync(path.join(world, 'bevel-array-base.json'), 'utf8')).triangles).toBe(facts.base_triangles)
    await batch(helper, ['convert', 'bevel-array.fbx', 'bevel-array-converted.glb', '--target', 'web'])
    expect(glbSummary(fs.readFileSync(path.join(world, 'bevel-array-converted.glb'))).triangles).toBe(facts.evaluated_triangles)
    await batch(helper, ['preview', 'bevel-array.blend', path.join(scratch, 'bevel-array.png')])
    expect(fs.readFileSync(path.join(scratch, 'bevel-array.png')).subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]))
  }, 180000)

  it('keeps shape keys: a mesh with shape keys ships its base mesh and morph targets', async () => {
    const { facts, glb } = await modifierScenario('shape-keys')
    expect(facts.validation).toMatchObject({ triangles: facts.base_triangles, base_triangles: facts.base_triangles })
    expect(facts.validation.meshes[0]).toMatchObject({ modifiers_applied: false, unapplied_modifiers: ['Bevel', 'Array'] })
    expect(glb).toMatchObject({ triangles: facts.base_triangles, morphTargets: 1 })
  }, 60000)

  it('keeps armature modifiers live: a rigged mesh bakes its other modifiers and stays skinned', async () => {
    const { facts, glb } = await modifierScenario('rig')
    expect(facts.validation).toMatchObject({ triangles: facts.evaluated_triangles })
    expect(glb).toMatchObject({ triangles: facts.evaluated_triangles, skins: 1, jointed: true })
  }, 60000)

  it('terminates a hung batch on timeout', async () => {
    const script = path.join(scratch, 'sleep.py')
    fs.writeFileSync(script, 'import time\ntime.sleep(60)')
    await expect(batch(script, [], ['--timeout', '1'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('timed out') })
  }, 30000)
})

it('rejects logs inside the world before launching Blender', async () => {
  await expect(run(process.execPath, [runner, '--script', helper, '--scratch', path.join(world, 'logs')], { cwd: world }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('outside the project/worktree') })
})
