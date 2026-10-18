/** Real Chromium geometry at the requested window sizes, using the real chats and overlay components. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'

it('keeps the amber warning readable and clear of headers, choices, tips and toasts in both chat hosts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-warning-layout-'))
  const resultFile = path.join(root, 'results.json')
  const child = spawn(process.execPath, [path.resolve('tests/support/chat-scroll-browser.mjs'), resultFile,
    path.resolve('tests/support/quota-protection-layout-electron.cjs'), path.resolve('tests/support/quota-protection-layout.html')],
  { env: { ...process.env, CHAT_BROWSER_TIMEOUT: '100000' }, windowsHide: true })
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
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toEqual(
      ['1440x900', '480x360'].flatMap(size => ['screen', 'panel'].map(surface => ({ label: `${size}-${surface}`, ok: true }))))
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 130_000)
