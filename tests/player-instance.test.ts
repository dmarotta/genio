import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppCtx } from '../src/main/services'
import { PlayerInstanceService, type PlayerRuntime } from '../src/main/player-instance'
import { biggestConsumers, closePlayerRoot, type MemoryProcess, type PlayerProcess, type PlayerSystem } from '../src/main/player-process'
import { PlayerCopies } from '../resources/unit-skills/genio/lib/player-copy.mjs'
import type { DesktopApi, DesktopWindow } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'

// Real mirrors in disposable repositories; every process, desktop and Pipeline action is fake.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true }).trim()
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
let scratch: string, data: string, clock: number, free: number, processes: PlayerProcess[], nextPid: number
let system: PlayerSystem, desktop: DesktopApi, copies: PlayerCopies, svc: PlayerInstanceService, ctx: AppCtx
let projects: Map<string, { path: string; engine: string }>, events: string[], modes: Map<string, string>, dialogs: DesktopWindow[]
let graceful: boolean, killed: boolean, compilerErrors: boolean, installed: boolean
let commit: number | undefined, usage: MemoryProcess[], slots: { label: string; close(): Promise<unknown> }[]
const GiB = 2 ** 30
const services: PlayerInstanceService[] = []
function project(name: string) {
  const root = path.join(scratch, name); fs.mkdirSync(root, { recursive: true })
  git(root, 'init', '-q', '-b', 'main')
  write(path.join(root, '.gitignore'), 'Library/\nTemp/\n')
  write(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.1f1\n')
  write(path.join(root, 'ProjectSettings/ProjectSettings.asset'), 'activeInputHandler: 1\n')
  write(path.join(root, 'Packages/manifest.json'), '{"dependencies":{"com.unity.inputsystem":"1.14.0"}}')
  write(path.join(root, 'Assets/Code.cs'), '// initial\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial')
  projects.set(name, { path: root, engine: 'unity' }); return root
}
function service() {
  const r = new PlayerInstanceService(ctx, { copies, system, desktop, ownerCreated: async () => '100', executable: () => installed ? 'FakeUnity.exe' : undefined, graceMs: 500, forceMs: 500, readyMs: 2000, idleSlots: async () => slots,
    runtime: root => ({
      async request(command: string, parameters?: object) {
        events.push(command)
        if (command === 'editor_play') modes.set(root, 'playing')
        if (command === 'editor_stop') modes.set(root, 'stopped')
        if (command === 'editor_status') return { playMode: modes.get(root) ?? 'stopped', compiling: false, domainReloadInProgress: false }
        if (command === 'console') return { entries: compilerErrors ? [{ message: 'error CS1002: ; expected', level: 'Error' }] : [] }
        if (command === 'eval' && (parameters as { code?: string })?.code?.includes('scriptCompilationFailed')) return { success: true, result: compilerErrors }
        if (command === 'eval' && graceful) processes = processes.filter(p => !p.command.includes(root))
        if (command === 'eval') events.push(`quit-version:${fs.readFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').trim()}`)
        return parameters ?? {}
      },
      async stream() { events.push('stream') }, stopStream() { events.push('stream-stop') }, input() { events.push('input') }
    }) as PlayerRuntime
  })
  services.push(r); return r
}
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-instance-')); data = path.join(scratch, 'data')
  clock = Date.now(); free = 20 * 2 ** 30; processes = []; nextPid = 1000; projects = new Map(); events = []; modes = new Map(); dialogs = []
  graceful = true; killed = true; compilerErrors = false; installed = true; commit = undefined; usage = []; slots = []
  system = { list: async () => processes.map(p => ({ ...p })), killVerified: vi.fn(async p => { events.push(`kill:${p.pid}`); if (killed) processes = processes.filter(q => !(q.pid === p.pid && q.created === p.created)); return killed }),
    memory: () => ({ freeBytes: free, totalBytes: 32 * 2 ** 30 }), commit: async () => commit, usage: async () => usage, sleep: async ms => { clock += ms }, now: () => clock }
  desktop = { available: () => true,
    launch: vi.fn(async options => {
      const pid = nextPid++, created = String(200 + pid)
      events.push('launch')
      // Parse the quoted project root supplied by the launcher, never spawn anything.
      const root = options.command.match(/-projectPath (?:"([^"]+)"|(\S+))/)!.slice(1).find(Boolean)!
      processes.push({ pid, ppid: process.pid, created, command: `"FakeUnity.exe" -projectPath "${root}"`, workingSet: 4 * 2 ** 30 })
      write(path.join(root, 'Library/EditorInstance.json'), JSON.stringify({ process_id: pid }))
      return { ok: true, pid, created, desktop: options.name }
    }), windows: async () => dialogs, close: vi.fn(async () => false), click: vi.fn(async () => true), screenshot: async (_d, file) => { write(file, 'fake-png'); return file }
  }
  copies = new PlayerCopies(data, { env, system: { alive: pid => pid === process.pid || processes.some(p => p.pid === pid), created: async pid => pid === process.pid ? '100' : processes.find(p => p.pid === pid)?.created ?? '' } })
  ctx = { appRoot: process.cwd(), main: { home: { data } }, projects: { get: (name: string) => projects.get(name) }, stats: { unlock: vi.fn() } } as unknown as AppCtx
  project('A'); svc = service()
})
afterEach(async () => {
  graceful = true; killed = true; dialogs = []
  await Promise.all(services.splice(0).map(s => s.shutdown())); await copies.settle()
  fs.rmSync(scratch, { recursive: true, force: true })
})
it('keeps one editor warm on Stop and hot-syncs the next source before Play', async () => {
  const root = projects.get('A')!.path
  const first = await svc.play('A', { path: root })
  expect(first.state).toBe('playing'); expect(first.copy?.root).not.toBe(root)
  expect(fs.existsSync(path.join(root, 'Packages/com.genio.play'))).toBe(false)
  const packageFile = path.join(first.copy!.root, 'Packages/com.genio.play/Runtime/StreamSession.cs')
  const packageTime = fs.statSync(packageFile).mtimeMs
  const stopped = await svc.stop('A')
  expect(stopped.state).toBe('stopped-warm'); expect(stopped.pid).toBe(first.pid)
  expect(stopped.deadline).toBe(clock + 10 * 60000)
  const at = events.length
  write(path.join(root, 'Assets/Code.cs'), '// edited, uncommitted and longer\n')
  write(path.join(root, 'Assets/New.txt'), 'untracked')
  const again = await svc.play('A', { path: root })
  expect(again.pid).toBe(first.pid); expect(events.filter(e => e === 'launch')).toHaveLength(1)
  expect(events.slice(at)).toEqual(expect.arrayContaining(['editor_stop', 'genio_sync_begin', 'genio_sync_end', 'editor_play']))
  expect(events.indexOf('genio_sync_begin', at)).toBeLessThan(events.indexOf('genio_sync_end', at))
  expect(fs.readFileSync(path.join(again.root!, 'Assets/New.txt'), 'utf8')).toBe('untracked')
  expect(fs.statSync(packageFile).mtimeMs).toBe(packageTime)
  expect(again.deadline).toBeUndefined()
  await expect(svc.syncCopy('A', { path: root })).rejects.toThrow('safely')
})
it('closes before restart-sensitive writes and keeps the copy and Library for the restart', async () => {
  const root = projects.get('A')!.path, first = await svc.play('A', { path: root })
  write(path.join(first.root!, 'Library/keep'), 'warm-cache')
  write(path.join(root, 'ProjectSettings/TagManager.asset'), 'new tag')
  const at = events.length, second = await svc.play('A', { path: root })
  expect(second.pid).not.toBe(first.pid); expect(second.copy!.id).toBe(first.copy!.id)
  expect(fs.readFileSync(path.join(second.root!, 'Library/keep'), 'utf8')).toBe('warm-cache')
  expect(events.slice(at).indexOf('eval')).toBeLessThan(events.slice(at).indexOf('launch'))
  write(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.4.0f1\n')
  await svc.play('A', { path: root })
  expect(events).toContain('quit-version:m_EditorVersion: 6000.3.1f1')
})
it('resets idle on keep-alive, quits at the deadline, and deletes asynchronously', async () => {
  await svc.play('A', { path: projects.get('A')!.path }); await svc.stop('A')
  clock += 9 * 60000; await svc.keepAlive('A'); clock += 9 * 60000; await svc.poll()
  expect(svc.status('A').state).toBe('stopped-warm')
  clock += 60000; await svc.poll()
  expect(svc.status('A').state).toBe('idle'); expect(svc.status('A').pid).toBeUndefined()
  await copies.settle(); expect(copies.status(projects.get('A')!.path)).toBeUndefined()
})
it('applies a zero idle setting to Stop and persists the global default-two cap', async () => {
  expect((await svc.machine('A')).settings).toEqual({ idleMinutes: 10, maxEditors: 2 })
  await svc.configure('A', { idleMinutes: 0, maxEditors: 3 })
  await svc.play('A', { path: projects.get('A')!.path }); await svc.stop('A')
  expect(svc.status('A').pid).toBeUndefined()
  expect((await service().machine('A')).settings).toEqual({ idleMinutes: 0, maxEditors: 3 })
  await expect(svc.configure('A', { idleMinutes: -1 })).rejects.toThrow('0–60')
})
it('serializes parallel launches under the cap and evicts only a warm editor', async () => {
  project('B'); project('C')
  await Promise.all(['A', 'B'].map(name => svc.play(name, { path: projects.get(name)!.path })))
  await expect(svc.play('C', { path: projects.get('C')!.path })).rejects.toThrow('limit')
  expect(processes).toHaveLength(2)
  await svc.stop('A')
  await svc.play('C', { path: projects.get('C')!.path })
  expect(svc.status('A').pid).toBeUndefined(); expect(svc.status('B').state).toBe('playing')
  expect((await svc.machine('C')).playerEditors).toBe(2)
})
it('starts when available memory covers the 6 GiB first-run estimate plus a 1 GiB reserve, closing nothing', async () => {
  free = 7 * GiB
  const close = vi.fn(async () => {}); slots = [{ label: 'A slot 1 editor', close }]
  expect((await svc.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
  expect(close).not.toHaveBeenCalled()
})
it('closes Genio\'s warm player and idle slot editors before refusing, never the player\'s own editor', async () => {
  project('B'); await svc.play('B', { path: projects.get('B')!.path }); await svc.stop('B')
  processes.push({ pid: 50, ppid: 1, created: '1', command: 'Unity.exe -projectPath "C:/games/lands-of-old"', workingSet: 9 * GiB })
  free = 5 * GiB
  const close = vi.fn(async () => { free += 2 * GiB }); slots = [{ label: 'B slot 1 editor', close }]
  expect((await svc.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
  expect(svc.status('B').pid).toBeUndefined(); expect(close).toHaveBeenCalledOnce()
  expect(processes.some(p => p.pid === 50)).toBe(true); expect(events).not.toContain('kill:50')
})
it('asks before copying, naming the biggest consumers, then Cancel dismisses and Start anyway plays', async () => {
  const p = (pid: number, ppid: number, name: string, gib: number, command = name) => ({ pid, ppid, name, command, workingSet: gib * GiB })
  usage = [p(27424, 1, 'Unity.exe', 9.4, 'Unity.exe -projectpath C:\\Users\\p\\git\\lands-of-old'), p(22508, 27424, 'Unity.exe', 2.2, 'Unity.exe -batchMode -name AssetImportWorker0'),
    p(34152, 27424, 'Unity.exe', 1.9), ...[1, 2, 3].map(n => p(60 + n, 1, 'claude.exe', 0.7)), p(70, 1, 'ChatGPT.exe', 1.5), p(71, 1, 'Discord.exe', 0.6)]
  free = 3.3 * GiB
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('3.3 GB available; Unity needs about 6.0 GB. Biggest: lands-of-old editor 13.5 GB, claude 2.1 GB, ChatGPT 1.5 GB.')
  expect(svc.status('A')).toMatchObject({ state: 'low-memory', lowMemory: { hard: false, neededBytes: 6 * GiB, closed: [] } })
  expect(copies.status(projects.get('A')!.path)).toBeUndefined(); expect(events).not.toContain('launch')
  const cancelled = await svc.stop('A')
  expect(cancelled.state).toBe('idle'); expect(cancelled.lowMemory).toBeUndefined(); expect(cancelled.message).toBeUndefined()
  expect((await svc.play('A', { path: projects.get('A')!.path }, { startAnyway: true })).state).toBe('playing')
  expect(svc.status('A').lowMemory).toBeUndefined()
})
it('blocks even Start anyway when Windows cannot commit the estimate', async () => {
  commit = 5 * GiB
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('commit')
  await expect(svc.play('A', { path: projects.get('A')!.path }, { startAnyway: true })).rejects.toThrow('5.0 GB left to commit')
  expect(svc.status('A')).toMatchObject({ state: 'low-memory', lowMemory: { hard: true, commitBytes: 5 * GiB } }); expect(events).not.toContain('launch')
  commit = 8 * GiB
  expect((await svc.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
})
it('learns the steady working set from the last session instead of the import peak', async () => {
  compilerErrors = true
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('compile errors')
  processes[0].workingSet = 12 * GiB; await svc.poll()
  compilerErrors = false; await svc.play('A', { path: projects.get('A')!.path })
  processes[0].workingSet = 3 * GiB; await svc.poll()
  expect(svc.status('A')).toMatchObject({ peakWorkingSet: 12 * GiB, steadyWorkingSet: 3 * GiB })
  await svc.quit('A'); await copies.settle()
  free = 4.5 * GiB
  expect((await svc.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
  processes[0].workingSet = 5 * GiB; await svc.poll(); processes[0].workingSet = 2 * GiB; await svc.poll()
  expect(svc.status('A').steadyWorkingSet).toBe(5 * GiB)
})
it('gives a copy refused for low memory the idle deadline, then deletes it', async () => {
  await svc.ensureCopy('A'); free = 3 * GiB
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('available')
  expect(copies.status(projects.get('A')!.path)?.deadline).toBe(clock + 10 * 60000)
  clock += 10 * 60000; await svc.poll(); await copies.settle()
  expect(copies.status(projects.get('A')!.path)).toBeUndefined()
})
it('groups a Unity editor\'s children under its project and other programs by name', () => {
  expect(biggestConsumers([{ pid: 1, ppid: 0, name: 'Unity.exe', command: 'Unity.exe -projectPath "D:/w/Game/"', workingSet: 2 }, { pid: 2, ppid: 1, name: 'dotnet.exe', command: 'dotnet VBCSCompiler.dll', workingSet: 1 },
    { pid: 3, ppid: 0, name: 'Code.exe', command: '', workingSet: 1 }, { pid: 4, ppid: 0, name: 'code.exe', command: '', workingSet: 1 }, { pid: 5, ppid: 0, name: 'x', command: '', workingSet: 0 }], 5))
    .toEqual([{ name: 'Game editor', bytes: 3 }, { name: 'Code', bytes: 2 }])
})
it('reports missing editors and compile errors with a warm error deadline', async () => {
  installed = false
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('Install Unity')
  expect(svc.status('A').state).toBe('missing-editor')
  installed = true; compilerErrors = true
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('compile errors')
  expect(svc.status('A')).toMatchObject({ state: 'compile-errors', deadline: clock + 10 * 60000 })
})
it('surfaces blocking hidden dialogs with screenshots and does not enter Play', async () => {
  dialogs = [{ hwnd: '7', pid: 1000, className: '#32770', title: 'Unity Licensing', texts: ['Sign in to activate your license'], buttons: ['Sign in'] }]
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow()
  expect(svc.status('A').state).toBe('stuck-dialog'); expect(svc.status('A').dialog?.screenshot).toBeTruthy()
  expect(events).not.toContain('editor_play')
})
it('cleans up a crash and never kills a reused PID', async () => {
  const first = await svc.play('A', { path: projects.get('A')!.path })
  processes = [{ pid: first.pid!, ppid: 0, created: '999999', command: 'OtherApp.exe' }]
  await svc.poll(); expect(svc.status('A').state).toBe('crashed')
  expect(system.killVerified).not.toHaveBeenCalled(); expect(processes[0].created).toBe('999999')
  await copies.settle(); expect(copies.status(projects.get('A')!.path)).toBeUndefined()
})
it('sweeps an orphan using PID, creation time and root before deleting the copy', async () => {
  await svc.play('A', { path: projects.get('A')!.path })
  const rec = copies.status(projects.get('A')!.path)!, file = path.join(copies.dir, rec.key, 'player.json')
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')); persisted.owner = { pid: 9999, created: '55' }; fs.writeFileSync(file, JSON.stringify(persisted))
  const recovered = service(); await recovered.start()
  expect(processes).toHaveLength(0); await copies.settle(); expect(copies.status(rec.project)).toBeUndefined()
  expect(events).toContain('eval')
})
it('keeps a stuck editor and its copy, with verified tree kills that exclude licence clients', async () => {
  await svc.play('A', { path: projects.get('A')!.path })
  const root = svc.status('A').root!, parent = processes[0]
  processes.push({ pid: 2000, ppid: parent.pid, created: '9999', command: 'ImportWorker.exe' }, { pid: 2001, ppid: parent.pid, created: '9999', command: 'Unity.Licensing.Client.exe' }, { pid: 2002, ppid: parent.pid, created: '9999', command: 'Unity.exe -projectPath "C:/other"' })
  graceful = false; killed = false
  const result = await svc.quit('A')
  expect(result.state).toBe('close-stuck'); expect(fs.existsSync(root)).toBe(true)
  expect(events).toContain('kill:2000'); expect(events).toContain(`kill:${parent.pid}`)
  expect(events).not.toContain('kill:2001'); expect(events).not.toContain('kill:2002')
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('stuck')
})
it('refuses an unverified editor using the copy and checks exact projectPath instead of a substring', async () => {
  const root = path.join(scratch, 'copy')
  processes = [{ pid: 33, ppid: 0, created: '20', command: `Unity.exe -projectPath "${root}"` }]
  const result = await closePlayerRoot(root, { pid: 33, created: '10', hidden: true }, [], system, desktop, async () => {}, 0, 0)
  expect(result.closed).toBe(false); expect(system.killVerified).not.toHaveBeenCalled()
  processes[0].command = `OtherApp.exe -note "${root}" -projectPath "${root}2"`
  expect((await closePlayerRoot(root, { pid: 33, created: '10', hidden: true }, [], system, desktop, async () => {}, 0, 0)).closed).toBe(true)
})
it('stops and starts the idle deadline on detach and closes all editors on Genio exit', async () => {
  project('B'); await svc.play('A', { path: projects.get('A')!.path }); await svc.play('B', { path: projects.get('B')!.path })
  await svc.stream('A', 1280, 720, () => {}, () => {})
  svc.input('A', { type: 'release' }); await svc.detach('A')
  expect(svc.status('A').state).toBe('stopped-warm')
  await expect(svc.stream('A', 1280, 720, () => {}, () => {})).rejects.toThrow('Play')
  await svc.shutdown(); expect(processes).toHaveLength(0)
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('exiting')
})
it('cancels a cold copy on Stop before launching or entering Play', async () => {
  let release!: () => void, started = false
  const gate = new Promise<void>(r => { release = r })
  copies = new PlayerCopies(data, { env, system: { alive: () => false, created: async () => '100' }, io: { copyFile: async (from, to) => { started = true; await gate; await fs.promises.copyFile(from, to) } } })
  svc = service()
  write(path.join(projects.get('A')!.path, 'Assets/Large.txt'), 'a'.repeat(4096))
  const playing = svc.play('A', { path: projects.get('A')!.path }); void playing.catch(() => {})
  await vi.waitFor(() => expect(started).toBe(true))
  const stopped = svc.stop('A'); release()
  await expect(playing).rejects.toThrow(/cancel/i)
  expect((await stopped).state).toBe('idle'); expect(events).not.toContain('launch')
  expect(copies.status(projects.get('A')!.path)?.lastSync?.cancelled).toBe(true)
})
it('resumes auto-refresh after a failed hot mirror and allows the next Play', async () => {
  await svc.play('A', { path: projects.get('A')!.path })
  vi.spyOn(copies, 'sync').mockRejectedValueOnce(new Error('failed file copy'))
  const at = events.length
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('failed file copy')
  expect(events.slice(at)).toContain('genio_sync_end')
  expect((await svc.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
})
it('marks legacy input view-only while still allowing video and release', async () => {
  write(path.join(projects.get('A')!.path, 'ProjectSettings/ProjectSettings.asset'), 'activeInputHandler: 0\n')
  const i = await svc.play('A', { path: projects.get('A')!.path })
  expect(i.capabilities?.input).toBe(false)
  expect(() => svc.input('A', { type: 'state', keys: ['W'], x: 0, y: 0, buttons: 0, axes: [0, 0, 0, 0, 0, 0], gamepadButtons: 0 })).toThrow('view-only')
  expect(() => svc.input('A', { type: 'release' })).not.toThrow()
  await svc.stream('A', 1280, 720, () => {}, () => {})
})
