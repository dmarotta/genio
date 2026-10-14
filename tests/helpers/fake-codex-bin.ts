import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import { clearWhichCache } from '../../src/main/util'

export const FAKE_CODEX = path.join(__dirname, '..', 'fixtures', 'fake-codex.mjs')

/** Put a `codex` shim for the fake CLI first on PATH, so no real Codex ever runs. */
export function installFakeCodex(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const shim = process.platform === 'win32' ? path.join(dir, 'codex.cmd') : path.join(dir, 'codex')
  if (process.platform === 'win32') fs.writeFileSync(shim, `@"${process.execPath}" "${FAKE_CODEX}" %*\r\n`)
  else fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, { mode: 0o755 })
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('GENIO_CODEX_BIN', FAKE_CODEX)
  clearWhichCache()
  return shim
}

/** Sign a temp Codex home in the way the fake CLI records it. */
export function fakeSignIn(home: string, state = 'Logged in using ChatGPT'): void {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'fake-login'), state)
}

/** A rollout for thread `id` started in `cwd`, laid out like Codex 0.162. */
export function fakeThread(home: string, id: string, cwd: string): string {
  const dir = path.join(home, 'sessions', '2026', '10', '14')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`)
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-14T10:00:00Z' } }) + '\n')
  return file
}
