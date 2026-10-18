import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { checkFreeSpace, copyLibrary, seedLibrary, treeStats } from '../resources/unit-skills/genio/lib/unity-seed.mjs'

let root: string, source: string, copy: string
const file = (relative: string, body = 'cache'): void => {
  const dest = path.join(source, relative)
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, body)
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-unity-seed-'))
  source = path.join(root, 'source', 'Library'); copy = path.join(root, 'copy')
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(copy)
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

it('seeds an atomic Library with timing and byte counts, PackageCache included and editor state withheld', async () => {
  file('Artifacts/warm', '12345'); file('Bee/warm', '123')
  file('PackageCache/com.unity.collections@a43cabe808ca/package.json', '123456789')
  for (const dir of ['Pipeline', 'Temp', 'Logs']) file(`${dir}/private`, 'never copy')
  for (const name of ['EditorInstance.json', 'ArtifactDB-lock', 'SourceAssetDB-lock', 'Other-lock']) file(name, 'never copy')
  const report = await seedLibrary(copy, source)
  expect(report).toMatchObject({ seeded: true, method: process.platform === 'win32' ? 'robocopy' : 'fs.cp', bytes: 17, files: 3, estimatedBytes: 17 })
  expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
  expect(report.requiredBytes).toBeGreaterThan(17)
  expect(report.availableBytes).toBeGreaterThanOrEqual(report.requiredBytes!)
  expect(fs.readdirSync(path.join(copy, 'Library')).sort()).toEqual(['Artifacts', 'Bee', 'PackageCache'])
  expect(fs.readFileSync(path.join(copy, 'Library/PackageCache/com.unity.collections@a43cabe808ca/package.json'), 'utf8')).toBe('123456789')
  expect(fs.readdirSync(path.join(copy, 'Temp'))).toEqual([])
  file('Artifacts/warm', 'changed')
  expect(await seedLibrary(copy, source)).toMatchObject({ seeded: false, reason: 'exists' })
  expect(fs.readFileSync(path.join(copy, 'Library/Artifacts/warm'), 'utf8')).toBe('12345')
})

it('uses the same exclusions on the non-Windows fallback', async () => {
  file('warm', '123'); file('pipeline/omitted'); file('EditorInstance.JSON'); file('db-LOCK')
  const report = await seedLibrary(copy, source, { platform: 'linux' })
  expect(report).toMatchObject({ method: 'fs.cp', bytes: 3, files: 1 })
  expect(fs.readdirSync(path.join(copy, 'Library'))).toEqual(['warm'])
})

it('never seeds from or into a tree whose submodule packages are not checked out', async () => {
  file('warm', '123')
  const tree = path.dirname(source)
  fs.mkdirSync(path.join(tree, '.git')); fs.mkdirSync(path.join(tree, 'Packages', 'hhg-core'), { recursive: true })
  fs.writeFileSync(path.join(tree, '.gitmodules'), '[submodule "Packages/hhg-core"]\n\tpath = Packages/hhg-core\n\turl = https://example.invalid/core.git\n')
  expect(await seedLibrary(copy, source)).toMatchObject({ seeded: false, reason: 'source-submodules-missing', missing: ['Packages/hhg-core'] })
  fs.writeFileSync(path.join(tree, 'Packages', 'hhg-core', '.git'), 'gitdir: ../../.git/modules/Packages/hhg-core\n')
  expect(await seedLibrary(copy, source)).toMatchObject({ seeded: true })
})

it('skips missing Libraries and refuses an overlapping destination', async () => {
  expect(await seedLibrary(copy, path.join(root, 'missing'))).toMatchObject({ seeded: false, reason: 'missing' })
  await expect(seedLibrary(path.join(source, 'nested'), source)).rejects.toThrow('overlaps')
})

it('checks the target filesystem before creating a staging directory', async () => {
  file('warm')
  const statfs = vi.fn(async () => ({ bavail: 1n, bsize: 4096n }))
  await expect(seedLibrary(copy, source, { statfs })).rejects.toThrow('Not enough free space')
  expect(statfs).toHaveBeenCalledWith(copy, { bigint: true })
  expect(fs.readdirSync(copy)).toEqual([])
  await expect(checkFreeSpace(path.join(copy, 'does/not/exist'), 2 ** 30, { statfs })).rejects.toThrow('available')
  expect(statfs).toHaveBeenLastCalledWith(copy, { bigint: true })
})

it('removes a failed staging copy without publishing Library and can retry', async () => {
  file('warm')
  const run = vi.fn(async (_: string, args: string[]) => {
    fs.writeFileSync(path.join(args[1], 'partial'), 'incomplete')
    throw Object.assign(new Error('copy failure'), { code: 8 })
  })
  await expect(seedLibrary(copy, source, { platform: 'win32', run })).rejects.toThrow('robocopy failed')
  expect(fs.existsSync(path.join(copy, 'Library'))).toBe(false)
  expect(fs.readdirSync(path.join(copy, 'Temp'))).toEqual([])
  expect(await seedLibrary(copy, source)).toMatchObject({ seeded: true, bytes: 5 })
})

it('refuses junctions and hardlinks in the seed and a junction at destination Temp', async () => {
  file('warm')
  fs.linkSync(path.join(source, 'warm'), path.join(source, 'hard'))
  await expect(seedLibrary(copy, source)).rejects.toThrow('hardlinks')
  fs.unlinkSync(path.join(source, 'hard'))
  const external = path.join(root, 'external'); fs.mkdirSync(external)
  fs.symlinkSync(external, path.join(source, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(seedLibrary(copy, source)).rejects.toThrow('junctions')
  fs.unlinkSync(path.join(source, 'outside'))
  fs.symlinkSync(external, path.join(copy, 'Temp'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(seedLibrary(copy, source)).rejects.toThrow('junctions')
  expect(fs.readdirSync(external)).toEqual([])
})

it('checks the finished seed for unsafe links before publishing', async () => {
  file('warm')
  const run = async (_: string, args: string[]): Promise<void> => { fs.linkSync(path.join(source, 'warm'), path.join(args[1], 'hard')) }
  await expect(seedLibrary(copy, source, { platform: 'win32', run })).rejects.toThrow('hardlinks')
  expect(fs.existsSync(path.join(copy, 'Library'))).toBe(false)
  expect(fs.readdirSync(path.join(copy, 'Temp'))).toEqual([])
})

it('runs robocopy with 16 workers and exclusions, accepting success codes 0–7 only', async () => {
  const run = vi.fn(async () => {})
  expect(await copyLibrary(source, copy, { platform: 'win32', run })).toBe('robocopy')
  expect(run).toHaveBeenCalledWith('robocopy.exe', expect.arrayContaining(['/MT:16', '/XJ', '/XD', 'Pipeline', 'Temp', 'Logs', '/XF', 'EditorInstance.json', '*-lock', '/R:1', '/W:1']), expect.objectContaining({ windowsHide: true }))
  for (let code = 0; code < 8; code++) {
    run.mockRejectedValueOnce(Object.assign(new Error('robocopy'), { code }))
    await expect(copyLibrary(source, copy, { platform: 'win32', run })).resolves.toBe('robocopy')
  }
  for (const code of [8, 16, 'ENOENT', -1]) {
    run.mockRejectedValueOnce(Object.assign(new Error('robocopy'), { code }))
    await expect(copyLibrary(source, copy, { platform: 'win32', run })).rejects.toThrow('failed')
  }
})

it('counts PackageCache but not the excluded Pipeline bytes in the Library footprint', async () => {
  file('warm', '12345'); file('PackageCache/package', '0123456789'); file('Pipeline/token', 'abc')
  expect(await treeStats(source, { library: true })).toEqual({ bytes: 15, files: 2 })
  expect(await treeStats(source)).toEqual({ bytes: 18, files: 3 })
})
