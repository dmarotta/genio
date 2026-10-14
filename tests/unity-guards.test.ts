import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalPath, guardTool, leasedUnityRoots, rawUnityReason, recordUnityIncident } from '../resources/unit-skills/genio/lib/unity-guard.mjs'
import { poolDirectory } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { createUnityProcessWatch, installUnityShims, unitUnityAudit, unityGuardScript, unityLogAudit, unityPreToolHook, unityVerifiedKillScript, type UnityProcess, type UnityWatchRoot } from '../src/main/unity-guards'
import { unityUnitConfig, type UnityUnitConfig } from '../src/main/unity-unit'
import { genioUnityScript } from '../src/main/unitskills'
import { terminalEnv } from '../src/main/terminals'

const plugin = fileURLToPath(new URL('../resources/unit-skills/genio', import.meta.url))
let tmp: string, c: UnityUnitConfig, configFile: string, pool: string, slot: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unity-guards-'))
  const world = path.join(tmp, 'main'), worktree = path.join(tmp, 'unit')
  for (const root of [world, worktree]) fs.mkdirSync(path.join(root, 'Game'), { recursive: true })
  c = unityUnitConfig({ path: world, engine: 'unity', engineRoot: 'Game' } as any,
    { task: 'unit-a', worktree, data: path.join(tmp, 'data'), taskDir: path.join(tmp, 'task'), cli: path.join(tmp, 'cli/unity.exe') })!
  configFile = path.join(tmp, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify(c))
  pool = poolDirectory(c.play.data, c.play.world)
  slot = path.join(pool, 'slot-1', 'Game')
  fs.mkdirSync(slot, { recursive: true })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }) })

const lease = (owner = `unit:${c.task}`, expires = Date.now() + 30000, pid = 11): void => {
  fs.writeFileSync(path.join(pool, 'state.json'), JSON.stringify({ slots: [{ id: 1, lease: { owner, expires, pid, token: 'lease-token' } }] }))
}
const tool = (name: string, args: Record<string, unknown>, extra = {}): string | undefined =>
  guardTool({ tool_name: name, tool_input: args, cwd: c.worktree, ...extra }, c, { isAlive: pid => pid === 11 })

describe('Claude PreToolUse denial', () => {
  it.each(['unity test', 'Unity status', '& unity test', 'cmd /c unity test', 'powershell -Command "unity test"', 'bash -lc "unity test"', 'echo $(unity test)', 'FOO=1 unity test',
    '"C:/Unity/Editor/Unity.exe" -projectPath "C:/main"', 'Start-Process "Unity Hub.exe"',
    'node -e "spawn(\'Unity.exe\')"', 'something -batchmode', 'something -runTests', 'something -executeMethod Foo'])('denies %s even in bypass mode', command => {
    expect(tool('Bash', { command }, { permission_mode: 'bypassPermissions' })).toContain('genio-unity')
    expect(tool('PowerShell', { command }, { permission_mode: 'bypassPermissions' })).toContain('genio-unity')
  })

  it.each(['Read', 'Edit', 'Write'])('fences %s paths, including relative paths and new files', name => {
    expect(tool(name, { file_path: path.join(c.play.world, 'Assets/new.cs') })).toContain('main project')
    expect(tool(name, { file_path: '../main/Game/file.cs' })).toContain('main project')
    expect(tool(name, { file_path: path.join(c.worktree, 'Game/new.cs') })).toBeUndefined()
    expect(tool(name, { file_path: path.join(tmp, 'main-sibling/new.cs') })).toBeUndefined()
  })

  it('allows git internals only to git commands; ordinary main-copy reads stay denied', () => {
    expect(tool('Bash', { command: `git --git-dir="${c.play.world}/.git" status` })).toBeUndefined()
    expect(tool('Read', { file_path: path.join(c.play.world, '.git/config') })).toContain('main project')
    expect(tool('Bash', { command: `cat "${c.play.world}/.git/config"` })).toContain('main project')
    expect(tool('Bash', { command: `git status; cat "${c.play.world}/.git/config"` })).toContain('main project')
    expect(tool('Bash', { command: `git -C "${c.play.world}" status` })).toContain('main project')
  })

  it('resolves junctions, including new files through a linked ancestor', () => {
    fs.symlinkSync(c.play.world, path.join(c.worktree, 'linked-main'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(tool('Write', { file_path: path.join(c.worktree, 'linked-main', 'new-file.cs') })).toContain('main project')
  })

  it('allows a Pipeline descriptor only while this unit owns a live lease', () => {
    const descriptor = path.join(slot, 'Library/Pipeline/.unity-pipeline-port')
    expect(tool('Read', { file_path: descriptor })).toContain('Pipeline descriptors')
    lease()
    expect(tool('Read', { file_path: descriptor })).toBeUndefined()
    expect(tool('Read', { file_path: path.join(c.worktree, 'Game/Library/Pipeline/.unity-pipeline-port') })).toContain('Pipeline descriptors')
    lease('unit:other')
    expect(tool('Read', { file_path: descriptor })).toContain('Pipeline descriptors')
    lease(`unit:${c.task}`, Date.now() - 1)
    expect(tool('Read', { file_path: descriptor })).toContain('Pipeline descriptors')
    lease(`unit:${c.task}`, Date.now() + 30000, 99)
    expect(leasedUnityRoots(c, { isAlive: () => false })).toEqual([])
  })

  it('follows placement.json for leased copies on the project volume and rejects the old slot path', () => {
    const copies = path.join(tmp, 'project-volume', 'slots'), moved = path.join(copies, 'slot-1', 'Game')
    fs.mkdirSync(moved, { recursive: true })
    fs.writeFileSync(path.join(pool, 'placement.json'), JSON.stringify({ dir: copies }))
    lease()
    expect(leasedUnityRoots(c, { isAlive: () => true })).toEqual([canonicalPath(moved)])
    expect(tool('Read', { file_path: path.join(moved, 'Library/Pipeline/.unity-pipeline-port') })).toBeUndefined()
    expect(tool('Read', { file_path: path.join(slot, 'Library/Pipeline/.unity-pipeline-port') })).toContain('Pipeline descriptors')
  })

  it('allows the wrapper, source reads, and an engine folder named unity', () => {
    for (const command of [`node "${genioUnityScript(plugin)}" test`, 'genio-unity build --execute-method Game.Build',
      'cd unity; rg Player Assets', 'echo "Never start Unity.exe or unity test"', 'rg "-batchmode" src']) {
      expect(tool('Bash', { command })).toBeUndefined()
    }
    expect(rawUnityReason('genio-unity test; unity test')).toBeDefined()
  })
})

function runHook(command?: string, shim = false, badConfig = false): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [unityGuardScript(plugin), ...(shim ? ['--shim'] : [])],
      { cwd: c.worktree, env: { ...process.env, GENIO_UNITY_CONFIG: badConfig ? path.join(tmp, 'missing') : configFile } }, (err, _stdout, stderr) =>
        resolve({ code: err ? Number((err as any).code) : 0, stderr }))
    child.stdin!.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: c.worktree, permission_mode: 'bypassPermissions' }))
  })
}

describe('shipped hook and PATH shims', () => {
  it('returns blocking exit 2 with a reason and durable incident; valid wrapper use returns 0', async () => {
    expect(await runHook('unity test')).toMatchObject({ code: 2, stderr: expect.stringContaining('genio-unity') })
    expect(await runHook('genio-unity status')).toMatchObject({ code: 0 })
    expect(JSON.parse(fs.readFileSync(path.join(c.runs, 'guard-incidents.jsonl'), 'utf8'))).toMatchObject({ layer: 'hook' })
    expect(await runHook('unity test', false, true)).toMatchObject({ code: 2 })
    expect(await runHook(undefined)).toMatchObject({ code: 2, stderr: expect.stringContaining('Invalid PreToolUse input') })
    expect(await runHook(undefined, true)).toMatchObject({ code: 21, stderr: expect.stringContaining('genio-unity') })
  })

  it('prepends a decoy before a fake real CLI and runs the wrapper through its absolute script', async () => {
    const bin = path.join(tmp, 'unit-bin'), realBin = path.join(tmp, 'real-bin'), marker = path.join(tmp, 'real-invoked')
    fs.mkdirSync(realBin)
    fs.writeFileSync(path.join(realBin, 'unity.cmd'), `@echo off\r\necho invoked>"${marker}"\r\n`)
    fs.writeFileSync(path.join(realBin, 'unity'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    const wrapper = path.join(tmp, 'fake-wrapper.mjs')
    fs.writeFileSync(wrapper, 'console.log(JSON.stringify(process.argv.slice(2)))')
    const inherited = realBin + path.delimiter + process.env.PATH
    const env = terminalEnv({ env: { ...installUnityShims(bin, wrapper, unityGuardScript(plugin), inherited), GENIO_UNITY_CONFIG: configFile } })
    const run = (command: string) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
        { cwd: c.worktree, env, windowsVerbatimArguments: process.platform === 'win32' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code) : 0, stdout, stderr }))
    })
    expect(await run(process.platform === 'win32' ? 'Unity test' : 'unity test')).toMatchObject({ code: 21, stderr: expect.stringContaining('genio-unity') })
    expect(fs.existsSync(marker)).toBe(false)
    expect(await run('genio-unity test --filter "Some test"')).toMatchObject({ code: 0, stdout: expect.stringContaining('Some test') })
    expect(env.PATH.split(path.delimiter)[0]).toBe(bin)
    if (process.platform === 'win32') expect(terminalEnv({ env: { PATH: 'shim' } }, { Path: 'real' })).toMatchObject({ PATH: 'shim' })
    expect(unityPreToolHook(unityGuardScript(plugin))).toMatchObject({ matcher: expect.stringContaining('PowerShell'), hooks: [{ type: 'command', timeout: 10, command: 'node', args: [unityGuardScript(plugin)], onFailure: 'block' }] })
  })
})

describe('process watch (fake process snapshots only)', () => {
  const time = (ms: number): string => String(BigInt(ms) * 10000n + 116444736000000000n)
  const p = (pid: number, ppid: number, command: string, ms = 100000 + pid): UnityProcess => ({ pid, ppid, command, created: time(ms) })
  const editor = (pid: number, parent: number, project?: string) => p(pid, parent, `"C:/Hub/Editor/Unity.exe"${project ? ` -projectPath "${project}"` : ''}`)
  let snapshot: UnityProcess[], root: UnityWatchRoot, notify: ReturnType<typeof vi.fn<(task: string, message: string) => void>>, killed: number[]
  beforeEach(() => {
    snapshot = [p(10, 1, 'fake-unit', 100000)]
    root = { pid: 10, startedAt: 100000, spawnedAt: 100050, config: c, statusFile: path.join(tmp, 'status'), isLive: () => true }
    notify = vi.fn(); killed = []
  })
  const watch = () => createUnityProcessWatch({ list: async () => [...snapshot], killVerified: async process => {
    killed.push(process.pid); snapshot = snapshot.filter(p => p.pid !== process.pid); return true
  } })

  it('stops only a proven unit editor on main/foreign targets, never player editors or Toolbox', async () => {
    snapshot.push(editor(20, 10, path.join(c.play.world, 'Game')), editor(21, 1, path.join(c.play.world, 'Game')),
      p(22, 1, 'Toolbox.exe'), editor(23, 10, path.join(c.worktree, 'Game')), editor(24, 10, path.join(tmp, 'foreign')),
      p(25, 10, `"${c.cli}" test`), editor(26, 10), p(27, 10, '"C:/WindowsApps/UnityCLI/unity.exe" run copy'))
    await watch().poll([root], notify)
    expect(killed).toEqual([20, 24, 26])
    expect(notify).toHaveBeenCalledTimes(3)
    expect(fs.readFileSync(root.statusFile, 'utf8')).toContain('note [key=unity-guard]')
    expect(unitUnityAudit(configFile, '')).toHaveLength(3)
  })

  it('allows only this unit\'s live leased slot; takeover stops its editor but leaves unrelated editors alone', async () => {
    snapshot.push(p(11, 10, 'play-helper'), editor(20, 11, slot), editor(21, 1, slot))
    lease()
    const watcher = watch()
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
    lease('unit:other')
    await watcher.poll([root], notify)
    expect(killed).toEqual([20])
  })

  it('leaves wrapper-recorded pool editors alone after keep/release or handoff to a player lease', async () => {
    snapshot.push(p(11, 10, 'play-helper'), editor(20, 11, slot))
    lease()
    const watcher = watch()
    await watcher.poll([root], notify)
    const managed = { id: 1, editor: { pid: 20, owner: `unit:${c.task}`, at: 100050 } }
    fs.writeFileSync(path.join(pool, 'state.json'), JSON.stringify({ slots: [managed] }))
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
    fs.writeFileSync(path.join(pool, 'state.json'), JSON.stringify({ slots: [{ ...managed, lease: { owner: 'player', pid: 11, expires: Date.now() + 30000 } }] }))
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
    fs.writeFileSync(path.join(pool, 'state.json'), '{')
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
    fs.writeFileSync(path.join(pool, 'state.json'), JSON.stringify({ slots: [managed] }))
    // A stale recorded PID does not protect a new unit editor that reused that PID.
    snapshot = [p(10, 1, 'unit', 100000), p(20, 10, `"C:/Hub/Editor/Unity.exe" -projectPath "${slot}"`, 100100)]
    await watcher.poll([root], notify)
    expect(killed).toEqual([20])
  })

  it('also protects live leases and retained pool editors at the placed slot location', async () => {
    const copies = path.join(tmp, 'project-volume', 'slots'), moved = path.join(copies, 'slot-1', 'Game')
    fs.mkdirSync(moved, { recursive: true })
    fs.writeFileSync(path.join(pool, 'placement.json'), JSON.stringify({ dir: copies }))
    snapshot.push(p(11, 10, 'helper'), editor(20, 11, moved))
    lease()
    const watcher = watch()
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
    fs.writeFileSync(path.join(pool, 'state.json'), JSON.stringify({ slots: [{ id: 1, editor: { pid: 20, owner: `unit:${c.task}`, at: 100050 } }] }))
    await watcher.poll([root], notify)
    expect(killed).toEqual([])
  })

  it('remembers observed detached children after parents exit but never infers ownership from project paths', async () => {
    snapshot.push(p(11, 10, 'helper'), editor(20, 11, path.join(c.worktree, 'Game')))
    const watcher = watch()
    await watcher.poll([root], notify)
    snapshot = [editor(20, 1, path.join(c.play.world, 'Game')), editor(21, 1, path.join(c.worktree, 'Game'))]
    await watcher.poll([], notify)
    expect(killed).toEqual([20])
  })

  it('rejects stale root identities, reused descendants, children older than parents, and missing birth times', async () => {
    snapshot = [p(10, 1, 'unrelated', 200000), editor(20, 10, path.join(c.play.world, 'Game'))]
    await watch().poll([root], notify)
    expect(killed).toEqual([])
    snapshot = [p(10, 1, 'unit', 100000), editor(20, 10, c.play.world)]
    await watch().poll([{ ...root, isLive: () => false }], notify)
    expect(killed).toEqual([])
    snapshot = [p(10, 1, 'unit', 100000), p(11, 10, 'child', 99999), { ...editor(20, 11, c.play.world), created: '' }]
    await watch().poll([root], notify)
    expect(killed).toEqual([])
    snapshot = [p(10, 1, 'unit', 100000), editor(20, 10, path.join(c.worktree, 'Game'))]
    const watcher = watch()
    await watcher.poll([root], notify)
    snapshot = [p(20, 1, `"C:/Hub/Editor/Unity.exe" -projectPath "${c.play.world}"`, 300000)]
    await watcher.poll([], notify)
    expect(killed).toEqual([])
  })

  it('rechecks identity before kill, stops safely during an in-flight poll, and never calls a tree kill', async () => {
    const initial = [...snapshot, editor(20, 10, c.play.world)]
    const system = { list: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue([{ ...initial[1], created: time(300000) }]), killVerified: vi.fn() }
    await createUnityProcessWatch(system).poll([root], notify)
    expect(system.killVerified).not.toHaveBeenCalled()
    let release!: (value: UnityProcess[]) => void
    const waiting = new Promise<UnityProcess[]>(r => { release = r })
    const pausedSystem = { list: () => waiting, killVerified: vi.fn() }
    const watcher = createUnityProcessWatch(pausedSystem), pending = watcher.poll([root], notify)
    watcher.stop(); release(initial); await pending
    expect(pausedSystem.killVerified).not.toHaveBeenCalled()
  })

  it('uses the actual spawn window even when launching the terminal takes several seconds', async () => {
    snapshot = [p(10, 1, 'unit', 104000), p(20, 10, `"C:/Hub/Editor/Unity.exe" -projectPath "${c.play.world}"`, 104100)]
    await watch().poll([{ ...root, spawnedAt: 105000 }], notify)
    expect(killed).toEqual([20])
  })

  it.skipIf(process.platform !== 'win32')('the Windows kill code uses a fake process handle and compares at CIM precision without losing 64-bit digits', async () => {
    const expected = '134053085894173390'
    const identity = { pid: 999, ppid: 10, created: expected, command: 'Unity.exe' }
    const fake = async (start: string): Promise<string> => {
      // Overrides Get-Process locally. No real process lookup or termination is performed.
      const prefix = `function Get-Process { param([int]$Id); $fake=[pscustomobject]@{Handle=123; StartTime=[DateTime]::FromFileTimeUtc([long]'${start}')}; $fake | Add-Member -MemberType ScriptMethod -Name Kill -Value { }; return $fake }; `
      const script = prefix + unityVerifiedKillScript(identity)
      return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())))
    }
    expect(await fake(expected)).toBe('killed')
    expect(await fake(String(BigInt(expected) + 7n))).toBe('killed')
    expect(await fake(String(BigInt(expected) + 10n))).toBe('')
    expect(() => unityVerifiedKillScript({ ...identity, created: "1'; exit" })).toThrow('Invalid process identity')
  })
})

describe('Gauntlet evidence audit', () => {
  it('finds raw invocations while ignoring brief wording, JSON wrapper results and legitimate wrapper commands', () => {
    const log = ['Never start Unity.exe, Unity Hub or the unity CLI yourself.', 'Use genio-unity for Unity actions.',
      'node "C:/skills/genio-unity.mjs" test', '{"command":["Unity.exe","-batchmode"]}',
      '$ unity test', 'PS C:/copy> & "C:/Hub/Editor/Unity.exe" -runTests', '● Bash(unity test)', 'PowerShell: unity status'].join('\n')
    expect(unityLogAudit(log)).toHaveLength(3)
  })

  it('does not repeat old evidence after a fix round; new identical attempts and trimmed logs are audited', () => {
    recordUnityIncident(c, { layer: 'shim', reason: 'Use genio-unity' })
    expect(unitUnityAudit(configFile, '$ unity test')).toHaveLength(2)
    expect(unitUnityAudit(configFile, '$ unity test')).toEqual([])
    expect(unitUnityAudit(configFile, '$ unity test\n$ unity test')).toHaveLength(1)
    expect(unitUnityAudit(configFile, '$ Unity status')).toHaveLength(1)
    recordUnityIncident(c, { layer: 'watch', reason: 'An incident after the audit but before validation ends' })
    expect(unitUnityAudit(configFile, '$ Unity status')).toHaveLength(1)
    expect(unitUnityAudit(path.join(tmp, 'missing'), '$ unity test')).toHaveLength(1)
  })

  it('leaves a record still being appended for the next audit', () => {
    fs.mkdirSync(c.runs, { recursive: true })
    const file = path.join(c.runs, 'guard-incidents.jsonl')
    const incident = JSON.stringify({ schema: 'genio.unity-guard.v1', layer: 'watch', reason: 'Use genio-unity' })
    fs.writeFileSync(file, incident.slice(0, 20))
    expect(unitUnityAudit(configFile, '')).toEqual([])
    fs.appendFileSync(file, incident.slice(20) + '\n')
    expect(unitUnityAudit(configFile, '')).toHaveLength(1)
    expect(unitUnityAudit(configFile, '')).toEqual([])
  })
})
