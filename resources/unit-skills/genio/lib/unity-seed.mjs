/** Shared Library seeding for Play slots and unit worktrees. Node standard library only. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { seedTree } from '../skills/play/scripts/clone.mjs'
import { missingSubmodules } from './git-submodules.mjs'
const exec = promisify(execFile)
// PackageCache is seeded: UPM resolves from it without the network. Withheld, a copy without registry access (or with a
// slow one) sits in Package Manager until Unity gives up after 60 seconds and quits.
const SKIP_DIRS = ['Pipeline', 'Temp', 'Logs']
const excluded = (name, directory) => directory ? SKIP_DIRS.some(v => v.toLowerCase() === name.toLowerCase()) : /^EditorInstance\.json$|.*-lock$/i.test(name)
const linkError = p => new Error(`Unity copies cannot contain symlinks, junctions or hardlinks: ${p}`)

/** Check existing ancestors, including junctions at Temp or the copy root, before writing. */
export async function checkCopyPath(p) {
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    try { if ((await fs.promises.lstat(current)).isSymbolicLink()) throw linkError(current) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (path.dirname(current) === current) break
  }
}

/** One bounded scan supplies size/file telemetry and refuses links without following them. */
export async function treeStats(root, { library = false, rejectLinks = true } = {}) {
  let bytes = 0, files = 0
  const scan = async p => {
    const stat = await fs.promises.lstat(p)
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1 && rejectLinks) {
      if (rejectLinks) throw linkError(p)
      if (stat.isSymbolicLink()) return
    }
    if (stat.isFile()) { bytes += stat.size; files++; return }
    if (!stat.isDirectory()) throw new Error(`Unsupported Unity copy entry: ${p}`)
    const entries = await fs.promises.readdir(p, { withFileTypes: true })
    // Parallelize file stats, while keeping directory recursion bounded.
    const kept = entries.filter(e => !library || !excluded(e.name, e.isDirectory()))
    const names = kept.filter(e => !e.isDirectory()).map(e => path.join(p, e.name))
    for (let at = 0; at < names.length; at += 16) await Promise.all(names.slice(at, at + 16).map(scan))
    for (const e of kept.filter(e => e.isDirectory())) await scan(path.join(p, e.name))
  }
  await checkCopyPath(root)
  await scan(root)
  return { bytes, files }
}

/** Free bytes for the target filesystem, even before the target directory exists. */
export async function checkFreeSpace(target, bytes, { statfs = fs.promises.statfs } = {}) {
  await checkCopyPath(target)
  let ancestor = path.resolve(target)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const stat = await statfs(ancestor, { bigint: true })
  const availableBytes = Number(stat.bavail * stat.bsize)
  // Leave room for metadata, concurrent writes and the import following the seed.
  const requiredBytes = Math.ceil(bytes + Math.max(256 * 1024 * 1024, bytes * 0.1))
  if (availableBytes < requiredBytes) {
    const gib = n => (n / 2 ** 30).toFixed(2)
    throw new Error(`Not enough free space for Unity copy at ${target}: need ${gib(requiredBytes)} GiB (${bytes} copy bytes plus reserve), available ${gib(availableBytes)} GiB`)
  }
  return { availableBytes, requiredBytes }
}

/**
 * Block clones when source and dest share a Dev Drive (or other block-cloning volume); otherwise, and after
 * any clone failure, the normal copy below. Returns the method plus the clone attempt's report.
 */
export async function cloneOrCopyLibrary(source, dest, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32' || options.clone === false) return { method: await copyLibrary(source, dest, options) }
  let method
  const clone = await seedTree(source, dest, { skip: excluded, data: options.data, system: options.clone?.system, fallback: async () => { method = await copyLibrary(source, dest, options) } })
  // A volume that refused every clone already left a complete per-file copy.
  return { method: clone.method === 'clone' ? `clone:${clone.via}` : method ?? 'clone-refused-copy', clone }
}

/**
 * A 16-thread robocopy of a whole tree that never copies junctions or symlinks (/XJ). Robocopy uses codes
 * 0–7 for success; 8 and above (and launch errors) are failures.
 */
export async function robocopyTree(source, dest, { run = exec, excludeDirs = [], excludeFiles = [], label = 'robocopy' } = {}) {
  const args = [source, dest, '/E', '/MT:16', '/XJ', '/R:1', '/W:1', '/COPY:DAT', '/DCOPY:DAT', '/NP', '/NFL', '/NDL', '/NJH', '/NJS',
    ...excludeDirs.length ? ['/XD', ...excludeDirs] : [], ...excludeFiles.length ? ['/XF', ...excludeFiles] : []]
  try { await run('robocopy.exe', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }) }
  catch (e) {
    if (!Number.isInteger(e.code) || e.code < 0 || e.code >= 8) throw new Error(`${label} failed (${e.code ?? e.message}): ${e.stderr || e.stdout || ''}`, { cause: e })
  }
  return 'robocopy'
}

export async function copyLibrary(source, dest, { platform = process.platform, run = exec } = {}) {
  if (platform !== 'win32') {
    await fs.promises.cp(source, dest, { recursive: true, filter: async p => !excluded(path.basename(p), (await fs.promises.lstat(p)).isDirectory()) })
    return 'fs.cp'
  }
  return robocopyTree(source, dest, { run, excludeDirs: SKIP_DIRS, excludeFiles: ['EditorInstance.json', '*-lock'], label: 'Library robocopy' })
}

/**
 * source is a Library directory; copy is the destination Unity project root.
 * Publish only a complete, validated seed, PackageCache included, so the first open needs no network resolve.
 * Return a report suitable for a slot's state.json or a wrapper's result.json.
 */
export async function seedLibrary(copy, source, options = {}) {
  const started = Date.now(), library = path.join(copy, 'Library')
  await checkCopyPath(library)
  if (fs.existsSync(library)) return { seeded: false, reason: 'exists', elapsedMs: Date.now() - started }
  await checkCopyPath(source)
  if (!fs.existsSync(source)) return { seeded: false, reason: 'missing', elapsedMs: Date.now() - started }
  // Only Library is copied, never packages: a tree whose submodule packages are not checked out, on either
  // side, would pair a Library with a different package set. Unity then imports from scratch instead.
  for (const [reason, root] of [['submodules-missing', copy], ['source-submodules-missing', path.dirname(path.resolve(source))]]) {
    const missing = missingSubmodules(root)
    if (missing.length) return { seeded: false, reason, missing, elapsedMs: Date.now() - started }
  }
  const relative = path.relative(path.resolve(source), path.resolve(library))
  const reverse = path.relative(path.resolve(library), path.resolve(source))
  const inside = rel => !rel || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)
  if (inside(relative) || inside(reverse)) throw new Error('Library seed source overlaps its destination')
  const planned = await treeStats(source, { library: true })
  const space = await checkFreeSpace(copy, planned.bytes, options)
  const temp = path.join(copy, 'Temp')
  await checkCopyPath(temp)
  await fs.promises.mkdir(temp, { recursive: true })
  const staging = await fs.promises.mkdtemp(path.join(temp, 'genio-library-seed-'))
  try {
    const { method, clone } = await cloneOrCopyLibrary(source, staging, options)
    const actual = await treeStats(staging)
    await checkCopyPath(library)
    await fs.promises.rename(staging, library)
    return { seeded: true, method, ...clone && { clone: { verified: clone.verified, reason: clone.reason } }, ...actual, estimatedBytes: planned.bytes, ...space, elapsedMs: Date.now() - started }
  } finally { await fs.promises.rm(staging, { recursive: true, force: true }) }
}
