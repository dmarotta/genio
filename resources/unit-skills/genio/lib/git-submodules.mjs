/**
 * Git submodules for unit worktrees and Play slots. `git worktree add` and `git clone` leave submodule
 * folders empty, so a project keeping packages as submodules (lands-of-old's Packages/hhg-*) would miss them.
 * Each submodule is cloned from the source checkout's own submodule git dir, at the commit the copy records:
 * local paths only (no network, no credentials prompt), hooks disabled, and nothing in the source is written.
 * `git submodule init` is never used: in a linked worktree it writes the main checkout's shared config.
 * Node standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
// Inherited repository overrides would point every command at the wrong repository.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']
const safeRelative = p => typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !/[:\x00-\x1f]/.test(p) && !p.split(/[\\/]/).includes('..')
const posix = p => p.replace(/\\/g, '/')
const key = p => { const v = path.resolve(p); return process.platform === 'win32' ? v.toLowerCase() : v }
const inside = (child, parent) => { const r = path.relative(key(parent), key(child)); return r === '' || !r.startsWith('..') && !path.isAbsolute(r) }
// A network remote (https://, ssh://, git@host:). A local path could be the player's own repository.
const remoteUrl = u => typeof u === 'string' && (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/^file:/i.test(u) || /^[^\\/:]{2,}:/.test(u))
const LFS_POINTER = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n(?:.*\r?\n)*oid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/

/**
 * A core.hooksPath that holds no hooks and never will: a path beneath a regular file. git finds no hook
 * there, and git-lfs, which installs its hooks into any hooks folder it can create, cannot create this one.
 */
export function noHooksPath(dir) {
  const file = path.join(dir, 'no-hooks.txt')
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'Genio runs git here with hooks off: core.hooksPath points beneath this file.\n')
  return path.join(file, 'hooks')
}

/** Submodule paths declared by <top>/.gitmodules, read as a file (no git). */
export function declaredSubmodules(top) {
  let text
  try { text = fs.readFileSync(path.join(top, '.gitmodules'), 'utf8') } catch { return [] }
  const out = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*submodule\s+"(.*)"\s*\]\s*$/)
    if (section) { current = { name: section[1] }; out.push(current); continue }
    if (/^\s*\[/.test(line)) { current = undefined; continue }
    const value = current && line.match(/^\s*(path|url)\s*=\s*(.*?)\s*$/i)
    if (value) current[value[1].toLowerCase()] = value[2].replace(/^"(.*)"$/, '$1')
  }
  return out.filter(s => safeRelative(s.path))
}

/**
 * Declared submodules under projectRoot whose folder is not checked out (no .git inside), relative to the
 * repository top, as forward-slash paths. [] when projectRoot is not in a git checkout or declares none.
 */
export function missingSubmodules(projectRoot) {
  let top = path.resolve(projectRoot)
  while (!fs.existsSync(path.join(top, '.git'))) { const up = path.dirname(top); if (up === top) return []; top = up }
  return declaredSubmodules(top).filter(s => inside(path.join(top, s.path), projectRoot) && !fs.existsSync(path.join(top, s.path, '.git'))).map(s => posix(s.path))
}

/**
 * Check out every submodule of the checkout at `dir` (a unit worktree or a Play slot clone) at the commit its
 * index records, recursively, using objects from `source` (the player's checkout or one of its worktrees).
 * - A submodule already at its commit is left alone, so a slot's branch switch only touches changed ones.
 * - force (Genio-owned slots only): a changed or Unity-dirtied submodule is reset (checkout --force, clean).
 * - LFS objects are copied from the source submodule's store into the copy's own; never downloaded.
 * Never throws for one submodule: each failure is reported, so callers decide whether it is fatal.
 */
export async function initSubmodules(dir, { source, force = false, hooksPath, env = process.env, timeoutMs = 600000 } = {}) {
  const started = Date.now()
  const report = { submodules: [], problems: [], ok: true, elapsedMs: 0 }
  if (!fs.existsSync(path.join(dir, '.gitmodules'))) return { ...report, elapsedMs: Date.now() - started }
  const base = Object.fromEntries(Object.entries(env).filter(([k]) => !REPO_ENV.includes(k)))
  const runEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '0' }
  const git = async (cwd, args, extra = {}) => (await exec('git', ['-c', `core.hooksPath=${hooksPath}`, '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', ...args], { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...runEnv, ...extra } })).stdout
  const tryGit = async (cwd, args, extra) => { try { return (await git(cwd, args, extra)).trim() } catch { return undefined } }
  // Reads of the source never take optional locks (no index refresh is written there).
  const readSource = (cwd, args) => tryGit(cwd, args, { GIT_OPTIONAL_LOCKS: '0' })
  const topGitDir = await tryGit(dir, ['rev-parse', '--absolute-git-dir'])
  if (!topGitDir) return { ...report, ok: false, problems: [`${dir} is not a git checkout`], elapsedMs: Date.now() - started }
  hooksPath ??= noHooksPath(topGitDir)
  const sourceGitDirs = source ? [await readSource(source, ['rev-parse', '--absolute-git-dir']), await readSource(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])].filter(Boolean) : []
  await level({ work: dir, gitDir: topGitDir, sourceTree: source, sourceGitDirs: [...new Set(sourceGitDirs.map(p => path.resolve(p)))], prefix: '' })
  report.ok = !report.problems.length
  report.elapsedMs = Date.now() - started
  return report

  async function level(at) {
    const gitlinks = new Map()
    for (const entry of (await tryGit(at.work, ['ls-files', '-s', '-z']) ?? '').split('\0')) {
      const m = entry.match(/^160000 ([a-f0-9]{40,64}) \d\t(.+)$/)
      if (m) gitlinks.set(posix(m[2]), m[1])
    }
    for (const sub of declaredNames(at.work)) {
      const full = posix(path.join(at.prefix, sub.path))
      const commit = gitlinks.get(posix(sub.path))
      if (!commit) continue
      const entry = { path: full, name: sub.name, commit }
      report.submodules.push(entry)
      try { await one(at, sub, entry) } catch (e) { fail(entry, (e.stderr || e.message || String(e)).toString().trim().split(/\r?\n/).slice(-3).join(' ')) }
    }
  }

  function declaredNames(work) {
    // Names come from section headers; git refuses names that escape modules/, and so does Genio.
    return declaredSubmodules(work).filter(s => safeRelative(s.name))
  }

  function fail(entry, reason) { entry.action = 'failed'; entry.reason = reason; report.problems.push(`${entry.path}: ${reason}`) }

  async function one(at, sub, entry) {
    const work = path.join(at.work, sub.path)
    const gitDir = path.join(at.gitDir, 'modules', sub.name)
    for (let p = work; inside(p, at.work) && key(p) !== key(at.work); p = path.dirname(p)) {
      try { if (fs.lstatSync(p).isSymbolicLink()) return fail(entry, 'its folder is a link') } catch { /* Created below. */ }
    }
    const candidates = await sourceCandidates(at, sub)
    const has = async (g, commit) => (await tryGit(at.work, ['--git-dir', g, 'cat-file', '-e', `${commit}^{commit}`])) !== undefined
    let from
    for (const c of candidates) if (await has(c, entry.commit)) { from = c; break }
    const populated = fs.existsSync(path.join(work, '.git'))
    if (populated) {
      const head = await tryGit(work, ['rev-parse', 'HEAD'])
      const dirty = force && head === entry.commit && (await tryGit(work, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])) !== ''
      if (head === entry.commit && !dirty) entry.action = 'current'
      else {
        const own = await tryGit(work, ['rev-parse', '--absolute-git-dir']) ?? gitDir
        if (!await has(own, entry.commit)) {
          if (!from) return fail(entry, missingReason(candidates, entry.commit))
          await git(work, ['fetch', '--quiet', '--no-tags', '--', from, entry.commit])
        }
        const pointers = await lfs(own, entry, candidates)
        if (pointers === undefined) return
        await checkout(work, entry.commit, pointers)
        entry.action = head === entry.commit ? 'reset' : 'updated'
      }
    } else {
      if (!from) return candidates.length ? fail(entry, missingReason(candidates, entry.commit)) : skip(entry)
      if (fs.existsSync(work) && fs.readdirSync(work).length) {
        if (!force) return fail(entry, 'its folder is not empty and has no checkout')
        fs.rmSync(work, { recursive: true, force: true })
      }
      fs.mkdirSync(work, { recursive: true })
      if (fs.existsSync(path.join(gitDir, 'HEAD'))) {
        // A slot keeps a removed submodule's git dir; reattach it instead of cloning again.
        fs.writeFileSync(path.join(work, '.git'), `gitdir: ${posix(gitDir)}\n`)
        if (!await has(gitDir, entry.commit)) await git(work, ['fetch', '--quiet', '--no-tags', '--', from, entry.commit])
        entry.action = 'reattached'
      } else {
        fs.mkdirSync(path.dirname(gitDir), { recursive: true })
        // --no-hardlinks: the copy never shares inodes with the player's submodule objects.
        await git(at.work, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--separate-git-dir', gitDir, '--', from, work])
        // A clone carries refs only; a commit no ref reaches (rebased away, detached) is fetched by id.
        if (!await has(gitDir, entry.commit)) await git(work, ['fetch', '--quiet', '--no-tags', '--', from, entry.commit])
        // Point origin at the real upstream, so a later push or fetch never targets the player's copy.
        const upstream = [await readSource(at.work, ['--git-dir', from, 'config', '--get', 'remote.origin.url']), sub.url].find(remoteUrl)
        if (upstream) await git(work, ['remote', 'set-url', 'origin', upstream])
        else await git(work, ['remote', 'remove', 'origin'])
        entry.action = 'cloned'
      }
      const pointers = await lfs(gitDir, entry, candidates)
      if (pointers === undefined) return
      await checkout(work, entry.commit, pointers)
    }
    if (fs.existsSync(path.join(work, '.gitmodules'))) {
      const own = await tryGit(work, ['rev-parse', '--absolute-git-dir']) ?? gitDir
      await level({ work, gitDir: own, sourceTree: at.sourceTree && path.join(at.sourceTree, sub.path), sourceGitDirs: candidates, prefix: entry.path })
    }
  }

  function skip(entry) { entry.action = 'skipped'; entry.reason = 'the main checkout has not initialised it either'; report.problems.push(`${entry.path}: ${entry.reason}`) }

  function missingReason(candidates, commit) {
    return `commit ${commit.slice(0, 12)} is not in the main checkout's copy of this submodule (${candidates.length ? 'fetch it there first' : 'it is not initialised there'}); Genio never downloads it`
  }

  /** The source's git dirs for this submodule: its checked-out folder's, then <git dir>/modules/<name>. */
  async function sourceCandidates(at, sub) {
    const out = []
    const tree = at.sourceTree && path.join(at.sourceTree, sub.path)
    if (tree && fs.existsSync(path.join(tree, '.git'))) {
      const g = await readSource(tree, ['rev-parse', '--absolute-git-dir'])
      // An unpopulated folder resolves to its parent repository: never take that for the submodule.
      if (g && !at.sourceGitDirs.some(p => key(p) === key(g))) out.push(path.resolve(g))
    }
    for (const g of at.sourceGitDirs) out.push(path.join(g, 'modules', sub.name))
    return [...new Map(out.filter(g => fs.existsSync(path.join(g, 'HEAD'))).map(g => [key(g), g])).values()]
  }

  /** Copy the commit's LFS objects from the source stores into the submodule's own store. Their count, or undefined after a failure. */
  async function lfs(gitDir, entry, candidates) {
    const pointers = await lfsPointers(gitDir, entry.commit)
    if (!pointers.length) return 0
    const store = async g => {
      const set = await tryGit(dir, ['--git-dir', g, 'config', '--get', 'lfs.storage'])
      return set ? path.resolve(g, set) : path.join(g, 'lfs')
    }
    const target = await store(gitDir)
    const stores = []
    for (const c of candidates) stores.push(await store(c))
    const object = (s, oid) => path.join(s, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)
    const missing = []
    let copied = 0
    for (const { oid, size } of pointers) {
      const dest = object(target, oid)
      if (fs.existsSync(dest) && fs.statSync(dest).size === size) continue
      const found = stores.map(s => object(s, oid)).find(p => fs.existsSync(p) && fs.statSync(p).size === size)
      if (!found) { missing.push(oid); continue }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(found, dest)
      copied++
    }
    entry.lfs = { objects: pointers.length, copied }
    if (missing.length) { fail(entry, `${missing.length} LFS object(s) are not in the main checkout's LFS store for this submodule; Genio never downloads them`); return undefined }
    return pointers.length
  }

  async function lfsPointers(gitDir, commit) {
    const listing = await tryGit(dir, ['--git-dir', gitDir, 'ls-tree', '-r', '-l', '-z', commit]) ?? ''
    const small = [...new Set(listing.split('\0').map(e => e.match(/^\d+ blob ([a-f0-9]+)\s+(\d+)\t/)).filter(m => m && Number(m[2]) <= 1024).map(m => m[1]))]
    if (!small.length) return []
    const output = await new Promise((resolve, reject) => {
      const child = execFile('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: runEnv }, (e, stdout) => e ? reject(e) : resolve(stdout))
      child.stdin.end(small.join('\n') + '\n')
    })
    const out = []
    for (let at = 0; at < output.length;) {
      const end = output.indexOf(10, at), header = output.subarray(at, end).toString().split(' ')
      const size = Number(header[2])
      if (end < at || header[1] !== 'blob' || !Number.isFinite(size)) break
      const m = output.subarray(end + 1, end + 1 + size).toString().match(LFS_POINTER)
      if (m) out.push({ oid: m[1], size: Number(m[2]) })
      at = end + 1 + size + 1
    }
    return out
  }

  async function checkout(work, commit, pointers) {
    // Explicit filter config: the copy smudges LFS whether or not git-lfs was installed globally.
    const lfsConfig = pointers ? ['-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true', '-c', 'filter.lfs.smudge=git-lfs smudge -- %f', '-c', 'filter.lfs.clean=git-lfs clean -- %f'] : []
    await git(work, [...lfsConfig, 'checkout', '--quiet', ...(force ? ['--force'] : []), '--detach', commit])
    if (force) await git(work, ['clean', '-ffdq'])
  }
}
