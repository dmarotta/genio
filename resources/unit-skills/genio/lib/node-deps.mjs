/**
 * Unit worktree dependencies: every unit worktree gets its OWN real node_modules, never a link to the main
 * checkout's. Link detection, link-only removal, the package-manager guard, private setup and the main
 * install's health check. Node standard library only (the shims and hooks run it with the unit's node).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pluginFile } from './resource-path.mjs'
import { seedTree } from '../skills/play/scripts/clone.mjs'
import { robocopyTree } from './unity-seed.mjs'
import { PRIORITY, playIsLive, setProcessPriority } from './play-live.mjs'

export const DEPS_RULE = "node_modules in a unit worktree is private to it: never link, junction or move it, and never touch the main checkout's."
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
export const PACKAGE_MANAGERS = ['npm', 'npx', 'pnpm', 'yarn']

const lstat = p => { try { return fs.lstatSync(p) } catch { return undefined } }
const key = p => { const v = path.resolve(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? v.toLowerCase() : v }
const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
/** p is root or inside it (plain path comparison, case-insensitive on Windows). */
export const within = (p, root) => { const a = key(p), b = key(root); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) }

/** True for a symlink or a junction: Node's lstat reports a junction as a symbolic link. */
export function isLink(p) { return !!lstat(p)?.isSymbolicLink() }

/** Where a link points, as an absolute path; undefined when p is not a link or cannot be read. */
export function linkTarget(p) {
  if (!isLink(p)) return undefined
  try { return path.resolve(path.dirname(p), fs.readlinkSync(p).replace(/^\\\\\?\\/, '')) } catch { return undefined }
}

/**
 * Remove ONLY the link at p, never what it points to. A real folder is refused. On Windows rmdir deletes a
 * junction's or directory symlink's own entry (like `cmd /c rmdir "<p>"`); it never recurses. Afterwards p
 * must be gone and a target that existed before must still exist.
 */
export function removeLinkSafely(p) {
  const before = lstat(p)
  if (!before) return { removed: false, path: p, reason: 'missing' }
  if (!before.isSymbolicLink()) return { removed: false, path: p, reason: 'not a link: real folders are never touched' }
  const target = linkTarget(p)
  const targetExisted = !!target && fs.existsSync(target)
  try { fs.rmdirSync(p) }
  catch (e) {
    // A file symlink (or a POSIX directory symlink) is unlinked instead; unlink never recurses either.
    if (!isLink(p)) throw e
    fs.unlinkSync(p)
  }
  if (lstat(p)) throw new Error(`Could not remove the link ${p}`)
  const targetIntact = !targetExisted || fs.existsSync(target)
  return { removed: true, path: p, target, targetIntact }
}

/**
 * Why a package manager run from cwd would not use the worktree's own real node_modules: cwd or any parent
 * holds a node_modules that is a link, a node_modules inside the worktree resolves outside it, or cwd is the
 * main checkout. undefined when it is safe.
 */
export function linkedNodeModules(cwd, { worktree, main } = {}) {
  const at = path.resolve(cwd)
  if (main && (within(at, main) || within(real(at), real(main)))) return { path: at, reason: `${at} is the main checkout, which units must never install into` }
  if (worktree && main && key(real(worktree)) === key(real(main))) return { path: worktree, reason: `the worktree ${worktree} resolves to the main checkout` }
  for (let dir = at; ; dir = path.dirname(dir)) {
    const nm = path.join(dir, 'node_modules'), st = lstat(nm)
    if (st?.isSymbolicLink()) return { path: nm, target: linkTarget(nm), reason: `${nm} is a link to ${linkTarget(nm) ?? 'an unreadable target'}` }
    if (st && worktree && within(dir, worktree) && !within(real(nm), real(worktree))) return { path: nm, target: real(nm), reason: `${nm} resolves outside the worktree, to ${real(nm)}` }
    if (path.dirname(dir) === dir) return undefined
  }
}

const NPM_MUTATING = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add',
  'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install-test', 'it', 'install-ci-test', 'cit',
  'uninstall', 'unlink', 'un', 'remove', 'rm', 'r', 'update', 'up', 'upgrade', 'udpate', 'prune', 'dedupe', 'ddp',
  'rebuild', 'rb', 'exec', 'x', 'link', 'ln'])
const PNPM_MUTATING = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'prune', 'dedupe',
  'rebuild', 'rb', 'exec', 'dlx', 'link', 'ln', 'unlink', 'import', 'fetch'])
const YARN_MUTATING = new Set(['install', 'add', 'remove', 'upgrade', 'up', 'dedupe', 'exec', 'dlx', 'rebuild', 'link', 'unlink', 'import', 'autoclean'])
const VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '--registry', '--cache', '--userconfig', '--loglevel'])
const DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd'])

/** The subcommand and the folder a package-manager command line acts on (--prefix, -C, --dir, --cwd). */
export function packageCommand(tool, args, cwd = process.cwd()) {
  let sub, dir = cwd
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const eq = a.match(/^(--?[\w-]+)=(.*)$/)
    if (eq && DIR_FLAGS.has(eq[1])) { dir = path.resolve(cwd, eq[2]); continue }
    if (VALUE_FLAGS.has(a)) { if (DIR_FLAGS.has(a) && args[i + 1] !== undefined) dir = path.resolve(cwd, String(args[i + 1])); i++; continue }
    if (a.startsWith('-')) continue
    sub = a.toLowerCase(); break
  }
  const name = path.basename(String(tool)).replace(/\.(cmd|exe|ps1|js|cjs|mjs)$/i, '').replace(/-cli$/, '').toLowerCase()
  const mutating = name === 'npx' || name === 'npm' && NPM_MUTATING.has(sub) || name === 'pnpm' && PNPM_MUTATING.has(sub) ||
    name === 'yarn' && (sub === undefined || YARN_MUTATING.has(sub))
  return { tool: name, sub, dir, mutating }
}

/** The refusal for a package-manager run, or undefined when it may go ahead. */
export function npmGuardReason(tool, args, { cwd = process.cwd(), worktree, main, state } = {}) {
  const command = packageCommand(tool, args, cwd)
  if (!command.mutating) return undefined
  const label = [command.tool, command.sub].filter(Boolean).join(' ')
  const linked = linkedNodeModules(command.dir, { worktree, main })
  if (linked) return `Refused "${label}": ${linked.reason}. Installing through it would delete and rewrite the folder it points to. ${DEPS_RULE} ` +
    `Fix: run \`node "${setupScript()}" setup\` in your worktree (it removes only the link, then gives your worktree its own node_modules).`
  const setup = readState(state)
  if (setup?.state === 'installing' && pidAlive(setup.pid) && worktree && within(command.dir, worktree)) {
    return `Refused "${label}": Genio is still setting up this worktree's node_modules (${setup.method ?? 'in progress'}). Wait until ${state} says "ready", then retry.`
  }
  return undefined
}

const pidAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const readState = file => { try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined } catch { return undefined } }
const setupScript = () => {
  if (process.env.GENIO_DEPS_SETUP) return process.env.GENIO_DEPS_SETUP
  try { return pluginFile('lib/npm-guard.mjs') } catch { return 'npm-guard.mjs' }
}

// Shell segments and words, the same split the Unity guard uses. Quoted text stays one word.
const segments = command => command.split(/[;|\n]|&&/)
const words = segment => [...segment.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s;&|()]+)/g)].map(m => m[1] ?? m[2] ?? m[3])
const QUIET = ['echo', 'write-output', 'write-host', 'printf', 'rg', 'grep', 'select-string', 'git', 'findstr', 'cat', 'type', 'get-content']
const first = w => path.basename(String(w ?? '').replace(/\\/g, '/')).toLowerCase()

/** The nearest node_modules link at or above p, inside a node_modules path; undefined otherwise. */
function linkedPath(word, cwd) {
  if (!/node_modules/i.test(word)) return undefined
  const p = path.resolve(cwd, word.replace(/^["']|["']$/g, ''))
  for (let at = p; ; at = path.dirname(at)) {
    if (/^node_modules$/i.test(path.basename(at)) && isLink(at)) return at
    if (path.dirname(at) === at) return undefined
  }
}

/**
 * PreToolUse rule for Bash and PowerShell: deny creating a link at node_modules, moving node_modules,
 * a recursive delete on (or through) a node_modules link, and an install through a linked tree.
 */
export function depsToolReason(input, { worktree, main, state } = {}) {
  const tool = input?.tool_name, command = input?.tool_input?.command
  if (!['Bash', 'PowerShell'].includes(tool) || typeof command !== 'string') return undefined
  const cwd = input.cwd || worktree || process.cwd()
  return checkShell(command, cwd, { worktree, main, state }, 0)
}

const LAUNCHERS = ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'bash.exe', 'sh', 'node', 'node.exe', 'call', 'start', 'start-process', 'invoke-expression', 'iex', '&']

function checkShell(command, cwd, context, depth) {
  const { worktree, main, state } = context
  for (const segment of segments(command)) {
    const w = words(segment)
    while (/^[A-Za-z_]\w*=/.test(w[0] ?? '')) w.shift()
    if (QUIET.includes(first(w[0]))) continue
    // Nested shells: cmd /c "rmdir /s /q node_modules", powershell -Command "...", node -e "...".
    if (LAUNCHERS.includes(first(w[0])) && depth < 3) {
      const inner = [...segment.matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] ?? m[2])
      const rest = segment.replace(/^\s*\S+\s+(?:(?:\/[cdsk]|-c|-Command|-NoProfile|-NonInteractive|-e|--eval)\s+)*/i, '')
      for (const text of [...inner, ...rest !== segment ? [rest] : []]) {
        const reason = checkShell(text, cwd, context, depth + 1)
        if (reason) return reason
      }
    }
    const mentions = /node_modules/i.test(segment)
    if (mentions && (/\bmklink\b/i.test(segment) || /-ItemType\s+["']?(?:Junction|SymbolicLink|HardLink)\b/i.test(segment) ||
      /(?:^|\s)ln\s+(?:-\w*s\w*\s+)/.test(segment) || /symlink(?:Sync)?\s*\(/.test(segment))) {
      return `Never link, junction or hardlink node_modules. ${DEPS_RULE} If dependencies are missing, run \`node "${setupScript()}" setup\` in your worktree.`
    }
    const verb = first(w[0])
    const args = w.slice(1)
    if (['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni'].includes(verb) && args.some(x => /(?:^|[\\/])node_modules[\\/]?$/i.test(x))) {
      return `Never move node_modules. ${DEPS_RULE}`
    }
    // cmd: rmdir /s, del /s. PowerShell: Remove-Item (rm, rmdir, rd, ri, del) -Recurse or any prefix of it. sh: rm -r, -rf, -fr.
    const recursive = ['remove-item', 'ri', 'rm', 'rmdir', 'rd', 'del', 'erase'].includes(verb) &&
      args.some(f => /^\/s$/i.test(f) || /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(f) || /^-[a-z]{0,3}$/i.test(f) && /r/i.test(f)) ||
      /\brimraf\b|rmSync\s*\(|rm\s*\([^)]*recursive/i.test(segment)
    if (recursive) {
      const link = args.map(x => linkedPath(x, cwd)).find(Boolean)
      if (link) return `Refused: ${link} is a link to ${linkTarget(link) ?? 'another folder'}, and a recursive delete can follow it and wipe that folder. Remove only the link: \`cmd /c rmdir "${link}"\` (no /s), or run \`node "${setupScript()}" setup\`. ${DEPS_RULE}`
    }
    if (PACKAGE_MANAGERS.includes(verb.replace(/\.(cmd|exe)$/, ''))) {
      const reason = npmGuardReason(verb, args, { cwd, worktree, main, state })
      if (reason) return reason
    }
  }
  return undefined
}

/** The project's lockfile and its sha256; undefined without one. */
export function lockHash(root) {
  for (const file of LOCKFILES) {
    try { return { file, hash: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') } }
    catch { /* next */ }
  }
  return undefined
}

/**
 * Existence-only check of an install: node_modules is there, .bin exists, every declared dependency has its
 * package.json (and, with electron, Electron's binary). Fast: a few dozen stats, no package code runs.
 */
export function checkInstall(root, { packages, dev = false, bin = true, electron = false } = {}) {
  const nm = path.join(root, 'node_modules'), missing = []
  if (!fs.existsSync(path.join(root, 'package.json'))) return { ok: true, root, missing, skipped: 'no package.json' }
  if (!fs.existsSync(nm)) return { ok: false, root, missing: ['node_modules'] }
  let names = packages
  if (!names) {
    let pkg = {}
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) } catch { /* unreadable: check the folder only */ }
    names = Object.keys({ ...pkg.dependencies, ...dev ? pkg.devDependencies : {} })
  }
  if (bin && !fs.existsSync(path.join(nm, '.bin'))) missing.push('node_modules/.bin')
  for (const name of names) if (!fs.existsSync(path.join(nm, name, 'package.json'))) missing.push(`node_modules/${name}`)
  if (electron) {
    let exe
    try { exe = fs.readFileSync(path.join(nm, 'electron', 'path.txt'), 'utf8').trim() } catch { /* below */ }
    if (!exe || !fs.existsSync(path.join(nm, 'electron', 'dist', exe))) missing.push('node_modules/electron/dist (the Electron binary)')
  }
  return { ok: !missing.length, root, missing, ...isLink(nm) ? { linked: linkTarget(nm) } : {} }
}

/**
 * node_modules links in unit worktree folders: <root>/<project>/<unit>/node_modules for each root
 * (a worktrees folder). Registered or not, live or not: the caller decides what to do with each.
 */
export function worktreeLinks(roots) {
  const out = []
  for (const root of roots) {
    let projects = []
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
    for (const project of projects) {
      let units = []
      try { units = fs.readdirSync(path.join(root, project.name), { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
      for (const unit of units) {
        const worktree = path.join(root, project.name, unit.name), nm = path.join(worktree, 'node_modules')
        if (isLink(nm)) out.push({ worktree, project: project.name, unit: unit.name, path: nm, target: linkTarget(nm) })
      }
    }
  }
  return out
}

/** Genio's own worktree folders: <home>/worktrees and every ally base's <home>/workspaces/<name>/worktrees. */
export function genioWorktreeRoots(homeRoot) {
  const roots = [path.join(homeRoot, 'worktrees')]
  try { for (const e of fs.readdirSync(path.join(homeRoot, 'workspaces'), { withFileTypes: true })) if (e.isDirectory()) roots.push(path.join(homeRoot, 'workspaces', e.name, 'worktrees')) } catch { /* no allies */ }
  return roots
}

/** Packages Genio cannot start or build without, beyond its declared runtime dependencies. */
export const GENIO_CRITICAL = ['@anthropic-ai/claude-agent-sdk', 'three', 'electron', 'electron-vite']

/**
 * Genio's own install at appRoot, existence checks only: node_modules/.bin, Electron's binary, every runtime
 * dependency and GENIO_CRITICAL. With homeRoot, also the unit worktrees whose node_modules links to it.
 */
export function genioInstallReport(appRoot, homeRoot) {
  let pkg = {}
  try { pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) } catch { /* checked below */ }
  const packages = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...GENIO_CRITICAL])]
  const check = checkInstall(appRoot, { packages, electron: true })
  const own = path.join(appRoot, 'node_modules')
  const linked = homeRoot ? worktreeLinks(genioWorktreeRoots(homeRoot)).filter(l => l.target && within(l.target, own)) : []
  const command = `npm install --prefix "${appRoot}"`
  return { ...check, linked, command, message: `Dependencies are broken: run npm install in ${appRoot}` }
}

/** Copy (or block clone on a Dev Drive) a real node_modules into dest, which must not exist. Links are never copied. */
export async function copyNodeModules(source, dest, { platform = process.platform, run, data, system } = {}) {
  if (lstat(dest)) throw new Error(`Refusing to copy into an existing ${dest}`)
  if (platform !== 'win32') {
    await fs.promises.cp(source, dest, { recursive: true, verbatimSymlinks: true })
    return { method: 'fs.cp' }
  }
  let copied
  const clone = await seedTree(source, dest, { data, system, fallback: async () => { copied = await robocopyTree(source, dest, { run, data, label: 'node_modules robocopy' }) } })
  return { method: clone.method === 'clone' ? `clone:${clone.via}` : copied ?? 'clone-refused-copy', reason: clone.reason }
}

/** `npm ci --prefer-offline` in dir only, through the platform shell (npm is a .cmd on Windows). */
export function npmCi(dir, { timeoutMs = 20 * 60_000, data } = {}) {
  return new Promise(resolve => {
    const line = 'npm ci --prefer-offline --no-audit --no-fund'
    const win = process.platform === 'win32'
    const child = spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', line] : ['-c', line], { cwd: dir, windowsHide: true, env: { ...process.env, npm_config_yes: 'false' } })
    // While a Play is live the install runs at below-normal priority (play-live.mjs); its children inherit it.
    try { if (data && playIsLive(data)) setProcessPriority(child.pid, PRIORITY.belowNormal) } catch { /* best effort */ }
    let tail = ''
    const keep = d => { tail = (tail + d.toString('utf8')).slice(-4000) }
    child.stdout.on('data', keep); child.stderr.on('data', keep)
    const timer = setTimeout(() => { tail += '\n[genio] npm ci timed out'; child.kill() }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); resolve({ code: 127, output: tail + e.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output: tail }) })
  })
}

/**
 * Give worktree its own real node_modules. A link left there is removed (the link only). Seeded by a copy of
 * main's node_modules when both lockfiles hash the same and main's install is complete; otherwise
 * `npm ci --prefer-offline` inside the worktree. Never a junction, symlink or hardlink; main is only read.
 */
export async function setupNodeModules(worktree, main, options = {}) {
  const started = Date.now()
  let deferred = {}
  const done = r => ({ ...r, ...deferred, elapsedMs: Date.now() - started })
  const dest = path.join(worktree, 'node_modules')
  if (!fs.existsSync(path.join(worktree, 'package.json'))) return done({ state: 'skipped', reason: 'no package.json' })
  if (key(real(worktree)) === key(real(main))) throw new Error('Refusing to set up dependencies: the worktree is the main checkout')
  let repaired
  if (isLink(dest)) {
    repaired = removeLinkSafely(dest)
    if (!repaired.targetIntact) throw new Error(`Removed the link ${dest}, but its target ${repaired.target} is gone`)
  } else if (lstat(dest)) return done({ state: 'ready', method: 'existing' })
  const above = linkedNodeModules(worktree, { worktree, main })
  if (above) throw new Error(`Refusing to install: ${above.reason}`)
  const own = lockHash(worktree), theirs = lockHash(main), source = path.join(main, 'node_modules')
  let copyFailure
  const method = own && own.hash === theirs?.hash ? 'copy' : 'npm ci'
  options.progress?.({ state: 'installing', method })
  // Quiet start: a Play starting holds the copy or npm ci back until it is ready, at most the cap (quiet-start.mjs).
  const quiet = await options.quiet?.(() => options.progress?.({ state: 'installing', method, waiting: 'a Play is starting' }))
  if (quiet?.deferred) options.progress?.({ state: 'installing', method })
  if (quiet?.deferred) deferred = { deferredMs: quiet.waitedMs }
  if (own && theirs && own.file === theirs.file && own.hash === theirs.hash) {
    const health = checkInstall(main)
    if (health.ok && !isLink(source) && fs.existsSync(source)) {
      try {
        const copied = await (options.copy ?? copyNodeModules)(source, dest, options)
        return done({ state: 'ready', method: copied.method, from: source, ...repaired && { repaired: repaired.path } })
      } catch (e) {
        copyFailure = e.message
        // Only the folder this copy created: a real directory, never a link.
        if (lstat(dest) && !isLink(dest)) await fs.promises.rm(dest, { recursive: true, force: true })
      }
    } else copyFailure = health.missing.length ? `the main install is incomplete (${health.missing.slice(0, 5).join(', ')})` : 'the main node_modules is a link or missing'
  }
  if (own?.file !== 'package-lock.json' && own?.file !== 'npm-shrinkwrap.json') {
    return done({ state: 'skipped', reason: own ? `${own.file} needs its own package manager: install in the worktree yourself` : 'no lockfile: run npm install in the worktree yourself',
      ...copyFailure && { copyFailure }, ...repaired && { repaired: repaired.path } })
  }
  const result = await (options.install ?? npmCi)(worktree, { data: options.data })
  if (result.code !== 0) return done({ state: 'failed', method: 'npm ci', reason: `npm ci exited ${result.code}: ${String(result.output ?? '').trim().slice(-600)}`, ...copyFailure && { copyFailure } })
  return done({ state: 'ready', method: 'npm ci', ...copyFailure && { copyFailure }, ...repaired && { repaired: repaired.path } })
}
