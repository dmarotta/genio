import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppCtx } from '../src/main/services'
import { PlayerInstanceService, type PlayerInstanceOptions, type PlayerRuntime, type RuntimeGpu } from '../src/main/player-instance'
import type { GpuDevice, TextureApi } from '../src/main/shared-texture'
import { biggestConsumers, closePlayerRoot, type MemoryProcess, type PlayerProcess, type PlayerSystem } from '../src/main/player-process'
import { PlayerCopies, PLAYER_COPY_CLEANUP_INTERVAL_MS, PLAYER_COPY_MAX_AGE_MS } from '../resources/unit-skills/genio/lib/player-copy.mjs'
import type { DesktopApi, DesktopWindow } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'
import { sourceLeases, sourceRemoved, yieldSource } from '../src/main/source-leases'
import { playStarts, waitForQuiet } from '../resources/unit-skills/genio/lib/quiet-start.mjs'

// Real mirrors in disposable repositories; every process, desktop and Pipeline action is fake.
// Real git and file copies are slow under a loaded full-suite run.
vi.setConfig({ testTimeout: 30000 })
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true }).trim()
const write = (file: string, bytes: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
let scratch: string, data: string, clock: number, free: number, processes: PlayerProcess[], nextPid: number
let system: PlayerSystem, desktop: DesktopApi, copies: PlayerCopies, svc: PlayerInstanceService, ctx: AppCtx
let projects: Map<string, { path: string; engine: string }>, events: string[], modes: Map<string, string>, dialogs: DesktopWindow[]
let graceful: boolean, killed: boolean, compilerErrors: boolean, installed: boolean
let commit: number | undefined, usage: MemoryProcess[], slots: { label: string; close(): Promise<unknown> }[]
/** Test hooks: just before Unity starts, and on every Pipeline command. */
let beforeLaunch: (() => void) | undefined, onCommand: ((command: string) => void) | undefined
/** The fast-path hooks the service gave the last runtime it made. */
let runtimeGpu: RuntimeGpu | undefined
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
function service(extra: Partial<PlayerInstanceOptions> = {}) {
  const r = new PlayerInstanceService(ctx, { copies, system, desktop, ownerCreated: async () => '100', executable: () => { beforeLaunch?.(); return installed ? 'FakeUnity.exe' : undefined }, graceMs: 500, forceMs: 500, readyMs: 2000, idleSlots: async () => slots,
    runtime: (root, _pid, gpu) => (runtimeGpu = gpu, {
      async request(command: string, parameters?: object) {
        events.push(command)
        onCommand?.(command)
        if (command === 'editor_play') modes.set(root, 'playing')
        if (command === 'editor_stop') modes.set(root, 'stopped')
        // Pipeline's editor_pause toggles, and does nothing outside Play.
        if (command === 'editor_pause' && modes.get(root) === 'playing') modes.set(root, 'paused')
        else if (command === 'editor_pause' && modes.get(root) === 'paused') modes.set(root, 'playing')
        if (command === 'genio_step' && modes.get(root) !== 'paused') throw new Error('Pause Play Mode first')
        if (command === 'open_scene') { if (modes.get(root) === 'playing' || modes.get(root) === 'paused') throw new Error('open_scene refuses while playing'); events.push(`open:${(parameters as { path: string }).path}`) }
        if (command === 'get_build_settings') return { scenes: [{ path: 'Assets/Scenes/Menu.unity', enabled: true }, { path: 'Assets/Scenes/Arena.unity', enabled: false }] }
        if (command === 'list_open_scenes') return { scenes: [{ name: 'Arena', path: 'Assets/Scenes/Arena.unity', isActive: true }] }
        if (command === 'editor_status') return { playMode: modes.get(root) ?? 'stopped', compiling: false, domainReloadInProgress: false }
        if (command === 'console') return { entries: compilerErrors ? [{ message: 'error CS1002: ; expected', level: 'Error' }] : [] }
        if (command === 'eval' && (parameters as { code?: string })?.code?.includes('scriptCompilationFailed')) return { success: true, result: compilerErrors }
        if (command === 'eval' && graceful) processes = processes.filter(p => !p.command.includes(root))
        if (command === 'eval') events.push(`quit-version:${fs.readFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').trim()}`)
        return parameters ?? {}
      },
      async stream() { events.push('stream') }, async resize(width: number, height: number) { events.push(`resize:${width}x${height}`) },
      stopStream() { events.push('stream-stop') }, input() { events.push('input') }
    }) as PlayerRuntime,
    ...extra
  })
  services.push(r); return r
}
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-instance-')); data = path.join(scratch, 'data')
  clock = Date.now(); free = 20 * 2 ** 30; processes = []; nextPid = 1000; projects = new Map(); events = []; modes = new Map(); dialogs = []
  graceful = true; killed = true; compilerErrors = false; installed = true; commit = undefined; usage = []; slots = []; beforeLaunch = undefined; onCommand = undefined
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
  copies = new PlayerCopies(data, { env, statfs: async () => ({ bavail: 100n * BigInt(GiB), bsize: 1n, blocks: 200n * BigInt(GiB) }), system: { alive: pid => pid === process.pid || processes.some(p => p.pid === pid), created: async pid => pid === process.pid ? '100' : processes.find(p => p.pid === pid)?.created ?? '' } })
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
  expect(stopped.state).toBe('ready'); expect(stopped.pid).toBe(first.pid)
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
it('holds Genio\'s background copies while a Play starts and releases them once it plays', async () => {
  const phases: string[] = []
  let waiting: Promise<{ deferred: boolean; resumed: string }> | undefined
  const seen = () => { for (const s of playStarts(data)) if (phases.at(-1) !== s.phase) phases.push(s.phase!) }
  beforeLaunch = () => { seen(); waiting ??= waitForQuiet(data, { pollMs: 60_000 }) }
  onCommand = command => { if (command === 'editor_status' || command === 'editor_play') seen() }
  const playing = await svc.play('A', { path: projects.get('A')!.path })
  expect(playing.state).toBe('playing')
  expect(phases).toEqual(['copying', 'starting', 'entering-play'])
  expect(playStarts(data)).toEqual([])
  expect(await waiting).toMatchObject({ deferred: true, resumed: 'quiet' })
  // A warm editor syncing for the next Play holds them again, then releases.
  phases.length = 0
  await svc.stop('A'); await svc.play('A', { path: projects.get('A')!.path })
  expect(phases).toContain('entering-play'); expect(playStarts(data)).toEqual([])
})
it('a failed or refused start releases the hold, so nothing waits on it', async () => {
  let waiting: Promise<{ deferred: boolean; resumed: string }> | undefined
  installed = false
  beforeLaunch = () => { waiting ??= waitForQuiet(data, { pollMs: 60_000 }) }
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('Install Unity')
  expect(svc.status('A').state).toBe('missing-editor')
  expect(await waiting).toMatchObject({ deferred: true, resumed: 'quiet' })
  installed = true; waiting = undefined
  onCommand = command => { if (command === 'editor_status') processes = [] }
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('exited while starting')
  expect(svc.status('A').state).toBe('error')
  expect(await waiting).toMatchObject({ deferred: true, resumed: 'quiet' })
  expect(playStarts(data)).toEqual([])
})
it('shows the start phase from Unity\'s log, asks Pipeline only once loading completed, and stamps each phase', async () => {
  svc = service({ readyMs: 10 * 60000 })
  const root = projects.get('A')!.path, logFile = path.join(copies.dir, copies.keyOf(root), 'editor.log')
  const excerpt = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures/play-start', name), 'utf8').split(/\r?\n/)
  let pending: string[] = [], seen: { phase: string; since: number }[] = [], early = 0, hold = 0
  // Each phase takes a while after its first line; UPM's resolve, silent in the log, the longest.
  const feed = (n: number) => {
    if (hold && hold--) return
    let k = 0
    while (k < Math.min(n, pending.length)) {
      const line = pending[k++]
      if (/^(Application\.AssetDatabase Initial Refresh|Begin MonoManager|Domain Reload Profiling|\[ScriptCompilation\]|Starting: .*bee_backend)/.test(line)) { hold = line.includes('Refresh Start') ? 3 : 1; break }
    }
    fs.appendFileSync(logFile, pending.splice(0, k).map(l => `${l}\n`).join(''))
  }
  const launch = desktop.launch
  desktop.launch = vi.fn(async options => {
    const launched = await launch(options)
    // By the first poll Unity has written its header and first domain reload; then a dozen lines a second.
    feed(pending.findIndex(l => l.startsWith('Domain Reload Profiling')) + 1)
    return launched
  })
  system.sleep = async ms => {
    clock += ms
    const s = svc.status('A')
    if (s.state === 'starting' && s.start) seen.push(s.start)
    feed(12)
  }
  onCommand = command => { if (command === 'editor_status' && !fs.readFileSync(logFile, 'utf8').includes('[Project] Loading completed')) early++ }
  const phases = () => seen.map(s => s.phase).filter((p, n, all) => p !== all[n - 1])

  // First start: no PackageCache in the copy, so unpacking shows.
  pending = excerpt('cold-editor.txt')
  expect((await svc.startUnity('A', { path: root })).state).toBe('ready')
  expect(phases()).toEqual(['opening', 'packages', 'compiling', 'loading', 'importing', 'scene'])
  expect(seen.every(s => !('bar' in s) && Number.isFinite(s.since))).toBe(true)
  expect(seen.map(s => s.since)).toEqual([...seen.map(s => s.since)].sort((a, b) => a - b))
  expect(early).toBe(0); expect(events).toContain('editor_status')
  expect(svc.status('A').start).toBeUndefined()
  expect(JSON.parse(fs.readFileSync(path.join(copies.dir, copies.keyOf(root), 'player.json'), 'utf8'))).not.toHaveProperty('startDurations')

  // The next session's second start of the kept copy, PackageCache in place: no unpacking.
  await svc.stopUnity('A')
  write(path.join(svc.status('A').copy!.root, 'Library/PackageCache/com.unity.inputsystem/package.json'), '{}')
  await svc.shutdown(); svc = service({ readyMs: 10 * 60000 })
  pending = excerpt('warm-editor.txt'); seen = []
  expect((await svc.startUnity('A', { path: root })).state).toBe('ready')
  expect(phases()).toEqual(['opening', 'compiling', 'loading', 'importing', 'scene'])
  expect(early).toBe(0)
  // The last session's log moved aside, so it never reads as an instant start.
  expect(fs.readFileSync(`${logFile}.prev`, 'utf8')).toContain('Loading completed in 355.907 seconds')
})
it('still finds ready through Pipeline when the log is missing or goes quiet', async () => {
  svc = service({ readyMs: 10 * 60000 })
  const root = projects.get('A')!.path, logFile = path.join(copies.dir, copies.keyOf(root), 'editor.log')
  // No log at all (the other tests): Pipeline answers on the first poll, as before.
  expect((await svc.startUnity('A', { path: root })).state).toBe('ready')
  await svc.stopUnity('A')
  // A log Genio recognises that never says "Loading completed": a background probe after 30 quiet seconds.
  const launch = desktop.launch
  desktop.launch = vi.fn(async options => { const r = await launch(options); fs.writeFileSync(logFile, 'Begin MonoManager ReloadAssembly\n'); return r })
  const asked: number[] = [], started = clock
  onCommand = command => { if (command === 'editor_status') asked.push(clock - started) }
  expect((await svc.startUnity('A', { path: root })).state).toBe('ready')
  expect(asked[0]).toBeGreaterThanOrEqual(30000)
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
it('lists no processes while no player editor is launched (the five-second poll starts two PowerShells)', async () => {
  const list = vi.spyOn(system, 'list')
  await svc.poll(); await svc.poll()
  expect(list).not.toHaveBeenCalled()
  await svc.play('A', { path: projects.get('A')!.path })
  list.mockClear()
  await svc.poll()
  expect(list).toHaveBeenCalledTimes(1)
  list.mockRestore()
})
it('quits at the idle deadline and keeps the copy', async () => {
  await svc.play('A', { path: projects.get('A')!.path }); await svc.stop('A')
  clock += 9 * 60000; await svc.poll()
  expect(svc.status('A').state).toBe('ready')
  clock += 60000; await svc.poll()
  expect(svc.status('A').state).toBe('idle'); expect(svc.status('A').pid).toBeUndefined()
  await copies.settle(); expect(copies.status(projects.get('A')!.path)?.state).toBe('ready')
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
it('retains a copy refused for low memory past the editor idle deadline', async () => {
  await svc.ensureCopy('A'); free = 3 * GiB
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('available')
  expect(copies.status(projects.get('A')!.path)?.deadline).toBeUndefined()
  clock += 10 * 60000; await svc.poll(); await copies.settle()
  expect(copies.status(projects.get('A')!.path)?.state).toBe('ready')
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
  await copies.settle(); expect(copies.status(projects.get('A')!.path)?.id).toBe(first.copy!.id)
})
it('sweeps an orphan using PID, creation time and root while retaining the copy', async () => {
  await svc.play('A', { path: projects.get('A')!.path })
  const rec = copies.status(projects.get('A')!.path)!, file = path.join(copies.dir, rec.key, 'player.json')
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')); persisted.owner = { pid: 9999, created: '55' }; fs.writeFileSync(file, JSON.stringify(persisted))
  const recovered = service(); await recovered.start()
  expect(processes).toHaveLength(0); await copies.settle(); expect(copies.status(rec.project)?.id).toBe(rec.id)
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
  expect(svc.status('A').state).toBe('ready')
  await expect(svc.stream('A', 1280, 720, () => {}, () => {})).rejects.toThrow('Play')
  await svc.shutdown(); expect(processes).toHaveLength(0)
  expect(copies.list().filter(copy => copy.state === 'ready')).toHaveLength(2)
  await expect(svc.play('A', { path: projects.get('A')!.path })).rejects.toThrow('exiting')
})
it('cancels a cold copy on Stop before launching or entering Play', async () => {
  let release!: () => void, started = false
  const gate = new Promise<void>(r => { release = r })
  copies = new PlayerCopies(data, { env, system: { alive: () => false, created: async () => '100' }, io: { copyFile: async (from, to) => { started = true; await gate; await fs.promises.copyFile(from, to) } } })
  svc = service()
  write(path.join(projects.get('A')!.path, 'Assets/Large.txt'), 'a'.repeat(4096))
  const playing = svc.play('A', { path: projects.get('A')!.path }); void playing.catch(() => {})
  await vi.waitFor(() => expect(started).toBe(true), { timeout: 20000 })
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

// Build 1: Start/Stop Unity and Enter/Exit Play are separate controls.
const source = () => ({ path: projects.get('A')!.path })
const input = { type: 'state' as const, keys: ['W'], x: 0, y: 0, buttons: 0, axes: [0, 0, 0, 0, 0, 0], gamepadButtons: 0 }
it('starts Unity into ready with an idle deadline and no Play, and a second Start is a no-op', async () => {
  const ready = await svc.startUnity('A', source())
  expect(ready).toMatchObject({ state: 'ready', deadline: clock + 10 * 60000 }); expect(ready.pid).toBeTruthy()
  expect(events).toContain('launch'); expect(events).not.toContain('editor_play')
  const at = events.length
  expect((await svc.startUnity('A', source())).pid).toBe(ready.pid); expect(events.slice(at)).toEqual([])
  await expect(svc.stream('A', 1280, 720, () => {}, () => {})).rejects.toThrow('Play')
  expect(() => svc.input('A', input)).toThrow('not playing')
})
it("warns before Unity starts when the copy's deepest path nears 260 characters, and starts anyway", async () => {
  const world = projects.get('A')!.path
  // The main checkout's PackageCache stands in for the one the copy's first start unpacks: the same relative paths.
  // The copy folder is a random 9-hex name directly under the data folder: a stand-in of the same length.
  const root = path.join(data, '0'.repeat(9), 'A'), cache = path.join('Library', 'PackageCache', 'com.unity.visualscripting@8bed5ad90189')
  write(path.join(world, cache, 'p'.repeat(250 - root.length - cache.length - 2 - 'x.dll'.length - 1), 'x.dll'), 'dll')
  // Not Windows: no check.
  const other = service({ platform: 'linux' })
  expect((await other.startUnity('A', source())).pathWarning).toBeUndefined()
  await other.shutdown()
  const ready = await service({ platform: 'win32' }).startUnity('A', source())
  expect(path.dirname(path.dirname(ready.root!))).toBe(data)
  expect(ready).toMatchObject({ state: 'ready', pathWarning: expect.stringMatching(/^Paths in com.unity.visualscripting reach 250 characters \(\d+ for the project's folder, \d+ inside it\), close to Windows' 260 limit \(10 to spare\)/) })
  expect(events).toContain('launch')
})
it('enters Play from ready without a new editor and exits back to ready', async () => {
  const ready = await svc.startUnity('A', source())
  const playing = await svc.enterPlay('A', source())
  expect(playing).toMatchObject({ state: 'playing', pid: ready.pid }); expect(playing.deadline).toBeUndefined()
  expect(events.filter(e => e === 'launch')).toHaveLength(1)
  const exited = await svc.exitPlay('A')
  expect(exited).toMatchObject({ state: 'ready', pid: ready.pid, deadline: clock + 10 * 60000 })
})
it('enters Play from Off in one call: copies, starts Unity, then plays (D1)', async () => {
  const playing = await svc.enterPlay('A', source())
  expect(playing.state).toBe('playing')
  expect(events.indexOf('launch')).toBeLessThan(events.indexOf('editor_play'))
})
it('Stop Unity while playing exits Play, quits, and keeps the copy between sessions', async () => {
  const first = await svc.enterPlay('A', source())
  const at = events.length
  const stopped = await svc.stopUnity('A')
  expect(stopped.state).toBe('idle'); expect(stopped.pid).toBeUndefined(); expect(processes).toHaveLength(0)
  expect(events.slice(at).indexOf('editor_stop')).toBeLessThan(events.slice(at).indexOf('eval'))
  await copies.settle()
  expect(copies.status(source().path)).toMatchObject({ state: 'ready', id: first.copy!.id })
  expect(copies.status(source().path)?.deadline).toBeUndefined()
  // The next start reuses the copy: nothing to copy again.
  const again = await svc.enterPlay('A', source())
  expect(again.copy).toMatchObject({ id: first.copy!.id }); expect(again.copy!.lastSync!.bytes!.copied).toBe(0)
  expect(again.pid).not.toBe(first.pid)
})
it('keeps a copy past Stop Unity idle time', async () => {
  await svc.startUnity('A', source()); await svc.stopUnity('A')
  clock += 9 * 60000; await svc.poll(); await copies.settle()
  expect(copies.status(source().path)?.state).toBe('ready')
  clock += 60000; await svc.poll(); await copies.settle()
  expect(copies.status(source().path)?.state).toBe('ready')
})
it('keeps the copy on Genio exit and with a zero idle time', async () => {
  await svc.startUnity('A', source()); await svc.stopUnity('A')
  await svc.shutdown(); await copies.settle()
  expect(copies.status(source().path)?.state).toBe('ready')
  const next = service(); await next.configure('A', { idleMinutes: 0 })
  await next.enterPlay('A', source()); await next.stopUnity('A'); await copies.settle()
  expect(copies.status(source().path)?.state).toBe('ready')
})
it('closing the project window retains its copy; only explicit Delete copy deletes it', async () => {
  const first = await svc.enterPlay('A', source())
  await svc.quit('A'); await copies.settle()
  expect(processes).toHaveLength(0)
  expect(copies.status(source().path)?.id).toBe(first.copy!.id)
  await svc.enterPlay('A', source())
  await svc.deleteCopy('A'); await copies.settle()
  expect(processes).toHaveLength(0)
  expect(copies.status(source().path)).toBeUndefined()
})
it('explicit Delete copy cannot remove a stuck running editor', async () => {
  const first = await svc.enterPlay('A', source())
  graceful = false; killed = false
  expect((await svc.deleteCopy('A')).deleted).toBe(false)
  await copies.settle()
  expect(svc.status('A').state).toBe('close-stuck')
  expect(copies.status(source().path)?.id).toBe(first.copy!.id)
})
it('runs cleanup at startup and hourly, protects a launch even without editor metadata, and stops the timer on exit', async () => {
  const intervals = vi.spyOn(global, 'setInterval'), clears = vi.spyOn(global, 'clearInterval')
  try {
    const old = await copies.ensure(source().path)
    await copies.playing(source().path, clock - PLAYER_COPY_MAX_AGE_MS - 1)
    await svc.start(); await svc.cleanup()
    expect(copies.status(source().path)).toBeUndefined()
    const callIndex = intervals.mock.calls.findIndex(([, ms]) => ms === PLAYER_COPY_CLEANUP_INTERVAL_MS)
    expect(callIndex).toBeGreaterThanOrEqual(0)
    const hourly = intervals.mock.calls[callIndex][0] as () => void
    const first = await svc.enterPlay('A', source())
    expect(first.copy!.id).not.toBe(old.id)
    fs.rmSync(path.join(first.root!, 'Library/EditorInstance.json'))
    clock += PLAYER_COPY_MAX_AGE_MS + 1
    hourly(); await svc.cleanup()
    expect(copies.status(source().path)?.id).toBe(first.copy!.id)
    await svc.stopUnity('A')
    hourly(); await svc.cleanup()
    expect(copies.status(source().path)).toBeUndefined()
    const cleanupTimer = intervals.mock.results[callIndex].value
    await svc.shutdown()
    expect(clears).toHaveBeenCalledWith(cleanupTimer)
  } finally { intervals.mockRestore(); clears.mockRestore() }
})
it('cancels a cold copy from the Unity button and keeps the copy', async () => {
  let release!: () => void, started = false
  const gate = new Promise<void>(r => { release = r })
  copies = new PlayerCopies(data, { env, system: { alive: () => false, created: async () => '100' }, io: { copyFile: async (from, to) => { started = true; await gate; await fs.promises.copyFile(from, to) } } })
  svc = service()
  write(path.join(source().path, 'Assets/Large.txt'), 'a'.repeat(4096))
  const starting = svc.startUnity('A', source()); void starting.catch(() => {})
  await vi.waitFor(() => expect(started).toBe(true), { timeout: 20000 })
  const cancelled = svc.stopUnity('A'); release()
  await expect(starting).rejects.toThrow(/cancel/i)
  expect((await cancelled).state).toBe('idle'); expect(events).not.toContain('launch')
  expect(copies.status(source().path)).toMatchObject({ state: 'ready' })
})
it('checks memory before copying, so a low-memory refusal copies nothing (D3 ordering)', async () => {
  free = 5 * 2 ** 30
  await expect(svc.startUnity('A', source())).rejects.toThrow('Unity needs')
  expect(svc.status('A').state).toBe('low-memory'); expect(copies.status(source().path)).toBeUndefined()
  await expect(svc.enterPlay('A', source())).rejects.toThrow('Unity needs')
  expect(copies.status(source().path)).toBeUndefined()
  expect((await svc.enterPlay('A', source(), { startAnyway: true })).state).toBe('playing')
})
it('pauses idempotently from Unity\'s playMode, keeps streaming and input while paused, and resumes', async () => {
  await svc.enterPlay('A', source())
  await svc.stream('A', 1280, 720, () => {}, () => {})
  expect((await svc.pause('A')).state).toBe('paused')
  const at = events.length
  expect((await svc.pause('A', true)).state).toBe('paused'); expect(events.slice(at)).not.toContain('editor_pause')
  await svc.stream('A', 1280, 720, () => {}, () => {})
  expect(() => svc.input('A', input)).not.toThrow()
  expect((await svc.pause('A')).state).toBe('playing')
  await expect(svc.exitPlay('A').then(() => svc.pause('A'))).rejects.toThrow('Enter Play')
})
it('steps by pausing a running Play first, then one genio_step per press', async () => {
  await svc.enterPlay('A', source())
  let at = events.length
  expect((await svc.step('A')).state).toBe('paused')
  expect(events.slice(at).filter(e => ['editor_pause', 'genio_step'].includes(e))).toEqual(['editor_pause', 'genio_step'])
  at = events.length; await svc.step('A')
  expect(events.slice(at).filter(e => ['editor_pause', 'genio_step'].includes(e))).toEqual(['genio_step'])
})
it('shows a pause or a stop made in Unity itself on the next poll', async () => {
  const root = (await svc.enterPlay('A', source())).root!
  modes.set(root, 'paused'); await svc.poll(); expect(svc.status('A').state).toBe('paused')
  modes.set(root, 'playing'); await svc.poll(); expect(svc.status('A').state).toBe('playing')
  modes.set(root, 'stopped'); await svc.poll()
  expect(svc.status('A')).toMatchObject({ state: 'ready', deadline: clock + 10 * 60000 })
})
it('lists scenes from files while Unity is off and from Pipeline while it runs, build order first', async () => {
  const root = source().path
  write(path.join(root, 'Assets/Scenes/Menu.unity'), 'scene'); write(path.join(root, 'Assets/Scenes/Arena.unity'), 'scene'); write(path.join(root, 'Assets/Zoo.unity'), 'scene')
  write(path.join(root, 'Assets/.hidden/Skip.unity'), 'scene'); write(path.join(root, 'Assets/Samples~/Skip.unity'), 'scene')
  write(path.join(root, 'ProjectSettings/EditorBuildSettings.asset'), 'EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Arena.unity\n    guid: 1\n  - enabled: 0\n    path: Assets/Scenes/Menu.unity\n    guid: 2\n')
  expect(await svc.scenes('A')).toEqual([
    { path: 'Assets/Scenes/Arena.unity', name: 'Arena', inBuild: true, enabled: true },
    { path: 'Assets/Scenes/Menu.unity', name: 'Menu', inBuild: true, enabled: false },
    { path: 'Assets/Zoo.unity', name: 'Zoo' }
  ])
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'scenes')
  await svc.startUnity('A', source())
  expect(await svc.scenes('A')).toEqual([
    { path: 'Assets/Scenes/Menu.unity', name: 'Menu', inBuild: true, enabled: true },
    { path: 'Assets/Scenes/Arena.unity', name: 'Arena', inBuild: true, enabled: false, open: true, active: true },
    { path: 'Assets/Zoo.unity', name: 'Zoo' }
  ])
})
it('remembers a scene while off, opens it when ready, and re-plays into it while playing', async () => {
  await expect(svc.setScene('A', 'Assets/../x.unity')).rejects.toThrow('Invalid scene')
  expect((await svc.setScene('A', 'Assets/Arena.unity')).scene).toBe('Assets/Arena.unity')
  await svc.enterPlay('A', source())
  expect(events.indexOf('open:Assets/Arena.unity')).toBeLessThan(events.indexOf('editor_play'))
  await svc.exitPlay('A')
  let at = events.length
  expect((await svc.setScene('A', 'Assets/Menu.unity')).state).toBe('ready')
  expect(events.slice(at)).toContain('open:Assets/Menu.unity'); expect(events.slice(at)).not.toContain('editor_play')
  await svc.enterPlay('A', source()); at = events.length
  expect((await svc.setScene('A', 'Assets/Zoo.unity')).state).toBe('playing')
  const after = events.slice(at)
  expect(after.indexOf('editor_stop')).toBeLessThan(after.indexOf('open:Assets/Zoo.unity'))
  expect(after.indexOf('open:Assets/Zoo.unity')).toBeLessThan(after.indexOf('editor_play'))
})
it('resizes the stream during Play or pause without leaving Play', async () => {
  await expect(svc.resize('A', 960, 540)).rejects.toThrow('Play')
  await svc.enterPlay('A', source()); await svc.stream('A', 1280, 720, () => {}, () => {})
  expect((await svc.resize('A', 960, 540)).state).toBe('playing')
  await svc.pause('A'); expect((await svc.resize('A', 640, 360)).state).toBe('paused')
  expect(events).toEqual(expect.arrayContaining(['resize:960x540', 'resize:640x360'])); expect(events.filter(e => e === 'editor_stop')).toHaveLength(0)
  await expect(svc.resize('A', 8, 8)).rejects.toThrow('16–1920')
})
it('retries a stuck close from the Unity button', async () => {
  await svc.startUnity('A', source())
  graceful = false; killed = false
  expect((await svc.stopUnity('A')).state).toBe('close-stuck')
  graceful = true; killed = true
  expect((await svc.stopUnity('A')).state).toBe('idle'); expect(processes).toHaveLength(0)
})

// ---- A unit's worktree merged and removed by Genio at each phase of a Play
describe('a Play source that vanishes', () => {
  const MERGED = 'This unit was merged and removed while loading. Its work is in main now.'
  let unhandled: unknown[]
  const record = (e: unknown) => { unhandled.push(e) }
  /** A unit's worktree of project A with work of its own, known to Genio as a merged Build. */
  function unit(files = 4): string {
    const main = projects.get('A')!.path, dir = path.join(scratch, 'unit-wt')
    git(main, 'worktree', 'add', '-q', '-b', 'genio/fix-jump', dir)
    for (let n = 0; n < files; n++) write(path.join(dir, `Assets/Unit/U${n}.txt`), `unit work ${n}\n`.repeat(200))
    write(path.join(dir, 'Assets/Code.cs'), '// the unit edit\n')
    const task = { id: 'u1', title: 'Fix the jump', kind: 'ship', project: 'A', worktree: dir, baseBranch: 'main', state: 'merged', landedCommit: 'abc123' }
    Object.assign(ctx, { homes: new Map([['main', { crew: { list: () => [task] } }]]) })
    return dir
  }
  /** Genio's cleanup after a merge: the worktree and its branch go. */
  function remove(dir: string): void {
    const main = projects.get('A')!.path
    try { git(main, 'worktree', 'remove', '--force', dir) } catch { /* a file still open (Windows): removed by hand below */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
    git(main, 'worktree', 'prune'); git(main, 'branch', '-D', 'genio/fix-jump')
  }
  const copyFile = (root: string, rel: string) => { try { return fs.readFileSync(path.join(root, rel), 'utf8') } catch { return undefined } }
  /** A slower copy (so a removal lands mid-copy), with a hook on each file read from the unit. */
  function slowCopies(onUnitFile?: (n: number) => void, ms = 0) {
    let n = 0
    copies = new PlayerCopies(data, { env, io: { copyFile: async (from: string, to: string) => {
      if (from.includes('unit-wt')) onUnitFile?.(++n)
      if (ms) await new Promise(r => setTimeout(r, ms))
      await fs.promises.copyFile(from, to)
    } }, system: { alive: pid => pid === process.pid || processes.some(p => p.pid === pid), created: async pid => pid === process.pid ? '100' : processes.find(p => p.pid === pid)?.created ?? '' } })
    svc = service()
  }
  beforeEach(() => { unhandled = []; process.on('unhandledRejection', record) })
  afterEach(() => { process.off('unhandledRejection', record); expect(unhandled).toEqual([]) })

  it('sync start: stops before copying anything, says so plainly, and starts no Unity', async () => {
    const dir = unit()
    const sync = copies.sync.bind(copies)
    copies.sync = (async (...args: Parameters<typeof copies.sync>) => { remove(dir); return sync(...args) }) as typeof copies.sync
    const s = await svc.enterPlay('A', { path: dir })
    expect(s).toMatchObject({ state: 'idle', message: MERGED, sourceGone: { when: 'loading', unit: 'Fix the jump', merged: true, base: 'main' } })
    expect(events).not.toContain('launch')
    expect(s.copy?.lastSync).toMatchObject({ complete: false, sourceGone: true })
  })

  it('mid-copy: a warm editor keeps the previous copy, untouched, and plays main on the next press', async () => {
    const main = projects.get('A')!.path
    slowCopies(n => { if (n === 3) remove(dir) })
    const dir = unit(12)
    const first = await svc.play('A', { path: main })
    const at = events.length
    const s = await svc.enterPlay('A', { path: dir })
    expect(s).toMatchObject({ state: 'ready', pid: first.pid, message: MERGED, source: { path: main }, sourceGone: { when: 'loading' } })
    expect(events.slice(at)).toEqual(expect.arrayContaining(['genio_sync_begin', 'genio_sync_end'])); expect(events.slice(at)).not.toContain('launch')
    // Nothing of the unit reached the copy Unity has open.
    expect(copyFile(s.root!, 'Assets/Code.cs')).toBe('// initial\n'); expect(copyFile(s.root!, 'Assets/Unit/U0.txt')).toBeUndefined()
    const again = await svc.enterPlay('A', { path: main })
    expect(again).toMatchObject({ state: 'playing', pid: first.pid }); expect(again.sourceGone).toBeUndefined()
  })

  it('mid-copy on a cold start: no Unity, the copy kept for a quick start of main', async () => {
    slowCopies(n => { if (n === 2) remove(dir) })
    const dir = unit(8)
    const s = await svc.enterPlay('A', { path: dir })
    expect(s).toMatchObject({ state: 'idle', sourceGone: { when: 'loading' } }); expect(events).not.toContain('launch')
    expect((await svc.enterPlay('A', source())).state).toBe('playing')
  })

  it('after the copy, before Unity starts: Unity and Play go on; the status notes the source is gone; controls work', async () => {
    const dir = unit()
    beforeLaunch = () => { beforeLaunch = undefined; remove(dir) }
    const s = await svc.enterPlay('A', { path: dir })
    expect(s.state).toBe('playing'); expect(copyFile(s.root!, 'Assets/Code.cs')).toBe('// the unit edit\n')
    await svc.poll()
    expect(svc.status('A').sourceGone).toMatchObject({ when: 'running', merged: true })
    expect((await svc.pause('A')).state).toBe('paused'); expect((await svc.pause('A')).state).toBe('playing')
    expect((await svc.exitPlay('A')).state).toBe('ready')
  })

  it('entering Play: the game starts anyway, and Genio\'s cleanup marks the source at once', async () => {
    const dir = unit()
    onCommand = c => { if (c === 'editor_play') { onCommand = undefined; remove(dir) } }
    const s = await svc.enterPlay('A', { path: dir })
    expect(s.state).toBe('playing')
    sourceRemoved(dir)
    expect(svc.status('A')).toMatchObject({ state: 'playing', sourceGone: { when: 'running' } })
    expect((await svc.step('A')).state).toBe('paused')
    expect((await svc.stopUnity('A')).state).toBe('idle')
  })

  it('while playing, then Restart and the next Play: both fall back to main with the message', async () => {
    const main = projects.get('A')!.path, dir = unit()
    expect((await svc.enterPlay('A', { path: dir })).state).toBe('playing')
    remove(dir); sourceRemoved(dir)
    expect(svc.status('A').sourceGone?.when).toBe('running')
    const restarted = await svc.restart('A')
    expect(restarted).toMatchObject({ state: 'playing', sourceGone: { when: 'fallback', unit: 'Fix the jump' } })
    expect(fs.realpathSync.native((restarted.source as { path: string }).path)).toBe(fs.realpathSync.native(main))
    expect(copyFile(restarted.root!, 'Assets/Code.cs')).toBe('// initial\n'); expect(copyFile(restarted.root!, 'Assets/Unit/U0.txt')).toBeUndefined()
    const replayed = await svc.enterPlay('A', { path: dir })
    expect(replayed).toMatchObject({ state: 'playing', sourceGone: { when: 'fallback' } })
    expect(await svc.sourceAvailable('A', { path: dir })).toBe(false); expect(await svc.sourceAvailable('A', { path: main })).toBe(true)
  })

  it('defers Genio\'s worktree deletion while the copy reads it, then stops the read cleanly', async () => {
    slowCopies(undefined, 40)
    const dir = unit(60)
    const playing = svc.enterPlay('A', { path: dir })
    while (!sourceLeases(dir)) await new Promise(r => setTimeout(r, 10))
    // What crew.cleanup does before removing the worktree: wait (bounded), then stop the read.
    expect(await yieldSource(dir, { waitMs: 50, abortMs: 20000 })).toBe('aborted')
    expect(fs.existsSync(dir)).toBe(true)
    expect(sourceLeases(dir)).toBe(0)
    remove(dir)
    expect(await playing).toMatchObject({ state: 'idle', message: MERGED, sourceGone: { when: 'loading' } })
  })

  it('lets a short read finish before the deletion goes ahead', async () => {
    slowCopies(undefined, 5)
    const dir = unit(4)
    const playing = svc.enterPlay('A', { path: dir })
    while (!sourceLeases(dir)) await new Promise(r => setTimeout(r, 5))
    expect(await yieldSource(dir, { waitMs: 20000, abortMs: 1000 })).toBe('finished')
    remove(dir)
    const s = await playing
    expect(s.state).toBe('playing'); expect(copyFile(s.root!, 'Assets/Code.cs')).toBe('// the unit edit\n')
  })

  it('an unexpected failure in the background poll becomes an error state with a message, never a crash', async () => {
    await svc.play('A', source()); await svc.exitPlay('A')
    desktop.windows = async () => { throw new Error('desktop service vanished') }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(svc.poll()).resolves.toBeUndefined()
    expect(svc.status('A')).toMatchObject({ state: 'error' })
    expect(svc.status('A').message).toContain('desktop service vanished')
    expect(log).toHaveBeenCalled(); log.mockRestore()
    desktop.windows = async () => dialogs
    expect((await svc.enterPlay('A', source())).state).toBe('playing')
  })
})

describe('the GPU stream\'s editor', () => {
  const NVIDIA: GpuDevice = { vendorId: 0x10de, deviceId: 0x2486, active: true }
  const textures = (gpus: GpuDevice[] = [NVIDIA], available = true): TextureApi => ({ available, gpus: async () => gpus, importTexture: () => ({ release() {} }), send: async () => {}, onGpuGone: () => () => {} })
  const commands = () => (desktop.launch as ReturnType<typeof vi.fn>).mock.calls.map(([o]) => (o as { command: string }).command)
  const d3d12Only = 'activeInputHandler: 1\nPlayerSettings:\n  m_BuildTargetGraphicsAPIs:\n  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 12000000\n    m_Automatic: 0\n'
  it('starts the Play editor on Direct3D 11 when the project and one GPU allow it, and tells the runtime', async () => {
    const s = service({ textures: textures() })
    expect((await s.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
    expect(commands()).toHaveLength(1); expect(commands()[0]).toContain('-force-d3d11')
    expect(runtimeGpu?.fast()).toBe(true); expect(runtimeGpu?.playing()).toBe(true)
    await s.pause('A'); expect(runtimeGpu?.playing()).toBe(false)
  })
  it.each([
    ['a project that needs Direct3D 12', () => write(path.join(projects.get('A')!.path, 'ProjectSettings/ProjectSettings.asset'), d3d12Only), textures()],
    ['a hybrid GPU', () => {}, textures([{ ...NVIDIA, active: false }, { vendorId: 0x8086, deviceId: 1, active: true }])],
    ['no shared textures', () => {}, textures([NVIDIA], false)]
  ])('starts the editor as today for %s', async (_name, arrange, api) => {
    arrange()
    const s = service({ textures: api })
    expect((await s.play('A', { path: projects.get('A')!.path })).state).toBe('playing')
    expect(commands()[0]).not.toContain('-force-d3d11'); expect(runtimeGpu?.fast()).toBe(false)
  })
  it('starts later editors as today after a session found the GPUs unfit', async () => {
    const s = service({ textures: textures() })
    await s.play('A', { path: projects.get('A')!.path })
    runtimeGpu!.fellBack!('gpu-mismatch')
    await s.restart('A')
    expect(commands()).toHaveLength(2); expect(commands()[1]).not.toContain('-force-d3d11')
  })
  it('keeps the warm editor for a session fallback, and restarts it when the project now needs Direct3D 12', async () => {
    const s = service({ textures: textures() }), root = projects.get('A')!.path
    await s.play('A', { path: root })
    runtimeGpu!.fellBack!('import')
    await s.stop('A'); await s.play('A', { path: root })
    expect(commands()).toHaveLength(1)
    write(path.join(root, 'ProjectSettings/ProjectSettings.asset'), d3d12Only)
    await s.stop('A')
    expect((await s.play('A', { path: root })).state).toBe('playing')
    expect(commands()).toHaveLength(2); expect(commands()[1]).not.toContain('-force-d3d11')
    expect(runtimeGpu?.fast()).toBe(false)
  })
})