import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { findBlender } from '../resources/unit-skills/genio/lib/blender-path.mjs'

const run = promisify(execFile)
/** Primitives and triangles from a GLB's JSON chunk. */
function glbSummary(bytes: Buffer): { primitives: number; triangles: number } {
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as { meshes: { primitives: { indices?: number; attributes: { POSITION: number } }[] }[]; accessors: { count: number }[] }
  const primitives = json.meshes.flatMap(m => m.primitives)
  return { primitives: primitives.length, triangles: primitives.reduce((n, p) => n + json.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0) }
}
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
