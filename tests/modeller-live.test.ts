import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasModellerModel, readModellerLive, scriptCaption } from '../src/main/modeller-live'

let data: string
const base = (): string => 'genio-media://model/abc/'
const write = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true }); fs.writeFileSync(path.join(data, rel), text) }
const entry = (n: number, parent: string | null, caption: string, t: string) => ({
  id: `s00${n}`, n, parent, branch: 'main', name: caption.split(' ')[0].toLowerCase(), caption, t, ms: 1500 + n, triangles: 100 * n, vertices: 50 * n, objects: n, warnings: n === 2 ? 1 : 0,
  blend_sha256: null, files: { script: `steps/s00${n}/script.py`, blend: null, glb: `steps/s00${n}/model.glb`, sheet: null, view: n === 1 ? null : `steps/s00${n}/view.png`, receipt: `steps/s00${n}/receipt.json` }
})
const manifest = (patch: Record<string, unknown> = {}) => ({
  schema: 'genio.modeller.v1', model: 'tower', created: '2026-10-16T10:00:00.000Z', updated: '2026-10-16T10:05:00.000Z', branch: 'main',
  branches: { main: { head: 's002', from: null }, wide: { head: 's003', from: 's001' } }, next: 4,
  steps: [entry(1, null, 'Legs on stone footings', '2026-10-16T10:01:00.000Z'), entry(2, 's001', 'Deck of planks', '2026-10-16T10:02:00.000Z'), entry(3, 's001', 'Wide deck', '2026-10-16T10:03:00.000Z')],
  failures: [], history: [], ...patch
})

beforeEach(() => { data = fs.mkdtempSync(path.join(os.tmpdir(), 'modeller-live-')) })
afterEach(() => fs.rmSync(data, { recursive: true, force: true }))

describe('Modeller live state', () => {
  it('is null without a model and never asks for a grant then', () => {
    let asked = false
    expect(readModellerLive(path.join(data, 'missing'), () => { asked = true; return '' })).toBeNull()
    write('notes/readme.txt', 'x')
    expect(readModellerLive(data, () => { asked = true; return '' })).toBeNull()
    expect(asked).toBe(false)
  })

  it('lists the current branch from its root with GLBs and review renders through the unit grant', () => {
    write('tower/manifest.json', JSON.stringify(manifest()))
    const live = readModellerLive(data, base)!
    expect(live).toMatchObject({ model: 'tower', branch: 'main', branches: ['main', 'wide'], running: null, failure: null })
    expect(live.steps).toEqual([
      { id: 's001', n: 1, caption: 'Legs on stone footings', triangles: 100, parts: 1, warnings: 0, ms: 1501, glb: 'genio-media://model/abc/modeller/tower/steps/s001/model.glb', view: null },
      { id: 's002', n: 2, caption: 'Deck of planks', triangles: 200, parts: 2, warnings: 1, ms: 1502, glb: 'genio-media://model/abc/modeller/tower/steps/s002/model.glb', view: 'genio-media://model/abc/modeller/tower/steps/s002/view.png' }
    ])
    write('tower/manifest.json', JSON.stringify(manifest({ branch: 'wide', updated: '2026-10-16T10:06:00.000Z' })))
    const wide = readModellerLive(data, base)!
    expect(wide.steps.map(s => [s.id, s.n])).toEqual([['s001', 1], ['s003', 2]])
    expect(wide.stamp).not.toBe(live.stamp)
  })

  it("carries the head step's checks as information, and says whether the unit has a model at all", () => {
    expect(hasModellerModel(data)).toBe(false)
    write('tower/manifest.json', JSON.stringify(manifest()))
    expect(hasModellerModel(data)).toBe(true)
    expect(readModellerLive(data, base)!.checks).toEqual([])
    write('tower/steps/s002/receipt.json', JSON.stringify({ warnings: ['Over budget: 2802 triangles, budget 2000.', 7, 'Nothing touches the ground.'] }))
    expect(readModellerLive(data, base)!.checks).toEqual(['Over budget: 2802 triangles, budget 2000.', 'Nothing touches the ground.'])
    // Only the kernel's own receipt path is read.
    const odd = manifest()
    odd.steps[1].files.receipt = '../../secret.json'
    write('tower/manifest.json', JSON.stringify(odd))
    expect(readModellerLive(data, base)!.checks).toEqual([])
  })

  it('picks the most recently updated model', () => {
    write('tower/manifest.json', JSON.stringify(manifest()))
    write('crate/manifest.json', JSON.stringify(manifest({ model: 'crate', updated: '2026-10-16T11:00:00.000Z' })))
    expect(readModellerLive(data, base)!.model).toBe('crate')
  })

  it('shows the step Blender is running, with its docstring caption, only while the lock holder lives', () => {
    write('tower/manifest.json', JSON.stringify(manifest()))
    write('tower/steps/.pending-s004/script.py', '# step four\n"""Pitched roof with shingles\n\nMore words."""\nimport bpy\n')
    expect(readModellerLive(data, base)!.running).toBeNull()
    write('tower/.lock', String(process.pid))
    const live = readModellerLive(data, base)!
    // n is the place it takes on the branch (after s001 and s002), not the id's number
    expect(live.running).toMatchObject({ id: 's004', n: 3, caption: 'Pitched roof with shingles' })
    expect(Math.abs(live.running!.startedAt - Date.now())).toBeLessThan(60_000)
    // a batch stages several steps: the lowest is the next to land
    write('tower/steps/.pending-s010/script.py', '"""Wing mirrors"""\n')
    write('tower/steps/.pending-s005/script.py', '"""Chimney"""\n')
    expect(readModellerLive(data, base)!.running).toMatchObject({ id: 's004', n: 3 })
    fs.rmSync(path.join(data, 'tower/steps/.pending-s004'), { recursive: true })
    expect(readModellerLive(data, base)!.running).toMatchObject({ id: 's005', n: 3, caption: 'Chimney' })
    write('tower/.lock', '999999999')
    expect(readModellerLive(data, base)!.running).toBeNull()
  })

  it('reports a failed last attempt until a step, revert or switch moves the model', () => {
    const failure = { id: 's004', name: 'roof', kind: 'error', parent: 's002', branch: 'main', t: '2026-10-16T10:04:00.000Z', error: "NameError: name 'roff' is not defined. The model stays at s002.\nTraceback", dir: 'failed/s004-error-1' }
    write('tower/failed/s004-error-1/script.py', '"""Pitched roof"""\n')
    write('tower/manifest.json', JSON.stringify(manifest({ failures: [failure] })))
    expect(readModellerLive(data, base)!.failure).toEqual({ id: 's004', n: 3, caption: 'Pitched roof', kind: 'error', error: failure.error })
    write('tower/manifest.json', JSON.stringify(manifest({ failures: [failure], history: [{ op: 'revert', t: '2026-10-16T10:04:30.000Z' }] })))
    expect(readModellerLive(data, base)!.failure).toBeNull()
    write('tower/manifest.json', JSON.stringify(manifest({ failures: [{ ...failure, branch: 'wide' }] })))
    expect(readModellerLive(data, base)!.failure).toBeNull()
  })

  it('survives a torn or odd manifest', () => {
    write('tower/manifest.json', '{"schema": "genio.modeller.v1", "steps": [')
    expect(readModellerLive(data, base)).toBeNull()
    write('tower/manifest.json', JSON.stringify({ steps: [{ id: 's001', n: 1, parent: 's001' }], branches: { main: { head: 's001' } }, history: 'x', failures: 7 }))
    expect(readModellerLive(data, base)).toMatchObject({ model: 'tower', steps: [{ id: 's001', caption: 's001', glb: null }], failure: null })
  })

  it('reads captions the way genio_step.py does', () => {
    expect(scriptCaption('"""Raising four timber legs"""\nimport bpy')).toBe('Raising four timber legs')
    expect(scriptCaption("﻿#!python\n\n  r'''\n  Bracing between the legs\n  second line'''")).toBe('Bracing between the legs')
    expect(scriptCaption('import bpy\n"""not a docstring"""')).toBeNull()
    expect(scriptCaption('""""""')).toBeNull()
  })
})
