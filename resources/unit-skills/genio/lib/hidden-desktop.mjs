/**
 * Slot editors on Genio's hidden Win32 desktop: no window, no focus theft, and Unity still believes it is
 * focused, so it never throttles. Node has no API for CreateDesktop or STARTUPINFO.lpDesktop, so a tiny
 * C# helper (hidden-desktop/GenioDesktop.cs) does the Win32 calls. It is compiled once per source hash
 * with the csc.exe that ships with .NET Framework 4 on every Windows 10/11 into <data>/hidden-desktop/bin.
 * The helper only executes primitives; every decision (dialog rules, fallback, logging) lives here so it
 * is testable with a fake desktop API. Anything that cannot create the desktop (another OS, no compiler,
 * a restricted session) falls back to today's visible launch with a warning. Node 18+, standard library only.
 *
 *   <data>/hidden-desktop/bin/<hash>/genio-desktop.exe
 *   <data>/hidden-desktop/launches/<desktop>/exit.json    the editor's exit, written by the helper
 *                                            dialogs.jsonl every dialog seen and every button pressed
 *                                            watch.json    when each open dialog was first seen
 *                                            blocked-*.png screenshot of the hidden desktop on a block
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HELPER_SOURCE = path.join(HERE, 'hidden-desktop', 'GenioDesktop.cs')
const LAUNCH_TIMEOUT_MS = 30_000
const KEEP_LAUNCH_DIRS_MS = 7 * 24 * 3600_000

export const hiddenDesktopDir = data => path.join(data, 'hidden-desktop')

/** The .NET Framework 4 compiler every supported Windows ships; undefined elsewhere. */
export function cscPath(env = process.env) {
  if (process.platform !== 'win32') return undefined
  const windir = env.WINDIR || env.windir || env.SystemRoot || 'C:\\Windows'
  return ['Framework64', 'Framework'].map(f => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(p => fs.existsSync(p))
}

/** Builds the helper once per source hash; concurrent callers race to an atomic rename. */
export async function helperExecutable(data, { source = HELPER_SOURCE, compiler = cscPath(), compile = compileWithCsc } = {}) {
  const code = fs.readFileSync(source)
  const dir = path.join(hiddenDesktopDir(data), 'bin', createHash('sha256').update(code).digest('hex').slice(0, 16))
  const exe = path.join(dir, 'genio-desktop.exe')
  if (fs.existsSync(exe)) return exe
  if (!compiler) throw new Error('the .NET Framework C# compiler (csc.exe) is not installed')
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `build-${randomUUID().slice(0, 8)}.exe`)
  try {
    await compile(compiler, source, temp)
    try { fs.renameSync(temp, exe) } catch (e) { if (!fs.existsSync(exe)) throw e }
  } finally { fs.rmSync(temp, { force: true }) }
  return exe
}

function compileWithCsc(compiler, source, out) {
  return new Promise((resolve, reject) => execFile(compiler, ['/nologo', '/target:winexe', '/optimize+', '/r:System.Drawing.dll', `/out:${out}`, source], { windowsHide: true, timeout: 120_000 },
    (error, stdout) => error ? reject(new Error(`could not build the hidden-desktop helper: ${String(stdout).trim() || error.message}`)) : resolve()))
}

/** One argument as CommandLineToArgvW / the MSVC runtime reads it back (the rules Node uses for spawn). */
export function quoteArg(arg) {
  arg = String(arg)
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  let out = '"', slashes = 0
  for (const ch of arg) {
    if (ch === '\\') { slashes++; continue }
    out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
    slashes = 0
  }
  return out + '\\'.repeat(slashes * 2) + '"'
}
export function windowsCommandLine(file, args) {
  if (/"/.test(file)) throw new Error('Invalid executable path')
  return [`"${file}"`, ...args.map(quoteArg)].join(' ')
}

function parseLast(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).pop()
  try { return JSON.parse(line) } catch { return { ok: false, message: `unreadable helper output: ${line?.slice(0, 200) ?? ''}` } }
}

/** The real Win32 desktop API, through the compiled helper. Tests pass a fake with the same shape. */
export function createDesktopApi(data, { compiler = cscPath(), compile } = {}) {
  let exe
  const helper = () => exe ??= helperExecutable(data, { compiler, compile }).catch(e => { exe = undefined; throw e })
  const run = async (args, timeout = 15_000) => {
    const file = await helper()
    return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const v = parseLast(stdout)
      resolve(error && v.ok !== false && !Array.isArray(v) ? { ok: false, message: error.message } : v)
    }))
  }
  return {
    available: () => process.platform === 'win32' && !!compiler,
    /** Starts `command` on a new desktop; resolves {ok, pid, created, desktop, helper} or {ok: false, stage, message}. */
    async launch({ name, command, cwd, env, dir }) {
      const file = await helper()
      return new Promise(resolve => {
        // Detached: the helper owns the desktop for the editor's whole life, whoever launched it.
        const child = spawn(file, ['launch', '--desktop', name, '--cwd', cwd, '--command', Buffer.from(command, 'utf8').toString('base64'), '--dir', dir], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env })
        let done = false
        const finish = v => { if (done) return; done = true; clearTimeout(timer); lines.close(); child.stdout.destroy(); child.unref(); resolve(v) }
        const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish({ ok: false, stage: 'helper', message: 'the hidden-desktop helper did not answer' }) }, LAUNCH_TIMEOUT_MS)
        const lines = createInterface({ input: child.stdout })
        lines.once('line', line => finish(parseLast(line)))
        child.once('error', e => finish({ ok: false, stage: 'helper', message: e.message }))
        child.once('exit', code => finish({ ok: false, stage: 'helper', message: `the hidden-desktop helper exited (${code})` }))
      })
    },
    /** Visible top-level windows on the desktop; null once the desktop is gone. */
    async windows(desktop) { const v = await run(['windows', '--desktop', desktop]); if (Array.isArray(v)) return v; if (v.gone) return null; throw new Error(v.message ?? 'window listing failed') },
    async click(desktop, hwnd, button) { return (await run(['click', '--desktop', desktop, '--hwnd', String(hwnd), '--button', button])).ok === true },
    async screenshot(desktop, file) { return (await run(['screenshot', '--desktop', desktop, '--out', file], 30_000)).ok === true ? file : undefined },
    async close(desktop, pid) { const v = await run(['close', '--desktop', desktop, '--pid', String(pid)]); return v.ok === true && v.windows > 0 }
  }
}

function defaultSpawnVisible(file, args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, env, cwd })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve(child.pid) })
  })
}

function pruneLaunches(data, now = Date.now()) {
  const root = path.join(hiddenDesktopDir(data), 'launches')
  let names = []
  try { names = fs.readdirSync(root) } catch { return }
  for (const name of names) {
    const dir = path.join(root, name)
    try { if (fs.existsSync(path.join(dir, 'exit.json')) && now - fs.statSync(dir).mtimeMs > KEEP_LAUNCH_DIRS_MS) fs.rmSync(dir, { recursive: true, force: true }) } catch { /* in use */ }
  }
}

/**
 * Launches an editor for a Play slot: on a fresh hidden desktop unless `visible`, with the caller's
 * arguments and environment either way. Resolves the editor identity the pool records:
 * { pid, created, hidden, desktop?, dir?, helper?, warning? }. created is '' when unknown.
 */
export async function launchEditor({ file, args, cwd = process.cwd(), env = process.env, data, visible = false, label = 'slot', api, spawnVisible = defaultSpawnVisible }) {
  let warning
  if (visible) return { pid: await spawnVisible(file, args, { env }), created: '', hidden: false }
  api ??= createDesktopApi(data)
  if (!api.available()) warning = process.platform === 'win32' ? 'the .NET Framework C# compiler (csc.exe) is missing' : 'hidden desktops exist only on Windows'
  else {
    const name = `genio-${String(label).replace(/[^\w-]/g, '').slice(0, 24) || 'slot'}-${randomUUID().slice(0, 8)}`
    const dir = path.join(hiddenDesktopDir(data), 'launches', name)
    try {
      pruneLaunches(data)
      fs.mkdirSync(dir, { recursive: true })
      const v = await api.launch({ name, command: windowsCommandLine(file, args), cwd, env, dir })
      if (v?.ok && Number.isInteger(v.pid) && v.pid > 0) return { pid: v.pid, created: typeof v.created === 'string' && /^\d+$/.test(v.created) ? v.created : '', hidden: true, desktop: v.desktop || name, dir, helper: v.helper }
      warning = v?.message ?? 'the hidden-desktop helper failed'
    } catch (e) { warning = e.message }
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const pid = await spawnVisible(file, args, { env })
  return { pid, created: '', hidden: false, warning: `Opened the slot editor visibly: ${warning}.` }
}

// ---------------------------------------------------------------- dialog watcher

/**
 * Dialogs on a hidden desktop are invisible, and a modal one stalls the editor. Benign ones get their safe
 * button; blocking ones fail the lease. Order matters: the first matching rule wins.
 */
export const DIALOG_RULES = [
  // Unity progress windows are not modal questions: they close by themselves.
  { id: 'progress', kind: 'ignore', title: /^(?:hold on|compiling|importing|reloading|loading|refreshing|initiali[sz]ing|building|baking|updating|resolving|searching|saving|waiting|busy|application\.)/i },
  { id: 'scene-modified', kind: 'benign', match: /scene\(s\) have been modified|save changes to the following|do you want to save the changes/i, button: ["Don't Save", 'Discard', 'No'] },
  { id: 'api-updater', kind: 'benign', match: /api update required|script updating consent/i, button: ['No Thanks'] },
  // Compile errors: continue without Safe Mode so the console (and the unit) can see them.
  { id: 'safe-mode', kind: 'benign', match: /safe mode/i, button: ['Ignore'] },
  { id: 'licence', kind: 'blocking', immediate: true, match: /licen[cs]e|activation|sign in|unity hub|seat/i, reason: 'a Unity licence or sign-in prompt' },
  { id: 'crash', kind: 'blocking', immediate: true, match: /crash|bug report|has stopped working|fatal error/i, reason: 'Unity crashed' },
  { id: 'import-errors', kind: 'blocking', match: /import(?:ing)? (?:error|failed)|failed to import|errors? (?:while|during) import/i, reason: 'an import error dialog' },
  { id: 'version', kind: 'blocking', immediate: true, match: /non-matching editor|different version of unity|upgrade the project|downgrad/i, reason: 'a Unity version prompt' }
]
const DIALOG_CLASSES = /^(?:#32770|DirectUIHWND)$/
const FOREIGN_PROCESS = /^(?:UnityCrashHandler(?:64|32)?|UnityBugReporter|Unity Hub|Unity\.Licensing\.Client)$/i
const plain = s => String(s).replace(/&/g, '').trim().toLowerCase()

/** { kind: 'ignore' | 'benign' | 'blocking', rule, button?, immediate? } for one window description. */
export function classifyWindow(w, rules = DIALOG_RULES) {
  const text = [w.title, ...(w.texts ?? [])].join('\n')
  const dialog = DIALOG_CLASSES.test(w.className ?? '') || FOREIGN_PROCESS.test(w.process ?? '')
  for (const rule of rules) {
    const hit = rule.title ? rule.title.test(w.title ?? '') : rule.match.test(text)
    if (!hit) continue
    if (rule.kind === 'ignore') return { kind: 'ignore', rule: rule.id }
    // A rule names dialogs; an ordinary editor window that happens to say "Licence" is not one.
    if (!dialog) continue
    if (rule.kind === 'benign') {
      const button = (w.buttons ?? []).find(b => rule.button.some(want => plain(want) === plain(b)))
      if (button) return { kind: 'benign', rule: rule.id, button }
      return { kind: 'blocking', rule: rule.id, reason: 'a dialog without its expected safe button' }
    }
    return { kind: 'blocking', rule: rule.id, reason: rule.reason, immediate: !!rule.immediate }
  }
  return dialog ? { kind: 'blocking', rule: 'unknown', reason: 'an unexpected dialog', immediate: false } : { kind: 'ignore', rule: 'window' }
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * One watcher pass over a launch's desktop. Logs each dialog once (title, text, buttons), presses the safe
 * button of benign ones, and reports a block once an unknown dialog has stayed for graceMs (licence and
 * crash dialogs at once), with a screenshot of the hidden desktop when one can be taken.
 * benignOnly: dismiss what is safe but never report a block (used while closing an editor).
 */
export async function inspectDesktop(api, launch, { now = Date.now(), graceMs = 10_000, benignOnly = false, rules = DIALOG_RULES } = {}) {
  if (!launch?.desktop || !launch.dir) return { watched: false, clicked: [] }
  const windows = await api.windows(launch.desktop)
  if (windows === null) return { watched: true, gone: true, clicked: [] }
  fs.mkdirSync(launch.dir, { recursive: true })
  const log = event => { try { fs.appendFileSync(path.join(launch.dir, 'dialogs.jsonl'), JSON.stringify({ at: new Date(now).toISOString(), ...event }) + '\n') } catch { /* logging never blocks the watcher */ } }
  const watchFile = path.join(launch.dir, 'watch.json')
  const before = readJson(watchFile, {}), seen = {}
  const clicked = []
  let blocked
  for (const w of windows) {
    const c = classifyWindow(w, rules)
    if (c.kind === 'ignore') continue
    const key = String(w.hwnd), first = Number.isFinite(before[key]) ? before[key] : now
    seen[key] = first
    const detail = { hwnd: key, pid: w.pid, process: w.process, className: w.className, title: clip(w.title), text: clip((w.texts ?? []).join(' '), 1000), buttons: w.buttons ?? [], rule: c.rule }
    if (!(key in before)) log({ event: 'dialog', ...detail, kind: c.kind })
    if (c.kind === 'benign') {
      const ok = await api.click(launch.desktop, w.hwnd, c.button).catch(() => false)
      log({ event: ok ? 'clicked' : 'click-failed', ...detail, button: c.button })
      if (ok) clicked.push({ title: detail.title, button: c.button, rule: c.rule })
      continue
    }
    if (benignOnly || blocked || !c.immediate && now - first < graceMs) continue
    blocked = { ...detail, reason: c.reason }
  }
  try { fs.writeFileSync(watchFile, JSON.stringify(seen)) } catch { /* next pass starts the clock again */ }
  if (!blocked) return { watched: true, clicked }
  const shot = await api.screenshot(launch.desktop, path.join(launch.dir, `blocked-${now}.png`)).catch(() => undefined)
  blocked.screenshot = shot
  blocked.message = `is blocked by ${blocked.reason} on its hidden desktop: "${blocked.title || '(untitled)'}"${blocked.text ? ` says "${blocked.text}"` : ''}${blocked.buttons.length ? ` [${blocked.buttons.join(' | ')}]` : ''}.` +
    `${shot ? ` Screenshot: ${shot}.` : ''} Genio closed that editor and ended the lease. To see the dialog, switch Settings › This project › Unity slots › Slot editor windows to Visible and open the slot again.`
  log({ event: 'blocked', ...blocked })
  return { watched: true, clicked, blocked }
}
