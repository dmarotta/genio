/**
 * Git-guided mirror for the player's Play copy. The copy follows one source: a checkout of the project (the
 * main checkout, any worktree, a unit's worktree) as it is on disk right now (tracked, modified and untracked
 * non-ignored files), or a commit with no checkout, read from git objects. Only files whose content differs
 * are copied. A tracked file that is clean in the source's index is identified by its blob id, so switching
 * between checkouts whose files carry different timestamps costs only the changed bytes; dirty and untracked
 * files compare by size and mtime against the manifest of what Genio wrote.
 * The source is only read: git runs without optional locks, fsmonitor or LFS filters (git-lfs clean would
 * store objects in the source's .git), and nothing is written there. Every read lands in a staging folder
 * first; the copy changes only after the whole source was read, so a source that vanishes mid-sync (a unit's
 * worktree merged and removed) leaves the copy exactly as the previous sync left it. Node standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { checkFreeSpace } from './unity-seed.mjs'
import { parseGitmodules } from './git-submodules.mjs'
const exec = promisify(execFile)

// Inherited repository overrides would point every command at the wrong repository.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']
// Empty filter commands make git hash LFS files as they are on disk instead of running git-lfs clean.
const READ_ONLY = ['-c', 'core.fsmonitor=false', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false']
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n(?:.*\r?\n)*oid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/
const POINTER_MAX = 1024
// Never mirrored, never purged: the copy's own Library (and per-version stashes), editor and IDE output.
const SKIP_TOP = new Set(['library', 'temp', 'logs', 'usersettings', 'obj', 'build', 'builds', '.vs', '.idea', '.gradle', 'memorycaptures'])
const SKIP_ROOT_FILE = /\.(csproj|sln|slnx|user|suo|userprefs|pidb|unityproj)$/i
/** Genio's own embedded package in the copy: never mirrored and never purged. */
export const GENIO_PACKAGE = 'Packages/com.genio.play'
/** Common restart-sensitive files; every source change under Packages or ProjectSettings restarts. */
export const RESTART_FILES = ['ProjectSettings/ProjectVersion.txt', 'Packages/manifest.json', 'Packages/packages-lock.json', 'ProjectSettings/ProjectSettings.asset']

const posix = p => p.replace(/\\/g, '/')
const join = (a, b) => a ? `${a}/${b}` : b
const parentOf = rel => { const at = rel.lastIndexOf('/'); return at < 0 ? '' : rel.slice(0, at) }
const ci = rel => process.platform === 'win32' || process.platform === 'darwin' ? rel.toLowerCase() : rel
const abs = (root, rel) => path.join(root, ...rel.split('/'))
const canonical = p => { const v = path.resolve(fs.realpathSync(p)); return process.platform === 'win32' ? v.toLowerCase() : v }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** True for a Unity-root-relative posix path the mirror never copies, compares or deletes. */
export function mirrorSkip(rel, exclude = []) {
  const lower = rel.toLowerCase(), parts = lower.split('/'), first = parts[0]
  if (SKIP_TOP.has(first) || first.startsWith('library@')) return true
  if (parts.length === 1 && SKIP_ROOT_FILE.test(lower)) return true
  const genio = GENIO_PACKAGE.toLowerCase()
  if (lower === genio || lower.startsWith(`${genio}/`)) return true
  if (parts.includes('.git')) return true
  return exclude.some(x => { const v = posix(String(x)).toLowerCase().replace(/^\/+|\/+$/g, ''); return !!v && (lower === v || lower.startsWith(`${v}/`)) })
}

/** The Unity version a project root names in ProjectSettings/ProjectVersion.txt, or undefined. */
export function unityVersionOf(root) {
  try { return fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*(\S+)/m)?.[1] } catch { return undefined }
}

function gitRunner(env = process.env) {
  const base = Object.fromEntries(Object.entries(env).filter(([k]) => !REPO_ENV.includes(k) && !k.startsWith('GIT_CONFIG_')))
  const runEnv = { ...base, GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' }
  const git = async (cwd, args) => (await exec('git', [...READ_ONLY, ...args], { cwd, windowsHide: true, maxBuffer: 512 * 1024 * 1024, env: runEnv })).stdout
  const tryGit = async (cwd, args) => { try { return await git(cwd, args) } catch { return undefined } }
  return { git, tryGit, env: runEnv }
}

async function each(items, limit, fn, signal) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { if (signal?.aborted) return; await fn(items[next++]) }
  }))
}

/**
 * Validate a Play source and say what it is. source is { path } (any checkout of the project: the main
 * checkout, a worktree, a unit's worktree) or { ref } (a branch, tag or commit, read from git objects).
 */
export async function resolveSource(project, engineRoot = '', source, options = {}) {
  const { git, tryGit } = gitRunner(options.env)
  const prefix = posix(engineRoot).replace(/^\/+|\/+$/g, '')
  if (path.isAbsolute(prefix) || /[:\x00-\x1f]/.test(prefix) || prefix.split('/').includes('..')) throw new Error('Invalid Unity root')
  const top = async cwd => path.resolve((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())
  const common = async cwd => path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim())
  const projectTop = await top(project)
  const projectCommon = await common(projectTop)
  if (source && typeof source.path === 'string') {
    if (!fs.existsSync(source.path)) throw new Error(`Play source not found: ${source.path}`)
    const sourceTop = await top(source.path)
    // A submodule checkout or another repository has its own common dir.
    if (canonical(await common(sourceTop)) !== canonical(projectCommon)) throw new Error('A Play source must be a checkout of this project (its main checkout or one of its worktrees)')
    const head = (await tryGit(sourceTop, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim() || undefined
    const branch = (await tryGit(sourceTop, ['symbolic-ref', '-q', '--short', 'HEAD']))?.trim() || undefined
    return { kind: 'checkout', top: sourceTop, prefix, project: projectTop, head, branch }
  }
  if (source && typeof source.ref === 'string') {
    const ref = source.ref.trim()
    if (!ref || ref.startsWith('-') || /[\x00-\x1f]/.test(ref)) throw new Error('Invalid Play source ref')
    const commit = (await tryGit(projectTop, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim()
    if (!commit) throw new Error(`No commit named ${ref} in this project`)
    return { kind: 'commit', gitDir: projectCommon, commit, ref, prefix, project: projectTop }
  }
  throw new Error('A Play source is { path } or { ref }')
}

/**
 * True when a Play source can no longer be read: its checkout folder, its .git link or the worktree metadata
 * that link names is gone (a unit's worktree merged and removed), or its ref no longer names a commit (a
 * deleted branch). Never throws; anything it cannot decide counts as present.
 */
export async function sourceMissing(project, source, options = {}) {
  try {
    const { tryGit } = gitRunner(options.env)
    if (source && typeof source.path === 'string') {
      if (!fs.existsSync(source.path)) return true
      const link = path.join(source.path, '.git')
      let st
      try { st = fs.statSync(link) } catch { st = undefined }
      if (st?.isFile()) {
        const gitdir = fs.readFileSync(link, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
        if (!gitdir || !fs.existsSync(path.resolve(source.path, gitdir))) return true
      }
      const top = (await tryGit(source.path, ['rev-parse', '--show-toplevel']))?.trim()
      if (!top) return true
      // No .git of its own: a leftover folder inside another checkout, unless it is part of the project itself.
      if (!st) {
        const inside = (a, b) => { const r = path.relative(canonical(b), canonical(a)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }
        return !(fs.existsSync(project) && (inside(source.path, project) || inside(project, source.path)))
      }
      return false
    }
    if (source && typeof source.ref === 'string') {
      const ref = source.ref.trim()
      if (!ref || ref.startsWith('-')) return false
      return !(await tryGit(project, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim()
    }
  } catch { /* Undecided: present. */ }
  return false
}

/** What a resolved source is, for records and reports. */
export function describeSource(src) {
  return src.kind === 'checkout' ? { kind: 'checkout', path: src.top, head: src.head, branch: src.branch } : { kind: 'commit', ref: src.ref, commit: src.commit }
}

/**
 * Every file of the source under the Unity root, by Unity-root-relative posix path. Submodules are read from
 * their checkout in the source, else from a checkout that has them at the same commit (the main checkout),
 * else from their git objects. Throws when a submodule cannot be found anywhere, or when the source holds no
 * Unity project: an empty scan must never empty the copy.
 */
export async function scanSource(src, options = {}) {
  const started = Date.now()
  const ctx = { ...gitRunner(options.env), exclude: options.exclude ?? [], entries: new Map(), problems: [], warnings: [], stores: new Map() }
  if (src.kind === 'checkout') await scanCheckout(ctx, src.top, src.prefix, '', src.project)
  else await scanCommit(ctx, src.gitDir, src.commit, src.prefix, '', src.project)
  if (ctx.problems.length) throw new Error(`Cannot mirror this source: ${ctx.problems.join('; ')}`)
  if (!ctx.entries.has('ProjectSettings/ProjectVersion.txt')) throw new Error(`The source has no Unity project${src.prefix ? ` under ${src.prefix}` : ''} (ProjectSettings/ProjectVersion.txt is missing)`)
  return { entries: ctx.entries, warnings: ctx.warnings, scanMs: Date.now() - started }
}

async function lfsStore(ctx, gitDir) {
  if (!ctx.stores.has(gitDir)) {
    const set = (await ctx.tryGit(gitDir, ['--git-dir', gitDir, 'config', '--get', 'lfs.storage']))?.trim()
    ctx.stores.set(gitDir, set ? path.resolve(gitDir, set) : path.join(gitDir, 'lfs'))
  }
  return ctx.stores.get(gitDir)
}

async function gitDirsOf(ctx, top) {
  const gitDir = path.resolve((await ctx.git(top, ['rev-parse', '--absolute-git-dir'])).trim())
  const common = path.resolve(top, (await ctx.git(top, ['rev-parse', '--git-common-dir'])).trim())
  return { gitDir, common }
}

async function scanCheckout(ctx, top, prefix, base, twin) {
  const spec = prefix ? ['--', `:(literal)${prefix}`] : []
  const under = p => !prefix || p.startsWith(`${prefix}/`)
  const strip = p => prefix ? p.slice(prefix.length + 1) : p
  const [staged, others, status, dirs] = await Promise.all([
    ctx.git(top, ['ls-files', '-z', '-s', ...spec]),
    ctx.git(top, ['ls-files', '-z', '--others', '--exclude-standard', ...spec]),
    ctx.git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=all', ...spec]),
    gitDirsOf(ctx, top)
  ])
  // Tracked files whose working copy differs from the index (or that are mid-merge) have no blob identity.
  const dirty = new Set()
  const records = status.split('\0')
  for (let at = 0; at < records.length; at++) {
    const e = records[at]
    if (e.length < 4) continue
    const x = e[0], y = e[1]
    if (x === 'R' || x === 'C') at++
    if (y !== ' ' || x === 'U') dirty.add(e.slice(3))
  }
  const tracked = new Map(), gitlinks = []
  for (const line of staged.split('\0')) {
    const m = line.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/)
    if (!m || !under(m[4])) continue
    if (m[1] === '160000') { gitlinks.push({ path: m[4], commit: m[2] }); continue }
    const seen = tracked.get(m[4])
    if (seen) seen.conflict = true
    else tracked.set(m[4], { mode: m[1], oid: m[2], conflict: m[3] !== '0' })
  }
  const stores = [await lfsStore(ctx, dirs.common)]
  const candidates = [...tracked.keys(), ...others.split('\0').filter(p => p && !p.endsWith('/') && under(p))]
  await each(candidates, 32, async p => {
    const rel = join(base, strip(p))
    if (mirrorSkip(rel, ctx.exclude)) return
    const file = path.join(top, p)
    let st
    try { st = await fs.promises.lstat(file) } catch { return }
    const t = tracked.get(p)
    if (st.isSymbolicLink() || t?.mode === '120000') { ctx.warnings.push(`${rel}: symbolic links are not copied`); return }
    if (!st.isFile()) return
    const id = t && !t.conflict && !dirty.has(p) ? t.oid : undefined
    ctx.entries.set(rel, { kind: 'file', abs: file, size: st.size, mtimeMs: st.mtimeMs, ...(id ? { id } : {}), stores })
  })
  if (!gitlinks.length) return
  let modules = ''
  try { modules = fs.readFileSync(path.join(top, '.gitmodules'), 'utf8') } catch { /* No names: object fallbacks are skipped. */ }
  const names = new Map(parseGitmodules(modules).map(s => [posix(s.path), s.name]))
  for (const link of gitlinks) {
    const rel = join(base, strip(link.path))
    if (mirrorSkip(rel, ctx.exclude)) continue
    const sub = path.join(top, link.path)
    const subTwin = twin && path.join(twin, link.path)
    if (fs.existsSync(path.join(sub, '.git'))) await scanCheckout(ctx, sub, '', rel, subTwin)
    else await scanElsewhere(ctx, { rel, name: names.get(link.path), commit: link.commit, gitDirs: [dirs.gitDir, dirs.common], twin: subTwin })
  }
}

async function scanCommit(ctx, gitDir, commit, prefix, base, twin) {
  const spec = prefix ? ['--', `:(literal)${prefix}`] : []
  const listing = await ctx.git(gitDir, ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', '--full-tree', commit, ...spec])
  const under = p => !prefix || p.startsWith(`${prefix}/`)
  const strip = p => prefix ? p.slice(prefix.length + 1) : p
  const stores = [await lfsStore(ctx, gitDir)]
  const gitlinks = []
  for (const line of listing.split('\0')) {
    const m = line.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/)
    if (!m || !under(m[5])) continue
    const rel = join(base, strip(m[5]))
    if (mirrorSkip(rel, ctx.exclude)) continue
    if (m[2] === 'commit') { gitlinks.push({ path: m[5], rel, commit: m[3] }); continue }
    if (m[2] !== 'blob') continue
    if (m[1] === '120000') { ctx.warnings.push(`${rel}: symbolic links are not copied`); continue }
    ctx.entries.set(rel, { kind: 'blob', gitDir, oid: m[3], size: Number(m[4]), id: m[3], stores })
  }
  if (!gitlinks.length) return
  const modules = await ctx.tryGit(gitDir, ['--git-dir', gitDir, 'cat-file', 'blob', `${commit}:.gitmodules`]) ?? ''
  const names = new Map(parseGitmodules(modules).map(s => [posix(s.path), s.name]))
  for (const link of gitlinks) await scanElsewhere(ctx, { rel: link.rel, name: names.get(link.path), commit: link.commit, gitDirs: [gitDir], twin: twin && path.join(twin, link.path) })
}

/** A submodule the source has not checked out: a clean checkout of it at that commit, else its git objects. */
async function scanElsewhere(ctx, { rel, name, commit, gitDirs, twin }) {
  if (twin && fs.existsSync(path.join(twin, '.git'))) {
    const head = (await ctx.tryGit(twin, ['rev-parse', 'HEAD']))?.trim()
    const dirty = await ctx.tryGit(twin, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all'])
    if (head === commit && dirty === '') return scanCheckout(ctx, twin, '', rel, twin)
  }
  const candidates = []
  if (twin && fs.existsSync(path.join(twin, '.git'))) { const g = (await ctx.tryGit(twin, ['rev-parse', '--absolute-git-dir']))?.trim(); if (g) candidates.push(path.resolve(g)) }
  // Names come from .gitmodules; git refuses names that escape modules/, and so does Genio.
  if (name && !path.isAbsolute(name) && !/[:\x00-\x1f]/.test(name) && !name.split(/[\\/]/).includes('..')) for (const g of gitDirs) candidates.push(path.join(g, 'modules', name))
  for (const g of [...new Set(candidates)]) {
    if (!fs.existsSync(path.join(g, 'HEAD'))) continue
    if (await ctx.tryGit(g, ['--git-dir', g, 'cat-file', '-e', `${commit}^{commit}`]) === undefined) continue
    return scanCommit(ctx, g, commit, '', rel, twin)
  }
  ctx.problems.push(`git submodule ${rel} at ${commit.slice(0, 12)} is not checked out in the source, and no checkout or git data here has that commit`)
}

/** git cat-file --batch over one git dir: blobs by id, one at a time. */
class BlobReader {
  constructor(gitDir, env) {
    this.child = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.chunks = []; this.length = 0; this.waiting = []; this.stderr = ''; this.body = undefined
    this.child.stdout.on('data', b => { this.chunks.push(b); this.length += b.length; this.pump() })
    this.child.stderr.on('data', b => { this.stderr += b })
    const fail = e => { for (const w of this.waiting.splice(0)) w.reject(e) }
    this.child.on('error', fail)
    this.child.stdin.on('error', fail)
    this.child.on('close', code => fail(new Error(`git cat-file stopped (${code}): ${this.stderr.trim()}`)))
  }
  read(oid) { return new Promise((resolve, reject) => { this.waiting.push({ resolve, reject }); this.child.stdin.write(`${oid}\n`) }) }
  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []; this.length = rest.length
    return out
  }
  pump() {
    while (this.waiting.length) {
      if (this.body === undefined) {
        const head = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length)
        const nl = head.indexOf(10)
        if (nl < 0) return
        const fields = this.take(nl + 1).toString().trim().split(' ')
        if (fields[1] === 'missing' || fields.length < 3) { this.waiting.shift().reject(new Error(`git object ${fields[0]} is missing`)); continue }
        this.body = Number(fields[2])
      }
      if (this.length < this.body + 1) return
      const blob = Buffer.from(this.take(this.body + 1).subarray(0, this.body))
      this.body = undefined
      this.waiting.shift().resolve(blob)
    }
  }
  close() { try { this.child.stdin.end() } catch { /* Already closed. */ } }
}

function readManifest(file) {
  try { const m = JSON.parse(fs.readFileSync(file, 'utf8')); if (m && m.version === 1 && m.files && typeof m.files === 'object') return m } catch { /* New or unreadable: everything is compared afresh. */ }
  return { version: 1, files: {} }
}
/** The staging folder beside the manifest; its leading dot keeps it apart from the copy's project folder. */
const STAGING = '.mirror-staging'
const STAGED = 'staged.json'
const stagedName = rel => createHash('sha1').update(rel).digest('hex')
/** The source identity a manifest or staging entry was made from: the blob id, else size and mtime. */
const sameSource = (m, src) => !!m && (src.id && m.id ? src.id === m.id : src.kind === 'file' && m.mtimeMs !== undefined && m.size === src.size && m.mtimeMs === src.mtimeMs)
async function renameRetry(from, to, retries = 6) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.rename(from, to); return } catch (e) {
      if (!RETRY.has(e.code) || attempt >= retries) throw e
      await sleep(Math.min(2000, 50 * 2 ** attempt))
    }
  }
}
function writeManifest(file, manifest) {
  const temp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, JSON.stringify(manifest))
  fs.renameSync(temp, file)
}

const RETRY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'])
/** Remove one file or link (never what a link points to), clearing read-only and retrying Windows locks. */
export async function removeFile(p, { retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.promises.unlink(p); return } catch (e) {
      if (e.code === 'ENOENT') return
      // A directory link (junction) is removed as a directory entry, never followed.
      if (e.code === 'EISDIR' || e.code === 'EPERM' && (await fs.promises.lstat(p).catch(() => undefined))?.isDirectory()) { await fs.promises.rmdir(p); return }
      if (!RETRY.has(e.code) || attempt >= retries) throw e
      if (e.code === 'EPERM' || e.code === 'EACCES') await fs.promises.chmod(p, 0o666).catch(() => {})
      await sleep(Math.min(2000, 50 * 2 ** attempt))
    }
  }
}

async function writable(p) {
  try { const st = await fs.promises.lstat(p); if (st.isFile() && !(st.mode & 0o200)) await fs.promises.chmod(p, 0o666) } catch { /* Missing: written fresh. */ }
}

function findLfs(stores, pointer) {
  for (const s of stores ?? []) {
    const p = path.join(s, 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid)
    try { if (fs.statSync(p).size === pointer.size) return p } catch { /* Not in this store. */ }
  }
  return undefined
}

async function walkCopy(root, exclude) {
  const files = new Map()
  const visit = async (dir, rel) => {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    const found = []
    for (const e of entries) {
      const r = join(rel, e.name)
      if (mirrorSkip(r, exclude)) continue
      if (e.isDirectory()) await visit(path.join(dir, e.name), r)
      // A link in the copy was never written by Genio: it is listed so it is removed, never followed.
      else if (e.isFile() || e.isSymbolicLink()) found.push(r)
    }
    await each(found, 32, async r => { const st = await fs.promises.lstat(abs(root, r)); files.set(r, { size: st.isSymbolicLink() ? -1 : st.size, mtimeMs: st.mtimeMs }) })
  }
  await visit(root, '')
  return files
}

/**
 * Make the copy at root match the scanned source and return what changed. Removals run before copies, so a
 * case-only rename works on Windows. Files Unity made in the copy are deleted, except a .meta for an asset
 * the source has (purging it would give the asset a new GUID and a reimport), packages-lock.json and
 * ProjectSettings files.
 * Two phases. Staging reads every changed file into a staging folder beside the manifest (on the copy's
 * volume) and is the only phase that reads the source. Applying then removes and renames inside the copy and
 * never reads the source. Cancelling (signal) or a failing read stops staging between files with the copy
 * untouched; what was staged is kept in its own manifest and reused by the next sync of the same content.
 */
export async function applyMirror(scan, root, manifestFile, options = {}) {
  const { signal, io = {}, extraBytes = 0, statfs, concurrency = 16, exclude = [] } = options
  const copyFile = io.copyFile ?? ((from, to) => fs.promises.copyFile(from, to))
  const staging = path.join(path.dirname(manifestFile), STAGING)
  const stagedFile = path.join(staging, STAGED)
  const stagedAt = rel => path.join(staging, stagedName(rel))
  const started = Date.now()
  let lastProgress = 0
  const progress = (phase, done, total, bytesDone, bytesTotal, force) => {
    if (!options.onProgress || (!force && Date.now() - lastProgress < 200)) return
    lastProgress = Date.now()
    options.onProgress({ phase, files: { done, total }, bytes: { done: bytesDone, total: bytesTotal } })
  }
  const aborted = () => { if (signal?.aborted) { const e = new Error('Sync cancelled'); e.code = 'ABORT_ERR'; throw e } }
  const manifest = readManifest(manifestFile)
  const files = manifest.files
  const first = !Object.keys(files).length
  await fs.promises.mkdir(root, { recursive: true })
  const dest = await walkCopy(root, exclude)
  const source = scan.entries
  const sourceKeys = new Set(), sourceDirs = new Set()
  for (const rel of source.keys()) { sourceKeys.add(ci(rel)); for (let d = parentOf(rel); d; d = parentOf(d)) sourceDirs.add(ci(d)) }
  const unityMade = rel => {
    const lower = rel.toLowerCase()
    if (lower.endsWith('.meta')) { const asset = ci(rel.slice(0, -5)); return sourceKeys.has(asset) || sourceDirs.has(asset) }
    return lower === 'packages/packages-lock.json' || /^projectsettings\/[^/]+$/.test(lower)
  }
  const report = {
    first, complete: false,
    files: { source: source.size, unchanged: 0, added: 0, updated: 0, restored: 0, deleted: 0, unityMadeDeleted: 0, unityMadeKept: 0 },
    bytes: { copied: 0, deleted: 0 }, lfs: { resolved: 0, pointers: [] }, restart: { needed: false, reasons: [] }, warnings: [...scan.warnings], elapsedMs: 0, scanMs: scan.scanMs
  }
  const copies = [], removals = []
  for (const [rel, src] of source) {
    const m = files[rel], d = dest.get(rel)
    const same = sameSource(m, src)
    const intact = !!m?.copy && !!d && d.size === m.copy.size && d.mtimeMs === m.copy.mtimeMs
    if (same && intact) {
      report.files.unchanged++
      files[rel] = { ...m, ...(src.id ? { id: src.id } : {}), size: src.size, ...(src.kind === 'file' ? { mtimeMs: src.mtimeMs } : {}) }
      continue
    }
    copies.push({ rel, src, kind: same ? 'restored' : m || d ? 'updated' : 'added' })
  }
  for (const rel of Object.keys(files)) {
    if (source.has(rel)) continue
    // A meta Genio wrote whose asset the source still has (the source dropped only the meta) keeps its GUID.
    if (dest.has(rel) && unityMade(rel)) { delete files[rel]; report.files.unityMadeKept++; continue }
    removals.push({ rel, kind: 'deleted', size: Math.max(0, dest.get(rel)?.size ?? 0), exists: dest.has(rel) })
  }
  for (const [rel, d] of dest) {
    if (files[rel] || source.has(rel)) continue
    if (d.size >= 0 && unityMade(rel)) { report.files.unityMadeKept++; continue }
    removals.push({ rel, kind: 'unityMadeDeleted', size: Math.max(0, d.size), exists: true })
  }
  const restart = new Set()
  for (const c of [...copies.filter(c => c.kind !== 'restored'), ...removals.filter(r => r.kind === 'deleted')]) if (/^(packages|projectsettings)\//i.test(c.rel)) restart.add(`${c.rel} changed`)

  // What an earlier, interrupted sync already staged: reused when the source still has the same content.
  const staged = readManifest(stagedFile)
  const stagedIntact = async (s, rel) => {
    if (!s?.file || s.pointer) return false
    const st = await fs.promises.stat(stagedAt(rel)).catch(() => undefined)
    return !!st && st.size === s.file.size && st.mtimeMs === s.file.mtimeMs
  }
  report.staged = { reused: 0 }
  // Small files may be Git LFS pointers: read them first, so sizes and the space check use the real content.
  const readers = new Map()
  const reader = gitDir => { let r = readers.get(gitDir); if (!r) { r = new BlobReader(gitDir, gitRunner(options.env).env); readers.set(gitDir, r) } return r }
  try {
    for (const c of copies) {
      aborted()
      if (sameSource(staged.files[c.rel], c.src) && await stagedIntact(staged.files[c.rel], c.rel)) { c.staged = true; report.staged.reused++; continue }
      if (c.src.size > POINTER_MAX) continue
      c.content = c.src.kind === 'blob' ? await reader(c.src.gitDir).read(c.src.oid) : await fs.promises.readFile(c.src.abs).catch(() => undefined)
      const m = c.content?.length <= POINTER_MAX ? c.content.toString('utf8').match(LFS_POINTER) : undefined
      if (m) c.pointer = { oid: m[1], size: Number(m[2]) }
    }
    const sizeOf = c => c.pointer ? c.pointer.size : c.src.size
    const toStage = copies.filter(c => !c.staged)
    const bytesTotal = toStage.reduce((n, c) => n + sizeOf(c), 0)
    const need = bytesTotal + extraBytes - removals.reduce((n, r) => n + r.size, 0)
    if (need > 0) await checkFreeSpace(root, need, { statfs })

    // Staging: the only reads of the source. The copy is untouched until every changed file is staged.
    let stagedCount = 0, bytesDone = 0
    const stage = async c => {
      aborted()
      const target = stagedAt(c.rel)
      await removeFile(target)
      const object = c.pointer && findLfs(c.src.stores, c.pointer)
      if (object) await copyFile(object, target)
      else if (c.content) await fs.promises.writeFile(target, c.content)
      else if (c.src.kind === 'file') await copyFile(c.src.abs, target)
      else await fs.promises.writeFile(target, await reader(c.src.gitDir).read(c.src.oid))
      const st = await fs.promises.stat(target)
      staged.files[c.rel] = { ...(c.src.id ? { id: c.src.id } : {}), size: c.src.size, ...(c.src.kind === 'file' ? { mtimeMs: c.src.mtimeMs } : {}), file: { size: st.size, mtimeMs: st.mtimeMs }, ...(object ? { lfs: true } : c.pointer ? { pointer: true } : {}) }
      c.staged = true
      bytesDone += sizeOf(c)
      progress('copying', ++stagedCount, toStage.length, bytesDone, bytesTotal)
    }
    if (toStage.length) await fs.promises.mkdir(staging, { recursive: true })
    try {
      progress('copying', 0, toStage.length, 0, bytesTotal, true)
      // Files stage in parallel; blobs stream one at a time through their git dir's reader.
      await each(toStage.filter(c => c.src.kind === 'file' || c.content), concurrency, stage, signal)
      aborted()
      for (const c of toStage.filter(c => c.src.kind === 'blob' && !c.content)) await stage(c)
      aborted()
      progress('copying', stagedCount, toStage.length, bytesDone, bytesTotal, true)
    } finally { if (toStage.length) writeManifest(stagedFile, staged) }

    // Decide before writing restart-sensitive files or moving a live editor's Library.
    await options.beforeApply?.({ needed: first || restart.size > 0, reasons: first ? ['first copy'] : [...restart] })
    aborted()

    // Applying: removals and renames inside the copy's volume only, never cancelled halfway.
    try {
      progress('deleting', 0, removals.length, 0, 0, true)
      const emptied = new Set()
      let done = 0
      for (const r of removals) {
        if (r.exists) await removeFile(abs(root, r.rel))
        if (r.kind === 'deleted') delete files[r.rel]
        report.files[r.kind]++; report.bytes.deleted += r.size
        for (let d = parentOf(r.rel); d; d = parentOf(d)) emptied.add(d)
        progress('deleting', ++done, removals.length, 0, 0)
      }
      // Deepest first; a folder that still has files, or that the source has, stays.
      for (const d of [...emptied].sort((a, b) => b.split('/').length - a.split('/').length)) {
        if (sourceDirs.has(ci(d))) continue
        await fs.promises.rmdir(abs(root, d)).catch(() => {})
      }
      let copied = 0
      for (const c of copies) {
        const s = staged.files[c.rel], target = abs(root, c.rel)
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await writable(target)
        await renameRetry(stagedAt(c.rel), target)
        delete staged.files[c.rel]
        const st = await fs.promises.stat(target)
        files[c.rel] = { ...(c.src.id ? { id: c.src.id } : {}), size: c.src.size, ...(c.src.kind === 'file' ? { mtimeMs: c.src.mtimeMs } : {}), copy: { size: st.size, mtimeMs: st.mtimeMs }, ...(s.pointer ? { pointer: true } : {}) }
        if (s.lfs) report.lfs.resolved++
        report.files[c.kind]++; report.bytes.copied += st.size
        if (++copied % 64 === 0) progress('copying', copied, copies.length, bytesTotal, bytesTotal)
      }
      progress('copying', copied, copies.length, bytesTotal, bytesTotal, true)
      // Nothing staged is left to reuse: a later sync starts from a clean staging folder.
      await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    } finally {
      if (Object.keys(staged.files).length) writeManifest(stagedFile, staged)
      const previous = manifest.unityVersion
      const version = unityVersionOf(root)
      if (previous && version && previous !== version) restart.add(`Unity ${previous} → ${version}`)
      if (version) manifest.unityVersion = version
      writeManifest(manifestFile, manifest)
      report.restart = { needed: first || restart.size > 0, reasons: first ? ['first copy: no editor has opened it yet'] : [...restart], unityVersion: version, ...(previous && previous !== version ? { previousUnityVersion: previous } : {}) }
    }
  } finally { for (const r of readers.values()) r.close() }
  const pointers = Object.entries(files).filter(([, f]) => f.pointer).map(([rel]) => rel)
  report.lfs.pointers = pointers.slice(0, 50)
  if (pointers.length) report.warnings.push(`${pointers.length} file(s) are Git LFS pointers whose content was never downloaded, e.g. ${pointers.slice(0, 3).join(', ')}`)
  report.complete = true
  report.elapsedMs = Date.now() - started
  return report
}
