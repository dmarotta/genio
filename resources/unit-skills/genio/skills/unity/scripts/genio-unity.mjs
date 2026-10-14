#!/usr/bin/env node
/**
 * genio-unity: the only way a Genio unit drives Unity. It picks the target
 * itself, the unit's own worktree copy or its leased Play slot, and never the
 * main checkout or the player's editor. Batch runs go through Unity's `unity`
 * CLI (pinned range, with a raw Unity.exe fallback inside), take a machine-wide
 * editor seat shared with the Gauntlet, and leave a record per run:
 *
 *   <runs>/<stamp>-<verb>-<id>/result.json   genio.unity-run.v1
 *                               editor.log, results.xml (NUnit), results.junit.xml, cli.json
 *
 * Exit codes keep the unity CLI's (0 ok, 2 usage, 3 auth, 4 no license, 6 failed,
 * 7 service unreachable, 8 tests failed) and add 20 waited too long, 21
 * forbidden target, 22 project already open, 23 Play lease lost or no session.
 * Genio writes the config (GENIO_UNITY_CONFIG) outside the worktree. Node 18+,
 * standard library only.
 */
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { acquireEditor, editorCap, editorHolders } from '../../../lib/unity-editors.mjs'
import { PlayPool } from '../../play/scripts/pool.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLAY_SCRIPT = path.join(HERE, '..', '..', 'play', 'scripts', 'play.mjs')

export const EXIT = Object.freeze({ ok: 0, usage: 2, auth: 3, license: 4, failed: 6, unreachable: 7, testsFailed: 8, wait: 20, forbidden: 21, open: 22, leaseLost: 23 })
const CLI_CODES = new Set([0, 2, 3, 4, 6, 7, 8, 130, 143])
/** The unity CLI range this wrapper was built against; anything else uses the raw editor. */
export const CLI_PINNED = Object.freeze({ min: '1.0.0-beta.13', below: '2.0.0' })
export const CONFIG_SCHEMA = 'genio.unity-unit.v1'
export const RUN_SCHEMA = 'genio.unity-run.v1'
const SESSION_SCHEMA = 'genio.unity-play-session.v1'
const COMMAND = /^[a-z][a-z0-9_]{0,80}$/
const GLOBAL = ['--format', 'json', '--non-interactive', '--no-banner']

export class UnityError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const MESSAGES = {
  license: 'Unity has no active license on this machine. Append "blocked: Unity license" to your status and stop; never run unity license or auth yourself.',
  noSession: 'No Play session holds a slot lease for you: none was started, it was stopped, or its lease was lost. Start one with `genio-unity play` and wait for its ready record.',
  lost: 'Your Play lease was lost (the player or Genio took the slot). Stop driving the slot; start a new session only if your mission still needs Play.',
  path: 'genio-unity picks the target itself (your own copy or your leased Play slot); it takes no project path.'
}

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const say = line => process.stderr.write(`genio-unity: ${line}\n`)
const key = p => process.platform === 'win32' ? p.toLowerCase() : p
const inside = (child, parent) => { const r = path.relative(key(parent), key(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

// ---------------------------------------------------------------- versions

/** Semver order, prereleases included (1.0.0-beta.8 < 1.0.0-beta.13 < 1.0.0). NaN when either is not a version. */
export function compareVersions(a, b) {
  const parse = v => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim()); return m && { main: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } }
  const x = parse(a), y = parse(b)
  if (!x || !y) return NaN
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] - y.main[i]
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) { if (+p !== +q) return +p - +q } else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}
// The upper bound ignores prereleases: 2.0.0-alpha already belongs to the next major.
export const cliPinned = v => compareVersions(v, CLI_PINNED.min) >= 0 && compareVersions(String(v).replace(/-.*/, ''), CLI_PINNED.below) < 0

// ---------------------------------------------------------------- processes

const active = new Set()
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}
// A .mjs/.js "binary" runs under this Node: Genio's fake CLIs in tests, nothing else ships that way.
const invocation = (file, args) => /\.[cm]?js$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args]
const CAP = 4 * 1024 * 1024

/** Run to completion. Output is kept in memory (capped) and copied to files when asked; the deadline kills the whole tree. */
export function run(file, args, { cwd, env, timeoutMs, stdoutFile, stderrFile } = {}) {
  return new Promise(resolve => {
    const [exe, argv] = invocation(file, args)
    let child, done = false, timedOut = false
    const out = [], err = []
    let outSize = 0, errSize = 0
    const finish = r => { if (done) return; done = true; active.delete(child); clearTimeout(timer); resolve({ ...r, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString(), timedOut, command: [exe, ...argv] }) }
    const outFile = stdoutFile ? fs.createWriteStream(stdoutFile) : null
    const errFile = stderrFile ? fs.createWriteStream(stderrFile) : null
    let timer
    try { child = spawn(exe, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { finish({ code: -1, error: e.message }); return }
    active.add(child)
    child.stdout.on('data', d => { outFile?.write(d); if ((outSize += d.length) <= CAP) out.push(d) })
    child.stderr.on('data', d => { errFile?.write(d); if ((errSize += d.length) <= CAP) err.push(d) })
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, timeoutMs)
    child.once('error', e => { outFile?.end(); errFile?.end(); finish({ code: -1, error: e.message }) })
    child.once('close', (code, signal) => {
      let pending = (outFile ? 1 : 0) + (errFile ? 1 : 0)
      const end = () => finish({ code: code ?? (signal ? 143 : -1) })
      if (!pending) return end()
      for (const f of [outFile, errFile]) f?.end(() => { if (--pending === 0) end() })
    })
  })
}

async function git(cwd, args) {
  const r = await run('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 60_000 })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${(r.stderr || r.error || '').trim()}`)
  return r.stdout.trim()
}

// ---------------------------------------------------------------- config and targets

export function loadConfig(env = process.env) {
  const file = env.GENIO_UNITY_CONFIG
  if (!file) throw new UnityError(EXIT.forbidden, 'genio-unity runs only inside a Genio Unity unit (GENIO_UNITY_CONFIG is not set).')
  let c
  try { c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { throw new UnityError(EXIT.forbidden, `Unreadable Genio Unity config ${file}: ${e.message}`) }
  const strings = [c?.task, c?.worktree, c?.runs, c?.slotFile, c?.play?.data, c?.play?.world, c?.editors?.dir]
  if (c?.schema !== CONFIG_SCHEMA || !strings.every(v => typeof v === 'string' && v)) throw new UnityError(EXIT.forbidden, `Invalid Genio Unity config ${file}.`)
  if (typeof c.engineRoot !== 'string' || path.isAbsolute(c.engineRoot) || /[:\x00-\x1f]/.test(c.engineRoot) || c.engineRoot.split(/[\\/]/).includes('..')) throw new UnityError(EXIT.forbidden, 'Invalid Unity root in the Genio Unity config.')
  return c
}

/** The unit's own copy: its worktree's Unity root. Never the main checkout, never through a link. */
export async function resolveCopy(c) {
  let worktree, world
  try { worktree = fs.realpathSync(c.worktree); world = fs.realpathSync(c.play.world) } catch (e) { throw new UnityError(EXIT.forbidden, `Your worktree or project is missing: ${e.message}`) }
  if (inside(worktree, world) || inside(world, worktree)) throw new UnityError(EXIT.forbidden, 'Refusing the main checkout: genio-unity works only on your own worktree copy and your leased Play slot.')
  const common = async cwd => key(fs.realpathSync(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir']))))
  try {
    if (await common(worktree) !== await common(world)) throw new UnityError(EXIT.forbidden, 'Your worktree does not belong to the registered project.')
    if (key(fs.realpathSync(await git(worktree, ['rev-parse', '--show-toplevel']))) !== key(worktree)) throw new UnityError(EXIT.forbidden, 'Your worktree is not a git worktree root.')
  } catch (e) { throw e instanceof UnityError ? e : new UnityError(EXIT.forbidden, e.message) }
  let copy = worktree
  for (const part of c.engineRoot.split(/[\\/]/).filter(Boolean)) {
    copy = path.join(copy, part)
    let stat
    try { stat = fs.lstatSync(copy) } catch { throw new UnityError(EXIT.failed, `No Unity project at ${copy}.`) }
    if (stat.isSymbolicLink()) throw new UnityError(EXIT.forbidden, 'Your Unity root cannot follow a link.')
  }
  if (!fs.existsSync(path.join(copy, 'ProjectSettings', 'ProjectVersion.txt'))) throw new UnityError(EXIT.failed, `No Unity project at ${copy} (ProjectSettings/ProjectVersion.txt is missing).`)
  return { worktree, world, copy }
}

export function projectVersion(root) {
  try { return fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*([\w.]+)\s*$/m)?.[1] } catch { return undefined }
}

/** PID of an editor holding `root` open, -1 when only its lock file says so, 0 when none. */
export function editorOpen(root) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'Library', 'EditorInstance.json'), 'utf8'))
    if (Number.isInteger(d.process_id) && d.process_id > 0 && alive(d.process_id)) return d.process_id
  } catch { /* no instance record */ }
  const lock = path.join(root, 'Temp', 'UnityLockfile')
  if (!fs.existsSync(lock)) return 0
  // A running editor holds the lock file; one left by a crash opens fine.
  try { fs.closeSync(fs.openSync(lock, 'r+')); return 0 } catch (e) { return e.code === 'ENOENT' ? 0 : -1 }
}

const SEED_SKIP = new Set(['Pipeline', 'EditorInstance.json', 'SourceAssetDB-lock', 'ArtifactDB-lock'])
/** A copy without Library starts from the project's, minus editor credentials and locks (as Play slots do). */
export async function seedLibrary(copy, source) {
  const library = path.join(copy, 'Library')
  if (fs.existsSync(library) || !fs.existsSync(source)) return false
  // Assemble under Temp (ignored by Unity projects) and move in whole, so a crash never leaves half a Library.
  const temp = path.join(copy, 'Temp', 'genio-library-seed')
  fs.rmSync(temp, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(temp), { recursive: true })
  await fs.promises.cp(source, temp, { recursive: true, filter: async p => !SEED_SKIP.has(path.basename(p)) && !(await fs.promises.lstat(p)).isSymbolicLink() })
  fs.renameSync(temp, library)
  return true
}

/** The editor for the raw fallback: the config's, else the Hub install for the project's version. */
export function editorFor(c, root) {
  if (c.editor) return fs.existsSync(c.editor) ? c.editor : undefined
  const version = projectVersion(root)
  if (!version) return undefined
  const bases = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor')] : process.platform === 'darwin' ? ['/Applications/Unity/Hub/Editor'] : [path.join(os.homedir(), 'Unity/Hub/Editor')]
  try {
    const hub = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'UnityHub/secondaryInstallPath.json'), 'utf8'))
    const secondary = typeof hub === 'string' ? hub : hub?.secondaryInstallPath
    if (typeof secondary === 'string' && secondary) bases.unshift(secondary)
  } catch { /* Hub custom install path is optional. */ }
  return bases.map(b => path.join(b, version, process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : process.platform === 'win32' ? 'Editor/Unity.exe' : 'Editor/Unity')).find(p => fs.existsSync(p))
}

// ---------------------------------------------------------------- unity CLI and license

const cliEnv = () => ({ ...process.env, UNITY_NO_UPDATE_CHECK: '1', UNITY_NO_CONSENT_PROMPT: '1', UNITY_NON_INTERACTIVE: '1', UNITY_NO_BANNER: '1', UNITY_NO_PAGER: '1', NO_COLOR: '1' })

export async function cliInfo(c) {
  if (!c.cli) return { mode: 'raw-editor', reason: 'the unity CLI was not found on this machine' }
  const r = await run(c.cli, ['--version'], { timeoutMs: 30_000, env: cliEnv() })
  const version = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(r.stdout)?.[0]
  if (r.code !== 0 || !version) return { path: c.cli, mode: 'raw-editor', reason: 'unity --version failed' }
  if (!cliPinned(version)) return { path: c.cli, version, mode: 'raw-editor', reason: `unity CLI ${version} is outside the pinned range >=${CLI_PINNED.min} <${CLI_PINNED.below}` }
  return { path: c.cli, version, mode: 'unity-cli' }
}

/** License preflight through `unity license status`; a good answer is reused for 15 minutes. */
export async function licenseCheck(c, info) {
  if (info.mode !== 'unity-cli') return { ok: true, checked: false, detail: 'raw editor fallback: the editor checks its own license' }
  const cache = path.join(c.runs, 'license.json')
  try { const v = JSON.parse(fs.readFileSync(cache, 'utf8')); if (v.ok && Date.now() - v.at < 15 * 60_000) return { ...v, cached: true } } catch { /* check now */ }
  const r = await run(c.cli, ['license', 'status', ...GLOBAL], { timeoutMs: 60_000, env: cliEnv() })
  let data
  try { data = JSON.parse(r.stdout)?.data } catch { /* human text or nothing */ }
  const active = data?.active !== false
  // Only an auth failure or a missing license blocks; a flaky service check never does.
  const ok = r.code === 0 ? active : ![3, 4].includes(r.code)
  const v = { ok, checked: true, code: r.code, at: Date.now(), active: data?.active, signedIn: data?.signedIn, products: Array.isArray(data?.licenses) ? data.licenses.map(l => l?.product).filter(Boolean) : undefined }
  if (ok && r.code === 0) fs.writeFileSync(cache, JSON.stringify(v))
  return v
}

// ---------------------------------------------------------------- reports

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e])
const escape = s => String(s).replace(/[&<>"']/g, ch => `&${Object.keys(ENTITIES).find(k => ENTITIES[k] === ch)};`)
const attr = (s, k) => { const v = new RegExp(`\\s${k}="([^"]*)"`).exec(s)?.[1]; return v === undefined ? undefined : decode(v) }

/** Totals and failing test names from an NUnit3 report; null when there is no test-run. */
export function parseNUnit(xml) {
  const head = /<test-run\b([^>]*)>/.exec(xml)
  if (!head) return null
  const n = k => Number(attr(head[1], k) ?? 0) || 0
  const failures = []
  for (const m of xml.matchAll(/<test-case\b([^>]*)>/g)) if (attr(m[1], 'result') === 'Failed' && failures.length < 50) failures.push(attr(m[1], 'fullname') ?? attr(m[1], 'name') ?? '')
  return { total: n('total'), passed: n('passed'), failed: n('failed'), skipped: n('skipped'), inconclusive: n('inconclusive'), result: attr(head[1], 'result') ?? '', failures }
}

/** JUnit for the raw fallback (the unity CLI writes its own). */
export function nunitToJUnit(xml) {
  const cases = []
  for (const m of xml.matchAll(/<test-case\b([^>]*?)(?:\/>|>([\s\S]*?)<\/test-case>)/g)) {
    const full = attr(m[1], 'fullname') ?? attr(m[1], 'name') ?? 'test', dot = full.lastIndexOf('.')
    const message = /<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/message>/.exec(m[2] ?? '')?.[1] ?? ''
    cases.push({ classname: dot > 0 ? full.slice(0, dot) : 'Unity', name: dot > 0 ? full.slice(dot + 1) : full, time: Number(attr(m[1], 'duration') ?? 0) || 0, result: attr(m[1], 'result') ?? '', message })
  }
  const failures = cases.filter(t => t.result === 'Failed').length, skipped = cases.filter(t => t.result === 'Skipped' || t.result === 'Inconclusive').length
  const body = cases.map(t => `    <testcase classname="${escape(t.classname)}" name="${escape(t.name)}" time="${t.time}">${t.result === 'Failed' ? `<failure message="${escape(t.message.split('\n')[0])}">${escape(t.message)}</failure>` : t.result === 'Skipped' || t.result === 'Inconclusive' ? '<skipped/>' : ''}</testcase>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n  <testsuite name="Unity" tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n${body.join('\n')}${body.length ? '\n' : ''}  </testsuite>\n</testsuites>\n`
}

/** Distinct C# compiler errors from an editor log, at most 50. */
export function compileErrors(log) {
  let text = ''
  try { text = fs.readFileSync(log, 'utf8') } catch { return [] }
  return [...new Set(text.split(/\r?\n/).filter(l => /\berror CS\d{4}\b/.test(l)).map(l => l.trim()))].slice(0, 50)
}

// ---------------------------------------------------------------- runs

function runDir(c, verb) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const dir = path.join(c.runs, `${stamp}-${verb}-${randomUUID().slice(0, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function runDirs(c) {
  try { return fs.readdirSync(c.runs, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(c.runs, e.name)).sort().reverse() } catch { return [] }
}

function lastRun(c) {
  for (const dir of runDirs(c)) {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); return { dir, verb: r.verb, exitCode: r.exitCode, verdict: r.verdict, finishedAt: r.finishedAt } } catch { /* unfinished run */ }
  }
  return null
}

const TIMEOUTS = { build: 3600, test: 1800, import: 1800, compile: 1800 }
const RAW_BUILD = { StandaloneWindows64: ['-buildWindows64Player', 'Game.exe'], StandaloneWindows: ['-buildWindowsPlayer', 'Game.exe'], StandaloneLinux64: ['-buildLinux64Player', 'Game'], StandaloneOSX: ['-buildOSXUniversalPlayer', 'Game.app'] }

/** test, compile, import and build: one record per run, whatever the outcome. */
async function batch(verb, c, opts) {
  const dir = runDir(c, verb)
  const started = Date.now()
  const record = { schema: RUN_SCHEMA, verb, task: c.task, startedAt: new Date(started).toISOString(), options: opts }
  const files = { log: path.join(dir, 'editor.log'), nunit: path.join(dir, 'results.xml'), junit: path.join(dir, 'results.junit.xml'), cli: path.join(dir, 'cli.json'), cliLog: path.join(dir, 'cli.log') }
  let seat, code = EXIT.failed, message
  try {
    const target = await resolveCopy(c)
    record.target = { kind: 'copy', path: target.copy }
    record.head = await git(target.worktree, ['rev-parse', 'HEAD']).catch(() => undefined)
    record.dirty = Boolean(await git(target.worktree, ['status', '--porcelain', '--', c.engineRoot || '.']).catch(() => ''))
    record.unityVersion = projectVersion(target.copy)
    const info = await cliInfo(c)
    record.cli = info
    const timeout = opts.timeout ?? TIMEOUTS[verb]

    if (verb === 'compile') {
      const session = readSession(c)
      if (opts.where === 'slot' && !session) throw new UnityError(EXIT.leaseLost, MESSAGES.noSession)
      if (opts.where === 'slot' && info.mode !== 'unity-cli') throw new UnityError(EXIT.failed, `Compiling in the Play slot needs the unity CLI (${info.reason}).`)
      const useSlot = opts.where === 'slot' || (opts.where !== 'copy' && session && info.mode === 'unity-cli' && await slotCurrent(session, record))
      if (useSlot) {
        record.target = { kind: 'slot', slot: session.slot, path: session.project }
        await sessionRequest(session, { op: 'cmd', command: 'editor_status' })
        const r = await run(info.path, ['recompile', '--project-path', session.project, '--timeout', String(timeout), ...GLOBAL], { cwd: target.worktree, env: cliEnv(), timeoutMs: (timeout + 120) * 1000, stdoutFile: files.cli, stderrFile: files.cliLog })
        record.command = r.command
        await sessionRequest(session, { op: 'cmd', command: 'editor_status' })
        code = r.timedOut ? EXIT.failed : CLI_CODES.has(r.code) ? r.code : EXIT.failed
        try { record.cliResult = JSON.parse(r.stdout) } catch { /* not JSON */ }
        return
      }
    }

    const holder = editorOpen(target.copy)
    if (holder) throw new UnityError(EXIT.open, `An editor already has your copy open${holder > 0 ? ` (pid ${holder})` : ''}. Wait for it to finish; never stop Unity processes yourself. If it stays open, append "blocked: Unity copy open" to your status.`)
    const license = await licenseCheck(c, info)
    record.license = { ok: license.ok, checked: license.checked, cached: license.cached }
    if (!license.ok) throw new UnityError(license.code === 3 ? EXIT.auth : EXIT.license, MESSAGES.license)
    const libraryFrom = path.join(c.play.world, c.engineRoot, 'Library')
    if (!fs.existsSync(path.join(target.copy, 'Library'))) say('seeding Library for your copy from the project (first run only)...')
    record.librarySeeded = await seedLibrary(target.copy, libraryFrom)

    let shown = 0
    seat = await acquireEditor(c.editors.dir, {
      owner: `unit:${c.task}`, project: target.copy, cap: c.editors.cap ?? editorCap(c.editors.dir), waitMs: (opts.wait ?? 1800) * 1000,
      onWait: holders => { if (Date.now() - shown > 30_000) { shown = Date.now(); say(`waiting for a Unity editor seat (${holders.length} in use: ${holders.map(h => h.owner).join(', ') || 'unknown'})...`) } }
    })
    if (!seat) throw new UnityError(EXIT.wait, `Waited ${opts.wait ?? 1800} s for a Unity editor seat. Retry later; if it repeats, append "blocked: Unity editor seat" to your status.`)
    record.seat = seat.seat
    record.waitedMs = seat.waitedMs
    const again = editorOpen(target.copy)
    if (again) throw new UnityError(EXIT.open, `An editor opened your copy while you waited${again > 0 ? ` (pid ${again})` : ''}.`)

    const out = path.join(dir, 'build', RAW_BUILD[opts.target]?.[1] ?? 'Game')
    if (info.mode === 'unity-cli') {
      const args = verb === 'test'
        ? ['test', target.copy, ...(opts.mode ? ['--mode', opts.mode] : []), ...(opts.filter ? ['--filter', opts.filter] : []), '--report-format', 'nunit,junit', '--output', files.nunit, '--junit-output', files.junit, '--timeout', String(timeout), ...GLOBAL, '--', '-logFile', files.log]
        : verb === 'build'
          ? ['build', target.copy, ...(opts.target ? ['--target', opts.target] : []), ...(opts.profile ? ['--profile', opts.profile] : []), ...(opts['execute-method'] ? ['--execute-method', opts['execute-method']] : []), '--output-path', out, '--log-file', files.log, '--no-tail', '--timeout', String(timeout), ...GLOBAL]
          : ['run', target.copy, '--timeout', String(timeout), ...GLOBAL, '--', '-logFile', files.log]
      const r = await run(info.path, args, { cwd: target.worktree, env: cliEnv(), timeoutMs: (timeout + 120) * 1000, stdoutFile: files.cli, stderrFile: files.cliLog })
      record.command = r.command
      try { record.cliResult = JSON.parse(r.stdout.trim().split(/\r?\n(?=\{)/).pop()) } catch { /* not JSON */ }
      code = r.timedOut || r.code === -1 ? EXIT.failed : CLI_CODES.has(r.code) ? r.code : EXIT.failed
      if (r.code === -1) message = `Could not start the unity CLI: ${r.error}`
      if (r.timedOut) message = `The unity CLI did not finish within ${timeout + 120} s.`
    } else {
      const editor = editorFor(c, target.copy)
      if (!editor) throw new UnityError(EXIT.failed, `Unity ${record.unityVersion ?? '(unknown version)'} is not installed through Hub, and the unity CLI is unavailable (${info.reason}).`)
      record.editor = editor
      say(`using the raw editor because ${info.reason}`)
      let args
      if (verb === 'test') args = ['-batchmode', '-projectPath', target.copy, '-runTests', '-testResults', files.nunit, '-logFile', files.log, ...(opts.mode ? ['-testPlatform', opts.mode] : []), ...(opts.filter ? ['-testFilter', opts.filter] : [])]
      else if (verb === 'build') {
        if (!RAW_BUILD[opts.target] || opts.profile || opts['execute-method']) throw new UnityError(EXIT.failed, `Without the unity CLI only plain ${Object.keys(RAW_BUILD).join(', ')} builds are possible.`)
        args = ['-batchmode', '-quit', '-projectPath', target.copy, '-logFile', files.log, RAW_BUILD[opts.target][0], out]
      } else args = ['-batchmode', '-quit', '-projectPath', target.copy, '-logFile', files.log]
      const r = await run(editor, args, { cwd: target.worktree, timeoutMs: timeout * 1000, stdoutFile: files.cliLog })
      record.command = r.command
      if (verb === 'test') {
        let xml = ''
        try { xml = fs.readFileSync(files.nunit, 'utf8') } catch { /* no verdict */ }
        const totals = xml && parseNUnit(xml)
        if (totals) fs.writeFileSync(files.junit, nunitToJUnit(xml))
        // -runTests exits 0 even when nothing ran and 2 on failures; trust the report, not the code.
        code = r.timedOut || !totals ? EXIT.failed : totals.failed > 0 ? EXIT.testsFailed : r.code === 0 || r.code === 2 ? EXIT.ok : EXIT.failed
      } else code = !r.timedOut && r.code === 0 ? EXIT.ok : EXIT.failed
      if (r.code === -1) message = `Could not start ${editor}: ${r.error}`
      if (r.timedOut) message = `The editor did not finish within ${timeout} s.`
    }
  } catch (e) {
    code = e instanceof UnityError ? e.code : EXIT.failed
    message = e.message
  } finally {
    seat?.release()
    const finished = Date.now()
    if (verb === 'test' && fs.existsSync(files.nunit)) record.tests = parseNUnit(fs.readFileSync(files.nunit, 'utf8'))
    if (verb !== 'test' && code !== EXIT.ok && fs.existsSync(files.log)) record.compileErrors = compileErrors(files.log)
    record.reports = Object.fromEntries(Object.entries({ nunit: files.nunit, junit: files.junit }).filter(([, f]) => fs.existsSync(f)))
    for (const [k, name] of [['log', 'editorLog'], ['cli', 'cliOutput'], ['cliLog', 'cliLog']]) if (fs.existsSync(files[k])) record[name] = files[k]
    record.exitCode = code
    record.verdict = verdictOf(verb, code, record.tests)
    if (message) record.message = message
    record.finishedAt = new Date(finished).toISOString()
    record.durationMs = finished - started
    record.dir = dir
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2) + '\n')
    process.stdout.write(JSON.stringify(record, null, 2) + '\n')
    say(`${verb} ${record.verdict} (exit ${code})${message ? `: ${message}` : ''}. Record: ${path.join(dir, 'result.json')}`)
  }
  return code
}

function verdictOf(verb, code, tests) {
  if ([EXIT.license, EXIT.auth, EXIT.wait, EXIT.forbidden, EXIT.open, EXIT.leaseLost].includes(code)) return 'refused'
  if (verb === 'test') return code === EXIT.ok ? (tests?.total ? 'passed' : 'no-tests') : code === EXIT.testsFailed ? 'failed' : 'error'
  return code === EXIT.ok ? 'passed' : 'failed'
}

/** The slot compiles the same code only when it holds this worktree's HEAD and the Unity root is clean. */
async function slotCurrent(session, record) {
  try {
    return !record.dirty && await git(session.project, ['rev-parse', 'HEAD']) === record.head
  } catch { return false }
}

// ---------------------------------------------------------------- Play session

function readSession(c) {
  try {
    const s = JSON.parse(fs.readFileSync(c.slotFile, 'utf8'))
    return s?.schema === SESSION_SCHEMA && Number.isInteger(s.pid) && alive(s.pid) && typeof s.pipe === 'string' ? s : null
  } catch { return null }
}

/** One request to the unit's Play session; lease loss and a missing session both exit 23. */
export function sessionRequest(session, message, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let buf = '', settled = false
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); fn(v) }
    const socket = net.connect(session.pipe)
    const timer = setTimeout(() => settle(reject, new UnityError(EXIT.failed, 'The Play session did not answer in time.')), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ token: session.token, ...message }) + '\n'))
    socket.on('data', d => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      let v
      try { v = JSON.parse(buf.slice(0, i)) } catch { return settle(reject, new UnityError(EXIT.failed, 'Invalid answer from the Play session.')) }
      if (typeof v?.error === 'string') return settle(reject, new UnityError(/lease lost|session ended/i.test(v.error) ? EXIT.leaseLost : EXIT.failed, /lease lost|session ended/i.test(v.error) ? `${v.error}. ${MESSAGES.lost}` : v.error))
      settle(resolve, v)
    })
    socket.on('error', () => settle(reject, new UnityError(EXIT.leaseLost, MESSAGES.noSession)))
    socket.on('close', () => settle(reject, new UnityError(EXIT.leaseLost, MESSAGES.lost)))
  })
}

/** Long-lived: leases a slot through the Play helper and serves `genio-unity cmd` until stopped. */
async function playSession(c, { open }) {
  const existing = readSession(c)
  if (existing) throw new UnityError(EXIT.failed, `A Play session is already running for you (pid ${existing.pid}). Use genio-unity cmd, or genio-unity play --stop.`)
  const { worktree } = await resolveCopy(c)
  const token = randomUUID()
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\genio-unity-${c.task.replace(/[^\w.-]/g, '-')}-${process.pid}` : path.join(os.tmpdir(), `genio-unity-${process.pid}.sock`)
  // The helper needs the registered project to clone the slot from; the unit is never given that path.
  const child = spawn(process.execPath, [PLAY_SCRIPT, ...(open ? ['--open'] : [])], {
    cwd: worktree, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GENIO_PLAY_DATA: c.play.data, GENIO_PLAY_WORLD: c.play.world, GENIO_PLAY_SOURCE: worktree, GENIO_PLAY_ENGINE_ROOT: c.engineRoot, GENIO_TASK_ID: c.task }
  })
  const pending = new Map(), owner = `unit:${c.task}`
  let seq = 0, ready = null, stopping = false, requested = false, lost = false, watch, released = null
  // `play --stop` callers wait for the helper's released record: the slot editor is closed, kept or stuck.
  const stopReplies = []
  const exited = new Promise(r => child.once('exit', code => r(code ?? 1)))
  const stop = keepEditor => { if (stopping) return; stopping = requested = true; child.stdin.end(JSON.stringify(keepEditor ? { command: 'exit', keep_editor: true } : { command: 'exit' }) + '\n') }
  // The slot went to someone else: answer everyone, end the helper (it may not notice on its own) and exit 23.
  const leaseLost = () => {
    if (requested || lost) return
    lost = true
    clearInterval(watch)
    for (const [id, reply] of pending) { pending.delete(id); reply({ error: 'Play lease lost' }) }
    stopping = true
    child.stdin.end()
    setTimeout(() => { if (child.exitCode === null) killTree(child.pid) }, 3000).unref()
  }
  child.stdin.on('error', () => { /* the helper already left */ })
  createInterface({ input: child.stdout }).on('line', line => {
    let v
    try { v = JSON.parse(line) } catch { process.stdout.write(line + '\n'); return }
    const reply = typeof v?.id === 'string' && pending.get(v.id)
    if (reply) { pending.delete(v.id); reply(v) }
    if (typeof v?.error === 'string' && /lease lost/i.test(v.error)) leaseLost()
    if (reply) return
    if (v?.released) released = v
    if (v?.ready && !ready) {
      ready = v
      const temp = `${c.slotFile}.${process.pid}.tmp`
      fs.mkdirSync(path.dirname(c.slotFile), { recursive: true })
      fs.writeFileSync(temp, JSON.stringify({ schema: SESSION_SCHEMA, pid: process.pid, pipe, token, slot: v.slot, project: v.project, startedAt: new Date().toISOString() }, null, 2))
      fs.renameSync(temp, c.slotFile)
      // Watch the pool too: a takeover is otherwise only noticed by the next command.
      const pool = new PlayPool(c.play.data, c.play.world, c.engineRoot)
      watch = setInterval(() => void pool.state().then(s => { if (!requested && s.slots.find(x => x.id === v.slot)?.owner !== owner) leaseLost() }).catch(() => { /* busy pool: next tick */ }), 2000)
    }
    process.stdout.write(line + '\n')
  })
  child.stderr.on('data', d => { if (/lease lost/i.test(String(d))) leaseLost(); process.stderr.write(d) })

  const server = net.createServer(socket => {
    let buf = ''
    const answer = v => socket.end(JSON.stringify(v) + '\n')
    socket.setEncoding('utf8')
    socket.on('error', () => { /* client left */ })
    socket.on('data', d => {
      buf += d
      if (buf.length > 1024 * 1024) return socket.destroy()
      const i = buf.indexOf('\n')
      if (i < 0) return
      let m
      try { m = JSON.parse(buf.slice(0, i)) } catch { return answer({ error: 'Invalid request' }) }
      buf = ''
      if (m?.token !== token) return answer({ error: 'Not this Play session' })
      if (m.op === 'stop') { stopReplies.push(answer); stop(m.keepEditor === true); return }
      if (m.op !== 'cmd') return answer({ error: 'Unknown request' })
      if (!ready) return answer({ error: 'The Play slot is not ready yet; wait for the ready record' })
      if (lost) return answer({ error: 'Play lease lost' })
      if (stopping) return answer({ error: 'Play session ended; it is stopping' })
      if (!COMMAND.test(m.command) || ['exit', 'close_editor'].includes(m.command)) return answer({ error: 'Invalid command' })
      const id = `genio-unity:${++seq}`
      pending.set(id, answer)
      child.stdin.write(JSON.stringify({ id, command: m.command, parameters: m.parameters ?? {} }) + '\n')
    })
  })
  if (process.platform !== 'win32') fs.rmSync(pipe, { force: true })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve) })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(false); void exited.then(() => process.exit(signal === 'SIGINT' ? 130 : 143)) })

  const code = await exited
  clearInterval(watch)
  for (const reply of pending.values()) reply({ error: 'Play session ended; lease lost or released' })
  for (const reply of stopReplies) reply({ stopped: true, slot: ready?.slot, ...(released ? { editor: released.editor, pids: released.pids, message: released.error } : {}) })
  server.close()
  try { if (JSON.parse(fs.readFileSync(c.slotFile, 'utf8')).pid === process.pid) fs.rmSync(c.slotFile, { force: true }) } catch { /* not ours */ }
  if (!ready) return code === 0 ? EXIT.ok : EXIT.failed
  if (lost || !requested) { say(MESSAGES.lost); return EXIT.leaseLost }
  if (released?.editor === 'stuck') { say(released.error ?? `Play slot ${ready.slot} is stuck.`); return EXIT.failed }
  return code === 0 ? EXIT.ok : EXIT.failed
}

/** Ends the session once the helper has released the slot and closed (or kept) its editor. */
async function stopSession(c, keepEditor) {
  const s = readSession(c)
  if (!s) { process.stdout.write(JSON.stringify({ stopped: false, message: 'No Play session is running.' }) + '\n'); return EXIT.ok }
  const v = await sessionRequest(s, { op: 'stop', keepEditor }, 180_000)
  // Return once the session is gone, so the next step never races the old lease.
  for (let i = 0; i < 600 && alive(s.pid); i++) await sleep(100)
  process.stdout.write(JSON.stringify(v) + '\n')
  if (v.editor === 'stuck') { say(`${v.message ?? `Play slot ${v.slot} is stuck.`} Append "blocked: Play slot ${v.slot} stuck" to your status with the PIDs above; never stop Unity processes yourself.`); return EXIT.failed }
  return EXIT.ok
}

/** Recovery: release this unit's leftover leases and close its slot editors, never another unit's. */
async function closeSlots(c) {
  const s = readSession(c)
  if (s) throw new UnityError(EXIT.failed, `A Play session is still running (pid ${s.pid}); end it with genio-unity play --stop.`)
  const { worktree } = await resolveCopy(c)
  const r = await run(process.execPath, [PLAY_SCRIPT, '--close'], { cwd: worktree, timeoutMs: 300_000, env: { ...process.env, GENIO_PLAY_DATA: c.play.data, GENIO_PLAY_WORLD: c.play.world, GENIO_PLAY_SOURCE: worktree, GENIO_PLAY_ENGINE_ROOT: c.engineRoot, GENIO_TASK_ID: c.task } })
  process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.code === 0) return EXIT.ok
  say('A Play slot is stuck. Append "blocked: Play slot <n> stuck" to your status with the reason and PIDs above; never stop Unity processes yourself.')
  return EXIT.failed
}

async function command(c, name, parameters) {
  const s = readSession(c)
  if (!s) throw new UnityError(EXIT.leaseLost, MESSAGES.noSession)
  const v = await sessionRequest(s, { op: 'cmd', command: name, parameters }, 120_000)
  process.stdout.write(JSON.stringify(v.result ?? null, null, 2) + '\n')
  return EXIT.ok
}

async function consoleTail(c, tail) {
  const s = readSession(c)
  if (s) return command(c, 'console', { tail })
  const log = runDirs(c).map(d => path.join(d, 'editor.log')).find(f => fs.existsSync(f))
  if (!log) { say('No Play session and no run log yet.'); return EXIT.ok }
  say(`no Play session; last ${tail} lines of ${log}`)
  const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/)
  process.stdout.write(lines.slice(-tail - 1).join('\n') + '\n')
  return EXIT.ok
}

async function status(c) {
  const out = { task: c.task }
  let code = EXIT.ok
  try {
    const t = await resolveCopy(c)
    const holder = editorOpen(t.copy)
    out.copy = { path: t.copy, unityVersion: projectVersion(t.copy), library: fs.existsSync(path.join(t.copy, 'Library')), open: holder !== 0 }
  } catch (e) { out.copy = { error: e.message }; code = e.code ?? EXIT.failed }
  const s = readSession(c)
  out.play = s ? { slot: s.slot, project: s.project, pid: s.pid, startedAt: s.startedAt } : null
  const info = await cliInfo(c)
  out.cli = info
  if (s && info.mode === 'unity-cli') {
    const r = await run(info.path, ['status', '--project-path', s.project, ...GLOBAL], { timeoutMs: 30_000, env: cliEnv() })
    try { out.play.editor = JSON.parse(r.stdout)?.data } catch { /* no editor yet */ }
  }
  const license = await licenseCheck(c, info)
  out.license = { ok: license.ok, checked: license.checked, active: license.active, products: license.products }
  if (!license.ok && code === EXIT.ok) code = license.code === 3 ? EXIT.auth : EXIT.license
  out.editors = { cap: c.editors.cap ?? editorCap(c.editors.dir), inUse: editorHolders(c.editors.dir).length }
  out.lastRun = lastRun(c)
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (!license.ok) say(MESSAGES.license)
  return code
}

// ---------------------------------------------------------------- arguments

const SPEC = {
  status: [], compile: ['timeout', 'wait', 'where'], test: ['mode', 'filter', 'timeout', 'wait'], import: ['timeout', 'wait'],
  build: ['target', 'profile', 'execute-method', 'timeout', 'wait'], play: ['no-open', 'stop', 'keep-editor', 'close'], cmd: [], console: ['tail']
}
const FLAGS = new Set(['no-open', 'stop', 'keep-editor', 'close'])
const RAW_EDITOR_FLAG = /^-(projectpath|batchmode|executemethod|runtests|quit|buildtarget|createproject|openfile)\b/i

export const HELP = `genio-unity <verb> [options]: every Unity action of a Genio unit, on your own copy or your leased Play slot.

  status                                      copy, Play session, unity CLI, license, editor seats, last run
  compile [--where auto|copy|slot]            compile scripts (the warm Play slot when it holds your HEAD, else your copy)
  test [--mode EditMode|PlayMode] [--filter F] run tests on your copy; NUnit + JUnit reports in the run record
  import                                      import your copy headless (refreshes a seeded Library)
  build --target T | --profile P [--execute-method M]   build your copy into the run folder
  play [--no-open]                            long-lived: lease a Play slot and open its editor; keep it running
  play --stop [--keep-editor]                 end the Play session, release the slot and close its editor
  play --close                                recovery: release leftover leases and close this unit's slot editors
  cmd <command> [key=value ... | json]        one Pipeline command in your leased slot (needs a play session)
  console [--tail N]                          slot console, or the last run's editor log

  --timeout S  editor deadline in seconds      --wait S  longest wait for an editor seat (default 1800)

Exit codes: 0 ok, 2 usage, 3 auth, 4 no license, 6 failed, 7 service unreachable, 8 tests failed,
20 waited too long, 21 forbidden target, 22 project already open, 23 Play lease lost or no session.
`

const positiveInt = (k, v, max) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > max) throw new UnityError(EXIT.usage, `--${k} must be a whole number from 0 to ${max}.`); return n }

export function parseArgs(argv) {
  const [verb, ...rest] = argv
  if (!verb || ['help', '--help', '-h'].includes(verb)) return { verb: 'help' }
  if (!Object.hasOwn(SPEC, verb)) throw new UnityError(EXIT.usage, `Unknown verb "${verb}". Verbs: ${Object.keys(SPEC).join(', ')}.`)
  const opts = {}, positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('='), k = a.slice(2, eq < 0 ? undefined : eq)
      if (/^(project-?path|world-?path|editor-?path|project|world|path)$/i.test(k)) throw new UnityError(EXIT.forbidden, MESSAGES.path)
      if (!SPEC[verb].includes(k)) throw new UnityError(EXIT.usage, `Unknown option --${k} for ${verb}.`)
      if (FLAGS.has(k)) { opts[k] = true; continue }
      const v = eq < 0 ? rest[++i] : a.slice(eq + 1)
      if (v === undefined) throw new UnityError(EXIT.usage, `--${k} needs a value.`)
      opts[k] = v
    } else if (RAW_EDITOR_FLAG.test(a)) throw new UnityError(EXIT.forbidden, `${MESSAGES.path} Raw editor flags such as ${a} are not passed through.`)
    else positional.push(a)
  }
  if (verb === 'cmd') {
    const [name, ...given] = positional
    if (!name) throw new UnityError(EXIT.usage, 'Usage: genio-unity cmd <command> [json-object | key=value ...]')
    if (!COMMAND.test(name)) throw new UnityError(EXIT.usage, `Invalid command name "${name}".`)
    if (['exit', 'close_editor'].includes(name)) throw new UnityError(EXIT.usage, 'End the session with genio-unity play --stop.')
    let parameters = {}
    if (given.length === 1 && given[0].trim().startsWith('{')) {
      try { parameters = JSON.parse(given[0]) } catch { throw new UnityError(EXIT.usage, 'The parameters must be a JSON object.') }
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new UnityError(EXIT.usage, 'The parameters must be a JSON object.')
    } else {
      // key=value pairs survive every shell's quoting; values that parse as JSON keep their type.
      for (const pair of given) {
        const eq = pair.indexOf('=')
        if (eq < 1) throw new UnityError(EXIT.usage, `Expected key=value, got "${pair}".`)
        const raw = pair.slice(eq + 1)
        let value = raw
        try { value = JSON.parse(raw) } catch { /* a plain string */ }
        parameters[pair.slice(0, eq)] = value
      }
    }
    return { verb, name, parameters }
  }
  if (positional.length) throw new UnityError(EXIT.forbidden, MESSAGES.path)
  if (opts.timeout !== undefined) { opts.timeout = positiveInt('timeout', opts.timeout, 86_400); if (!opts.timeout) throw new UnityError(EXIT.usage, '--timeout must be at least 1.') }
  if (opts.wait !== undefined) opts.wait = positiveInt('wait', opts.wait, 86_400)
  opts.tail = opts.tail === undefined ? 100 : positiveInt('tail', opts.tail, 5000)
  if (verb !== 'console') delete opts.tail
  if (opts.mode !== undefined) {
    const mode = { editmode: 'EditMode', playmode: 'PlayMode' }[String(opts.mode).toLowerCase()]
    if (!mode) throw new UnityError(EXIT.usage, '--mode must be EditMode or PlayMode.')
    opts.mode = mode
  }
  if (opts.where !== undefined && !['auto', 'copy', 'slot'].includes(opts.where)) throw new UnityError(EXIT.usage, '--where must be auto, copy or slot.')
  if (verb === 'build' && !opts.target && !opts.profile) throw new UnityError(EXIT.usage, 'build needs --target or --profile.')
  if (opts['keep-editor'] && !opts.stop) throw new UnityError(EXIT.usage, '--keep-editor goes with --stop.')
  if (opts.close && (opts.stop || opts['no-open'])) throw new UnityError(EXIT.usage, '--close stands alone.')
  return { verb, opts }
}

export async function main(argv = process.argv.slice(2)) {
  let a
  try {
    a = parseArgs(argv)
    if (a.verb === 'help') { process.stdout.write(HELP); return EXIT.ok }
    const c = loadConfig()
    fs.mkdirSync(c.runs, { recursive: true })
    switch (a.verb) {
      case 'status': return await status(c)
      case 'play': return a.opts.close ? await closeSlots(c) : a.opts.stop ? await stopSession(c, a.opts['keep-editor'] === true) : await playSession(c, { open: !a.opts['no-open'] })
      case 'cmd': return await command(c, a.name, a.parameters)
      case 'console': return await consoleTail(c, a.opts.tail)
      default: return await batch(a.verb, c, a.opts)
    }
  } catch (e) {
    say(e.message)
    return e instanceof UnityError ? e.code : EXIT.failed
  }
}

function interrupted(signal) {
  for (const child of active) killTree(child.pid)
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

if (process.argv[1] && key(path.resolve(process.argv[1])) === key(fileURLToPath(import.meta.url))) {
  const verb = process.argv[2]
  if (verb !== 'play') for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => interrupted(signal))
  process.exitCode = await main()
}
