import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cloneMethod, parseProbe, probeClone, seedTree, sharedExtents, volumeChild, volumeHome, volumeKey, volumePlacement, volumeVerification, windowsBuild,
  type CloneSystem, type VolumeInfo
} from '../resources/unit-skills/genio/skills/play/scripts/clone.mjs'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { seedLibrary } from '../resources/unit-skills/genio/lib/unity-seed.mjs'
import { Home, placeWorktree } from '../src/main/home'
import { worldOf } from '../src/main/usage'

const REFS = 0x08000000 | 0x3c7f02ff
const NTFS = 0x03e700ff
// Real `fsutil file queryExtentsAndRefCounts` lines have this shape on ReFS; NTFS answers "Incorrect function."
const SHARED = 'VCN: 0x0        Clusters: 0x800       LCN: 0x1a400      Ref: 0x2\r\nVCN: 0x800      Clusters: 0x10        LCN: 0x2b000      Ref: 0x1\r\n'
const UNSHARED = 'VCN: 0x0        Clusters: 0x810       LCN: 0x1a400      Ref: 0x1\r\n'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-dev-drive-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const volume = (p: string, over: Partial<VolumeInfo> = {}): VolumeInfo => ({ path: p, root: path.parse(path.resolve(p)).root, guid: '\\\\?\\Volume{dev}\\', fs: 'ReFS', flags: REFS, cluster: 4096, driveType: 3, blockClone: true, ...over })
/** A Windows machine whose temp folder sits on a Dev Drive (not the system drive). */
function devDrive(over: Partial<CloneSystem> = {}, calls: { helper: string[][]; fsutil: string[] } = { helper: [], fsutil: [] }): Partial<CloneSystem> {
  return {
    platform: () => 'win32', systemDrive: () => '', mounted: () => true, build: () => 22631,
    probe: async paths => paths.map(p => volume(p)),
    helper: async (list, cluster) => {
      expect(cluster).toBe(4096)
      const pairs = fs.readFileSync(list, 'utf8').split('\r\n').map(l => l.split('\t').map(p => p.replace(/^\\\\\?\\/, '')))
      calls.helper.push(...pairs)
      for (const [from, to] of pairs) fs.copyFileSync(from, to)
      return { cloned: pairs.length, copied: 0, failed: 0, error: 0 }
    },
    fsutil: async file => { calls.fsutil.push(file); return SHARED },
    ...over
  }
}
function tree(dir: string): void {
  fs.mkdirSync(path.join(dir, 'Artifacts', 'ab'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'Pipeline'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Artifacts', 'ab', 'big.bin'), Buffer.alloc(200 * 1024, 1))
  fs.writeFileSync(path.join(dir, 'Artifacts', 'edge.bin'), Buffer.alloc(4096, 2))
  fs.writeFileSync(path.join(dir, 'tiny.txt'), 'tiny')
  fs.writeFileSync(path.join(dir, 'EditorInstance.json'), '{}')
  fs.writeFileSync(path.join(dir, 'Pipeline', 'port'), 'secret')
}
const skip = (n: string): boolean => ['Pipeline', 'EditorInstance.json'].includes(n)

describe('volume probe parsing', () => {
  it('reads the Windows build and picks CopyFile cloning from 24H2', () => {
    expect(windowsBuild('10.0.22631')).toBe(22631)
    expect(cloneMethod(22631)).toBe('fsctl')
    expect(cloneMethod(26100)).toBe('copyfile')
    expect(cloneMethod(26200)).toBe('copyfile')
  })
  it('needs FILE_SUPPORTS_BLOCK_REFCOUNTING on a fixed drive', () => {
    expect(parseProbe(`D:\\git\tD:\\\t\\\\?\\Volume{a}\\\t1\tReFS\t${REFS}\t4096\t3`)).toMatchObject({ root: 'D:\\', guid: '\\\\?\\Volume{a}\\', fs: 'ReFS', cluster: 4096, blockClone: true })
    expect(parseProbe(`C:\\x\tC:\\\t\\\\?\\Volume{c}\\\t2\tNTFS\t${NTFS}\t4096\t3`)).toMatchObject({ fs: 'NTFS', blockClone: false })
    expect(parseProbe(`Z:\\x\tZ:\\\t\t7\tReFS\t${REFS}\t4096\t4`)).toMatchObject({ guid: 'serial:7', blockClone: false })
    expect(parseProbe('Q:\\x\t!21')).toEqual({ path: 'Q:\\x', error: 'GetVolumeInformation failed (21)' })
  })
  it('reads shared extents from fsutil', () => {
    expect(sharedExtents(SHARED)).toBe(true)
    expect(sharedExtents(UNSHARED)).toBe(false)
    expect(sharedExtents('RefCount: 3')).toBe(true)
    expect(sharedExtents('error: Incorrect function.')).toBeNull()
  })
})

describe('probeClone', () => {
  it('clones only on one block-cloning volume', async () => {
    const a = path.join(root, 'a'), b = path.join(root, 'b')
    expect(await probeClone(a, b, { system: devDrive() })).toMatchObject({ capable: true, method: 'fsctl' })
    expect(await probeClone(a, b, { system: devDrive({ build: () => 26100 }) })).toMatchObject({ capable: true, method: 'copyfile' })
    expect(await probeClone(a, b, { system: devDrive({ probe: async ps => [volume(ps[0]), volume(ps[1], { guid: 'other' })] }) })).toMatchObject({ capable: false, reason: expect.stringContaining('different volumes') })
    expect(await probeClone(a, b, { system: devDrive({ probe: async ps => ps.map(p => volume(p, { fs: 'NTFS', flags: NTFS, blockClone: false })) }) })).toMatchObject({ capable: false, reason: expect.stringContaining('(NTFS) does not support block cloning') })
    expect(await probeClone(a, b, { system: devDrive({ probe: async () => { throw new Error('Add-Type blocked') } }) })).toMatchObject({ capable: false, reason: 'volume probe failed (Add-Type blocked)' })
    expect(await probeClone(a, b, { system: devDrive({ platform: () => 'linux' }) })).toMatchObject({ capable: false })
  })
  it('never probes the system drive and reports a detached drive', async () => {
    const probe = async (): Promise<never> => { throw new Error('probed') }
    const here = path.parse(root).root.slice(0, 2)
    expect(await probeClone(root, root, { system: devDrive({ systemDrive: () => here, probe }) })).toMatchObject({ capable: false, reason: expect.stringContaining('system drive') })
    expect(await probeClone(root, root, { system: devDrive({ mounted: () => false, probe }) })).toMatchObject({ capable: false, detached: true, reason: expect.stringContaining('Dev Drive VHDX') })
  })
})

describe('seedTree', () => {
  it('clones large files with the FSCTL helper, copies small ones, skips session files and verifies sharing once', async () => {
    const src = path.join(root, 'src'), data = path.join(root, 'data'), calls = { helper: [] as string[][], fsutil: [] as string[] }
    tree(src)
    const fallback = async (): Promise<never> => { throw new Error('normal copy used') }
    const first = await seedTree(src, path.join(root, 'one', 'Library'), { skip, data, fallback, system: devDrive({}, calls) })
    expect(first).toMatchObject({ method: 'clone', via: 'fsctl', files: 3, cloned: 2, copied: 1, verified: true })
    expect(calls.helper.map(([from]) => path.basename(from)).sort()).toEqual(['big.bin', 'edge.bin'])
    expect(calls.fsutil).toEqual([path.join(root, 'one', 'Library', 'Artifacts', 'ab', 'big.bin')])
    expect(fs.readFileSync(path.join(root, 'one', 'Library', 'tiny.txt'), 'utf8')).toBe('tiny')
    expect(fs.existsSync(path.join(root, 'one', 'Library', 'Pipeline'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'one', 'Library', 'EditorInstance.json'))).toBe(false)
    expect(volumeVerification(data, '\\\\?\\Volume{dev}\\')).toMatchObject({ shared: true, method: 'fsctl' })
    await seedTree(src, path.join(root, 'two', 'Library'), { skip, data, fallback, system: devDrive({}, calls) })
    expect(calls.fsutil).toHaveLength(1)
  })
  it('lets CopyFile clone every file on 24H2', async () => {
    const src = path.join(root, 'src'), calls = { helper: [] as string[][], fsutil: [] as string[] }
    tree(src)
    const r = await seedTree(src, path.join(root, 'dest'), { skip, data: path.join(root, 'data'), fallback: async () => {}, system: devDrive({ build: () => 26100 }, calls) })
    expect(r).toMatchObject({ method: 'clone', via: 'copyfile', files: 3, verified: true })
    expect(calls.helper).toHaveLength(0)
    expect(fs.readFileSync(path.join(root, 'dest', 'Artifacts', 'ab', 'big.bin'))).toEqual(fs.readFileSync(path.join(src, 'Artifacts', 'ab', 'big.bin')))
  })
  it('falls back to the normal copy when cloning is impossible, fails, or was verified not to share', async () => {
    const src = path.join(root, 'src'), data = path.join(root, 'data')
    tree(src)
    let copies = 0
    const fallback = async (): Promise<void> => { copies++ }
    expect(await seedTree(src, path.join(root, 'a'), { skip, data, fallback, system: devDrive({ probe: async ps => ps.map(p => volume(p, { blockClone: false, fs: 'NTFS' })) }) })).toMatchObject({ method: 'copy', reason: expect.stringContaining('NTFS') })
    const broken = await seedTree(src, path.join(root, 'b'), { skip, data, fallback, system: devDrive({ helper: async () => { throw new Error('helper crashed') } }) })
    expect(broken).toMatchObject({ method: 'copy', reason: 'block clone failed (helper crashed)' })
    expect(fs.existsSync(path.join(root, 'b'))).toBe(false)
    const unshared = await seedTree(src, path.join(root, 'c'), { skip, data, fallback, system: devDrive({ fsutil: async () => UNSHARED }) })
    expect(unshared).toMatchObject({ method: 'clone', verified: false })
    expect(await seedTree(src, path.join(root, 'd'), { skip, data, fallback, system: devDrive() })).toMatchObject({ method: 'copy', reason: expect.stringContaining('verified not to share') })
    expect(copies).toBe(3)
  })
  it('keeps a complete copy and stops cloning when the volume refuses every clone', async () => {
    const src = path.join(root, 'src'), data = path.join(root, 'data')
    tree(src)
    const refuse: CloneSystem['helper'] = async list => {
      const pairs = fs.readFileSync(list, 'utf8').split('\r\n').map(l => l.split('\t').map(p => p.replace(/^\\\\\?\\/, '')))
      for (const [from, to] of pairs) fs.copyFileSync(from, to)
      return { cloned: 0, copied: pairs.length, failed: 0, error: 1 }
    }
    const r = await seedTree(src, path.join(root, 'dest'), { skip, data, fallback: async () => { throw new Error('normal copy used') }, system: devDrive({ helper: refuse }) })
    expect(r).toMatchObject({ method: 'copy', reason: expect.stringContaining('Windows error 1'), files: 3 })
    expect(fs.readFileSync(path.join(root, 'dest', 'Artifacts', 'edge.bin')).length).toBe(4096)
    expect(volumeVerification(data, '\\\\?\\Volume{dev}\\')).toMatchObject({ shared: false })
  })
  it.runIf(process.platform === 'win32')('runs the real FSCTL helper, which copies instead on NTFS', async () => {
    const src = path.join(root, 'src'), data = path.join(root, 'data')
    tree(src)
    const r = await seedTree(src, path.join(root, 'dest'), { skip, data, fallback: async () => { throw new Error('normal copy used') }, system: { systemDrive: () => '', build: () => 22631, probe: async ps => ps.map(p => volume(p)) } })
    expect(r).toMatchObject({ method: 'copy', reason: expect.stringContaining('refused block cloning'), files: 3 })
    expect(fs.readFileSync(path.join(root, 'dest', 'Artifacts', 'ab', 'big.bin'))).toEqual(fs.readFileSync(path.join(src, 'Artifacts', 'ab', 'big.bin')))
  }, 60_000)
})

describe('shared Library seeding (unity-seed)', () => {
  function library(dir: string): void {
    tree(dir)
    fs.mkdirSync(path.join(dir, 'PackageCache', 'com.unity.x'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'PackageCache', 'com.unity.x', 'a.cs'), 'x')
    fs.writeFileSync(path.join(dir, 'ArtifactDB-lock'), '')
  }
  const kept = (dir: string): string[] => fs.readdirSync(dir, { recursive: true }).map(String).map(p => p.replace(/\\/g, '/')).sort()
  it('clones a slot or worktree Library on a Dev Drive with the step 4 exclusions', async () => {
    const source = path.join(root, 'Library'), copy = path.join(root, 'copy'), data = path.join(root, 'data'), calls = { helper: [] as string[][], fsutil: [] as string[] }
    library(source)
    const report = await seedLibrary(copy, source, { data, clone: { system: devDrive({}, calls) } })
    expect(report).toMatchObject({ seeded: true, method: 'clone:fsctl', files: 3, clone: { verified: true } })
    expect(kept(path.join(copy, 'Library'))).toEqual(['Artifacts', 'Artifacts/ab', 'Artifacts/ab/big.bin', 'Artifacts/edge.bin', 'tiny.txt'])
    expect(calls.helper).toHaveLength(2)
    expect(fs.readdirSync(path.join(copy, 'Temp'))).toEqual([])
  })
  it('falls back to the step 4 copy after a clone failure, and leaves plain NTFS unchanged', async () => {
    const source = path.join(root, 'Library'), data = path.join(root, 'data')
    library(source)
    const runs: string[][] = []
    const run = async (_file: string, args: string[]): Promise<void> => { runs.push(args); fs.cpSync(args[0], args[1], { recursive: true, filter: p => !/PackageCache|Pipeline|EditorInstance|-lock$/.test(p) }) }
    const broken = await seedLibrary(path.join(root, 'a'), source, { data, platform: 'win32', run, clone: { system: devDrive({ helper: async () => { throw new Error('helper crashed') } }) } })
    expect(broken).toMatchObject({ seeded: true, method: 'robocopy', files: 3, clone: { reason: 'block clone failed (helper crashed)' } })
    expect(runs).toHaveLength(1)
    const plain = await seedLibrary(path.join(root, 'b'), source, { data, platform: 'win32', run, clone: { system: { platform: () => 'win32', systemDrive: () => path.parse(root).root.slice(0, 2), probe: async () => { throw new Error('probed') } } } })
    expect(plain).toMatchObject({ seeded: true, method: 'robocopy', clone: { reason: expect.stringContaining('system drive') } })
    expect(await seedLibrary(path.join(root, 'c'), source, { data, platform: 'win32', run, clone: false })).toMatchObject({ seeded: true, method: 'robocopy' })
    expect(fs.existsSync(path.join(data, 'clone-volumes.json'))).toBe(false)
  })
})

describe('placement on the project volume', () => {
  const capable = (project: string): Partial<CloneSystem> => devDrive({ probe: async ps => ps.map(p => path.parse(p).root === path.parse(project).root ? volume(p, { root: path.parse(p).root, guid: 'dev' }) : volume(p, { guid: 'sys', fs: 'NTFS', blockClone: false })) })
  it('moves copies to a Dev Drive project volume and nowhere else', async () => {
    const project = 'Q:\\git\\lands-of-old'
    expect(await volumePlacement(project, root, { system: capable(project) })).toBe('Q:\\')
    expect(await volumePlacement(project, root, { system: devDrive({ probe: async ps => ps.map(p => volume(p, { blockClone: false })) }) })).toBeUndefined()
    expect(await volumePlacement(project, root, { system: devDrive({ mounted: () => false }) })).toBeUndefined()
    expect(await volumePlacement(root, root, { system: devDrive({ probe: async () => { throw new Error('probed') } }) })).toBeUndefined()
  })
  it('places unit worktrees beside a Dev Drive project and attributes their usage to the world', async () => {
    const home = new Home(path.join(root, 'home'))
    const project = { name: 'lands-of-old', path: 'Q:\\git\\lands-of-old' }
    const wt = await placeWorktree(home, project, 'unit-1', { system: capable(project.path) })
    expect(wt).toBe(path.join('Q:\\', '.genio', volumeKey(home.root), 'worktrees', 'lands-of-old', 'unit-1'))
    expect(worldOf(wt, home.root)).toBe('lands-of-old')
    expect(worldOf(wt, path.join(root, 'other-home'))).toBeUndefined()
    expect(await placeWorktree(home, { name: 'game', path: root }, 'unit-2')).toBe(home.worktreeFor('game', 'unit-2'))
    await expect(placeWorktree(home, project, 'unit-3', { system: devDrive({ mounted: () => false }) })).rejects.toThrow('Attach VHD')
    expect(volumeChild(path.join(volumeHome(home.root, 'Q:\\'), 'play-pools', 'x'), home.root, 'worktrees')).toBeUndefined()
  })
  it('keeps slots where placement.json says, and in the pool folder when that drive is gone or slots already exist', async () => {
    const world = path.join(root, 'world'), data = path.join(root, 'data')
    fs.mkdirSync(world)
    const pool = new PlayPool(data, world)
    expect(pool.slots()).toBe(pool.dir)
    fs.mkdirSync(path.join(pool.dir, 'slot-1'))
    // A pool made before short folders keeps its slots until relocate() moves them.
    expect(await pool.place()).toBe(pool.dir)
    expect(fs.existsSync(path.join(pool.dir, 'placement.json'))).toBe(false)
    const moved = path.join(root, 'devdrive', 'play-pools', 'x')
    fs.writeFileSync(path.join(pool.dir, 'placement.json'), JSON.stringify({ dir: moved }))
    const next = new PlayPool(data, world)
    expect(next.root(2)).toBe(path.join(moved, 'slot-2'))
    fs.writeFileSync(path.join(pool.dir, 'placement.json'), JSON.stringify({ dir: 'Q:\\.genio\\k\\play-pools\\x' }))
    if (!fs.existsSync('Q:\\')) expect(new PlayPool(data, world).slots()).toBe(pool.dir)
  })
})
