/** Real Chromium layout and screenshot guard for the jump-to-latest overlay, with no providers or credentials.
 * Run with npm run test:e2e -- chat-jump-layout. Set CHAT_JUMP_SHOTS to a folder to keep the screenshots.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

it('jump to latest floats over the chat viewport above the composer in both hosts, wide and narrow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-jump-layout-'))
  const resultFile = path.join(root, 'results.json')
  const shots = process.env.CHAT_JUMP_SHOTS || path.join(root, 'shots')
  const child = spawn(process.execPath, [path.resolve('tests/support/chat-scroll-browser.mjs'), resultFile, path.resolve('tests/support/chat-jump-layout-electron.cjs')],
    { env: { ...process.env, CHAT_JUMP_SHOTS: shots, CHAT_BROWSER_TIMEOUT: '100000' }, windowsHide: true })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Browser fixture timed out\n' + output)) }, 110_000)
      child.once('error', e => { clearTimeout(timer); reject(e) })
      child.once('exit', code => { clearTimeout(timer); resolve(code) })
    })
    expect(exitCode, output).toBe(0)
    const labels = ['wide', 'narrow'].flatMap(size => ['screen', 'panel'].flatMap(surface => ['plain', 'calm-queued', 'streaming'].map(v => `${size}-${surface}-${v}`)))
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual(labels.map(label => ({ label, ok: true })))
    for (const label of labels) {
      const png = fs.readFileSync(path.join(shots, `${label}.png`))
      // PNG IHDR: the screenshot covers the whole window at its size (at least, on a high-DPI display).
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
      expect(label.startsWith('wide') ? [width >= 1280, height >= 900] : [width >= 480 && width < 1280, height >= 360 && height < 900]).toEqual([true, true])
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 130_000)
