/**
 * Startup reconciliation: every unit that is not cleaned and has no live terminal is updated once
 * (detached, exited or failed). Measured over the perf Base (GENIO_PERF_BASE for a real one).
 */
import fs from 'node:fs'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { note, perfRoot, report, seedBase, timeIt, type SeededBase } from './support'

vi.mock('electron', () => ({
  app: { getAppPath: () => '.', isPackaged: true }, BrowserWindow: class { static getAllWindows() { return [] } }, shell: {}, dialog: {},
  safeStorage: { isEncryptionAvailable: () => false }, Notification: undefined, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => { throw new Error('no SDK in perf') }, tool: () => ({}), createSdkMcpServer: () => ({}) }))

import { createApp } from '../../src/main/ctx'
import type { AppCtx } from '../../src/main/services'
import { writeJson } from '../../src/main/util'

let base: SeededBase
let ctx: AppCtx
beforeAll(() => { base = seedBase(perfRoot()) })
afterAll(async () => {
  report()
  try { ctx?.inventory.stop(); for (const h of ctx?.homes.values() ?? []) { h.supervisor.stop(); await h.wksp.stop() } } catch { /* best effort */ }
  fs.rmSync(base.root, { recursive: true, force: true, maxRetries: 3 })
})

describe('startup reconciliation', () => {
  it('reconcileOnStart over every home', async () => {
    ctx = createApp(process.cwd(), base.root)
    // A window's first snapshot reads every home's quests and plans before startup reconciles (as in the app).
    ctx.snapshot()
    const homes = [...ctx.homes.values()]
    const open = homes.reduce((n, h) => n + h.crew.list().filter(t => t.state !== 'cleaned').length, 0)
    const bytes = homes.reduce((n, h) => n + (fs.existsSync(h.home.tasksFile) ? fs.statSync(h.home.tasksFile).size : 0), 0)
    let writes = 0
    const byFile = new Map<string, number>()
    const rename = fs.renameSync, append = fs.appendFileSync
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { const name = String(to).split(/[\\/]/).pop()!; byFile.set(name, (byFile.get(name) ?? 0) + 1); if (name === 'tasks.json') writes++; return rename(from, to) }) as typeof fs.renameSync
    fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => { const name = '+' + String(file).split(/[\\/]/).pop()!; byFile.set(name, (byFile.get(name) ?? 0) + 1); return append(file, data, options) }) as typeof fs.appendFileSync
    const { Session } = await import('node:inspector')
    const session = process.env.GENIO_PERF_PROFILE ? new Session() : undefined
    const post = (m: string, p?: object) => new Promise<any>((res, rej) => session!.post(m, p ?? {}, (e: Error | null, r: unknown) => e ? rej(e) : res(r)))
    if (session) { session.connect(); await post('Profiler.enable'); await post('Profiler.start') }
    const t0 = performance.now()
    for (const h of homes) await h.crew.reconcileOnStart()
    if (session) fs.writeFileSync(process.env.GENIO_PERF_PROFILE!, JSON.stringify((await post('Profiler.stop')).profile))
    note('reconcileOnStart(): wall', performance.now() - t0, 'ms', `${open} unfinished units, tasks.json ${Math.round(bytes / 1024)} KB`)
    fs.renameSync = rename; fs.appendFileSync = append
    // What one write of the biggest roster costs (the pass used to pay it once per unfinished unit).
    const biggest = homes.reduce((a, h) => (h.crew.list().length > a.crew.list().length ? h : a))
    timeIt('tasks.json write (biggest home, pretty JSON + temp file + rename)', () => writeJson(biggest.home.tasksFile, biggest.crew.list()), { iterations: 15, warmup: 2, note: `${biggest.crew.list().length} units` })
    console.log('[perf] reconcile writes by file', JSON.stringify(Object.fromEntries(byFile)))
    note('reconcileOnStart(): tasks.json writes', writes, 'count')
  })
})
