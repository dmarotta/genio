// Screen benchmark: Genio's real main-process services and IPC over a sandboxed copy of a Base, driving the built
// renderer (npm run build) in Electron, with Chromium metrics per screen. Read-only for the source Base and projects.
// Usage: node scripts/screen-benchmark.mjs <output-dir> [--base <Base root>] [--project <name>] [--runs <n>] [--units <n>]
//        [--screens squad,quests,...] [--profile] [--trace <phase,...>]
//        node scripts/screen-benchmark.mjs --freeze <dir> [--base <Base root>]
// The copy skips worktrees, Play pools, player copies and the Claude/Codex homes; Base paths inside it are remapped
// into the copy, project folders stay where they are and are only read. results.json and summary.json go to <output-dir>.
// A live Base changes while units run: --freeze keeps one filtered snapshot, and --base <that dir> compares revisions
// on the same data. Run from the checkout to measure (this file can live elsewhere, e.g. to measure an older revision).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const root = process.cwd()
const here = path.dirname(fileURLToPath(import.meta.url))
const { build } = await import(pathToFileURL(createRequire(path.join(root, 'package.json')).resolve('esbuild')).href)
const { assertChildHomes, createIsolatedHomes } = await import(pathToFileURL(path.join(root, 'tests', 'support', 'isolated-homes.mjs')).href)
const source = path.resolve(flag('base', path.join(os.homedir(), '.genio')))
const project = flag('project', 'genio')
const runs = Number(flag('runs', '3'))

// Large or private folders never enter the copy. A unit's data folder keeps its brief and report; a live unit's also
// keeps its other top-level files and its Modeller steps. Matched below the copied Base's own root.
const SKIP = /[\\/](worktrees|projects|node_modules|chat-images|validation-node_modules|play-pools|player-copies|claude-home|codex-home|skills)([\\/]|$)/
const TASK_DIR = /[\\/]data[\\/]([^\\/]+-[0-9a-f]{4})(?:[\\/]|$)/
const norm = p => path.resolve(p).replaceAll('\\', '/').toLowerCase()

function liveTaskIds() {
  const ids = new Set()
  const homes = [source, ...fs.readdirSync(path.join(source, 'wksps'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(source, 'wksps', d.name))]
  for (const home of homes) {
    try { for (const t of JSON.parse(fs.readFileSync(path.join(home, 'state', 'tasks.json'), 'utf8'))) if (t.state !== 'cleaned') ids.add(t.id) } catch { /* no tasks */ }
  }
  return ids
}

/** Copy `source` to `destination`; `env` (the sandbox) replaces agent home settings, none keeps them. */
function copyBase(destination, env) {
  const live = liveTaskIds()
  fs.cpSync(source, destination, {
    recursive: true,
    filter: abs => {
      const src = path.sep + path.relative(source, abs)
      if (SKIP.test(src)) return false
      const task = TASK_DIR.exec(src)
      if (!task) return true
      const inside = src.slice(task.index + task[0].length)
      if (!inside) return true
      if (live.has(task[1])) return /^modeller([\\/]|$)/.test(inside) || (!/[\\/]/.test(inside) && fs.statSync(abs).isFile())
      return /^(brief|report)\.md$/.test(inside)
    }
  })
  // Base paths point into the copy; projects stay where they are (read only). Agent homes are the sandbox's.
  const from = norm(source)
  const HOME_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'GENIO_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP', 'TMPDIR']
  const rewrite = (value, key = '') => {
    if (Array.isArray(value)) return value.map(item => rewrite(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]))
    if (env && HOME_KEYS.includes(key) && typeof value === 'string') return env[key]
    if (typeof value === 'string' && path.isAbsolute(value) && (norm(value) === from || norm(value).startsWith(from + '/'))) return path.join(destination, path.relative(source, value))
    return value
  }
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.json')) {
        let parsed
        try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
        fs.writeFileSync(file, JSON.stringify(rewrite(parsed), null, 2))
      }
    }
  }
  walk(destination)
}

const frozen = flag('freeze')
if (frozen) {
  if (fs.existsSync(frozen)) throw new Error(`${frozen} exists: freeze into a new folder`)
  const t0 = Date.now()
  copyBase(path.resolve(frozen))
  console.log(`[screens] froze ${source} into ${path.resolve(frozen)} in ${Date.now() - t0} ms`)
  process.exit(0)
}
const output = path.resolve(args[0] ?? '')
if (!args[0] || args[0].startsWith('--')) throw new Error('Usage: node scripts/screen-benchmark.mjs <output-dir> [--base <Base root>] [--project <name>] [--runs <n>]')
if (!fs.existsSync(path.join(root, 'out', 'renderer', 'index.html'))) throw new Error('Run npm run build first: the benchmark drives the built renderer.')
fs.mkdirSync(output, { recursive: true })

const mainFile = path.join(root, 'out', 'screen-benchmark', 'main.cjs')
await build({
  entryPoints: [path.join(here, 'screen-benchmark-main.mjs')], bundle: true, platform: 'node', format: 'cjs', outfile: mainFile,
  alias: { '@shared': path.join(root, 'src', 'shared'), '@main': path.join(root, 'src', 'main') }, packages: 'external', logLevel: 'warning',
  // As in Genio's own bundle, plugin modules find their resources from out/<folder>/ (resource-path.mjs).
  define: { 'import.meta.url': '__benchModuleUrl' }, banner: { js: "const __benchModuleUrl = require('node:url').pathToFileURL(__filename).href;" }
})

const results = []
for (let run = 0; run < runs; run++) {
  const homes = createIsolatedHomes('genio-screens-')
  try {
    const base = homes.env.GENIO_HOME
    fs.rmSync(base, { recursive: true, force: true })
    const t0 = Date.now()
    copyBase(base, homes.env)
    console.log(`[screens] run ${run + 1}/${runs}: Base copied in ${Date.now() - t0} ms`)
    const env = { ...process.env, ...homes.env, GENIO_SCREEN_BASE: base, GENIO_SCREEN_PROJECT: project, GENIO_SCREEN_OUT: path.join(output, `run-${run + 1}`),
      GENIO_SCREEN_APP_ROOT: root, GENIO_SCREEN_UNITS: flag('units', '6'), GENIO_SCREEN_LIST: flag('screens', ''), GENIO_SCREEN_PROFILE: args.includes('--profile') ? '1' : '', GENIO_SCREEN_TRACE: flag('trace', '') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
    assertChildHomes(env)
    fs.mkdirSync(env.GENIO_SCREEN_OUT, { recursive: true })
    const electron = createRequire(import.meta.url)('electron')
    const child = spawn(electron, [mainFile, `--user-data-dir=${path.join(homes.root, 'electron-user-data')}`], { env, cwd: homes.root, stdio: 'inherit', windowsHide: true })
    // A main that fails to load shows Electron's error dialog and never exits.
    const limit = setTimeout(() => child.kill(), 10 * 60_000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', c => resolve(c ?? 1)) }).finally(() => clearTimeout(limit))
    if (code !== 0) throw new Error(`benchmark run ${run + 1} exited with ${code}`)
    results.push(JSON.parse(fs.readFileSync(path.join(env.GENIO_SCREEN_OUT, 'result.json'), 'utf8')))
  } finally { homes.dispose() }
}

// Median per measure across runs.
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined }
const summary = {}
for (const r of results) for (const [phase, values] of Object.entries(r.phases)) for (const [k, v] of Object.entries(values)) if (typeof v === 'number') ((summary[phase] ??= {})[k] ??= []).push(v)
for (const phase of Object.keys(summary)) for (const k of Object.keys(summary[phase])) summary[phase][k] = median(summary[phase][k])
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
const cols = ['firstFrameMs', 'contentMs', 'dataMs', 'taskMs', 'scriptMs', 'layoutMs', 'styleMs', 'longTasks', 'longTaskMs', 'ipcCalls', 'ipcKB', 'eventKB', 'mainLagMaxMs']
console.log(['', `| phase (median of ${results.length}) | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
  ...Object.entries(summary).map(([phase, v]) => `| ${phase} | ${cols.map(c => v[c] === undefined ? '' : (Math.abs(v[c]) >= 100 ? v[c].toFixed(0) : v[c].toFixed(1))).join(' | ')} |`), ''].join('\n'))
