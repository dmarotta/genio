import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modellerAction } from '../src/main/modeller-actions'

const KERNEL = path.resolve('resources/unit-skills/genio/skills/blender/scripts/modeller.mjs')

let data: string
const entry = (n: number, parent: string | null, caption: string) => ({
  id: `s00${n}`, n, parent, branch: 'main', name: `step${n}`, caption, t: `2026-10-16T10:0${n}:00.000Z`, ms: 1500, triangles: 100 * n, vertices: 50 * n, objects: n, warnings: 0,
  blend_sha256: null, files: { script: `steps/s00${n}/script.py`, blend: null, glb: `steps/s00${n}/model.glb`, sheet: null, view: null, receipt: `steps/s00${n}/receipt.json` }
})
const manifestFile = (): string => path.join(data, 'tower', 'manifest.json')
const read = () => JSON.parse(fs.readFileSync(manifestFile(), 'utf8'))

beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'modeller-act-'))
  fs.mkdirSync(path.join(data, 'tower', 'steps'), { recursive: true })
  fs.writeFileSync(manifestFile(), JSON.stringify({
    schema: 'genio.modeller.v1', model: 'tower', created: '2026-10-16T10:00:00.000Z', updated: '2026-10-16T10:03:00.000Z',
    blender: { path: 'blender.exe', version: '4.2.1', size: 1, mtimeMs: 1 }, target: 'web', checks: { budget: null, size: null },
    branch: 'main', branches: { main: { head: 's003', from: null } }, next: 4,
    steps: [entry(1, null, 'Legs'), entry(2, 's001', 'Deck'), entry(3, 's002', 'Roof')], failures: [], history: []
  }))
})
afterEach(() => fs.rmSync(data, { recursive: true, force: true }))

describe('Modeller actions from the unit page', () => {
  it('reverts through the kernel and tells the unit where to continue', async () => {
    const r = await modellerAction(KERNEL, data, { op: 'revert', model: 'tower', step: 's002' })
    expect(read().branches.main.head).toBe('s002')
    expect(r.message).toBe('Back at step 2 on main.')
    expect(r.ping).toContain('reverted model tower to s002 ("Deck") on branch main')
    expect(r.ping).toContain('Continue from s002')
  })

  it('branches from a step under a free name and switches back on request', async () => {
    const a = await modellerAction(KERNEL, data, { op: 'branch', model: 'tower', step: 's001' })
    expect(a.message).toBe('New branch from-s001 from step 1.')
    expect(read()).toMatchObject({ branch: 'from-s001', branches: { 'from-s001': { head: 's001', from: 's001' }, main: { head: 's003' } } })
    expect(a.ping).toContain('branch main keeps its steps')
    await modellerAction(KERNEL, data, { op: 'switch', model: 'tower', branch: 'main' })
    const b = await modellerAction(KERNEL, data, { op: 'branch', model: 'tower', step: '1' })
    expect(b.message).toBe('New branch from-s001-2 from step 1.')
    const s = await modellerAction(KERNEL, data, { op: 'switch', model: 'tower', branch: 'main' })
    expect(s.ping).toContain('switched model tower to branch main from the unit page; its head is s003 ("Roof")')
  })

  it('accepts a step: keeps its snapshot and asks the unit to deliver exactly it, merge unchanged', async () => {
    const r = await modellerAction(KERNEL, data, { op: 'accept', model: 'tower', step: 's003' })
    expect(read().steps.find((s: { id: string }) => s.id === 's003').keep).toBe(true)
    expect(r.ping).toContain('accepts s003 ("Roof") of model tower on branch main')
    expect(r.ping).toContain('commit the export with its compressed .blend and the build scripts, then report done')
    expect(r.ping).toContain('The player merges as usual')
  })

  it('refuses steps off the branch, unknown models and a model a step is running on', async () => {
    await modellerAction(KERNEL, data, { op: 'revert', model: 'tower', step: 's001' })
    await expect(modellerAction(KERNEL, data, { op: 'accept', model: 'tower', step: 's003' })).rejects.toThrow('not on branch main any more')
    await expect(modellerAction(KERNEL, data, { op: 'revert', model: '../x', step: 's001' })).rejects.toThrow('Model name')
    fs.writeFileSync(path.join(data, 'tower', '.lock'), String(process.pid))
    await expect(modellerAction(KERNEL, data, { op: 'revert', model: 'tower', step: 's001' })).rejects.toThrow('Wait for it to finish')
  })
})
