// Spike orchestration, from a Genio checkout (Node 18+, Windows):
//   node run-spike.mjs launch --data <scratch dir>     scratch project in a new temp folder; editor on a hidden desktop
//                                                      with -force-d3d11 (--d3d12: without it, the project's own API),
//                                                      launched like Genio's Play editor; stays in the foreground
//                                                      watching dialogs until the editor exits (run it in the background)
//   node run-spike.mjs run --data <dir> --label L -- <consumer args>    one consumer run against that editor, with
//                                                      Genio's src/main/play-stream.ts bundled into <data>/bundle
//   node run-spike.mjs quit --data <dir>               quits that editor (forced after 90 s), deletes the scratch project
// Only the editor this script launched (pid and creation time recorded in <data>/spike-state.json) is ever stopped.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const { launchEditor, inspectDesktop, createDesktopApi } = await import(new URL('file:///' + path.join(repo, 'resources/unit-skills/genio/lib/hidden-desktop.mjs').replace(/\\/g, '/')).href)
const [verb, ...rest] = process.argv.slice(2)
const dash = rest.indexOf('--')
const own = dash >= 0 ? rest.slice(0, dash) : rest, extra = dash >= 0 ? rest.slice(dash + 1) : []
const opt = (n, d) => { const i = own.indexOf(`--${n}`); return i >= 0 ? own[i + 1] : d }
const data = path.resolve(opt('data') ?? fail('--data is required'))
const stateFile = path.join(data, 'spike-state.json')
const UNITY = opt('unity', 'C:/Program Files/Unity/Hub/Editor/6000.5.1f1/Editor/Unity.exe')
function fail(m) { console.error(m); process.exit(2) }
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const say = o => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }))
const alive = pid => { try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' }).includes(`"${pid}"`) } catch { return false } }

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue
    const s = path.join(from, e.name), d = path.join(to, e.name)
    if (e.isDirectory()) copyDir(s, d, skip); else if (e.isFile()) fs.copyFileSync(s, d)
  }
}

if (verb === 'launch') {
  if (fs.existsSync(stateFile) && alive(readState().pid)) fail('a spike editor is already running')
  // --reuse: the last launch's project (kept by quit --keep), with the spike sources copied over it again.
  const root = own.includes('--reuse') ? readState().root : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-spike-83f6-')), 'SpikeProject')
  copyDir(path.join(here, 'unity', 'Assets'), path.join(root, 'Assets'))
  // The real package, minus its Pipeline dependency (stubbed in Assets/PipelineStub: the spike starts sessions directly).
  const pkg = path.join(root, 'Packages', 'com.genio.play')
  copyDir(path.join(repo, 'resources/unity/com.genio.play'), pkg)
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))
  delete manifest.dependencies['com.unity.pipeline']
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: Object.fromEntries(
    ['imageconversion', 'screencapture', 'physics', 'jsonserialize', 'imgui', 'audio'].map(m => [`com.unity.modules.${m}`, '1.0.0'])) }, null, 2))
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.1f1\n')
  fs.mkdirSync(path.join(root, 'spike'), { recursive: true })
  fs.rmSync(path.join(root, 'spike', 'request.json'), { force: true })  // a kept project's last request is the quit
  const log = path.join(data, 'editor.log')
  fs.rmSync(log, { force: true })
  // As player-instance.ts launches the Play editor for the GPU stream (with --d3d12, as it launches one that cannot use it).
  const args = ['-automated', '-projectPath', root, '-logFile', log, ...(own.includes('--d3d12') ? [] : ['-force-d3d11']), ...extra]
  const launched = await launchEditor({ file: UNITY, args, cwd: root, data, label: 'spike83f6' })
  const state = { root, log, args, ...launched, startedAt: new Date().toISOString() }
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
  say({ event: 'launched', ...state })
  const api = createDesktopApi(data)
  while (alive(launched.pid)) {
    const w = await inspectDesktop(api, launched, { graceMs: 15_000 }).catch(e => ({ error: e.message }))
    if (w.clicked?.length) say({ event: 'clicked', clicked: w.clicked })
    if (w.blocked) { say({ event: 'blocked', message: w.blocked.message }); break }
    await new Promise(r => setTimeout(r, 3000))
  }
  say({ event: 'watch-ended', alive: alive(launched.pid) })
} else if (verb === 'run') {
  const state = readState()
  const label = opt('label') ?? fail('--label is required')
  const results = path.join(data, 'results'); fs.mkdirSync(results, { recursive: true })
  const electron = path.join(repo, 'node_modules/electron/dist/electron.exe')
  // Genio's own stream code (PlayStream, the fast path, the shared-texture adapter), as the app bundles it.
  const bundle = path.join(data, 'bundle', 'genio-play-stream.cjs')
  const { build } = await import(new URL('file:///' + path.join(repo, 'node_modules/esbuild/lib/main.js').replace(/\\/g, '/')).href)
  await build({ stdin: { contents: `export { PlayStream } from './src/main/play-stream'; export { textureApi } from './src/main/shared-texture'`, resolveDir: repo, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: bundle, tsconfig: path.join(repo, 'tsconfig.node.json'), external: ['electron', 'bufferutil', 'utf-8-validate'], logLevel: 'warning' })
  const args = [path.join(here, 'consumer'), '--label', label, '--project', state.root, '--out', results, '--bundle', bundle, ...extra]
  const out = fs.openSync(path.join(results, `${label}.out`), 'w')
  const child = spawn(electron, args, { stdio: ['ignore', out, out], windowsHide: true })
  const code = await new Promise(r => child.once('exit', r))
  say({ event: 'run-ended', label, code, out: fs.readFileSync(path.join(results, `${label}.out`), 'utf8').split(/\r?\n/).filter(l => /^(RESULT|FAILED)/.test(l)) })
  fs.rmSync(path.join(results, 'userdata'), { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
} else if (verb === 'quit') {
  const state = readState()
  fs.writeFileSync(path.join(state.root, 'spike', 'request.json'), JSON.stringify({ id: `quit-${Date.now()}`, mode: 'quit' }))
  let gone = false
  for (let i = 0; i < 90 && !gone; i++) { await new Promise(r => setTimeout(r, 1000)); gone = !alive(state.pid) }
  if (!gone && state.desktop) await createDesktopApi(data).close(state.desktop, state.pid).catch(() => false)
  for (let i = 0; i < 20 && !gone; i++) { await new Promise(r => setTimeout(r, 1000)); gone = !alive(state.pid) }
  if (!gone) { try { execFileSync('taskkill', ['/PID', String(state.pid), '/F']) } catch { } }
  await new Promise(r => setTimeout(r, 3000))
  // Helpers this editor started and left (shader compiler, import workers, IL post-processing); never the licensing
  // client, which other editors share.
  const orphans = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${state.pid}" | Where-Object { $_.Name -notmatch 'Licensing' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8' }).trim()
  for (const line of orphans.split(/\r?\n/).filter(Boolean)) { try { execFileSync('taskkill', ['/PID', line.split(' ')[0], '/F']) } catch { } say({ event: 'stopped-helper', process: line }) }
  // The project folder and its temp parent; retried while Unity's child processes let go of files.
  const parent = path.dirname(state.root)
  if (own.includes('--keep')) { say({ event: 'quit', forced: !gone, editorAlive: alive(state.pid), projectKept: state.root }); process.exit(0) }
  for (let i = 0; i < 10 && fs.existsSync(parent); i++) { try { fs.rmSync(parent, { recursive: true, force: true }) } catch { await new Promise(r => setTimeout(r, 2000)) } }
  say({ event: 'quit', forced: !gone, editorAlive: alive(state.pid), projectRemoved: !fs.existsSync(parent) })
} else fail('usage: launch | run | quit')
