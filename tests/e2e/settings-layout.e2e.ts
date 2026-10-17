/** Real Chromium layout guard for Settings, with no providers or credentials: every page's card fills the
 * window height below the header with a single scrollbar, and the Auto-loot confirm on the short Delivery
 * page renders over the whole window (not clipped by the page card) with both buttons visible and clickable,
 * at 1440x900, 880x640 and 480x360. Run with npm run test:e2e -- settings-layout; set SETTINGS_SHOTS to a
 * folder to keep the screenshots.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { defaultSettings } from '../../src/main/settings'

const SIZES = [[1440, 900], [880, 640], [480, 360]]

it('Settings pages fill the window and the Auto-loot confirm is never clipped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-layout-'))
  const resultFile = path.join(root, 'results.json')
  const settingsFile = path.join(root, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify(defaultSettings()))
  const shots = process.env.SETTINGS_SHOTS || path.join(root, 'shots')
  const child = spawn(process.execPath, [path.resolve('tests/support/settings-layout-browser.mjs'), resultFile, settingsFile, path.resolve('tests/support/settings-layout-electron.cjs')],
    { env: { ...process.env, SETTINGS_SHOTS: shots }, windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Browser fixture timed out\n' + output)) }, 170_000)
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(exitCode, output).toBe(0)
    const results: { label: string; ok: boolean }[] = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    expect(results.filter(r => !r.ok), output).toEqual([])
    for (const [w, h] of SIZES) {
      const size = `${w}x${h}`
      expect(results.map(r => r.label)).toContain(`${size} Auto-loot confirm over the window`)
      // Every page was measured at every size, short and long ones alike.
      expect(results.filter(r => r.label.startsWith(`${size} `) && r.label.endsWith(' fills')).length).toBeGreaterThanOrEqual(12)
      for (const name of [`autoloot-confirm-${size}`, `short-delivery-${size}`, `short-asset-generation-${size}`]) {
        const png = fs.readFileSync(path.join(shots, `${name}.png`))
        // PNG IHDR: the screenshot covers the whole window at its size (at least, on a high-DPI display).
        expect([png.readUInt32BE(16) >= w, png.readUInt32BE(20) >= h, png.readUInt32BE(16) < w * 3]).toEqual([true, true, true])
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 180_000)
