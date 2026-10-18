import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkInstall, depsToolReason, genioInstallReport, isLink, linkedNodeModules, lockHash, npmGuardReason, packageCommand, removeLinkSafely, setupNodeModules, worktreeLinks
} from '../resources/unit-skills/genio/lib/node-deps.mjs'
import { installNpmShims, removeTreeSafely } from '../src/main/worktree-deps'
import { recoveryCardHtml } from '../src/main/install-health'

const lib = fileURLToPath(new URL('../resources/unit-skills/genio/lib', import.meta.url))
const guard = path.join(lib, 'npm-guard.mjs')
const win = process.platform === 'win32'
let tmp: string, main: string, worktree: string

/** A real junction on Windows (no admin needed); a directory symlink elsewhere. */
const junction = (target: string, link: string): void => fs.symlinkSync(target, link, 'junction')
const write = (file: string, text = 'x'): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
/** A small complete install: package.json, lockfile, .bin and each declared dependency. */
function project(root: string, lock = '{"lockfileVersion":3}', deps = ['left-pad']): void {
  write(path.join(root, 'package.json'), JSON.stringify({ name: path.basename(root), dependencies: Object.fromEntries(deps.map(d => [d, '1.0.0'])) }))
  write(path.join(root, 'package-lock.json'), lock)
  write(path.join(root, 'node_modules', '.bin', 'left-pad.cmd'), '@echo off')
  for (const d of deps) write(path.join(root, 'node_modules', d, 'package.json'), JSON.stringify({ name: d }))
  write(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-node-deps-'))
  main = path.join(tmp, 'git', 'genio')
  worktree = path.join(tmp, 'home', 'worktrees', 'genio', 'unit-a')
  project(main)
  write(path.join(worktree, 'package.json'), fs.readFileSync(path.join(main, 'package.json'), 'utf8'))
  write(path.join(worktree, 'package-lock.json'), fs.readFileSync(path.join(main, 'package-lock.json'), 'utf8'))
})
// Links go first, the links only, so cleanup can never reach through one.
afterEach(async () => { vi.restoreAllMocks(); await removeTreeSafely(tmp) })

describe('removing a node_modules link', () => {
  it('removes only the junction and leaves every file of its target intact (regression)', () => {
    const nm = path.join(worktree, 'node_modules')
    junction(path.join(main, 'node_modules'), nm)
    expect(isLink(nm)).toBe(true)
    const before = fs.readdirSync(path.join(main, 'node_modules')).sort()
    const r = removeLinkSafely(nm)
    expect(r).toMatchObject({ removed: true, targetIntact: true })
    expect(fs.existsSync(nm)).toBe(false)
    expect(fs.readdirSync(path.join(main, 'node_modules')).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(main, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1')
    expect(fs.existsSync(path.join(main, 'node_modules', '.bin', 'left-pad.cmd'))).toBe(true)
  })

  it('never touches a real folder', () => {
    write(path.join(worktree, 'node_modules', 'own', 'package.json'))
    expect(removeLinkSafely(path.join(worktree, 'node_modules'))).toMatchObject({ removed: false })
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'own', 'package.json'))).toBe(true)
  })

  it('removes the links inside a tree before deleting it, never the link targets', async () => {
    const leftover = path.join(tmp, 'leftover')
    write(path.join(leftover, 'src', 'a.ts'))
    junction(path.join(main, 'node_modules'), path.join(leftover, 'node_modules'))
    junction(path.join(main, 'node_modules'), path.join(leftover, 'src', 'node_modules'))
    await removeTreeSafely(leftover)
    expect(fs.existsSync(leftover)).toBe(false)
    expect(fs.existsSync(path.join(main, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
  })
})

describe('linked tree detection', () => {
  it('finds a junction at cwd or any parent, a node_modules resolving outside the worktree, and the main checkout', () => {
    expect(linkedNodeModules(worktree, { worktree, main })).toBeUndefined()
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    expect(linkedNodeModules(worktree, { worktree, main })?.reason).toContain('is a link to')
    fs.mkdirSync(path.join(worktree, 'packages', 'app'), { recursive: true })
    expect(linkedNodeModules(path.join(worktree, 'packages', 'app'), { worktree, main })?.path).toBe(path.join(worktree, 'node_modules'))
    expect(linkedNodeModules(path.join(main, 'src'), { worktree, main })?.reason).toContain('main checkout')
  })

  it('lists worktree links under each worktrees root, registered or leftover', () => {
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    write(path.join(tmp, 'home', 'worktrees', 'genio', 'unit-b', 'node_modules', 'real', 'package.json'))
    expect(worktreeLinks([path.join(tmp, 'home', 'worktrees')])).toEqual([
      expect.objectContaining({ worktree, project: 'genio', unit: 'unit-a', target: expect.stringMatching(/node_modules\\?$/) })
    ])
  })
})

describe('package-manager guard', () => {
  it.each([['npm', ['ci']], ['npm', ['install']], ['npm', ['i', 'react']], ['npm', ['uninstall', 'x']], ['npm', ['update']], ['npm', ['prune']], ['npm', ['dedupe']],
    ['npm', ['rebuild']], ['npm', ['exec', 'tsc']], ['npx', ['tsc']], ['pnpm', ['install']], ['pnpm', ['add', 'x']], ['yarn', []], ['yarn', ['add', 'x']]])('%s %s writes node_modules', (tool, args) => {
    expect(packageCommand(tool, args).mutating).toBe(true)
  })
  it.each([['npm', ['run', 'test']], ['npm', ['test']], ['npm', ['ls']], ['npm', ['view', 'react']], ['pnpm', ['run', 'build']], ['yarn', ['test']]])('%s %s does not', (tool, args) => {
    expect(packageCommand(tool, args).mutating).toBe(false)
  })

  it('refuses an install through a junction and allows it in a real folder', () => {
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    expect(npmGuardReason('npm', ['ci'], { cwd: worktree, worktree, main })).toMatch(/Refused "npm ci".*is a link.*setup/)
    expect(npmGuardReason('npm', ['run', 'test'], { cwd: worktree, worktree, main })).toBeUndefined()
    removeLinkSafely(path.join(worktree, 'node_modules'))
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    expect(npmGuardReason('npm', ['ci'], { cwd: worktree, worktree, main })).toBeUndefined()
  })

  it('follows --prefix, refuses the main checkout and waits for Genio\'s own setup', () => {
    expect(npmGuardReason('npm', ['--prefix', main, 'install'], { cwd: worktree, worktree, main })).toContain('main checkout')
    expect(npmGuardReason('npm', ['ci'], { cwd: main, worktree, main })).toContain('main checkout')
    const state = path.join(tmp, 'deps.json')
    fs.writeFileSync(state, JSON.stringify({ state: 'installing', pid: process.pid, method: 'copy' }))
    expect(npmGuardReason('npm', ['ci'], { cwd: worktree, worktree, main, state })).toContain('still setting up')
    fs.writeFileSync(state, JSON.stringify({ state: 'installing', pid: 2 ** 30, method: 'copy' }))
    expect(npmGuardReason('npm', ['ci'], { cwd: worktree, worktree, main, state })).toBeUndefined()
  })

  it('refuses through the real PATH shim and lets the real tool run in a real folder', () => {
    // A fake "real" npm that records it ran; the shim must resolve it from the inherited PATH.
    const realDir = path.join(tmp, 'real-bin'), shimDir = path.join(tmp, 'unit-bin')
    fs.mkdirSync(realDir)
    if (win) fs.writeFileSync(path.join(realDir, 'npm.cmd'), '@echo off\r\necho REAL npm %*\r\n')
    else fs.writeFileSync(path.join(realDir, 'npm'), '#!/bin/sh\necho REAL npm "$@"\n', { mode: 0o755 })
    const system = win ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin']
    const inherited = [realDir, path.dirname(process.execPath), ...system].join(path.delimiter)
    const env: NodeJS.ProcessEnv = { ...process.env, ...installNpmShims(shimDir, guard, inherited), GENIO_DEPS_WORKTREE: worktree, GENIO_DEPS_MAIN: main }
    delete env.Path
    const npm = (cwd: string) => win
      ? spawnSync('cmd.exe', ['/d', '/c', 'npm', 'ci'], { cwd, env, encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', 'npm ci'], { cwd, env, encoding: 'utf8' })
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    const refused = npm(worktree)
    expect(refused.status).toBe(23)
    expect(refused.stderr).toContain('Refused "npm ci"')
    expect(refused.stdout).not.toContain('REAL')
    removeLinkSafely(path.join(worktree, 'node_modules'))
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    const allowed = npm(worktree)
    expect(allowed.status, allowed.stderr + allowed.stdout).toBe(0)
    expect(allowed.stdout).toContain('REAL npm ci')
  })
})

describe('PreToolUse rules', () => {
  const tool = (command: string, name = 'PowerShell') => depsToolReason({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: { command }, cwd: worktree }, { worktree, main })

  it.each([
    'New-Item -ItemType Junction -Path node_modules -Target C:\\Users\\player\\git\\genio\\node_modules',
    'New-Item -Path node_modules -ItemType SymbolicLink -Value ..\\main\\node_modules',
    'cmd /c mklink /J node_modules C:\\main\\node_modules',
    'ln -s ../main/node_modules node_modules',
    'node -e "require(\'fs\').symlinkSync(\'C:/main/node_modules\', \'node_modules\', \'junction\')"'
  ])('denies linking node_modules: %s', command => {
    expect(tool(command)).toContain('Never link')
  })

  it('denies recursive deletes on or through a node_modules link, and allows removing only the link', () => {
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    for (const command of ['Remove-Item -Recurse -Force node_modules', 'rm -r node_modules', 'rmdir /s /q node_modules', 'cmd /c "rmdir /s /q node_modules"',
      'rm -rf node_modules/left-pad', `Remove-Item "${path.join(worktree, 'node_modules')}" -Recurse`]) {
      expect(tool(command), command).toContain('cmd /c rmdir')
    }
    expect(tool(`cmd /c rmdir "${path.join(worktree, 'node_modules')}"`)).toBeUndefined()
    expect(tool('rmdir node_modules', 'Bash')).toBeUndefined()
  })

  it('allows recursive deletes of a real node_modules and ignores quoted text', () => {
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    expect(tool('Remove-Item -Recurse -Force node_modules')).toBeUndefined()
    expect(tool('git commit -m "deny mklink /J node_modules"')).toBeUndefined()
    expect(tool('echo "New-Item -ItemType Junction node_modules"')).toBeUndefined()
  })

  it('denies moving node_modules and installing through a linked tree', () => {
    expect(tool('Move-Item node_modules ..\\elsewhere')).toContain('Never move')
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    expect(tool('npm ci', 'Bash')).toContain('Refused "npm ci"')
    expect(tool('cd x; npm run build', 'Bash')).toBeUndefined()
  })

  it('denies through the hook script itself with exit code 2', () => {
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install' }, cwd: worktree })
    const env = { ...process.env, GENIO_DEPS_WORKTREE: worktree, GENIO_DEPS_MAIN: main }
    const denied = spawnSync(process.execPath, [guard, '--hook'], { input, env, encoding: 'utf8' })
    expect(denied.status).toBe(2)
    expect(denied.stderr).toContain('Refused "npm install"')
    const fine = spawnSync(process.execPath, [guard, '--hook'], { input: input.replace('npm install', 'npm test'), env, encoding: 'utf8' })
    expect(fine.status).toBe(0)
  })
})

describe('private node_modules setup', () => {
  it('seeds by copy when the lockfiles hash the same; npm ci never runs', async () => {
    const install = vi.fn()
    expect(lockHash(worktree)).toEqual(lockHash(main))
    const r = await setupNodeModules(worktree, main, { install })
    expect(r).toMatchObject({ state: 'ready', method: win ? 'robocopy' : 'fs.cp' })
    expect(install).not.toHaveBeenCalled()
    const nm = path.join(worktree, 'node_modules')
    expect(isLink(nm)).toBe(false)
    expect(fs.readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1')
    // A private copy: writing in it leaves main's untouched.
    fs.writeFileSync(path.join(nm, 'left-pad', 'index.js'), 'changed')
    expect(fs.readFileSync(path.join(main, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1')
  })

  it('removes a link left in the worktree first (the link only), then copies', async () => {
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    const r = await setupNodeModules(worktree, main, { install: vi.fn() })
    expect(r).toMatchObject({ state: 'ready', repaired: path.join(worktree, 'node_modules') })
    expect(isLink(path.join(worktree, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(main, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
  })

  it('runs npm ci inside the worktree when the lockfiles differ or main is incomplete', async () => {
    const install = vi.fn(async () => ({ code: 0 }))
    const copy = vi.fn()
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')
    expect(await setupNodeModules(worktree, main, { install, copy })).toMatchObject({ state: 'ready', method: 'npm ci' })
    expect(install).toHaveBeenCalledWith(worktree)
    expect(copy).not.toHaveBeenCalled()
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), fs.readFileSync(path.join(main, 'package-lock.json')))
    fs.rmSync(path.join(main, 'node_modules', '.bin'), { recursive: true })
    install.mockClear()
    expect(await setupNodeModules(worktree, main, { install, copy })).toMatchObject({ state: 'ready', method: 'npm ci', copyFailure: expect.stringContaining('.bin') })
    expect(install).toHaveBeenCalledWith(worktree)
  })

  it('skips a worktree without package.json and keeps an existing real node_modules', async () => {
    fs.rmSync(path.join(worktree, 'package.json'))
    expect(await setupNodeModules(worktree, main)).toMatchObject({ state: 'skipped' })
    write(path.join(worktree, 'package.json'), '{}')
    fs.mkdirSync(path.join(worktree, 'node_modules'))
    expect(await setupNodeModules(worktree, main)).toMatchObject({ state: 'ready', method: 'existing' })
    await expect(setupNodeModules(main, main)).rejects.toThrow('main checkout')
  })
})

describe('main install health check', () => {
  it('reports missing .bin, packages and the Electron binary, and the worktrees linked to it', () => {
    expect(checkInstall(main)).toMatchObject({ ok: true, missing: [] })
    const home = path.join(tmp, 'home')
    junction(path.join(main, 'node_modules'), path.join(worktree, 'node_modules'))
    const r = genioInstallReport(main, home)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(expect.arrayContaining(['node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/three', 'node_modules/electron/dist (the Electron binary)']))
    expect(r.linked.map(l => l.worktree)).toEqual([worktree])
    expect(r.message).toBe(`Dependencies are broken: run npm install in ${main}`)
    for (const p of ['@anthropic-ai/claude-agent-sdk', 'three', 'electron', 'electron-vite']) write(path.join(main, 'node_modules', p, 'package.json'), '{}')
    write(path.join(main, 'node_modules', 'electron', 'path.txt'), 'electron.exe')
    write(path.join(main, 'node_modules', 'electron', 'dist', 'electron.exe'))
    expect(genioInstallReport(main, home)).toMatchObject({ ok: true, missing: [] })
    fs.rmSync(path.join(main, 'node_modules', '.bin'), { recursive: true })
    expect(genioInstallReport(main, home).missing).toEqual(['node_modules/.bin'])
  })

  it('renders a plain recovery card with the command, a copy button and the linked worktrees', () => {
    const odd = path.join(tmp, "a&b's")
    project(odd)
    junction(path.join(odd, 'node_modules'), path.join(worktree, 'node_modules'))
    const html = recoveryCardHtml(genioInstallReport(odd, path.join(tmp, 'home')))
    expect(html).toContain('Dependencies are broken: run npm install in')
    expect(html).toContain('a&amp;b&#39;s')
    expect(html).not.toContain("a&b's")
    expect(html).toContain('<button id="copy"')
    expect(html).toContain('npm install --prefix')
    expect(html).toContain('node_modules/three')
    expect(html).toContain(worktree)
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'/)
  })
})
