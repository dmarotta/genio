/**
 * Startup: building the app context over a realistic Base, the first snapshot
 * a window receives and the chat history a project window loads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { jsonBytes, note, perfRoot, report, seedBase, timeIt, type SeededBase } from './support'

vi.mock('electron', () => ({
  app: { getAppPath: () => '.', isPackaged: true }, BrowserWindow: class { static getAllWindows() { return [] } }, shell: {}, dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }, Notification: undefined, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('no SDK in perf') }, tool: () => ({}), createSdkMcpServer: () => ({}) }))

import { createApp } from '../../src/main/ctx'
import { projectSnapshot } from '../../src/main/project-windows'
import type { AppCtx } from '../../src/main/services'

let base: SeededBase
let ctx: AppCtx
beforeAll(() => { base = seedBase(perfRoot()) })
afterAll(async () => {
  report()
  try { ctx?.inventory.stop(); for (const h of ctx?.homes.values() ?? []) { h.supervisor.stop(); await h.wksp.stop() } } catch { /* best effort */ }
  fs.rmSync(base.root, { recursive: true, force: true, maxRetries: 3 })
})

describe('startup over a realistic Base', () => {
  it('createApp: every service constructed and every data file read', () => {
    const t0 = performance.now()
    ctx = createApp(process.cwd(), base.root)
    note('createApp()', performance.now() - t0, 'ms')
    note('Base data bytes read at startup', ['data/stats.json', 'data/projects.json', 'data/allies.json', 'config/settings.json', `wksps/${base.wksp}/state/tasks.json`, `wksps/${base.wksp}/data/backlog.json`, `wksps/${base.wksp}/data/decisions.json`]
      .reduce((n, p) => n + (fs.existsSync(path.join(base.root, p)) ? fs.statSync(path.join(base.root, p)).size : 0), 0), 'bytes')
  })

  it('first snapshot for the Hub and for the project window', () => {
    const snap = ctx.snapshot()
    note('first snapshot: JSON bytes (Hub)', jsonBytes(snap), 'bytes')
    note('first snapshot: JSON bytes (project window)', jsonBytes(projectSnapshot(snap, { project: base.project, wksp: base.wksp })), 'bytes')
    timeIt('ctx.snapshot() after startup', () => { ctx.snapshot() }, { iterations: 100, warmup: 5 })
  })

  it('project chat history: first read compacts the whole log, then the window loads 300 messages', () => {
    const wksp = ctx.home(base.wksp).wksp
    const t0 = performance.now()
    const hist = wksp.history(300)
    note('history(300): first call (reads + compacts chat.jsonl)', performance.now() - t0, 'ms')
    note('history(300): messages', hist.length, 'count')
    note('history(300): IPC bytes', jsonBytes(hist), 'bytes')
    note('history(300): tool-trace bytes inside', hist.reduce((n, m) => n + (m.tools ? jsonBytes(m.tools) : 0), 0), 'bytes')
    timeIt('history(300): warm', () => { wksp.history(300) }, { iterations: 50 })
  })
})
