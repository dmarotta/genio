import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlayPool, listProcesses, mentionsRoot, type PoolOptions } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import type { DesktopWindow } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'

// Every editor here is tests/fixtures/fake-unity-editor.mjs in a temp dir; no real Unity is touched.
const fixture = path.resolve('tests/fixtures/fake-unity-editor.mjs')
const helper = path.resolve('resources/unit-skills/genio/skills/play/scripts/play.mjs')
let root: string, world: string, data: string
const spawned: number[] = []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const fast = (options: PoolOptions = {}) => new PlayPool(data, world, '', { graceMs: 1500, forceMs: 5000, ...options })
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-play-editor-')); world = path.join(root, 'world'); data = path.join(root, 'data'); fs.mkdirSync(world) })
afterEach(() => {
  for (const pid of spawned.splice(0)) try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})
function lines(child: ChildProcess) {
  const queue: unknown[] = [], waiters: ((v: unknown) => void)[] = []
  createInterface({ input: child.stdout! }).on('line', line => { const v = JSON.parse(line); const w = waiters.shift(); if (w) w(v); else queue.push(v) })
  return () => new Promise<Record<string, unknown>>(resolve => queue.length ? resolve(queue.shift() as Record<string, unknown>) : waiters.push(resolve as (v: unknown) => void))
}
async function fakeEditor(project: string, mode: 'graceful' | 'stubborn') {
  const child = spawn(process.execPath, [fixture, '-projectPath', project, mode], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  const ready = await lines(child)() as { pid: number; worker: number }
  spawned.push(ready.pid, ready.worker)
  return ready
}
function idle() { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); spawned.push(child.pid!); return child.pid! }
function git(cwd: string, args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '0' } }).trim() }
function commit(text: string) {
  if (!fs.existsSync(path.join(world, '.git'))) { git(world, ['init', '-q']); git(world, ['config', 'user.name', 'Test']); git(world, ['config', 'user.email', 'test@example.invalid']); fs.writeFileSync(path.join(world, '.gitignore'), 'Library/\nTemp/\n'); fs.mkdirSync(path.join(world, 'Assets')) }
  fs.writeFileSync(path.join(world, 'Assets/game.txt'), text); git(world, ['add', '.']); git(world, ['commit', '-qm', text])
}

it('matches only the exact slot root on a command line', () => {
  const slot = path.join(root, 'slot-1')
  expect(mentionsRoot(`"Unity.exe" -projectPath "${slot}"`, slot)).toBe(true)
  expect(mentionsRoot(`Unity -projectPath ${slot.replace(/\\/g, '/').toUpperCase()} -automated`, slot)).toBe(true)
  expect(mentionsRoot(`Unity -projectPath ${slot}0`, slot)).toBe(false)
  expect(mentionsRoot(`Unity -projectPath ${slot}-copy`, slot)).toBe(false)
})

it('release closes the slot editor and its import worker before the slot is free', async () => {
  const pool = fast(), a = (await pool.acquire('unit:a'))!
  const editor = await fakeEditor(a.root, 'graceful')
  await pool.recordEditor(1, a.token, editor.pid)
  expect((await pool.state()).slots[0]).toMatchObject({ editor: true, owner: 'unit:a' })
  expect(await pool.release(1, a.token)).toMatchObject({ closed: true })
  expect(alive(editor.pid)).toBe(false); expect(alive(editor.worker)).toBe(false)
  expect(fs.existsSync(path.join(a.root, 'Temp/UnityLockfile'))).toBe(false)
  expect((await pool.state()).slots[0]).toMatchObject({ editor: false, closing: false })
  expect((await pool.state()).slots[0].stuck).toBeUndefined()
  expect((await pool.acquire('unit:b'))?.id).toBe(1)
}, 60000)

it('escalates to a forced stop of only the processes recorded for that slot', async () => {
  const killed: number[] = []
  const pool = fast({ system: { kill: async pid => { killed.push(pid); process.kill(pid, 'SIGKILL') } } })
  const a = (await pool.acquire('unit:a'))!
  const editor = await fakeEditor(a.root, 'stubborn')
  // The main editor runs the registered project; a stale launch record points at it (PID reuse).
  const main = await fakeEditor(world, 'stubborn')
  const bystander = idle()
  await pool.recordEditor(1, a.token, main.pid)
  const result = await pool.release(1, a.token)
  expect(result).toMatchObject({ closed: true, forced: true })
  expect(alive(editor.pid)).toBe(false); expect(alive(editor.worker)).toBe(false)
  // Only the slot editor's own tree (its worker, plus Windows' conhost) is force-stopped.
  expect(killed).toEqual(expect.arrayContaining([editor.pid, editor.worker]))
  for (const pid of [main.pid, main.worker, bystander]) { expect(killed).not.toContain(pid); expect(alive(pid)).toBe(true) }
  expect(fs.existsSync(path.join(world, 'Temp/UnityLockfile'))).toBe(true)
}, 90000)

it('marks a slot stuck when its editor survives, blocks leases, and recovers through closeSlot', async () => {
  const broken = fast({ graceMs: 500, forceMs: 1000, system: { kill: async () => {} } })
  const a = (await broken.acquire('unit:a'))!
  const editor = await fakeEditor(a.root, 'stubborn')
  const result = await broken.release(1, a.token)
  expect(result).toMatchObject({ closed: false, reason: expect.stringContaining('survived') })
  expect(result!.pids).toContain(editor.pid)
  const stuck = (await broken.state()).slots[0]
  expect(stuck.stuck?.pids).toContain(editor.pid)
  expect(await broken.acquire('unit:b')).toBeNull()
  const wait = await broken.waitInfo('unit:b')
  expect(wait).toMatchObject({ position: 1, estimateMs: null, stuck: [{ slot: 1 }] })
  // Genio-side recovery: the same safe sequence with a working forced stop.
  await expect(fast().closeSlot(1)).resolves.toMatchObject({ closed: true, forced: true })
  expect(alive(editor.pid)).toBe(false)
  expect((await broken.state()).slots[0].stuck).toBeUndefined()
  expect((await broken.acquire('unit:b'))?.id).toBe(1)
}, 90000)

it('refuses Genio recovery of a live lease but lets the player revoke it', async () => {
  const pool = fast(), a = (await pool.acquire('unit:a'))!
  const editor = await fakeEditor(a.root, 'graceful')
  await expect(pool.closeSlot(1)).rejects.toThrow('leased by unit:a')
  expect(alive(editor.pid)).toBe(true)
  await expect(pool.closeSlot(1, { force: true })).resolves.toMatchObject({ closed: true })
  await expect(pool.check(1, a.token)).rejects.toThrow('lost')
  expect(alive(editor.pid)).toBe(false)
}, 60000)

it('reuses an editor on the same revision and closes it automatically before switching branches', async () => {
  commit('v1')
  const pool = fast(), a = (await pool.acquire('unit:a'))!
  await pool.prepare(a.id, a.token)
  const editor = await fakeEditor(a.root, 'graceful')
  await pool.recordEditor(1, a.token, editor.pid)
  expect(await pool.release(1, a.token, { keepEditor: true })).toMatchObject({ closed: false, kept: true })
  expect(alive(editor.pid)).toBe(true)
  expect((await pool.state()).slots[0]).toMatchObject({ editor: true, owner: undefined })
  const same = (await pool.acquire('unit:same'))!
  await pool.prepare(same.id, same.token)
  expect(alive(editor.pid)).toBe(true)
  await pool.release(1, same.token, { keepEditor: true })
  commit('v2')
  const b = (await pool.acquire('unit:b'))!
  await pool.prepare(b.id, b.token)
  expect(alive(editor.pid)).toBe(false); expect(alive(editor.worker)).toBe(false)
  expect(fs.readFileSync(path.join(b.root, 'Assets/game.txt'), 'utf8')).toBe('v2')
  expect((await pool.check(1, b.token))).toBe(b.root)
}, 90000)

it('reclaims a dead owner\'s slot by closing its editor before the next lease, and renews live leases', async () => {
  const pool = fast(), owner = idle()
  const a = (await pool.acquire('unit:a', owner))!
  const before = JSON.parse(fs.readFileSync(path.join(pool.dir, 'state.json'), 'utf8')).slots[0].lease.expires
  await new Promise(r => setTimeout(r, 20)); await pool.check(1, a.token)
  expect(JSON.parse(fs.readFileSync(path.join(pool.dir, 'state.json'), 'utf8')).slots[0].lease.expires).toBeGreaterThan(before)
  const editor = await fakeEditor(a.root, 'graceful')
  process.kill(owner, 'SIGKILL'); while (alive(owner)) await new Promise(r => setTimeout(r, 50))
  expect(await pool.acquire('unit:b')).toBeNull() // reclaimed, closing in the background
  expect((await pool.state()).slots[0]).toMatchObject({ owner: undefined })
  await pool.settle()
  expect(alive(editor.pid)).toBe(false)
  expect((await pool.acquire('unit:b'))?.id).toBe(1)
}, 60000)

it('tells queued units their FIFO position and a rough wait with a cap of one', async () => {
  const pool = fast(), a = (await pool.acquire('unit:a'))!
  expect(await pool.acquire('unit:b')).toBeNull(); expect(await pool.acquire('unit:c')).toBeNull()
  const b = await pool.waitInfo('unit:b'), c = await pool.waitInfo('unit:c')
  expect(b).toMatchObject({ position: 1, length: 2, holders: [{ slot: 1, owner: 'unit:a' }], stuck: [] })
  expect(c.position).toBe(2)
  expect(c.estimateMs!).toBeGreaterThan(b.estimateMs!)
  await pool.release(1, a.token)
  expect(await pool.acquire('unit:c')).toBeNull()
  expect((await pool.acquire('unit:b'))?.id).toBe(1)
  expect((await pool.waitInfo('unit:c')).position).toBe(1)
})

it('lowering the cap never touches a leased slot editor; release of the draining slot closes it and retires the slot', async () => {
  const pool = fast(); await pool.configure(2)
  await pool.acquire('unit:a'); const b = (await pool.acquire('unit:b'))!
  expect(b.id).toBe(2)
  const editor = await fakeEditor(b.root, 'graceful')
  await pool.recordEditor(2, b.token, editor.pid)
  // No throw, nothing closed: the slot drains.
  await expect(pool.configure(1)).resolves.toEqual({ cap: 1, draining: [2] })
  expect(alive(editor.pid)).toBe(true)
  expect((await pool.state()).slots[1]).toMatchObject({ owner: 'unit:b', editor: true, draining: true, retired: false })
  expect(await pool.check(2, b.token)).toBe(b.root)
  expect(await pool.acquire('unit:c')).toBeNull()
  expect(await pool.waitInfo('unit:c')).toMatchObject({ position: 1, cap: 1, inUse: 1, draining: [2] })
  // keepEditor cannot keep it: no lease may follow on a draining slot.
  expect(await pool.release(2, b.token, { keepEditor: true })).toMatchObject({ closed: true })
  expect(alive(editor.pid)).toBe(false); expect(alive(editor.worker)).toBe(false)
  const retired = (await pool.state()).slots[1]
  expect(retired).toMatchObject({ editor: false, draining: false, retired: true })
  // Kept for cheap reuse: the copy and its Library stay on disk.
  expect(fs.existsSync(b.root)).toBe(true)
  expect(await pool.acquire('unit:c')).toBeNull()
  await pool.configure(2)
  expect((await pool.acquire('unit:c'))?.id).toBe(2)
}, 60000)

it('a cap change never stops a stubborn editor; only release runs the safe close', async () => {
  const killed: number[] = [], terminated: number[] = []
  const pool = fast({ system: { kill: async pid => { killed.push(pid); process.kill(pid, 'SIGKILL') }, terminate: async pid => { terminated.push(pid) } } })
  await pool.configure(3); await pool.acquire('unit:a'); await pool.acquire('unit:b'); const c = (await pool.acquire('unit:c'))!
  const editor = await fakeEditor(c.root, 'stubborn')
  await pool.recordEditor(3, c.token, editor.pid)
  for (const cap of [1, 2, 1]) await pool.configure(cap)
  expect(killed).toEqual([]); expect(terminated).toEqual([])
  expect(alive(editor.pid)).toBe(true)
  expect(await pool.release(3, c.token)).toMatchObject({ closed: true, forced: true })
  expect(killed).toEqual(expect.arrayContaining([editor.pid]))
}, 90000)

it('play.mjs exit closes the editor by default, keep_editor leaves it, and --close recovers it', async () => {
  commit('v1')
  const env = { ...process.env, GENIO_PLAY_DATA: data, GENIO_PLAY_WORLD: world, GENIO_PLAY_SOURCE: world, GENIO_PLAY_ENGINE_ROOT: '', GENIO_TASK_ID: 'probe' }
  const session = async (line: string) => {
    const child = spawn(process.execPath, [helper], { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    spawned.push(child.pid!)
    const next = lines(child)
    const ready = await next()
    expect(ready).toMatchObject({ ready: true, slot: 1 })
    const editor = await fakeEditor(String(ready.project), 'graceful')
    child.stdin!.write(line + '\n')
    const released = await next()
    child.stdin!.end()
    await new Promise(r => child.once('exit', r))
    return { editor, released }
  }
  const closed = await session('{"command":"exit"}')
  expect(closed.released).toMatchObject({ released: true, editor: 'closed' })
  expect(alive(closed.editor.pid)).toBe(false)
  const now = await session('{"command":"close_editor"}')
  expect(now.released).toMatchObject({ editor: 'closed' })
  expect(alive(now.editor.pid)).toBe(false)
  const kept = await session('{"command":"exit","keep_editor":true}')
  expect(kept.released).toMatchObject({ editor: 'kept' })
  expect(alive(kept.editor.pid)).toBe(true)
  const out = execFileSync(process.execPath, [helper, '--close'], { env, encoding: 'utf8', windowsHide: true })
  expect(JSON.parse(out.trim().split('\n')[0])).toMatchObject({ released: true, slot: 1, editor: 'closed' })
  expect(alive(kept.editor.pid)).toBe(false)
}, 120000)

// ---------------------------------------------------------------- hidden desktop (fake desktop API, fake editors)

function fakeDesktop(windows: () => DesktopWindow[] = () => []) {
  const workers = new Map<number, number>()
  const api = {
    available: () => true,
    launch: vi.fn(async ({ command }: { command: string }) => {
      const m = command.match(/^"[^"]+" -automated -projectPath (?:"([^"]+)"|(\S+))$/)
      if (!m) return { ok: false, stage: 'process', message: `unexpected command ${command}` }
      const editor = await fakeEditor(m[1] ?? m[2], 'stubborn')
      workers.set(editor.pid, editor.worker)
      const created = (await listProcesses()).find(p => p.pid === editor.pid)?.created ?? ''
      return { ok: true, pid: editor.pid, created, desktop: `WinSta0\\genio-fake-${editor.pid}`, helper: process.pid }
    }),
    windows: vi.fn(async () => windows()),
    click: vi.fn(async () => true),
    screenshot: vi.fn(async (_d: string, file: string) => { fs.writeFileSync(file, 'png'); return file }),
    // Stands in for WM_CLOSE on the hidden desktop: the editor and its worker exit.
    close: vi.fn(async (_d: string, pid: number) => { for (const p of [pid, workers.get(pid)]) try { process.kill(p!, 'SIGKILL') } catch { /* gone */ } return true })
  }
  return api
}
const stateFile = (pool: PlayPool) => JSON.parse(fs.readFileSync(path.join(pool.dir, 'state.json'), 'utf8'))

it('launches the slot editor on a hidden desktop, records its identity, and closes it through that desktop', async () => {
  const desktop = fakeDesktop(), terminated: number[] = []
  const pool = fast({ desktop, system: { terminate: async pid => { terminated.push(pid) } } })
  const a = (await pool.acquire('unit:a'))!
  fs.mkdirSync(a.root, { recursive: true })
  const launch = await pool.launchEditor(1, a.token, 'C:\\Hub\\Editor\\Unity.exe')
  expect(launch).toMatchObject({ hidden: true, desktop: `WinSta0\\genio-fake-${launch.pid}` })
  if (process.platform === 'win32') expect(launch.created).toMatch(/^\d+$/)
  expect(stateFile(pool).slots[0].editor).toMatchObject({ pid: launch.pid, created: launch.created || undefined, desktop: launch.desktop, owner: 'unit:a' })
  expect((await pool.state())).toMatchObject({ launch: 'hidden', slots: [{ editor: true, window: 'hidden' }] })
  // No Pipeline answer: the polite close goes through the hidden desktop, never taskkill.
  fs.rmSync(path.join(a.root, 'Library/Pipeline/.unity-pipeline-port'))
  expect(await pool.release(1, a.token)).toMatchObject({ closed: true, forced: false })
  expect(desktop.close).toHaveBeenCalledWith(launch.desktop, launch.pid)
  expect(terminated).toEqual([])
  expect(alive(launch.pid)).toBe(false)
}, 60000)

it('opens visibly when Settings › Unity slots says so', async () => {
  const desktop = fakeDesktop()
  const spawnVisible = vi.fn(async (_file: string, args: string[]) => (await fakeEditor(args[2], 'graceful')).pid)
  const pool = fast({ desktop, spawnVisible })
  expect(await pool.configureLaunch(true)).toEqual({ launch: 'visible' })
  const a = (await pool.acquire('unit:a'))!
  fs.mkdirSync(a.root, { recursive: true })
  const launch = await pool.launchEditor(1, a.token, 'Unity.exe')
  expect(launch).toMatchObject({ hidden: false, created: '' })
  expect(desktop.launch).not.toHaveBeenCalled()
  expect(spawnVisible).toHaveBeenCalledWith('Unity.exe', ['-automated', '-projectPath', a.root], expect.anything())
  expect(await pool.state()).toMatchObject({ launch: 'visible', slots: [{ window: 'visible' }] })
  expect(await pool.release(1, a.token)).toMatchObject({ closed: true })
}, 60000)

it('the dialog watcher presses safe buttons, and a blocking dialog fails the lease with a clear message and closes the editor', async () => {
  let shown: DesktopWindow[] = [{ hwnd: '7', pid: 1, className: '#32770', title: 'Scene(s) Have Been Modified', texts: ['Save changes?'], buttons: ['Save', "Don't Save"] }]
  const desktop = fakeDesktop(() => shown)
  const pool = fast({ desktop })
  const a = (await pool.acquire('unit:a'))!
  fs.mkdirSync(a.root, { recursive: true })
  const launch = await pool.launchEditor(1, a.token, 'Unity.exe')
  expect(await pool.watchEditor(1, a.token)).toMatchObject({ clicked: [{ button: "Don't Save" }] })
  expect(await pool.check(1, a.token)).toBe(a.root)
  shown = [{ hwnd: '8', pid: 1, className: '#32770', title: 'Unity', texts: ['No valid Unity Editor license found.'], buttons: ['OK'] }]
  await expect(pool.watchEditor(1, a.token)).rejects.toThrow(/^Play slot 1 editor is blocked by a Unity licence or sign-in prompt on its hidden desktop: "Unity" says "No valid Unity Editor license found\."/)
  // Every later call from that holder gets the same reason, not a bare "lease lost".
  await expect(pool.check(1, a.token)).rejects.toThrow('licence or sign-in prompt')
  expect(alive(launch.pid)).toBe(false)
  const slot = (await pool.state()).slots[0]
  expect(slot).toMatchObject({ owner: undefined, editor: false, failure: { message: expect.stringContaining('Screenshot:') } })
  expect(fs.existsSync(slot.failure!.screenshot!)).toBe(true)
  // The slot is usable again; a new editor clears the failure.
  const b = (await pool.acquire('unit:b'))!
  expect(b.id).toBe(1)
  shown = []
  await pool.launchEditor(1, b.token, 'Unity.exe')
  expect((await pool.state()).slots[0].failure).toBeUndefined()
  expect(await pool.release(1, b.token)).toMatchObject({ closed: true })
}, 90000)

it.runIf(process.platform === 'win32')('never touches a recorded PID whose creation time no longer matches (PID reuse)', async () => {
  const killed: number[] = [], terminated: number[] = []
  const pool = fast({ system: { kill: async pid => { killed.push(pid) }, terminate: async pid => { terminated.push(pid) } } })
  const a = (await pool.acquire('unit:a'))!
  const editor = await fakeEditor(a.root, 'stubborn')
  await pool.recordEditor(1, a.token, editor.pid, { created: '1', hidden: true, desktop: 'WinSta0\\genio-gone' })
  await pool.release(1, a.token)
  expect(killed).toEqual([]); expect(terminated).toEqual([])
  expect(alive(editor.pid)).toBe(true)
}, 60000)