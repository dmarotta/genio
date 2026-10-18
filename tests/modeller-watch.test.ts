import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLiveWatch, relevantChange, type LiveWatch } from '../src/main/modeller-watch'
import { routeProjectEvent } from '../src/main/project-windows'
import type { FleetSnapshot } from '../src/shared/types'

let dir: string, watch: LiveWatch
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (check()) return true
  return check()
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modeller-watch-')); watch = createLiveWatch({ idleMs: 1000, settleMs: 20 }) })
afterEach(() => { watch.close(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('Modeller live view push', () => {
  it('reacts to what the view shows, never to Blender logs or bakes', () => {
    for (const f of ['tower/manifest.json', 'tower\\steps\\.pending-s004', 'tower/.lock', 'tower/s03_roof.py', null]) expect(relevantChange(f)).toBe(true)
    for (const f of ['tower/logs/blender-1.log', 'tower/bake/basecolor.png', 'tower/manifest.json.123.tmp', 'tower/steps/.pending-s004/model.glb', 'tower/steps/s004/sheet.png']) expect(relevantChange(f)).toBe(false)
  })

  it('pushes once per burst of changes while the page reads, and stops after the reads stop', async () => {
    let pushes = 0
    const model = path.join(dir, 'tower')
    fs.mkdirSync(path.join(model, 'logs'), { recursive: true })
    watch.touch('u1', [dir, path.join(dir, 'missing')], () => { pushes++ })
    await wait(50)
    // a manifest write is a temp file and a rename: one push
    fs.writeFileSync(path.join(model, 'manifest.json.1.tmp'), '{}')
    fs.renameSync(path.join(model, 'manifest.json.1.tmp'), path.join(model, 'manifest.json'))
    expect(await until(() => pushes > 0)).toBe(true)
    await wait(150)
    expect(pushes).toBe(1)
    // Blender's log is not the view's business
    fs.writeFileSync(path.join(model, 'logs', 'blender.log'), 'Rendering')
    await wait(200)
    expect(pushes).toBe(1)
    // a folder created later is watched from the next read on
    fs.mkdirSync(path.join(dir, 'missing'))
    watch.touch('u1', [dir, path.join(dir, 'missing')], () => { pushes += 10 })
    fs.writeFileSync(path.join(dir, 'missing', 's01_legs.py'), '"""Legs"""')
    expect(await until(() => pushes >= 11)).toBe(true)
    // no read for idleMs: the watch is gone
    await wait(1300)
    const before = pushes
    fs.writeFileSync(path.join(model, 'manifest.json'), '{"x":1}')
    await wait(250)
    expect(pushes).toBe(before)
  })

  it('reaches only the windows of the unit\'s project', () => {
    const snap = { tasks: [{ id: 'u1', project: 'genio' }] } as unknown as FleetSnapshot
    const ev = { type: 'modeller-live' as const, taskId: 'u1', live: null }
    expect(routeProjectEvent(ev, { project: 'genio', workspace: 'main' }, snap)).toBe(ev)
    expect(routeProjectEvent(ev, { project: 'other', workspace: 'main' }, snap)).toBeUndefined()
  })
})
