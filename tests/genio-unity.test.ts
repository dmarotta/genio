import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertIsolatedHomes } from './support/isolated-homes.mjs'
import { engineProject } from './engine-cases'
import { unityUnitConfig, type UnityUnitConfig } from '../src/main/unity-unit'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { compareVersions, cliPinned, nunitToJUnit, parseArgs, parseNUnit, EXIT } from '../resources/unit-skills/genio/skills/unity/scripts/genio-unity.mjs'
import { acquireEditor, editorHolders, tryAcquireEditor } from '../resources/unit-skills/genio/lib/unity-editors.mjs'

const SCRIPT = path.resolve('resources/unit-skills/genio/skills/unity/scripts/genio-unity.mjs')
const FAKE_CLI = path.resolve('tests/fixtures/fake-unity-cli.mjs')
const FAKE_EDITOR = path.resolve('tests/fixtures/fake-unity-batch-editor.mjs')

describe('genio-unity arguments', () => {
  it('never takes a project path or raw editor flags', () => {
    for (const argv of [['test', '--project-path', 'C:/main'], ['test', '--world-path=C:/main'], ['compile', 'C:/main/Game'], ['import', '-projectPath', 'x'], ['build', '-batchmode']]) {
      expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ code: EXIT.forbidden }))
    }
    expect(() => parseArgs(['tset'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
    expect(() => parseArgs(['test', '--mode', 'Standalone'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
    expect(() => parseArgs(['build'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
    expect(() => parseArgs(['cmd', 'exit'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
    expect(() => parseArgs(['play', '--close', '--stop'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
    expect(parseArgs(['play', '--stop', '--keep-editor'])).toEqual({ verb: 'play', opts: { stop: true, 'keep-editor': true } })
    expect(parseArgs(['test', '--mode', 'playmode', '--filter', 'Game.Tests', '--timeout=90'])).toEqual({ verb: 'test', opts: { mode: 'PlayMode', filter: 'Game.Tests', timeout: 90 } })
  })
  it('reads cmd parameters as key=value pairs or one JSON object', () => {
    expect(parseArgs(['cmd', 'capture_game_view', 'width=1280', 'source=screen', 'flag=true'])).toEqual({ verb: 'cmd', name: 'capture_game_view', parameters: { width: 1280, source: 'screen', flag: true } })
    expect(parseArgs(['cmd', 'console', '{"tail":5}'])).toEqual({ verb: 'cmd', name: 'console', parameters: { tail: 5 } })
    expect(() => parseArgs(['cmd', 'console', 'tail'])).toThrow(expect.objectContaining({ code: EXIT.usage }))
  })
})

describe('unity CLI pinning', () => {
  it('orders prereleases and accepts only the pinned range', () => {
    expect(compareVersions('1.0.0-beta.8', '1.0.0-beta.13')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.13', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(['1.0.0-beta.13', '1.0.0-beta.20', '1.0.0', '1.4.2'].every(cliPinned)).toBe(true)
    expect(['1.0.0-beta.12', '0.9.0', '2.0.0-alpha.1', '2.0.0', 'nonsense'].some(cliPinned)).toBe(false)
  })
})

describe('NUnit reports', () => {
  const xml = '<test-run total="3" passed="1" failed="1" skipped="1" inconclusive="0" result="Failed"><test-case name="A" fullname="Game.Tests.A" result="Passed" duration="0.5"/><test-case name="B" fullname="Game.Tests.B&amp;C" result="Failed" duration="1"><failure><message><![CDATA[boom <here>\nsecond]]></message></failure></test-case><test-case name="D" fullname="D" result="Skipped"/></test-run>'
  it('reads totals and failing names', () => {
    expect(parseNUnit(xml)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, inconclusive: 0, result: 'Failed', failures: ['Game.Tests.B&C'] })
    expect(parseNUnit('<html/>')).toBeNull()
  })
  it('converts to JUnit for the raw fallback', () => {
    const junit = nunitToJUnit(xml)
    expect(junit).toContain('<testsuites tests="3" failures="1" skipped="1">')
    expect(junit).toContain('<testcase classname="Game.Tests" name="B&amp;C" time="1"><failure message="boom &lt;here&gt;">boom &lt;here&gt;\nsecond</failure></testcase>')
    expect(junit).toContain('<testcase classname="Unity" name="D" time="0"><skipped/></testcase>')
  })
})

let tmp: string, world: string, worktree: string, data: string, calls: string, configFile: string, config: UnityUnitConfig
const children: ChildProcess[] = []
function git(cwd: string, args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '0' } }).trim() }
const writeConfig = (over: Partial<UnityUnitConfig> = {}): void => { fs.writeFileSync(configFile, JSON.stringify({ ...config, ...over })) }
const callLog = (): { argv: string[]; editor?: boolean; seeded?: boolean; credentials?: boolean }[] =>
  fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const childEnv = (env: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, GENIO_UNITY_CONFIG: configFile, FAKE_UNITY_CALLS: calls, ...env }
  for (const k of Object.keys(e)) if (k.startsWith('GIT_CONFIG')) delete e[k]
  assertIsolatedHomes(e)
  return e
}

interface Run { code: number; stdout: string; stderr: string }
function unity(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise(resolve => execFile(process.execPath, [SCRIPT, ...args], { cwd: worktree, env: childEnv(env), windowsHide: true }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr })
  }))
}
const record = (r: Run): Record<string, any> => JSON.parse(r.stdout)

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unity-')))
  world = path.join(tmp, 'world'); worktree = path.join(tmp, 'wt'); data = path.join(tmp, 'data'); calls = path.join(tmp, 'calls.jsonl')
  fs.mkdirSync(path.join(world, 'Game', 'ProjectSettings'), { recursive: true }); fs.mkdirSync(path.join(world, 'Game', 'Assets'))
  fs.writeFileSync(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n')
  fs.writeFileSync(path.join(world, 'Game', 'Assets', 'Player.cs'), 'class Player {}\n')
  fs.writeFileSync(path.join(world, '.gitignore'), 'Library/\nTemp/\nLogs/\n')
  git(world, ['init', '-q', '-b', 'main']); git(world, ['config', 'user.name', 'Test']); git(world, ['config', 'user.email', 'test@example.invalid'])
  git(world, ['add', '.']); git(world, ['commit', '-qm', 'first'])
  // The player's warm Library, with editor credentials that must never be copied.
  fs.mkdirSync(path.join(world, 'Game', 'Library', 'Pipeline'), { recursive: true })
  fs.writeFileSync(path.join(world, 'Game', 'Library', 'warm'), 'cache')
  fs.writeFileSync(path.join(world, 'Game', 'Library', 'Pipeline', '.unity-pipeline-port'), '{"evalToken":"main-secret"}')
  git(world, ['worktree', 'add', '-q', worktree, '-b', 'genio/unit-a'])
  fs.mkdirSync(path.join(tmp, 'state'))
  configFile = path.join(tmp, 'state', 'unit-a.unity.json')
  config = unityUnitConfig(engineProject({ engine: 'unity', engineRoot: 'Game' }, world), { task: 'unit-a', worktree, data, taskDir: path.join(data, 'unit-a'), cli: FAKE_CLI })!
  config.editors.cap = 1
  writeConfig()
})
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) { c.kill(); await new Promise(r => c.once('exit', r)) }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('genio-unity batch runs', () => {
  it('tests only the unit copy, seeds its Library without credentials and records the run', async () => {
    const r = await unity(['test', '--mode', 'EditMode'])
    expect(r.code).toBe(EXIT.ok)
    const rec = record(r)
    const copy = path.join(worktree, 'Game')
    expect(rec).toMatchObject({ schema: 'genio.unity-run.v1', verb: 'test', exitCode: 0, verdict: 'passed', target: { kind: 'copy', path: copy }, librarySeeded: true, head: git(worktree, ['rev-parse', 'HEAD']), dirty: false, cli: { mode: 'unity-cli', version: '1.0.0-beta.13' }, license: { ok: true }, tests: { total: 2, passed: 2, failed: 0 } })
    expect(rec.librarySeed).toMatchObject({ seeded: true, bytes: 5, files: 1, method: process.platform === 'win32' ? 'robocopy' : 'fs.cp' })
    expect(rec.librarySeed.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(JSON.parse(fs.readFileSync(path.join(rec.dir, 'result.json'), 'utf8'))).toEqual(rec)
    for (const f of [rec.reports.nunit, rec.reports.junit, rec.editorLog]) expect(fs.existsSync(f)).toBe(true)
    expect(path.dirname(rec.dir)).toBe(config.runs)
    const run = callLog().find(c => c.argv[0] === 'test')!
    expect(run.argv.slice(0, 4)).toEqual(['test', copy, '--mode', 'EditMode'])
    expect(run).toMatchObject({ seeded: true, credentials: false })
    expect(run.argv).toEqual(expect.arrayContaining(['--report-format', 'nunit,junit', '--output', rec.reports.nunit, '--junit-output', rec.reports.junit, '-logFile', rec.editorLog]))
    // Never the main checkout, and the seat is free again.
    expect(JSON.stringify(callLog())).not.toContain(JSON.stringify(path.join(world, 'Game')).slice(1, -1))
    expect(editorHolders(config.editors.dir)).toEqual([])
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('keeps exit 8 for failing tests and names them; exit 0 with no tests says so', async () => {
    const failed = await unity(['test'], { FAKE_UNITY_TESTS: 'fail' })
    expect(failed.code).toBe(EXIT.testsFailed)
    expect(record(failed)).toMatchObject({ verdict: 'failed', tests: { total: 2, failed: 1, failures: ['Game.Tests.DoubleJump'] } })
    const none = await unity(['test'], { FAKE_UNITY_TESTS: 'none' })
    expect(none.code).toBe(EXIT.ok)
    expect(record(none)).toMatchObject({ verdict: 'no-tests', tests: { total: 0 } })
  })

  it('stops at the license preflight with exit 4 and starts no editor', async () => {
    for (const license of ['none', 'inactive']) {
      fs.rmSync(path.join(config.runs, 'license.json'), { force: true })
      const r = await unity(['test'], { FAKE_UNITY_LICENSE: license })
      expect(r.code).toBe(EXIT.license)
      expect(record(r)).toMatchObject({ verdict: 'refused', exitCode: 4 })
      expect(r.stderr).toContain('blocked: Unity license')
    }
    expect(callLog().some(c => c.argv[0] === 'test')).toBe(false)
    const status = await unity(['status'], { FAKE_UNITY_LICENSE: 'none' })
    expect(status.code).toBe(EXIT.license)
    expect(JSON.parse(status.stdout)).toMatchObject({ license: { ok: false }, copy: { path: path.join(worktree, 'Game'), library: false } })
    expect(status.stdout).not.toContain('secret-machine')
  })

  it('reports compile errors from the headless run as exit 6', async () => {
    const r = await unity(['compile'], { FAKE_UNITY_COMPILE: 'error' })
    expect(r.code).toBe(EXIT.failed)
    expect(record(r)).toMatchObject({ verdict: 'failed', target: { kind: 'copy' }, compileErrors: ["Assets/Player.cs(4,9): error CS0103: The name 'jumpz' does not exist"] })
    expect(callLog().find(c => c.argv[0] === 'run')!.argv.slice(0, 2)).toEqual(['run', path.join(worktree, 'Game')])
  })

  it('builds into the run folder, never the project', async () => {
    const r = await unity(['build', '--target', 'StandaloneWindows64'])
    expect(r.code).toBe(EXIT.ok)
    const rec = record(r)
    expect(fs.readFileSync(path.join(rec.dir, 'build', 'Game.exe'), 'utf8')).toBe('player')
    expect(rec.cliResult).toMatchObject({ success: true, data: { target: 'StandaloneWindows64' } })
  })

  it('falls back to the raw editor when the unity CLI is outside the pinned range', async () => {
    writeConfig({ editor: FAKE_EDITOR })
    const passed = await unity(['test', '--filter', 'Game.Tests'], { FAKE_UNITY_VERSION: '0.9.0' })
    expect(passed.code).toBe(EXIT.ok)
    const rec = record(passed)
    expect(rec).toMatchObject({ verdict: 'passed', cli: { mode: 'raw-editor', version: '0.9.0' }, tests: { total: 2 } })
    expect(fs.readFileSync(rec.reports.junit, 'utf8')).toContain('<testcase classname="Game.Tests" name="Jumps"')
    const raw = callLog().find(c => c.editor)!
    expect(raw.argv).toEqual(expect.arrayContaining(['-batchmode', '-projectPath', path.join(worktree, 'Game'), '-runTests', '-testFilter', 'Game.Tests']))
    // -runTests exits 0 with nothing run and 2 on failures: the report decides.
    expect((await unity(['test'], { FAKE_UNITY_VERSION: '0.9.0', FAKE_UNITY_TESTS: 'fail' })).code).toBe(EXIT.testsFailed)
    const none = await unity(['test'], { FAKE_UNITY_VERSION: '0.9.0', FAKE_UNITY_TESTS: 'none' })
    expect([none.code, record(none).verdict]).toEqual([0, 'no-tests'])
    writeConfig({ cli: '' , editor: FAKE_EDITOR })
    expect(record(await unity(['import'])).cli).toMatchObject({ mode: 'raw-editor', reason: 'the unity CLI was not found on this machine' })
  })
})

describe('genio-unity refusals', () => {
  it('refuses the main checkout and any path argument with exit 21', async () => {
    writeConfig({ worktree: world })
    const main = await unity(['test'])
    expect(main.code).toBe(EXIT.forbidden)
    expect(record(main)).toMatchObject({ verdict: 'refused', message: expect.stringContaining('main checkout') })
    writeConfig()
    expect((await unity(['test', world])).code).toBe(EXIT.forbidden)
    expect((await unity(['test'], { GENIO_UNITY_CONFIG: '' })).code).toBe(EXIT.forbidden)
    expect(callLog().filter(c => c.argv[0] !== '--version')).toEqual([])
  })

  it('refuses a copy an editor already holds with exit 22', async () => {
    fs.mkdirSync(path.join(worktree, 'Game', 'Library'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'Game', 'Library', 'EditorInstance.json'), JSON.stringify({ process_id: process.pid }))
    const r = await unity(['import'])
    expect(r.code).toBe(EXIT.open)
    expect(record(r).message).toContain(`pid ${process.pid}`)
  })

  it('waits for a machine-wide editor seat and gives up with exit 20', async () => {
    const held = tryAcquireEditor(config.editors.dir, { owner: 'gauntlet:other', cap: 1 })!
    const r = await unity(['test', '--wait', '1'])
    expect(r.code).toBe(EXIT.wait)
    expect(record(r)).toMatchObject({ verdict: 'refused', exitCode: 20 })
    expect(callLog().some(c => c.argv[0] === 'test')).toBe(false)
    held.release()
    expect((await unity(['test', '--wait', '1'])).code).toBe(EXIT.ok)
  })
})

describe('editor seats', () => {
  it('caps live seats, reclaims a dead owner and lets only the holder release', async () => {
    const dir = path.join(tmp, 'seats')
    const dead = spawnSync(process.execPath, ['-e', 'process.pid']).pid!
    const ghost = tryAcquireEditor(dir, { owner: 'unit:dead', cap: 1, pid: dead })!
    const a = tryAcquireEditor(dir, { owner: 'unit:a', cap: 1 })
    expect(a?.seat).toBe(1)
    expect(ghost.release()).toBe(false)
    expect(tryAcquireEditor(dir, { owner: 'unit:b', cap: 1 })).toBeNull()
    expect(await acquireEditor(dir, { owner: 'unit:b', cap: 1, waitMs: 50, pollMs: 10 })).toBeNull()
    const b = tryAcquireEditor(dir, { owner: 'unit:b', cap: 2 })
    expect(b?.seat).toBe(2)
    expect(editorHolders(dir).map(h => h.owner)).toEqual(['unit:a', 'unit:b'])
    expect(a!.release()).toBe(true)
    expect(a!.release()).toBe(false)
    expect(editorHolders(dir).map(h => h.owner)).toEqual(['unit:b'])
  })
})

describe('genio-unity play session', () => {
  let server: http.Server, port = 0
  const seen: { command: string; parameters: unknown }[] = []
  beforeEach(async () => {
    seen.length = 0
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const { command, parameters } = JSON.parse(body)
        seen.push({ command, parameters })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { command, parameters, auth: req.headers.authorization } }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>(r => server.close(() => r())))

  async function start(): Promise<{ child: ChildProcess; ready: { slot: number; project: string }; exit: Promise<number> }> {
    const child = spawn(process.execPath, [SCRIPT, 'play', '--no-open'], { cwd: worktree, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    const exit = new Promise<number>(r => child.once('exit', code => r(code ?? -1)))
    let stderr = ''
    child.stderr!.on('data', d => { stderr += d })
    const ready = await new Promise<{ slot: number; project: string }>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on('line', line => { const v = JSON.parse(line); if (v.ready) resolve(v) })
      void exit.then(code => reject(new Error(`play exited ${code}: ${stderr}`)))
    })
    // Stand in for the slot editor's Pipeline server.
    fs.mkdirSync(path.join(ready.project, 'Library', 'Pipeline'), { recursive: true })
    fs.writeFileSync(path.join(ready.project, 'Library', 'Pipeline', '.unity-pipeline-port'), JSON.stringify({ projectPath: ready.project, mode: 'editor', port, evalToken: 'slot-token' }))
    return { child, ready, exit }
  }

  it('leases a slot copy, serves cmd, console and slot compile, and releases on stop', async () => {
    const { ready, exit } = await start()
    expect(path.relative(data, ready.project).startsWith('play-pools')).toBe(true)
    expect(fs.existsSync(path.join(ready.project, 'Library', 'warm'))).toBe(true)
    const status = await unity(['cmd', 'editor_status'])
    expect(status.code).toBe(EXIT.ok)
    expect(JSON.parse(status.stdout)).toMatchObject({ success: true, data: { command: 'editor_status', auth: 'Bearer slot-token' } })
    expect((await unity(['console', '--tail', '5'])).code).toBe(EXIT.ok)
    expect(seen.at(-1)).toEqual({ command: 'console', parameters: { tail: 5 } })
    // The slot holds this worktree's HEAD, so compile uses the warm slot editor, fenced by the lease.
    const compile = await unity(['compile'])
    expect(compile.code).toBe(EXIT.ok)
    expect(record(compile)).toMatchObject({ target: { kind: 'slot', slot: ready.slot, path: ready.project }, verdict: 'passed' })
    expect(callLog().find(c => c.argv[0] === 'recompile')!.argv.slice(0, 3)).toEqual(['recompile', '--project-path', ready.project])
    expect((await unity(['compile', '--where', 'copy'])).code).toBe(EXIT.ok)
    const status2 = JSON.parse((await unity(['status'])).stdout)
    expect(status2.play).toMatchObject({ slot: ready.slot, project: ready.project })
    expect((await unity(['play', '--close'])).code).toBe(EXIT.failed)
    const stop = await unity(['play', '--stop'])
    expect(stop.code).toBe(EXIT.ok)
    expect(JSON.parse(stop.stdout)).toMatchObject({ stopped: true, slot: ready.slot, editor: 'closed' })
    expect(await exit).toBe(EXIT.ok)
    expect(fs.existsSync(config.slotFile)).toBe(false)
    expect((await new PlayPool(data, world, 'Game').state()).slots[0].owner).toBeUndefined()
    expect((await unity(['cmd', 'editor_status'])).code).toBe(EXIT.leaseLost)
    // Recovery with nothing left behind is a clean no-op.
    const close = await unity(['play', '--close'])
    expect(close.code).toBe(EXIT.ok)
    expect(close.stdout).toContain('This unit holds no Play slot or slot editor')
  }, 60_000)

  it('exits 23 for cmd and the session once the player takes the slot over', async () => {
    const { ready, exit } = await start()
    await new PlayPool(data, world, 'Game').acquire('player', process.pid, ready.slot, true)
    const r = await unity(['cmd', 'editor_status'])
    expect(r.code).toBe(EXIT.leaseLost)
    expect(r.stderr).toMatch(/lease/i)
    expect(await exit).toBe(EXIT.leaseLost)
    expect(seen).toEqual([])
  }, 60_000)
})
