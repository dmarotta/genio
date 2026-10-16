import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isLink } from '../resources/unit-skills/genio/lib/node-deps.mjs'
import { createDepsWatch, depsPreToolHook, installCommand, startWorktreeDeps, sweepWorktrees, removeTreeSafely, type SweepUnit } from '../src/main/worktree-deps'
import { renderBrief } from '../src/main/brief'

let tmp: string, main: string, root: string
const junction = (target: string, link: string): void => fs.symlinkSync(target, link, 'junction')
const write = (file: string, text = 'x'): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const unitDir = (id: string): string => path.join(root, 'genio', id)
/** A unit worktree folder whose node_modules is a junction to main's. */
const linked = (id: string): string => { fs.mkdirSync(unitDir(id), { recursive: true }); junction(path.join(main, 'node_modules'), path.join(unitDir(id), 'node_modules')); return unitDir(id) }
const unit = (id: string, patch: Partial<SweepUnit> = {}): SweepUnit => ({ id, worktree: unitDir(id), live: false, state: 'working', ...patch })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-worktree-deps-'))
  main = path.join(tmp, 'main')
  root = path.join(tmp, 'home', 'worktrees')
  write(path.join(main, 'node_modules', 'three', 'package.json'), '{}')
  write(path.join(main, 'node_modules', '.bin', 'tsc.cmd'))
})
afterEach(async () => { vi.restoreAllMocks(); await removeTreeSafely(tmp) })

describe('startup and despawn sweep', () => {
  const sweep = (units: SweepUnit[], registered: (folder: string) => boolean | undefined = () => true, extra = {}) => {
    const notify = vi.fn(), log = vi.fn()
    return { notify, log, run: sweepWorktrees({ roots: [root], units, registered: async f => registered(f), notify, log, setup: 'C:/genio/npm-guard.mjs', ...extra }) }
  }

  it('removes links in idle and leftover folders, the link only, and tells a live unit instead', async () => {
    linked('idle'); linked('leftover'); linked('live')
    write(path.join(unitDir('real'), 'node_modules', 'own', 'package.json'))
    const { notify, log, run } = sweep([unit('idle'), unit('live', { live: true }), unit('real')])
    const r = await run
    expect(r.removedLinks.map(l => path.basename(path.dirname(l.path))).sort()).toEqual(['idle', 'leftover'])
    expect(r.removedLinks.every(l => l.targetIntact)).toBe(true)
    expect(isLink(path.join(unitDir('live'), 'node_modules'))).toBe(true)
    expect(fs.existsSync(path.join(unitDir('real'), 'node_modules', 'own', 'package.json'))).toBe(true)
    expect(fs.existsSync(path.join(main, 'node_modules', 'three', 'package.json'))).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('live', expect.stringContaining('cmd /c rmdir'))
    expect(notify.mock.calls[0][1]).toContain('node "C:/genio/npm-guard.mjs" setup')
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'deps.link-removed', removed: true }))
  })

  it('tells a live unit once per session', async () => {
    linked('live')
    const told = new Set<string>()
    const first = sweep([unit('live', { live: true })], undefined, { told })
    await first.run
    const second = sweep([unit('live', { live: true })], undefined, { told })
    await second.run
    expect(first.notify).toHaveBeenCalledTimes(1)
    expect(second.notify).not.toHaveBeenCalled()
  })

  it('deletes an unregistered folder only for a unit despawned as landed; lists the rest untouched', async () => {
    for (const id of ['landed', 'forced', 'nobody', 'working', 'registered']) write(path.join(unitDir(id), 'src', 'a.ts'))
    linked('landed-linked')
    const units = [
      unit('landed', { state: 'cleaned', stateReason: 'despawned: landed (merged)' }),
      unit('landed-linked', { state: 'cleaned', stateReason: 'despawned: landed (ancestor)' }),
      unit('forced', { state: 'cleaned', stateReason: 'despawned: forced by the player' }),
      unit('working'), unit('registered', { state: 'cleaned', stateReason: 'despawned: landed (merged)' })
    ]
    const { run } = sweep(units, f => path.basename(f) === 'registered')
    const r = await run
    expect(r.removedFolders.map(f => path.basename(f)).sort()).toEqual(['landed', 'landed-linked'])
    expect(r.untouched.map(u => [path.basename(u.folder), u.reason])).toEqual(expect.arrayContaining([
      ['forced', expect.stringContaining('without a landed verdict')], ['nobody', 'no unit record owns it'], ['working', 'its unit is working']
    ]))
    for (const id of ['forced', 'nobody', 'working', 'registered']) expect(fs.existsSync(path.join(unitDir(id), 'src', 'a.ts'))).toBe(true)
    expect(fs.existsSync(path.join(main, 'node_modules', 'three', 'package.json'))).toBe(true)
  })

  it('leaves every folder of an unregistered project alone', async () => {
    write(path.join(unitDir('x'), 'a.ts'))
    const r = await sweep([unit('x', { state: 'cleaned', stateReason: 'despawned: landed (merged)' })], () => undefined).run
    expect(r.untouched).toEqual([{ folder: unitDir('x'), reason: 'its project is not registered' }])
    expect(fs.existsSync(path.join(unitDir('x'), 'a.ts'))).toBe(true)
  })
})

describe('background setup at launch', () => {
  it('writes installing then ready to deps.json and visible status notes; runs once per worktree', async () => {
    const wt = unitDir('fresh')
    write(path.join(wt, 'package.json'), '{}')
    write(path.join(wt, 'package-lock.json'), '{"a":1}')
    const stateFile = path.join(tmp, 'deps.json'), statusFile = path.join(tmp, 'unit.status')
    let release!: () => void
    const install = vi.fn(() => new Promise<{ code: number }>(resolve => { release = () => resolve({ code: 0 }) }))
    const job = startWorktreeDeps({ worktree: wt, main, stateFile, statusFile, install })!
    expect(startWorktreeDeps({ worktree: wt, main, stateFile, statusFile, install })).toBe(job)
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ state: 'installing', pid: process.pid })
    release()
    expect(await job).toMatchObject({ state: 'ready', method: 'npm ci' })
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toMatchObject({ state: 'ready', by: 'genio' })
    const status = fs.readFileSync(statusFile, 'utf8')
    expect(status).toMatch(/^note \[key=deps\].*setting up this worktree's own node_modules/m)
    expect(status).toMatch(/^note \[key=deps\].*node_modules ready \(npm ci/m)
  })

  it('does nothing without a package.json or with a real node_modules already there', () => {
    const wt = unitDir('plain')
    fs.mkdirSync(wt, { recursive: true })
    const opts = { worktree: wt, main, stateFile: path.join(tmp, 'd.json'), statusFile: path.join(tmp, 's') }
    expect(startWorktreeDeps(opts)).toBeUndefined()
    write(path.join(wt, 'package.json'), '{}')
    fs.mkdirSync(path.join(wt, 'node_modules'))
    expect(startWorktreeDeps(opts)).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'))).toMatchObject({ state: 'ready', method: 'existing' })
  })
})

describe('process watch note', () => {
  it('recognises package-manager installs in process command lines', () => {
    expect(installCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" ci')).toBe('npm ci')
    expect(installCommand('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npm install --prefer-offline"')).toBe('npm install')
    expect(installCommand('node C:/x/npm-cli.js run test')).toBeUndefined()
    expect(installCommand('node server.js')).toBeUndefined()
  })

  it('notes a linked worktree once and each install a unit starts through it', async () => {
    const wt = linked('busy')
    const statusFile = path.join(tmp, 'busy.status')
    const list = vi.fn(async () => [
      { pid: 10, ppid: 1, created: '1', command: 'claude' },
      { pid: 11, ppid: 10, created: '2', command: 'cmd.exe /d /s /c "npm ci"' },
      { pid: 12, ppid: 11, created: '3', command: 'node C:/nodejs/node_modules/npm/bin/npm-cli.js ci' },
      { pid: 20, ppid: 1, created: '4', command: 'node C:/nodejs/node_modules/npm/bin/npm-cli.js ci' }
    ])
    const watch = createDepsWatch('C:/genio/npm-guard.mjs', list)
    const notify = vi.fn()
    await watch.poll([{ id: 'busy', worktree: wt, pid: 10, statusFile }, { id: 'clean', worktree: unitDir('none'), pid: 30, statusFile }], notify)
    await watch.poll([{ id: 'busy', worktree: wt, pid: 10, statusFile }], notify)
    const notes = fs.readFileSync(statusFile, 'utf8').trim().split('\n')
    expect(notes.filter(l => l.includes('in this worktree is a link'))).toHaveLength(1)
    expect(notes.filter(l => l.includes('(PID 11)'))).toHaveLength(1)
    expect(notes.filter(l => l.includes('(PID 12)'))).toHaveLength(1)
    expect(notes.some(l => l.includes('PID 20'))).toBe(false) // not the unit's process
    expect(notify.mock.calls.every(([id]) => id === 'busy')).toBe(true)
    expect(notify).toHaveBeenCalledTimes(3)
  })

  it('lists no processes while no unit has a linked node_modules', async () => {
    const list = vi.fn(async () => [])
    write(path.join(unitDir('ok'), 'node_modules', 'a', 'package.json'))
    await createDepsWatch(undefined, list).poll([{ id: 'ok', worktree: unitDir('ok'), pid: 5, statusFile: path.join(tmp, 's') }], vi.fn())
    expect(list).not.toHaveBeenCalled()
  })
})

describe('unit launch wiring', () => {
  it('hooks shell tools and tells the unit its node_modules is private', () => {
    expect(depsPreToolHook('C:/genio/lib/npm-guard.mjs')).toEqual({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: ['C:/genio/lib/npm-guard.mjs', '--hook'], timeout: 10 }] })
    const brief = renderBrief({ taskId: 't', kind: 'ship', project: 'genio', worktree: 'C:/w', branch: 'b', baseBranch: 'main', intent: 'x', statusFile: 'C:/s', inboxDir: 'C:/i', taskDataDir: 'C:/d',
      nodeDeps: { stateFile: 'C:\\d\\deps.json', setup: 'C:\\genio\\lib\\npm-guard.mjs' } })
    expect(brief).toContain("Genio is installing this worktree's own private `node_modules`")
    expect(brief).toContain('`C:/d/deps.json`')
    expect(brief).toContain('you may run `npm install` or `npm ci` inside this worktree')
    expect(brief).toContain('Never link, junction or move `node_modules`')
    expect(brief).toContain("never touch the main checkout's `node_modules`")
    expect(brief).toContain('node "C:/genio/lib/npm-guard.mjs" setup')
    expect(renderBrief({ taskId: 't', kind: 'ship', project: 'g', worktree: 'C:/w', branch: 'b', baseBranch: 'main', intent: 'x', statusFile: 's', inboxDir: 'i', taskDataDir: 'd' })).not.toContain('node_modules')
  })
})
