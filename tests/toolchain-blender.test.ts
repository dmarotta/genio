/**
 * The toolchain's Blender probe (registry queries and `blender --version`, synchronous, about 1.3 s on
 * Windows) runs on a worker thread: same answer as the in-process probe, and the event loop keeps turning.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findBlender } from '../resources/unit-skills/genio/lib/blender-path.mjs'
import { findBlenderOffThread } from '../src/main/toolchain'

const saved = process.env.GENIO_BLENDER
afterEach(() => { if (saved === undefined) delete process.env.GENIO_BLENDER; else process.env.GENIO_BLENDER = saved })

it('answers what the in-process probe answers, GENIO_BLENDER included', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-blender-probe-'))
  try {
    const exe = path.join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender')
    fs.writeFileSync(exe, '')
    process.env.GENIO_BLENDER = exe
    expect(await findBlenderOffThread()).toBe(findBlender())
    expect(await findBlenderOffThread()).toBe(exe)
    process.env.GENIO_BLENDER = path.join(dir, 'missing', 'blender.exe')
    expect(await findBlenderOffThread()).toBeNull()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('keeps the event loop free while the machine is searched', async () => {
  delete process.env.GENIO_BLENDER
  let last = performance.now(), gap = 0
  const tick = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 10)
  try {
    const found = await findBlenderOffThread()
    expect(found).toBe(findBlender())
  } finally { clearInterval(tick) }
  expect(gap).toBeLessThan(500)
}, 30_000)
