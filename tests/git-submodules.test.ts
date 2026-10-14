import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as gitApi from '../src/main/git'
import { submoduleLines } from '../src/main/brief'
import { declaredSubmodules, initSubmodules, missingSubmodules } from '../resources/unit-skills/genio/lib/git-submodules.mjs'
import { seedLibrary } from '../resources/unit-skills/genio/lib/unity-seed.mjs'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'

// Local file paths only: every "remote" here is a folder in the temp root, never the network.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'protocol.file.allow=always']
const LFS = ['-c', 'filter.lfs.clean=git-lfs clean -- %f', '-c', 'filter.lfs.smudge=git-lfs smudge -- %f', '-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true']
const hasLfs = spawnSync('git', ['lfs', 'version'], { windowsHide: true }).status === 0
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', env, windowsHide: true }).trim()

let root: string, world: string, lib: string, inner: string, l1: string, l3: string
const BIG = Buffer.alloc(4096, 9)

/** Every file and folder under dir with its content hash: the byte-identical check. */
function snapshot(dir: string, skip: string[] = []): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (p: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name), rel = path.relative(dir, full).replace(/\\/g, '/')
      if (skip.some(s => rel === s || rel.startsWith(`${s}/`))) continue
      if (e.isDirectory()) { out.set(`${rel}/`, ''); walk(full) } else out.set(rel, createHash('sha1').update(fs.readFileSync(full)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-submodules-')))
  world = path.join(root, 'world'); lib = path.join(root, 'lib-upstream'); inner = path.join(root, 'inner-upstream')
  // inner: a nested submodule of lib.
  git(root, 'init', '-q', '-b', 'main', inner)
  fs.writeFileSync(path.join(inner, 'inner.txt'), 'inner'); git(inner, 'add', '.'); git(inner, 'commit', '-qm', 'inner')
  git(root, 'init', '-q', '-b', 'main', lib)
  fs.writeFileSync(path.join(lib, 'package.json'), '{"name":"com.test.lib","version":"1.0.0"}'); git(lib, 'add', '.'); git(lib, 'commit', '-qm', 'L1')
  git(lib, 'submodule', 'add', '-q', inner, 'deps/inner'); git(lib, 'commit', '-qm', 'L1 with inner')
  l1 = git(lib, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(lib, 'package.json'), '{"name":"com.test.lib","version":"2.0.0"}'); git(lib, 'commit', '-qam', 'L2')
  // world: the player's checkout. The Unity root is a subfolder; the package is a submodule under it.
  git(root, 'init', '-q', '-b', 'main', world)
  fs.mkdirSync(path.join(world, 'Game', 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.1f1\n')
  fs.writeFileSync(path.join(world, '.gitignore'), 'Library/\nTemp/\n')
  git(world, 'add', '.')
  git(world, 'submodule', 'add', '-q', lib, 'Game/Packages/lib')
  git(world, 'submodule', 'update', '-q', '--init', '--recursive')
  // A commit only the player's submodule has, no ref reaching it, with an LFS file when git-lfs exists.
  const sub = path.join(world, 'Game', 'Packages', 'lib')
  git(sub, 'checkout', '-q', '--detach')
  if (hasLfs) {
    fs.writeFileSync(path.join(sub, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    fs.writeFileSync(path.join(sub, 'big.bin'), BIG)
  }
  fs.writeFileSync(path.join(sub, 'local.txt'), 'only in the player copy')
  git(sub, ...LFS, 'add', '.'); git(sub, 'commit', '-qm', 'L3 local')
  l3 = git(sub, 'rev-parse', 'HEAD')
  git(world, 'add', '.'); git(world, 'commit', '-qm', 'world records L3')
  // The player's submodule is now at a different commit than main records (L1), and L3 is unreachable from refs.
  git(sub, 'checkout', '-q', l1)
  git(sub, 'submodule', 'update', '-q', '--recursive')
}, 60000)
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('reads declared submodules and finds unchecked-out ones under a Unity root', () => {
  expect(declaredSubmodules(world)).toMatchObject([{ name: 'Game/Packages/lib', path: 'Game/Packages/lib', url: expect.stringContaining('lib-upstream') }])
  expect(missingSubmodules(path.join(world, 'Game'))).toEqual([])
  const bare = path.join(root, 'bare-tree')
  fs.mkdirSync(path.join(bare, '.git'), { recursive: true }); fs.mkdirSync(path.join(bare, 'Game', 'Packages', 'lib'), { recursive: true })
  fs.copyFileSync(path.join(world, '.gitmodules'), path.join(bare, '.gitmodules'))
  expect(missingSubmodules(path.join(bare, 'Game'))).toEqual(['Game/Packages/lib'])
  expect(missingSubmodules(path.join(bare, 'Other'))).toEqual([])
})

it('checks out a unit worktree\'s submodules, nested and LFS included, and leaves the main checkout byte-identical', async () => {
  const wt = path.join(root, 'worktrees', 'unit-a')
  expect((await gitApi.addWorktree(world, wt, 'genio/unit-a', 'main', true)).code).toBe(0)
  // git worktree add leaves the folder empty: Unity would miss the package.
  expect(fs.readdirSync(path.join(wt, 'Game', 'Packages', 'lib'))).toEqual([])
  const before = snapshot(world, ['.git/worktrees/unit-a'])
  const report = await gitApi.initWorktreeSubmodules(world, wt)
  expect(report.problems).toEqual([])
  expect(report.submodules.map(s => [s.path, s.action])).toEqual([['Game/Packages/lib', 'cloned'], ['Game/Packages/lib/deps/inner', 'cloned']])
  expect(snapshot(world, ['.git/worktrees/unit-a'])).toEqual(before)
  const sub = path.join(wt, 'Game', 'Packages', 'lib')
  expect(git(sub, 'rev-parse', 'HEAD')).toBe(l3)
  expect(fs.readFileSync(path.join(sub, 'local.txt'), 'utf8')).toBe('only in the player copy')
  expect(fs.readFileSync(path.join(sub, 'deps', 'inner', 'inner.txt'), 'utf8')).toBe('inner')
  if (hasLfs) {
    expect(fs.readFileSync(path.join(sub, 'big.bin'))).toEqual(BIG)
    expect(report.submodules[0].lfs).toEqual({ objects: 1, copied: 1 })
  }
  // Git dirs live in the worktree's own admin folder, never in the player's .git/modules.
  expect(git(sub, 'rev-parse', '--absolute-git-dir').toLowerCase()).toBe(path.join(world, '.git', 'worktrees', 'unit-a', 'modules', 'Game', 'Packages', 'lib').replace(/\\/g, '/').toLowerCase())
  // A local upstream could be the player's repository: the copy keeps no origin pointing at it.
  expect(git(sub, 'remote')).toBe('')
  expect(git(wt, 'status', '--porcelain')).toBe('')
  expect(missingSubmodules(path.join(wt, 'Game'))).toEqual([])
  // A second run is a no-op.
  expect((await gitApi.initWorktreeSubmodules(world, wt)).submodules.map(s => s.action)).toEqual(['current', 'current'])
  expect(submoduleLines(report)[0]).toContain('`Game/Packages/lib`')
  expect((await gitApi.removeWorktree(world, wt, true)).code).toBe(0)
  expect(snapshot(world, ['.git/worktrees'])).toEqual(new Map([...before].filter(([k]) => !k.startsWith('.git/worktrees'))))
}, 60000)

it('reports a submodule commit the main checkout lacks, without fetching, and warns in the brief', async () => {
  // A branch recording a submodule commit nobody has locally.
  const tmp = path.join(root, 'setup')
  git(world, 'worktree', 'add', '-q', '-b', 'genio/bad', tmp)
  git(tmp, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},Game/Packages/lib`); git(tmp, 'commit', '-qm', 'unknown commit')
  git(world, 'worktree', 'remove', '--force', tmp)
  const wt = path.join(root, 'worktrees', 'unit-b')
  expect((await gitApi.addWorktree(world, wt, 'genio/bad', 'main', true)).code).toBe(0)
  const before = snapshot(world, ['.git/worktrees/unit-b'])
  const report = await gitApi.initWorktreeSubmodules(world, wt)
  expect(report.ok).toBe(false)
  expect(report.submodules[0]).toMatchObject({ path: 'Game/Packages/lib', action: 'failed', reason: expect.stringContaining('is not in the main checkout') })
  expect(report.problems[0]).toMatch(/^Game\/Packages\/lib: commit 111111111111 is not in the main checkout's copy.*never downloads/)
  expect(snapshot(world, ['.git/worktrees/unit-b'])).toEqual(before)
  const lines = submoduleLines(report)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^- WARNING: Genio could not initialise.*blocked: git submodules missing/)
  // The Library seed refuses a copy missing its packages.
  fs.mkdirSync(path.join(world, 'Game', 'Library'), { recursive: true }); fs.writeFileSync(path.join(world, 'Game', 'Library', 'warm'), 'cache')
  expect(await seedLibrary(path.join(wt, 'Game'), path.join(world, 'Game', 'Library'))).toMatchObject({ seeded: false, reason: 'submodules-missing', missing: ['Game/Packages/lib'] })
}, 60000)

it('a project without submodules reports nothing and costs no git call', async () => {
  const plain = path.join(root, 'plain'); git(root, 'init', '-q', plain)
  expect(await initSubmodules(plain, { source: world })).toMatchObject({ submodules: [], problems: [], ok: true })
  expect(submoduleLines(await initSubmodules(plain))).toEqual([])
})

it('prepares Play slots with their submodules, updates only changed ones on a switch and never writes the source', async () => {
  fs.mkdirSync(path.join(world, 'Game', 'Library'), { recursive: true }); fs.writeFileSync(path.join(world, 'Game', 'Library', 'warm'), 'cache')
  const pool = new PlayPool(path.join(root, 'data'), world, 'Game')
  const a = (await pool.acquire('unit:a'))!
  let before = snapshot(world)
  expect(await pool.prepare(a.id, a.token)).toBe(a.root)
  expect(snapshot(world)).toEqual(before)
  const sub = path.join(a.root, 'Packages', 'lib')
  expect(git(sub, 'rev-parse', 'HEAD')).toBe(l3)
  expect(fs.readFileSync(path.join(sub, 'deps', 'inner', 'inner.txt'), 'utf8')).toBe('inner')
  if (hasLfs) expect(fs.readFileSync(path.join(sub, 'big.bin'))).toEqual(BIG)
  let prep = (await pool.state()).slots[0].preparation!
  expect(prep.submodules?.entries).toEqual([{ path: 'Game/Packages/lib', action: 'cloned' }, { path: 'Game/Packages/lib/deps/inner', action: 'cloned' }])
  // Packages present on both sides: Library is seeded.
  expect(prep.library).toMatchObject({ seeded: true })

  // A superproject-only change: the submodule is reused as is.
  fs.writeFileSync(path.join(world, 'Game', 'game.txt'), 'v2'); git(world, 'add', 'Game/game.txt'); git(world, 'commit', '-qm', 'v2')
  // Unity dirtied the package in its slot copy: the slot resets it even at the same commit.
  fs.writeFileSync(path.join(sub, 'package.json.meta'), 'guid: 1')
  before = snapshot(world)
  await pool.prepare(a.id, a.token)
  // No hook ran: git-lfs's post-checkout hook would have created the source's .git/lfs.
  expect(snapshot(world)).toEqual(before)
  expect(fs.readdirSync(pool.dir).filter(n => /hooks/.test(n))).toEqual(['no-hooks.txt'])
  prep = (await pool.state()).slots[0].preparation!
  expect(prep.submodules?.entries.map(e => e.action)).toEqual(['reset', 'current'])
  expect(fs.existsSync(path.join(sub, 'package.json.meta'))).toBe(false)

  // The submodule moves to L1, a commit the player's submodule has under a ref.
  git(world, 'update-index', '--cacheinfo', `160000,${l1},Game/Packages/lib`); git(world, 'commit', '-qm', 'back to L1')
  before = snapshot(world)
  await pool.prepare(a.id, a.token)
  expect(snapshot(world)).toEqual(before)
  expect(git(sub, 'rev-parse', 'HEAD')).toBe(l1)
  expect(fs.existsSync(path.join(sub, 'local.txt'))).toBe(false)
  expect((await pool.state()).slots[0].preparation!.submodules?.entries.map(e => e.action)).toEqual(['updated', 'current'])
  expect(git(a.root, 'status', '--porcelain')).toBe('')

  // A commit the player does not have: the slot refuses rather than opening Unity without the package.
  git(world, 'update-index', '--cacheinfo', `160000,${'2'.repeat(40)},Game/Packages/lib`); git(world, 'commit', '-qm', 'unknown')
  await expect(pool.prepare(a.id, a.token)).rejects.toThrow(/cannot check out the git submodules Unity needs: Game\/Packages\/lib: commit 222222222222/)
  expect((await pool.state()).slots[0]).toMatchObject({ preparing: false })
}, 120000)
