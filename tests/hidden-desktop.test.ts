import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { classifyWindow, helperExecutable, inspectDesktop, launchEditor, quoteArg, windowsCommandLine, type DesktopApi, type DesktopWindow } from '../resources/unit-skills/genio/lib/hidden-desktop.mjs'

// Fake desktop API and fake spawns only: no desktop is created and no Unity editor is launched.
let root: string, data: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-hidden-desktop-')); data = path.join(root, 'data') })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

type FakeApi = { [K in keyof DesktopApi]: Mock<DesktopApi[K]> }
function fakeApi(patch: Partial<Record<keyof DesktopApi, unknown>> = {}): FakeApi {
  return {
    available: vi.fn(() => true),
    launch: vi.fn(async () => ({ ok: true, pid: 4242, created: '134364707721328310', desktop: 'WinSta0\\genio-slot1-x', helper: 77 })),
    windows: vi.fn(async () => [] as DesktopWindow[]),
    click: vi.fn(async () => true),
    screenshot: vi.fn(async (_d: string, file: string) => { fs.writeFileSync(file, 'png'); return file }),
    close: vi.fn(async () => true),
    ...patch
  } as FakeApi
}
const dialog = (title: string, texts: string[], buttons: string[], extra: Partial<DesktopWindow> = {}): DesktopWindow => ({ hwnd: String(1000 + title.length), pid: 4242, process: 'Unity', className: '#32770', title, texts, buttons, ...extra })

describe('command line', () => {
  it('quotes arguments so the editor reads back exactly what the pool passes', () => {
    expect(quoteArg('-automated')).toBe('-automated')
    expect(quoteArg('C:\\My Games\\slot-1')).toBe('"C:\\My Games\\slot-1"')
    expect(quoteArg('C:\\with space\\')).toBe('"C:\\with space\\\\"')
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArg('')).toBe('""')
    expect(windowsCommandLine('C:\\Program Files\\Unity\\Hub\\Editor\\6000.5.1f1\\Editor\\Unity.exe', ['-automated', '-projectPath', 'D:\\a b\\slot-1']))
      .toBe('"C:\\Program Files\\Unity\\Hub\\Editor\\6000.5.1f1\\Editor\\Unity.exe" -automated -projectPath "D:\\a b\\slot-1"')
    expect(() => windowsCommandLine('C:\\bad"name.exe', [])).toThrow('Invalid')
  })

  it.runIf(process.platform === 'win32')('round-trips through the Windows argument parser', () => {
    // Node's own argv parsing follows CommandLineToArgvW; feed it our line verbatim.
    const args = ['-projectPath', 'C:\\a b\\c\\', 'x"y', 'tab\there', 'plain']
    const out = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args].map(quoteArg), { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(out)).toEqual(args)
  })
})

describe('launchEditor', () => {
  const spawnVisible = vi.fn(async () => 5151)
  beforeEach(() => spawnVisible.mockClear())
  const args = ['-automated', '-projectPath', 'C:\\slots\\slot-1']

  it('passes a PID and creation-time watchdog owner for player launches, including visible recovery', async () => {
    const api = fakeApi(), owner = { pid: 123, created: '134364707721328300' }
    const launch = await launchEditor({ file: 'Unity.exe', args, data, api, owner, visible: true, spawnVisible })
    expect(api.launch).toHaveBeenCalledWith(expect.objectContaining({ owner, visible: true }))
    expect(launch.hidden).toBe(false); expect(launch.desktop).toBeUndefined()
    expect(launch.created).toBe('134364707721328310'); expect(spawnVisible).not.toHaveBeenCalled()
  })

  it('starts the editor on a fresh hidden desktop with the same arguments and environment, and returns its identity', async () => {
    const api = fakeApi(), env = { ...process.env, GENIO_TASK_ID: 'probe' }
    const launch = await launchEditor({ file: 'C:\\Unity\\Unity.exe', args, env, cwd: root, data, label: 'slot1', api, spawnVisible })
    expect(launch).toMatchObject({ pid: 4242, created: '134364707721328310', hidden: true, desktop: 'WinSta0\\genio-slot1-x', helper: 77 })
    expect(launch.warning).toBeUndefined()
    expect(spawnVisible).not.toHaveBeenCalled()
    const call = api.launch.mock.calls[0][0]
    expect(call).toMatchObject({ command: '"C:\\Unity\\Unity.exe" -automated -projectPath C:\\slots\\slot-1', cwd: root, env })
    expect(call.name).toMatch(/^genio-slot1-[0-9a-f]{8}$/)
    expect(launch.dir).toBe(call.dir)
    expect(fs.existsSync(call.dir)).toBe(true)
  })

  it('opens visibly when the player chose visible windows', async () => {
    const api = fakeApi()
    expect(await launchEditor({ file: 'Unity.exe', args, data, visible: true, api, spawnVisible })).toEqual({ pid: 5151, created: '', hidden: false })
    expect(api.launch).not.toHaveBeenCalled()
    expect(spawnVisible).toHaveBeenCalledWith('Unity.exe', args, expect.objectContaining({ env: process.env }))
  })

  it('falls back to the visible launch with a warning when no hidden desktop can be made', async () => {
    const missing = await launchEditor({ file: 'Unity.exe', args, data, api: fakeApi({ available: () => false }), spawnVisible })
    expect(missing).toMatchObject({ pid: 5151, hidden: false, warning: expect.stringContaining('Opened the slot editor visibly') })
    const restricted = fakeApi({ launch: vi.fn(async () => ({ ok: false, stage: 'desktop', message: 'CreateDesktop failed (Win32 error 5)' })) })
    const denied = await launchEditor({ file: 'Unity.exe', args, data, api: restricted, spawnVisible })
    expect(denied).toMatchObject({ pid: 5151, hidden: false, warning: expect.stringContaining('CreateDesktop failed') })
    // The unused launch folder is removed.
    expect(fs.existsSync(restricted.launch.mock.calls[0][0].dir)).toBe(false)
    const broken = await launchEditor({ file: 'Unity.exe', args, data, api: fakeApi({ launch: vi.fn(async () => { throw new Error('could not build the hidden-desktop helper') }) }), spawnVisible })
    expect(broken.warning).toContain('could not build')
    expect(spawnVisible).toHaveBeenCalledTimes(3)
  })
})

describe('helper build', () => {
  it('compiles once per source hash and reuses the executable', async () => {
    const source = path.join(root, 'Helper.cs'); fs.writeFileSync(source, 'class A {}')
    const compile = vi.fn(async (_c: string, _s: string, out: string) => { fs.writeFileSync(out, 'exe') })
    const exe = await helperExecutable(data, { source, compiler: 'csc.exe', compile })
    expect(await helperExecutable(data, { source, compiler: 'csc.exe', compile })).toBe(exe)
    expect(compile).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(path.dirname(exe))).toEqual(['genio-desktop.exe'])
    fs.writeFileSync(source, 'class B {}')
    expect(await helperExecutable(data, { source, compiler: 'csc.exe', compile })).not.toBe(exe)
    await expect(helperExecutable(path.join(root, 'other'), { source, compiler: '', compile })).rejects.toThrow('csc.exe')
  })
})

describe('dialog rules', () => {
  it('ignores editor and progress windows, presses safe buttons, and blocks on everything else', () => {
    expect(classifyWindow({ hwnd: '1', pid: 1, className: 'UnityContainerWndClass', title: 'Game - Main - Windows - Unity 6.5' })).toMatchObject({ kind: 'ignore' })
    expect(classifyWindow(dialog('Hold on (busy for 00:12)...', ['Importing'], ['Cancel']))).toMatchObject({ kind: 'ignore', rule: 'progress' })
    expect(classifyWindow(dialog('Scene(s) Have Been Modified', ['Do you want to save the changes you made in the scenes:'], ['Save', "&Don't Save", 'Cancel']))).toEqual({ kind: 'benign', rule: 'scene-modified', button: "&Don't Save" })
    expect(classifyWindow(dialog('Enter Safe Mode?', ['The project has compilation errors.'], ['Enter Safe Mode', 'Ignore', 'Quit']))).toMatchObject({ kind: 'benign', button: 'Ignore' })
    expect(classifyWindow(dialog('API Update Required', ['This project contains scripts...'], ['I Made a Backup. Go Ahead!', 'No Thanks']))).toMatchObject({ kind: 'benign', button: 'No Thanks' })
    expect(classifyWindow(dialog('Unity', ['No valid Unity Editor license found.'], ['OK']))).toMatchObject({ kind: 'blocking', rule: 'licence', immediate: true })
    expect(classifyWindow({ hwnd: '9', pid: 9, process: 'UnityCrashHandler64', className: 'Window', title: 'Unity Bug Reporter' })).toMatchObject({ kind: 'blocking', rule: 'crash', immediate: true })
    expect(classifyWindow(dialog('Import failed', ['Failed to import package'], ['OK']))).toMatchObject({ kind: 'blocking', rule: 'import-errors', immediate: false })
    expect(classifyWindow(dialog('Scene(s) Have Been Modified', [], ['Save']))).toMatchObject({ kind: 'blocking', reason: expect.stringContaining('safe button') })
    expect(classifyWindow(dialog('Mystery', ['?'], ['OK']))).toMatchObject({ kind: 'blocking', rule: 'unknown', immediate: false })
    // An ordinary editor window mentioning a licence is not a dialog.
    expect(classifyWindow({ hwnd: '3', pid: 1, className: 'UnityContainerWndClass', title: 'License Manager' })).toMatchObject({ kind: 'ignore' })
  })
})

describe('inspectDesktop (dialog watcher)', () => {
  const launch = () => ({ desktop: 'WinSta0\\genio-slot1-x', dir: path.join(data, 'launch') })
  const events = (dir: string) => fs.readFileSync(path.join(dir, 'dialogs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))

  it('presses the safe button of a benign dialog and logs its title and text', async () => {
    const save = dialog('Scene(s) Have Been Modified', ['Do you want to save the changes you made in the scenes: Main'], ['Save', "Don't Save", 'Cancel'])
    const api = fakeApi({ windows: vi.fn(async () => [{ hwnd: '1', pid: 4242, className: 'UnityContainerWndClass', title: 'Game - Unity' }, save]) })
    const r = await inspectDesktop(api, launch(), { now: 1000 })
    expect(r).toMatchObject({ watched: true, clicked: [{ title: 'Scene(s) Have Been Modified', button: "Don't Save", rule: 'scene-modified' }] })
    expect(r.blocked).toBeUndefined()
    expect(api.click).toHaveBeenCalledWith('WinSta0\\genio-slot1-x', save.hwnd, "Don't Save")
    expect(events(launch().dir).map(e => e.event)).toEqual(['dialog', 'clicked'])
    expect(events(launch().dir)[0]).toMatchObject({ title: 'Scene(s) Have Been Modified', text: expect.stringContaining('save the changes'), buttons: ['Save', "Don't Save", 'Cancel'] })
  })

  it('blocks on an unknown dialog only once it has stayed past the grace period, with a screenshot', async () => {
    const odd = dialog('Strange question', ['Continue?'], ['Yes', 'No'])
    const api = fakeApi({ windows: vi.fn(async () => [odd]) })
    expect((await inspectDesktop(api, launch(), { now: 1000, graceMs: 10000 })).blocked).toBeUndefined()
    expect((await inspectDesktop(api, launch(), { now: 5000, graceMs: 10000 })).blocked).toBeUndefined()
    const r = await inspectDesktop(api, launch(), { now: 11000, graceMs: 10000 })
    expect(r.blocked).toMatchObject({ title: 'Strange question', text: 'Continue?', buttons: ['Yes', 'No'], rule: 'unknown', screenshot: path.join(launch().dir, 'blocked-11000.png') })
    expect(r.blocked!.message).toMatch(/blocked by an unexpected dialog on its hidden desktop: "Strange question" says "Continue\?" \[Yes \| No\]\. Screenshot: .*blocked-11000\.png\./)
    expect(r.blocked!.message).toContain('Settings › This project › Unity slots')
    expect(api.click).not.toHaveBeenCalled()
    // Logged once when first seen, then once when it blocked.
    expect(events(launch().dir).map(e => e.event)).toEqual(['dialog', 'blocked'])
  })

  it('blocks at once on licence and crash dialogs, but never while only dismissing (closing an editor)', async () => {
    const licence = dialog('Unity', ['No valid Unity Editor license found.'], ['OK'])
    const api = fakeApi({ windows: vi.fn(async () => [licence]) })
    expect((await inspectDesktop(api, launch(), { now: 1, benignOnly: true })).blocked).toBeUndefined()
    expect((await inspectDesktop(api, launch(), { now: 2 })).blocked).toMatchObject({ rule: 'licence' })
  })

  it('restarts the grace clock when a dialog goes away, and reports a gone desktop', async () => {
    const odd = dialog('Strange question', ['Continue?'], ['Yes'])
    const windows = vi.fn<() => Promise<DesktopWindow[] | null>>().mockResolvedValueOnce([odd]).mockResolvedValueOnce([]).mockResolvedValueOnce([odd]).mockResolvedValueOnce(null)
    const api = fakeApi({ windows })
    await inspectDesktop(api, launch(), { now: 0 })
    await inspectDesktop(api, launch(), { now: 9000 })
    expect((await inspectDesktop(api, launch(), { now: 12000 })).blocked).toBeUndefined()
    expect(await inspectDesktop(api, launch(), { now: 13000 })).toMatchObject({ gone: true })
    expect(await inspectDesktop(api, {}, {})).toEqual({ watched: false, clicked: [] })
  })
})
