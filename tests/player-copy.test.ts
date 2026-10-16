import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PlayerCopies, PLAYER_COPY_MAX_AGE_MS } from '../resources/unit-skills/genio/lib/player-copy.mjs'
import { mirrorSkip } from '../resources/unit-skills/genio/lib/git-mirror.mjs'

// Temp repositories only: nothing here reads or writes a real project.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG')))
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'protocol.file.allow=always', '-c', 'core.autocrlf=false']
const hasLfs = spawnSync('git', ['lfs', 'version'], { windowsHide: true }).status === 0
const git = (cwd: string, ...args: string[]) => execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', env, windowsHide: true }).trim()
const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex')
const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let root: string, world: string, data: string

/** Every file and folder under dir with its content hash: the byte-identical check (.git included). */
function snapshot(dir: string, skip: string[] = []): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (p: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name), rel = path.relative(dir, full).replace(/\\/g, '/')
      if (skip.some(s => rel === s || rel.startsWith(`${s}/`))) continue
      if (e.isDirectory()) { out.set(`${rel}/`, ''); walk(full) } else out.set(rel, `${sha1(fs.readFileSync(full))} ${fs.statSync(full).mtimeMs}`)
    }
  }
  walk(dir)
  return out
}
/** Files under dir by Unity-root-relative path and content hash. */
function tree(dir: string, skip: (rel: string) => boolean = rel => mirrorSkip(rel)): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (p: string): void => {
    if (!fs.existsSync(p)) return
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name), rel = path.relative(dir, full).replace(/\\/g, '/')
      if (skip(rel)) continue
      if (e.isDirectory()) walk(full); else out[rel] = sha1(fs.readFileSync(full))
    }
  }
  walk(dir)
  return out
}
/** What a checkout's Unity root should mirror to: tracked and untracked non-ignored files on disk. */
function expected(top: string, prefix = 'Game'): Record<string, string> {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', prefix], { cwd: top, encoding: 'utf8', env, windowsHide: true }).split('\0').filter(Boolean)
  const out: Record<string, string> = {}
  for (const p of listed) {
    const rel = p.slice(prefix.length + 1), file = path.join(top, p)
    if (mirrorSkip(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    out[rel] = sha1(fs.readFileSync(file))
  }
  return out
}
const copyTree = (copies: PlayerCopies, w = world) => tree(copies.status(w)!.root)

function makeWorld(dir: string): string {
  git(path.dirname(dir), 'init', '-q', '-b', 'main', dir)
  write(path.join(dir, '.gitignore'), 'Game/Library/\nGame/Temp/\nGame/Assets/Ignored/\n*.csproj\n')
  write(path.join(dir, 'README.md'), 'outside the Unity root')
  write(path.join(dir, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.1f1\nm_EditorVersionWithRevision: 6000.3.1f1 (abc)\n')
  write(path.join(dir, 'Game', 'ProjectSettings', 'ProjectSettings.asset'), 'activeInputHandler: 1\n')
  write(path.join(dir, 'Game', 'Packages', 'manifest.json'), '{"dependencies":{}}\n')
  write(path.join(dir, 'Game', 'Assets', 'A.cs'), 'class A {}\n')
  write(path.join(dir, 'Game', 'Assets', 'A.cs.meta'), 'guid: a\n')
  write(path.join(dir, 'Game', 'Assets', 'Folder.meta'), 'guid: f\n')
  write(path.join(dir, 'Game', 'Assets', 'Folder', 'B.txt'), 'bee\n')
  write(path.join(dir, 'Game', 'Assets', 'Folder', 'B.txt.meta'), 'guid: b\n')
  write(path.join(dir, 'Game', 'Assets', 'NoMeta.png'), Buffer.alloc(2048, 7))
  write(path.join(dir, 'Game', 'Assets', 'Old.txt'), 'old name\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'project')
  // The main checkout's warm Library (ignored), the seed source.
  write(path.join(dir, 'Game', 'Library', 'ArtifactDB'), 'warm cache')
  write(path.join(dir, 'Game', 'Library', 'PackageCache', 'skip.txt'), 'UPM refills this')
  return dir
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-player-copy-')))
  data = path.join(root, 'data')
  world = makeWorld(path.join(root, 'world'))
}, 60000)
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

const make = (options: ConstructorParameters<typeof PlayerCopies>[1] = {}) => new PlayerCopies(data, { system: { created: async () => 'T0' }, ...options })

it('mirrors the main checkout as it is on disk, seeds the Library, and never writes the source', async () => {
  // Uncommitted, untracked and ignored work in the player's checkout.
  write(path.join(world, 'Game', 'Assets', 'A.cs'), 'class A { int dirty; }\n')
  write(path.join(world, 'Game', 'Assets', 'New.txt'), 'untracked\n')
  write(path.join(world, 'Game', 'Assets', 'Ignored', 'bake.bin'), 'ignored local bake')
  write(path.join(world, 'Game', 'Game.csproj'), '<Project/>')
  const copies = make()
  const before = snapshot(world)
  const rec = await copies.ensure(world, 'Game')
  expect(rec).toMatchObject({ state: 'ready', engineRoot: 'Game', project: world })
  expect(rec.root).toBe(path.join(rec.dir, 'world', 'Game'))
  expect(rec.dir.startsWith(path.join(data, 'player-copies'))).toBe(true)
  const report = await copies.sync(world, { path: world })
  expect(snapshot(world)).toEqual(before)
  expect(copyTree(copies)).toEqual(expected(world))
  expect(Object.keys(copyTree(copies))).toEqual(expect.arrayContaining(['Assets/New.txt', 'Assets/A.cs']))
  expect(copyTree(copies)['Assets/Ignored/bake.bin']).toBeUndefined()
  expect(fs.existsSync(path.join(rec.dir, 'world', 'README.md'))).toBe(false)
  expect(report).toMatchObject({ first: true, complete: true, source: { kind: 'checkout', path: world, branch: 'main' }, restart: { needed: true, unityVersion: '6000.3.1f1' } })
  expect(report.files).toMatchObject({ added: Object.keys(expected(world)).length, deleted: 0 })
  // The Library is seeded once from the main checkout; PackageCache is withheld.
  expect(report.library).toMatchObject({ version: '6000.3.1f1', seed: { seeded: true } })
  expect(fs.readFileSync(path.join(rec.root, 'Library', 'ArtifactDB'), 'utf8')).toBe('warm cache')
  expect(fs.existsSync(path.join(rec.root, 'Library', 'PackageCache'))).toBe(false)

  // Nothing changed: nothing is copied and no restart is advised.
  const again = await copies.sync(world, { path: world })
  expect(again.files).toMatchObject({ unchanged: again.files.source, added: 0, updated: 0, restored: 0, deleted: 0 })
  expect(again.bytes.copied).toBe(0)
  expect(again.restart).toMatchObject({ needed: false, reasons: [] })
  expect(snapshot(world)).toEqual(before)
  expect(copies.status(world)).toMatchObject({ state: 'ready', lastSync: { complete: true, source: { kind: 'checkout' } } })
}, 60000)

it('switching to a worktree copies only changed content: identity comes from the index, not timestamps', async () => {
  write(path.join(world, 'Game', 'Assets', 'A.cs'), 'class A { int dirty; }\n')
  write(path.join(world, 'Game', 'Assets', 'New.txt'), 'untracked in main\n')
  const wt = path.join(root, 'worktrees', 'unit-a')
  git(world, 'worktree', 'add', '-q', '-b', 'feature', wt)
  // A rename, an edit and a deletion committed; one edit left uncommitted; an untracked file.
  git(wt, 'mv', 'Game/Assets/Old.txt', 'Game/Assets/Renamed.txt')
  write(path.join(wt, 'Game', 'Assets', 'Folder', 'B.txt'), 'bee two\n')
  git(wt, 'rm', '-q', 'Game/Assets/NoMeta.png')
  git(wt, 'commit', '-qam', 'feature')
  write(path.join(wt, 'Game', 'Assets', 'Folder', 'B.txt.meta'), 'guid: b\nuserData: dirty\n')
  write(path.join(wt, 'Game', 'Assets', 'Unit.txt'), 'unit work\n')
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  // Files the sync wrote: new content or a new timestamp in the copy.
  const written = async (run: () => Promise<unknown>) => {
    const pre = snapshot(rec.root, ['Library'])
    await sleep(20)
    await run()
    const post = snapshot(rec.root, ['Library'])
    return [...post].filter(([k, v]) => !k.endsWith('/') && pre.get(k) !== v).map(([k]) => path.basename(k)).sort()
  }
  const beforeWorld = snapshot(world), beforeWt = snapshot(wt)
  let report!: Awaited<ReturnType<typeof copies.sync>>
  const copied = await written(async () => { report = await copies.sync(world, { path: wt }) })
  expect(snapshot(world)).toEqual(beforeWorld)
  expect(snapshot(wt)).toEqual(beforeWt)
  expect(copyTree(copies)).toEqual(expected(wt))
  // Every other file in the worktree has a new timestamp, yet none is copied.
  expect(copied).toEqual(['A.cs', 'B.txt', 'B.txt.meta', 'Renamed.txt', 'Unit.txt'])
  expect(report.files).toMatchObject({ added: 2, updated: 3, deleted: 3, restored: 0 })
  expect(report.source).toMatchObject({ kind: 'checkout', path: wt, branch: 'feature' })
  expect(report.restart.needed).toBe(false)

  // Back to the main checkout: the worktree's changes are undone, and only those files move.
  expect(await written(() => copies.sync(world, { path: world }))).toEqual(['A.cs', 'B.txt', 'B.txt.meta', 'New.txt', 'NoMeta.png', 'Old.txt'])
  expect(copyTree(copies)).toEqual(expected(world))
}, 60000)

it('restores files Unity rewrote, keeps Unity metas for source assets, and deletes other Unity-made files', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const r = (rel: string) => path.join(rec.root, ...rel.split('/'))
  write(r('Assets/A.cs.meta'), 'guid: a\nrewritten by Unity\n')
  write(r('ProjectSettings/ProjectSettings.asset'), 'activeInputHandler: 1\nupgraded: true\n')
  write(r('Assets/NoMeta.png.meta'), 'guid: generated\n')
  write(r('Assets/Stray.asset'), 'made by Unity')
  write(r('Assets/Generated/Thing.asset'), 'made by Unity')
  write(r('Packages/packages-lock.json'), '{}')
  write(r('Packages/com.genio.play/package.json'), '{"name":"com.genio.play"}')
  write(r('Temp/UnityTemp'), 'x'); write(r('Logs/Editor.log'), 'x'); write(r('Game.csproj'), 'x')
  // Read-only, as some tools leave files.
  write(r('Assets/Folder/B.txt'), 'locally changed\n'); fs.chmodSync(r('Assets/Folder/B.txt'), 0o444)
  const report = await copies.sync(world, { path: world })
  expect(report.files).toMatchObject({ restored: 3, unityMadeDeleted: 2, added: 0, updated: 0 })
  expect(report.restart.needed).toBe(false)
  expect(fs.readFileSync(r('Assets/A.cs.meta'), 'utf8')).toBe('guid: a\n')
  expect(fs.readFileSync(r('Assets/Folder/B.txt'), 'utf8')).toBe('bee\n')
  expect(fs.readFileSync(r('Assets/NoMeta.png.meta'), 'utf8')).toBe('guid: generated\n')
  expect(fs.existsSync(r('Assets/Stray.asset'))).toBe(false)
  expect(fs.existsSync(r('Assets/Generated'))).toBe(false)
  for (const kept of ['Packages/packages-lock.json', 'Packages/com.genio.play/package.json', 'Temp/UnityTemp', 'Logs/Editor.log', 'Game.csproj', 'Library/ArtifactDB']) expect(fs.existsSync(r(kept))).toBe(true)

  // An asset deleted from the source takes Unity's meta for it along.
  fs.rmSync(path.join(world, 'Game', 'Assets', 'NoMeta.png'))
  const gone = await copies.sync(world, { path: world })
  expect(gone.files).toMatchObject({ deleted: 1, unityMadeDeleted: 1 })
  expect(fs.existsSync(r('Assets/NoMeta.png.meta'))).toBe(false)
}, 60000)

it('advises a restart when packages, ProjectSettings or the Unity version change, and stashes the Library per version', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  write(path.join(world, 'Game', 'Packages', 'manifest.json'), '{"dependencies":{"com.unity.inputsystem":"1.19.0"}}\n')
  expect((await copies.sync(world, { path: world })).restart).toMatchObject({ needed: true, reasons: ['Packages/manifest.json changed'] })
  write(path.join(world, 'Game', 'Assets', 'A.cs'), 'class A { int hot; }\n')
  expect((await copies.sync(world, { path: world })).restart.needed).toBe(false)

  // A Unity upgrade: the Library moves aside (upgrades are one way) and a matching one is seeded.
  write(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.4.0f1\n')
  write(path.join(rec.root, 'Library', 'ArtifactDB'), 'imported by 6000.3')
  const upgrade = await copies.sync(world, { path: world })
  expect(upgrade.restart).toMatchObject({ needed: true, unityVersion: '6000.4.0f1', previousUnityVersion: '6000.3.1f1' })
  expect(upgrade.restart.reasons).toEqual(expect.arrayContaining(['ProjectSettings/ProjectVersion.txt changed', 'Unity 6000.3.1f1 → 6000.4.0f1']))
  expect(upgrade.library).toMatchObject({ version: '6000.4.0f1', stashed: '6000.3.1f1', seed: { seeded: true } })
  expect(fs.readFileSync(path.join(rec.root, 'Library@6000.3.1f1', 'ArtifactDB'), 'utf8')).toBe('imported by 6000.3')

  // Back to the old version: its Library returns.
  write(path.join(world, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.1f1\n')
  const back = await copies.sync(world, { path: world })
  expect(back.library).toMatchObject({ stashed: '6000.4.0f1', restored: '6000.3.1f1' })
  expect(fs.readFileSync(path.join(rec.root, 'Library', 'ArtifactDB'), 'utf8')).toBe('imported by 6000.3')
  // Stashes are never mirrored or purged.
  expect(fs.existsSync(path.join(rec.root, 'Library@6000.4.0f1'))).toBe(true)
}, 60000)

it('plays a branch with no checkout from git objects, resolving LFS pointers from the local store', async () => {
  const setup = path.join(root, 'setup')
  git(world, 'worktree', 'add', '-q', '-b', 'side', setup)
  const object = Buffer.alloc(5000, 3), oid = createHash('sha256').update(object).digest('hex')
  const pointer = (id: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${id}\nsize ${size}\n`
  write(path.join(setup, 'Game', 'Assets', 'Big.bin'), pointer(oid, object.length))
  write(path.join(setup, 'Game', 'Assets', 'Missing.bin'), pointer('e'.repeat(64), 9000))
  write(path.join(setup, 'Game', 'Assets', 'Side.cs'), 'class Side {}\n')
  git(setup, 'rm', '-q', 'Game/Assets/Old.txt')
  git(setup, 'add', '.'); git(setup, 'commit', '-qm', 'side')
  git(world, 'worktree', 'remove', '--force', setup)
  write(path.join(world, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid), object)
  const copies = make()
  await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const before = snapshot(world)
  const report = await copies.sync(world, { ref: 'side' })
  expect(snapshot(world)).toEqual(before)
  expect(report.source).toMatchObject({ kind: 'commit', ref: 'side', commit: git(world, 'rev-parse', 'side') })
  const copyRoot = copies.status(world)!.root
  expect(fs.readFileSync(path.join(copyRoot, 'Assets', 'Big.bin'))).toEqual(object)
  expect(fs.readFileSync(path.join(copyRoot, 'Assets', 'Side.cs'), 'utf8')).toBe('class Side {}\n')
  expect(fs.existsSync(path.join(copyRoot, 'Assets', 'Old.txt'))).toBe(false)
  expect(report.lfs).toEqual({ resolved: 1, pointers: ['Assets/Missing.bin'] })
  expect(report.warnings.join('\n')).toMatch(/1 file\(s\) are Git LFS pointers whose content was never downloaded, e\.g\. Assets\/Missing\.bin/)
  // The committed (clean) files it shares with main were not copied again.
  expect(report.files).toMatchObject({ added: 3, deleted: 1, updated: 0 })
  await expect(copies.sync(world, { ref: 'no-such-branch' })).rejects.toThrow(/No commit named no-such-branch/)
  await expect(copies.sync(world, { ref: '--output=x' })).rejects.toThrow(/Invalid Play source ref/)
}, 60000)

it('copies submodules from the source checkout, else from the main checkout, else from git objects', async () => {
  const lib = path.join(root, 'lib-upstream')
  git(root, 'init', '-q', '-b', 'main', lib)
  write(path.join(lib, 'package.json'), '{"name":"com.test.lib","version":"1.0.0"}\n'); git(lib, 'add', '.'); git(lib, 'commit', '-qm', 'lib')
  git(world, 'submodule', 'add', '-q', lib, 'Game/Packages/lib'); git(world, 'commit', '-qm', 'add lib')
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const pkg = path.join(rec.root, 'Packages', 'lib', 'package.json')
  expect(fs.readFileSync(pkg, 'utf8')).toContain('1.0.0')
  expect(fs.existsSync(path.join(rec.root, 'Packages', 'lib', '.git'))).toBe(false)

  // A unit worktree whose submodule folder git left empty: the main checkout supplies it.
  const wt = path.join(root, 'worktrees', 'unit-b')
  git(world, 'worktree', 'add', '-q', '-b', 'unit-b', wt)
  expect(fs.readdirSync(path.join(wt, 'Game', 'Packages', 'lib'))).toEqual([])
  fs.rmSync(pkg)
  let before = snapshot(world)
  await copies.sync(world, { path: wt })
  expect(fs.readFileSync(pkg, 'utf8')).toContain('1.0.0')
  expect(snapshot(world)).toEqual(before)

  // The main checkout's copy has local edits: the committed content comes from git objects instead.
  write(path.join(world, 'Game', 'Packages', 'lib', 'package.json'), '{"name":"com.test.lib","version":"local"}\n')
  fs.rmSync(pkg)
  before = snapshot(world)
  await copies.sync(world, { path: wt })
  expect(fs.readFileSync(pkg, 'utf8')).toContain('1.0.0')
  await copies.sync(world, { ref: 'main' })
  expect(fs.readFileSync(pkg, 'utf8')).toContain('1.0.0')
  expect(snapshot(world)).toEqual(before)

  // A submodule commit nobody has: refused before the copy changes.
  git(wt, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},Game/Packages/lib`); git(wt, 'commit', '-qm', 'unknown')
  const copyBefore = copyTree(copies)
  await expect(copies.sync(world, { ref: 'unit-b' })).rejects.toThrow(/git submodule Packages\/lib at 111111111111 is not checked out/)
  expect(copyTree(copies)).toEqual(copyBefore)
}, 90000)

const GiB = 2 ** 30
const plentyOfSpace = async () => ({ bavail: 100n * BigInt(GiB), bsize: 1n, blocks: 200n * BigInt(GiB) })

it('cleans copies unplayed for 24 hours, keeping recent copies and aging never-played copies from creation', async () => {
  const copies = make({ statfs: plentyOfSpace }), now = Date.now()
  const old = await copies.ensure(world, 'Game')
  await copies.playing(world, now - PLAYER_COPY_MAX_AGE_MS - 1)
  const recentWorld = makeWorld(path.join(root, 'recent'))
  const recent = await copies.ensure(recentWorld, 'Game')
  await copies.playing(recentWorld, now - PLAYER_COPY_MAX_AGE_MS)
  const neverWorld = makeWorld(path.join(root, 'never'))
  const never = await copies.ensure(neverWorld, 'Game')
  const file = path.join(copies.dir, never.key, 'instance.json')
  fs.writeFileSync(file, JSON.stringify({ ...never, createdAt: now - PLAYER_COPY_MAX_AGE_MS - 1 }))
  const freshWorld = makeWorld(path.join(root, 'fresh'))
  await copies.ensure(freshWorld, 'Game')
  const before = snapshot(world)
  expect((await copies.cleanup({ now })).map(r => r.project).sort()).toEqual([world, neverWorld].sort())
  expect(fs.existsSync(old.dir)).toBe(false)
  expect(fs.existsSync(never.dir)).toBe(false)
  expect(copies.status(recentWorld)?.id).toBe(recent.id)
  expect(copies.status(freshWorld)?.state).toBe('ready')
  expect(snapshot(world)).toEqual(before)
}, 60000)

it('skips old copies with editor PIDs, a live foreign owner, or a lifecycle operation', async () => {
  const copies = make({ statfs: plentyOfSpace }), now = Date.now()
  const rec = await copies.ensure(world, 'Game')
  await copies.playing(world, now - PLAYER_COPY_MAX_AGE_MS - 1)
  for (const [file, field] of [['Library/EditorInstance.json', 'process_id'], ['Library/Pipeline/.unity-pipeline-port', 'pid']]) {
    write(path.join(rec.root, file), JSON.stringify({ [field]: process.pid }))
    expect(await copies.cleanup({ now })).toEqual([])
    expect(copies.status(world)?.state).toBe('ready')
    fs.rmSync(path.join(rec.root, file))
  }
  expect(await copies.cleanup({ now, isInUse: copy => copy.project === world })).toEqual([])
  const file = path.join(copies.dir, rec.key, 'instance.json'), original = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), owner: { pid: process.ppid, created: 'PARENT' } }))
  const other = new PlayerCopies(data, { statfs: plentyOfSpace, system: { created: async pid => pid === process.ppid ? 'PARENT' : 'T0' } })
  expect(await other.cleanup({ now })).toEqual([])
  expect(copies.status(world)?.id).toBe(rec.id)
  fs.writeFileSync(file, original)
  expect((await copies.cleanup({ now }))[0].deleted).toBe(true)
})

it('never cancels or deletes an active sync during cleanup', async () => {
  let release!: () => void, started = false
  const gate = new Promise<void>(r => { release = r })
  const copies = make({ statfs: plentyOfSpace, io: { copyFile: async (from, to) => { started = true; await gate; await fs.promises.copyFile(from, to) } } })
  const rec = await copies.ensure(world, 'Game'), now = Date.now()
  await copies.playing(world, now - PLAYER_COPY_MAX_AGE_MS - 1)
  const syncing = copies.sync(world, { path: world })
  try {
    while (!started) await sleep(5)
    expect(await copies.cleanup({ now })).toEqual([])
    expect(copies.status(world)?.state).toBe('syncing')
  } finally { release() }
  await syncing
  expect(copies.status(world)?.id).toBe(rec.id)
}, 60000)

it('rechecks lifecycle use after a disk query before marking a copy for deletion', async () => {
  let busy = false
  const copies = make({ statfs: async () => { busy = true; return { bavail: 1n, bsize: 1n, blocks: 100n } } })
  const rec = await copies.ensure(world, 'Game')
  expect(await copies.cleanup({ isInUse: () => busy })).toEqual([])
  expect(copies.status(world)).toMatchObject({ id: rec.id, state: 'ready' })
})

it('on low disk deletes least recently played first, measures the copy volume and stops when space recovers', async () => {
  const queried: string[] = [], now = Date.now()
  let firstDir = '', secondDir = ''
  const copies = make({ statfs: async dir => {
    queried.push(dir)
    // More than 15 GiB free, but under 10% until the two oldest copies have gone.
    const low = fs.existsSync(firstDir) || fs.existsSync(secondDir)
    return { bavail: BigInt((low ? 20 : 40) * GiB), bsize: 1n, blocks: BigInt(300 * GiB) }
  } })
  firstDir = (await copies.ensure(world, 'Game')).dir
  await copies.playing(world, now - 3000)
  const second = makeWorld(path.join(root, 'second')), third = makeWorld(path.join(root, 'third'))
  secondDir = (await copies.ensure(second, 'Game')).dir
  await copies.playing(second, now - 2000)
  const newest = await copies.ensure(third, 'Game')
  await copies.playing(third, now - 1000)
  expect((await copies.cleanup({ now })).map(r => r.project)).toEqual([world, second])
  expect(queried).toEqual([firstDir, secondDir, newest.dir])
  expect(copies.status(third)?.id).toBe(newest.id)
}, 60000)

it('uses the absolute free-space threshold and keeps recent copies when their volume cannot be read', async () => {
  const low = make({ statfs: async () => ({ bavail: BigInt(14 * GiB), bsize: 1n, blocks: BigInt(50 * GiB) }) })
  await low.ensure(world, 'Game')
  expect((await low.cleanup())[0].deleted).toBe(true)
  const unavailable = make({ statfs: async () => { throw new Error('volume unavailable') } })
  const rec = await unavailable.ensure(world, 'Game')
  expect(await unavailable.cleanup()).toEqual([])
  expect(unavailable.status(world)?.id).toBe(rec.id)
})

it.skipIf(!hasLfs)('reads LFS-tracked files as they are on disk without git-lfs writing into the source', async () => {
  const lfs = ['filter.lfs.clean=git-lfs clean -- %f', 'filter.lfs.smudge=git-lfs smudge -- %f', 'filter.lfs.process=git-lfs filter-process', 'filter.lfs.required=true']
  for (const kv of lfs) { const at = kv.indexOf('='); git(world, 'config', kv.slice(0, at), kv.slice(at + 1)) }
  write(path.join(world, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
  write(path.join(world, 'Game', 'Assets', 'Tex.bin'), Buffer.alloc(3000, 1))
  write(path.join(world, 'Game', 'Assets', 'Other.bin'), Buffer.alloc(3000, 2))
  git(world, 'add', '.'); git(world, 'commit', '-qm', 'lfs')
  // A modified LFS file and a stat-dirty one: git status would run git-lfs clean on both.
  write(path.join(world, 'Game', 'Assets', 'Tex.bin'), Buffer.alloc(3000, 9))
  const touched = path.join(world, 'Game', 'Assets', 'Other.bin'); fs.utimesSync(touched, new Date(), new Date(Date.now() + 5000))
  const copies = make()
  await copies.ensure(world, 'Game')
  const before = snapshot(world)
  await copies.sync(world, { path: world })
  expect(snapshot(world)).toEqual(before)
  expect(fs.readFileSync(path.join(copies.status(world)!.root, 'Assets', 'Tex.bin'))).toEqual(Buffer.alloc(3000, 9))
  expect(fs.readFileSync(path.join(copies.status(world)!.root, 'Assets', 'Other.bin'))).toEqual(Buffer.alloc(3000, 2))
}, 60000)

it('cancels a slow first copy between files, reports progress, and finishes on the next sync', async () => {
  for (let i = 0; i < 40; i++) write(path.join(world, 'Game', 'Assets', 'Many', `f${i}.txt`), `file ${i}\n`.repeat(200))
  git(world, 'add', '.'); git(world, 'commit', '-qm', 'many')
  let n = 0
  const phases = new Set<string>()
  const copies = make({ io: { copyFile: async (from, to) => { if (++n === 5) copies.cancel(world); await sleep(15); await fs.promises.copyFile(from, to) } } })
  const rec = await copies.ensure(world, 'Game')
  await expect(copies.sync(world, { path: world }, { onProgress: p => phases.add(p.phase) })).rejects.toThrow(/Sync cancelled/)
  expect(phases.has('copying')).toBe(true)
  expect(copies.status(world)).toMatchObject({ state: 'ready', lastSync: { complete: false, cancelled: true } })
  // Staged, not applied: the copy Unity opens is untouched until every file was read.
  expect(copyTree(copies)).toEqual({})
  const staged = Object.keys(JSON.parse(fs.readFileSync(path.join(rec.dir, '.mirror-staging', 'staged.json'), 'utf8')).files).length
  expect(staged).toBeGreaterThan(0)
  expect(staged).toBeLessThan(Object.keys(expected(world)).length)
  n = -1000
  const report = await copies.sync(world, { path: world })
  expect(copyTree(copies)).toEqual(expected(world))
  // Files staged before the cancel are not read again, and the staging folder is gone once applied.
  expect(report.staged?.reused).toBeGreaterThanOrEqual(staged - 16)
  expect(fs.existsSync(path.join(rec.dir, '.mirror-staging'))).toBe(false)
  expect(copies.status(world)?.lastSync).toMatchObject({ complete: true })
}, 60000)

/** A unit's worktree of the test project, as Genio deploys one. */
function unitWorktree(name = 'unit'): string {
  const dir = path.join(root, name)
  git(world, 'worktree', 'add', '-q', '-b', `genio/${name}`, dir)
  return dir
}
/** What Genio's cleanup does after a merge: the worktree and its branch go. */
function removeWorktree(dir: string): void {
  try { git(world, 'worktree', 'remove', '--force', dir) } catch { /* a file still open (Windows): removed by hand, then pruned */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  git(world, 'worktree', 'prune')
}

it('a source removed before the sync starts stops it as SOURCE_GONE and leaves the previous copy', async () => {
  const unit = unitWorktree()
  const copies = make()
  await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const before = copyTree(copies)
  removeWorktree(unit)
  const failure = await copies.sync(world, { path: unit }).catch(e => e)
  expect(failure).toMatchObject({ code: 'SOURCE_GONE' })
  expect(copyTree(copies)).toEqual(before)
  expect(copies.status(world)).toMatchObject({ state: 'ready', lastSync: { complete: false, sourceGone: true } })
}, 60000)

it('a unit worktree removed mid-copy never leaves a half-synced copy, and the next sync from main is whole', async () => {
  const unit = unitWorktree()
  for (let i = 0; i < 30; i++) write(path.join(unit, 'Game', 'Assets', 'Unit', `u${i}.txt`), `unit work ${i}\n`.repeat(100))
  write(path.join(unit, 'Game', 'Assets', 'A.cs'), 'class A { int unitEdit; }\n')
  fs.rmSync(path.join(unit, 'Game', 'Assets', 'Old.txt'))
  let n = 0
  const copies = make({ io: { copyFile: async (from, to) => { if (from.startsWith(unit) && ++n === 6) removeWorktree(unit); await fs.promises.copyFile(from, to) } } })
  await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const before = copyTree(copies)
  const failure = await copies.sync(world, { path: unit }).catch(e => e)
  expect(failure).toMatchObject({ code: 'SOURCE_GONE' })
  expect(fs.existsSync(unit)).toBe(false)
  // Nothing of the unit landed: not its new files, not its edit, and Old.txt (deleted in the unit) is still there.
  expect(copyTree(copies)).toEqual(before)
  expect(copies.status(world)?.lastSync).toMatchObject({ complete: false, sourceGone: true })
  const report = await copies.sync(world, { path: world })
  expect(copyTree(copies)).toEqual(expected(world))
  expect(report.files).toMatchObject({ added: 0, updated: 0, deleted: 0 })
}, 60000)

it('a deleted branch source is SOURCE_GONE too', async () => {
  git(world, 'branch', 'feature')
  const copies = make()
  await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  git(world, 'branch', '-D', 'feature')
  await expect(copies.sync(world, { ref: 'feature' })).rejects.toMatchObject({ code: 'SOURCE_GONE' })
}, 60000)

it.skipIf(process.platform !== 'win32')('cancels the Library seed too, leaving no half-copied Library', async () => {
  const copies = make({ clone: { system: { platform: () => 'linux' } } as never, io: { run: async () => { copies.cancel(world); throw Object.assign(new Error('robocopy stopped'), { code: 'ABORT_ERR' }) } } })
  const rec = await copies.ensure(world, 'Game')
  await expect(copies.sync(world, { path: world })).rejects.toThrow(/Sync cancelled/)
  expect(fs.existsSync(path.join(rec.root, 'Library'))).toBe(false)
  expect(fs.readdirSync(path.join(rec.root, 'Temp')).filter(n => n.startsWith('genio-library-seed-'))).toEqual([])
  const done = await new PlayerCopies(data, { system: { created: async () => 'T0' } }).sync(world, { path: world })
  expect(done.library).toMatchObject({ seed: { seeded: true } })
  expect(done.files).toMatchObject({ unchanged: done.files.source })
}, 60000)

it('refuses a sync the disk cannot hold, before writing anything', async () => {
  const copies = make({ statfs: async () => ({ bavail: 1n, bsize: 1n }) })
  const rec = await copies.ensure(world, 'Game')
  await expect(copies.sync(world, { path: world })).rejects.toThrow(/Not enough free space/)
  expect(fs.existsSync(path.join(rec.root, 'Assets'))).toBe(false)
  await expect(copies.sync(world, { path: path.join(root, 'elsewhere') })).rejects.toThrow(/not found/)
  const other = makeWorld(path.join(root, 'other'))
  await expect(copies.sync(world, { path: other })).rejects.toThrow(/must be a checkout of this project/)
})

it('keeps the copy after every editor shutdown, including a zero idle time', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game'); await copies.sync(world, { path: world })
  await copies.stopped(world, 1000, 60000)
  for (const reason of ['the player stopped Unity', 'idle timeout', 'Genio exit', 'editor exited']) {
    expect(await copies.editorGone(world, reason, { manual: true, idleMs: 0 })).toMatchObject({ kept: true, record: { state: 'ready', id: rec.id } })
    await copies.settle()
    expect(copies.status(world)?.deadline).toBeUndefined()
    expect(fs.readFileSync(path.join(rec.root, 'Library/ArtifactDB'), 'utf8')).toBe('warm cache')
  }
  expect(await copies.delete(world)).toEqual({ deleted: true })
})
it('tracks the editor idle deadline, and explicit deletion waits until Unity has let go of the copy', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  await copies.playing(world, 500)
  expect((await copies.stopped(world, 1000, 60000))).toMatchObject({ stoppedAt: 1000, deadline: 61000, idleMs: 60000 })
  expect(copies.due(60999)).toEqual([])
  expect(copies.due(61000).map(r => r.project)).toEqual([world])
  expect((await copies.playing(world))?.deadline).toBeUndefined()
  // Read-only files and paths beyond Windows' 260 characters.
  const ro = path.join(rec.root, 'Assets', 'ReadOnly.txt'); write(ro, 'x'); fs.chmodSync(ro, 0o444)
  let deep = path.join(rec.root, 'Assets', 'Deep')
  while (deep.length < 300) deep = path.join(deep, 'a-rather-long-folder-name')
  write(path.join(deep, 'leaf.txt'), 'deep')
  expect(path.join(deep, 'leaf.txt').length).toBeGreaterThan(260)
  // Unity still has the copy open: the deletion waits, marked pending.
  write(path.join(rec.root, 'Library', 'EditorInstance.json'), JSON.stringify({ process_id: process.pid }))
  const before = snapshot(world)
  expect((await copies.deleteInBackground(world, { reason: 'the player deleted it' })).deleted).toBe(false)
  await copies.settle()
  expect(copies.status(world)).toMatchObject({ state: 'pending-delete', deletion: { reason: 'the player deleted it', blocked: expect.stringMatching(/Unity still has the copy open \(PID \d+\)/) } })
  expect(fs.existsSync(rec.root)).toBe(true)
  fs.rmSync(path.join(rec.root, 'Library', 'EditorInstance.json'))
  expect(await copies.delete(world)).toEqual({ deleted: true })
  expect(fs.existsSync(rec.dir)).toBe(false)
  expect(copies.status(world)).toBeUndefined()
  expect(copies.list()).toEqual([])
  expect(snapshot(world)).toEqual(before)
  // The next Play seeds a new copy.
  const next = await copies.ensure(world, 'Game')
  expect(next.id).not.toBe(rec.id)
  expect((await copies.sync(world, { path: world })).first).toBe(true)
}, 60000)

it('never deletes a folder that is not its marked copy', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  const marker = path.join(rec.dir, 'genio-player-copy.json')
  const original = fs.readFileSync(marker, 'utf8')
  fs.writeFileSync(marker, JSON.stringify({ kind: 'genio-player-copy', id: 'someone-else' }))
  await copies.delete(world)
  expect(copies.status(world)).toMatchObject({ state: 'pending-delete', deletion: { blocked: expect.stringMatching(/no matching Genio marker/) } })
  expect(fs.existsSync(rec.root)).toBe(true)
  fs.writeFileSync(marker, original)
  // A record pointing at the project itself (tampered) is refused before anything is touched.
  const file = path.join(data, 'player-copies', rec.key, 'instance.json')
  const tampered = { ...JSON.parse(fs.readFileSync(file, 'utf8')), dir: world, root: path.join(world, 'Game') }
  fs.writeFileSync(file, JSON.stringify(tampered))
  const before = snapshot(world)
  await copies.delete(world)
  expect(copies.status(world)?.deletion?.blocked).toMatch(/not a player-copy folder/)
  expect(snapshot(world)).toEqual(before)
  // A copy holding a .git (a checkout) is refused too.
  fs.writeFileSync(file, JSON.stringify({ ...tampered, dir: rec.dir, root: rec.root }))
  fs.mkdirSync(path.join(rec.dir, 'world', '.git'))
  await copies.delete(world)
  expect(copies.status(world)?.deletion?.blocked).toMatch(/looks like a git checkout/)
  expect(fs.existsSync(rec.root)).toBe(true)
}, 60000)

it('revives a copy waiting to be deleted instead of seeding a new one', async () => {
  const copies = make()
  const rec = await copies.ensure(world, 'Game')
  await copies.sync(world, { path: world })
  write(path.join(rec.root, 'Library', 'EditorInstance.json'), JSON.stringify({ process_id: process.pid }))
  await copies.deleteInBackground(world)
  await copies.settle()
  expect(copies.status(world)?.state).toBe('pending-delete')
  fs.rmSync(path.join(rec.root, 'Library', 'EditorInstance.json'))
  const revived = await copies.ensure(world, 'Game')
  expect(revived).toMatchObject({ id: rec.id, state: 'ready', revivedAt: expect.any(Number) })
  expect(revived.deletion).toBeUndefined()
  const report = await copies.sync(world, { path: world })
  expect(report.files).toMatchObject({ unchanged: report.files.source, added: 0 })
  expect(report.library?.seed).toBeUndefined()

  // Revived mid-deletion: whatever was deleted comes back, and the Library is whole or reseeded.
  for (let i = 0; i < 200; i++) write(path.join(world, 'Game', 'Assets', 'Bulk', `b${i}.txt`), 'bulk\n')
  await copies.sync(world, { path: world })
  const pending = copies.deleteInBackground(world)
  await sleep(5)
  await copies.ensure(world, 'Game')
  await pending
  await copies.settle()
  const status = copies.status(world)
  if (status) {
    expect(status.state).toBe('ready')
    await copies.sync(world, { path: world })
    await copies.settle()
    expect(copyTree(copies)).toEqual(expected(world))
    expect(fs.readFileSync(path.join(rec.root, 'Library', 'ArtifactDB'), 'utf8')).toBe('warm cache')
    expect(fs.existsSync(path.join(rec.dir, 'trash'))).toBe(false)
  }
}, 60000)

it('keeps one record per project, lists them, sizes them and estimates a first copy', async () => {
  const second = makeWorld(path.join(root, 'second'))
  const copies = make()
  await copies.ensure(world, 'Game')
  await copies.ensure(second, 'Game')
  await copies.sync(world, { path: world })
  await copies.sync(second, { path: second })
  expect(copies.list().map(r => r.project).sort()).toEqual([second, world].sort())
  expect(copies.status(world)!.dir).not.toBe(copies.status(second)!.dir)
  const sizes = await copies.sizes(world, 'Game')
  expect(sizes).toMatchObject({ exists: true, state: 'ready', libraryBytes: 'warm cache'.length, stashBytes: 0 })
  expect(sizes.projectBytes).toBeGreaterThan(2048)
  expect(sizes.totalBytes).toBe(sizes.projectBytes! + sizes.libraryBytes! + sizes.stashBytes! + sizes.trashBytes!)
  await copies.delete(second)
  const estimate = await copies.sizes(second, 'Game')
  expect(estimate).toMatchObject({ exists: false, estimate: { libraryBytes: 'warm cache'.length, files: Object.keys(expected(second)).length } })
  expect(copies.list().map(r => r.project)).toEqual([world])
  // A copy owned by another live Genio (here: the parent process) is not taken over.
  const file = path.join(data, 'player-copies', copies.keyOf(world), 'instance.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), owner: { pid: process.ppid, created: 'PARENT' } }))
  const busy = new PlayerCopies(data, { system: { created: async pid => pid === process.ppid ? 'PARENT' : 'T1' } })
  await expect(busy.ensure(world, 'Game')).rejects.toThrow(/belongs to another running Genio/)
  await expect(busy.sync(world, { path: world })).rejects.toThrow(/belongs to another running Genio/)
}, 90000)

it('the startup sweep finishes explicit deletions and keeps copies whose Genio session is gone', async () => {
  const second = makeWorld(path.join(root, 'second'))
  const third = makeWorld(path.join(root, 'third'))
  const old = new PlayerCopies(data, { system: { created: async () => 'DEAD' } })
  const a = await old.ensure(world, 'Game'); await old.sync(world, { path: world })
  const b = await old.ensure(second, 'Game'); await old.sync(second, { path: second })
  const c = await old.ensure(third, 'Game'); await old.sync(third, { path: third })
  // third is still open in Unity; second was left pending by an exit mid-deletion.
  write(path.join(c.root, 'Library', 'EditorInstance.json'), JSON.stringify({ process_id: process.pid }))
  const file = path.join(data, 'player-copies', b.key, 'instance.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'pending-delete', deletion: { reason: 'the player deleted it' } }))
  // A marked copy folder that lost its record.
  const stray = path.join(data, 'player-copies', 'f'.repeat(24), 'copy')
  write(path.join(stray, 'genio-player-copy.json'), JSON.stringify({ kind: 'genio-player-copy', id: 'x' }))
  write(path.join(stray, 'world', 'Assets', 'x.txt'), 'x')
  // The new session: the old one's PID is this process, but its creation time differs, so it is gone.
  const fresh = new PlayerCopies(data, { system: { created: async () => 'NEW' } })
  const swept = await fresh.sweep()
  expect(swept.map(s => [s.project ?? s.key, s.action]).sort()).toEqual([[world, 'kept'], [second, 'deleting'], [third, 'editor-running'], ['f'.repeat(24), 'stray-deleted']].sort())
  await fresh.settle()
  expect(fs.existsSync(a.dir)).toBe(true)
  expect(fs.existsSync(b.dir)).toBe(false)
  expect(fs.existsSync(stray)).toBe(false)
  expect(fs.existsSync(c.root)).toBe(true)
  expect(fresh.list().map(r => r.project).sort()).toEqual([world, third].sort())

  // Keeping copies is one policy switch.
  const keep = new PlayerCopies(data, { system: { created: async () => 'NEW' }, policy: { keepCopyWhenEditorQuits: true } })
  fs.rmSync(path.join(c.root, 'Library', 'EditorInstance.json'))
  expect(await keep.editorGone(third)).toMatchObject({ kept: true })
  expect(fs.existsSync(c.root)).toBe(true)
}, 90000)
