/** Real Chromium hit-testing and content-visibility guard, with no providers or credentials.
 * Run with npm run test:e2e -- chat-scroll. Deterministic late-layout cases live in chat-scroll.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

it('native clicks reach the latest after late layout, with and without streaming, in both chat hosts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scroll-browser-'))
  const resultFile = path.join(root, 'results.json')
  const child = spawn(process.execPath, [path.resolve('tests/support/chat-scroll-browser.mjs'), resultFile], { env: process.env, windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Browser fixture timed out\n' + output)) }, 60_000)
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(exitCode, output).toBe(0)
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual([
      { surface: 'screen', streaming: false, gap: 0 }, { surface: 'screen', streaming: true, gap: 0 },
      { surface: 'panel', streaming: false, gap: 0 }, { surface: 'panel', streaming: true, gap: 0 }
    ])
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 75_000)
