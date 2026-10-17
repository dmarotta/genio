import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { defaultSettings } from '../../src/main/settings'

it('keeps tips clear of choices, toasts and the terminal at 1440x900 and 480x360, and switches tips off/on in General', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-card-layout-'))
  const result = path.join(root, 'results.json'), settings = path.join(root, 'settings.json')
  fs.writeFileSync(settings, JSON.stringify(defaultSettings()))
  const child = spawn(process.execPath, [path.resolve('tests/support/tip-card-browser.mjs'), result, settings], { env: { ...process.env }, windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Tip render check timed out\n' + output)) }, 170_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    const results: { label: string; ok: boolean }[] = JSON.parse(fs.readFileSync(result, 'utf8'))
    if (process.env.TIP_CARD_SHOTS) fs.copyFileSync(result, path.join(process.env.TIP_CARD_SHOTS, 'render-check.json'))
    expect(code, output).toBe(0)
    expect(results.filter(r => !r.ok), output).toEqual([])
    expect(results).toHaveLength(10)
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 180_000)
