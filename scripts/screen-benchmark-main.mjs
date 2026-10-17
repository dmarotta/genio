// Electron main for scripts/screen-benchmark.mjs (bundled by it): the real services and IPC handlers over the Base
// copy in GENIO_SCREEN_BASE, one project window on the built renderer, and a scripted tour measured with the DevTools
// protocol. Units get real PTYs that fill a long scrollback and keep printing. Nothing runs supervision or agents.
import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
// '@main' and '@shared' are the measured checkout's (the launcher's working directory), wherever this file lives.
import { createApp, getCtx } from '@main/ctx'
import { registerIpc } from '@main/ipc'
import { createEventRouter } from '@main/event-router'
import { bus } from '@main/bus'
import { projectSnapshot } from '@main/project-windows'
import { registerMedia } from '@main/media-protocol'
import { MEDIA_SCHEME } from '@main/fal-service'
import { VIEWER_SCHEME } from '@shared/model-viewer'
import { API_PREFIX, EVENT_CHANNEL } from '@shared/api'

const env = process.env
const BASE = env.GENIO_SCREEN_BASE, PROJECT = env.GENIO_SCREEN_PROJECT || 'genio', OUT = env.GENIO_SCREEN_OUT, APP_ROOT = env.GENIO_SCREEN_APP_ROOT
const UNITS = Number(env.GENIO_SCREEN_UNITS || 6), PROFILE = env.GENIO_SCREEN_PROFILE === '1'
const FILL = 1_400_000
const now = () => performance.timeOrigin + performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: VIEWER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

// ---------------------------------------------------------------- IPC and event accounting
const calls = []
let pending = 0
const realHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, fn) => realHandle(channel, async (event, ...args) => {
  const rec = { method: channel.slice(API_PREFIX.length), at: now() }
  pending++
  try { const r = await fn(event, ...args); rec.result = r; return r }
  catch (e) { rec.error = String(e?.message ?? e); throw e }
  finally { pending--; rec.end = now(); calls.push(rec) }
})
const events = []
let snapshots = 0
const bytes = v => { try { return v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v) ?? '') } catch { return 0 } }

// A pseudo unit's output: a long Claude Code-like scrollback, then a line every 300 ms.
const FILLER = `
const E = '\\x1b[', c = (n, s) => E + n + 'm' + s + E + '0m'
const tools = ['Read', 'Bash', 'Update', 'Grep', 'Edit']
let n = 0
const line = () => { n++; const k = n % 9
  return k === 0 ? c('38;2;0;229;255', '●') + ' ' + c('1', tools[n % 5]) + '(src/renderer/src/views/Squad.tsx)'
    : k === 1 ? '  ⎿  Read ' + (n % 700) + ' lines'
    : k === 2 ? c('38;2;198;255;61', '     ' + n + ' +        <UnitSummary t={t} />')
    : k === 3 ? c('38;2;255;46;110', '     ' + n + ' -        <div className="detail-toolbar">')
    : k === 4 ? c('38;2;84;97;117', '✻ Thinking… (esc to interrupt · ' + (n % 60) + 's · ↓ ' + (n % 9) + '.1k tokens)')
    : 'The squad page reads each unit through its own terminal; line ' + n + ' of the transcript keeps going with more words.' }
let out = ''
while (out.length < Number(process.argv[2])) out += line() + '\\r\\n'
process.stdout.write(out)
setInterval(() => process.stdout.write(line() + '\\r\\n' + line() + '\\r\\n'), 300)
`

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const result = { project: PROJECT, phases: {}, ipc: {}, notes: {} }
  let t = performance.now()
  const ctx = createApp(APP_ROOT, BASE)
  result.notes.createAppMs = performance.now() - t
  const realSnapshot = ctx.snapshot
  ctx.snapshot = () => { snapshots++; return realSnapshot() }
  const ally = ctx.allies.list().find(a => !a.retiredAt && a.projects.length === 1 && a.projects[0] === PROJECT)
  if (!ally) throw new Error(`No project chat for ${PROJECT} in the Base copy`)
  const binding = { project: PROJECT, wksp: ally.name }

  // Live units: the project's live ones first, then its latest finished ones, each on a printing PTY.
  const filler = path.join(OUT, 'filler.js')
  fs.writeFileSync(filler, FILLER)
  const homes = [...ctx.homes.values()]
  const tasks = homes.flatMap(hc => hc.crew.list().map(task => ({ hc, task }))).filter(x => x.task.project === PROJECT)
  const order = s => (['working', 'blocked', 'paused', 'needs-decision', 'ready', 'validating'].includes(s) ? 0 : s === 'cleaned' ? 2 : 1)
  tasks.sort((a, b) => order(a.task.state) - order(b.task.state) || b.task.updatedAt.localeCompare(a.task.updatedAt))
  const units = tasks.slice(0, UNITS)
  for (const { hc, task } of units) {
    const term = ctx.terminals.create({ kind: 'worker', taskId: task.id, title: task.id, cwd: BASE, file: process.execPath, args: [filler, String(FILL)], env: { ELECTRON_RUN_AS_NODE: '1' }, harness: task.harness })
    hc.crew.update(task.id, { terminalId: term.id, state: task.state === 'cleaned' ? 'working' : task.state })
  }
  const termOf = id => ctx.terminals.list().find(x => x.taskId === id)?.id ?? ''
  const filled = Date.now() + 30_000
  while (Date.now() < filled && units.some(({ task }) => ctx.terminals.scrollback(termOf(task.id)).length < FILL * 0.6)) await sleep(250)
  result.notes.fillMs = 30_000 - (filled - Date.now())
  result.notes.units = units.map(({ task }) => ({ id: task.id, state: task.state, scrollback: ctx.terminals.scrollback(termOf(task.id)).length }))
  console.log('[screens] units ready', JSON.stringify(result.notes.units.map(u => u.scrollback)), `${result.notes.fillMs} ms`)

  let win
  registerIpc(getCtx, {
    openProject: async () => undefined, openHub: async () => undefined, close: () => undefined,
    binding: () => binding, list: () => [{ project: PROJECT, current: true }]
  })
  // Play actions would start Unity: never in a benchmark (status, sources and scenes stay real).
  for (const m of ['playerInstancePlay', 'playerInstanceStartUnity', 'playerInstanceEnterPlay', 'playerInstanceRestart', 'playerInstanceStream', 'playerCopyEnsure', 'playerCopySync', 'playerCopyDelete', 'playPoolCap', 'playPoolLaunch']) {
    ipcMain.removeHandler(API_PREFIX + m)
    realHandle(API_PREFIX + m, async () => { throw new Error('not in the benchmark') })
  }
  registerMedia(getCtx, { rendererDir: path.join(APP_ROOT, 'out', 'renderer') })
  const router = createEventRouter({
    snapshot: () => ctx.snapshot(), terminal: id => ctx.terminals.get(id),
    windows: () => win && !win.isDestroyed() ? [{ binding, alive: () => !win.isDestroyed() && !win.webContents.isDestroyed(), send: (channel, payload) => { events.push({ at: now(), channel, type: payload?.type, payload }); win.webContents.send(channel, payload) } }] : []
  })
  bus.onEvent(ev => { if (ev.type !== 'navigate') router.publish(ev) })
  ctx.terminals.onAnyData(router.terminalData)

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, backgroundColor: '#07090e', autoHideMenuBar: true, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07090e', symbolColor: '#00e5ff', height: 44 },
    webPreferences: { preload: path.join(APP_ROOT, 'out', 'preload', 'index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
  })
  win.setMenu(null)
  win.once('ready-to-show', () => win.showInactive())
  const consoleErrors = []
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && consoleErrors.length < 50) consoleErrors.push(e.message) })
  win.webContents.on('did-finish-load', () => {
    if (!win.webContents.getURL().startsWith('file:')) return
    win.webContents.send(EVENT_CHANNEL, { type: 'snapshot', data: projectSnapshot(ctx.snapshot(), binding) })
    win.webContents.send(EVENT_CHANNEL, { type: 'settings', settings: ctx.settings.get() })
  })
  // The DevTools protocol needs a page: a blank one first, then the measured load.
  await win.loadURL('about:blank')
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  const send = (method, params) => cdp.sendCommand(method, params)
  await send('Page.enable')
  await send('Performance.enable', { timeDomain: 'timeTicks' })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__bench = { long: [], frames: [], lastMut: 0 }
    new MutationObserver(() => { __bench.lastMut = performance.timeOrigin + performance.now() }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) __bench.long.push([performance.timeOrigin + e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true }) } catch {}
    __bench.frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.timeOrigin + performance.now()))))
    __bench.waitFor = (test, timeout) => new Promise(r => { const end = performance.now() + timeout; const f = () => { let ok = false; try { ok = test() } catch {} if (ok) __bench.frame().then(r); else if (performance.now() > end) r(-1); else requestAnimationFrame(f) }; f() })
    __bench.press = (key) => { const at = performance.timeOrigin + performance.now(); window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Digit' + key, ctrlKey: true, bubbles: true })); __bench.frame().then(t => __bench.frames.push([at, t])); return at }
  ` })
  const js = code => win.webContents.executeJavaScript(code)
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const lag = monitorEventLoopDelay({ resolution: 1 })
  lag.enable()
  const profileMain = PROFILE ? new Session() : undefined
  if (profileMain) { profileMain.connect(); profileMain.post('Profiler.enable'); }

  // GENIO_SCREEN_TRACE=<phase,...>: a Chromium timeline trace of those phases (layout and style events).
  const TRACE = new Set((env.GENIO_SCREEN_TRACE || '').split(',').filter(Boolean))
  let traceChunks = []
  cdp.on('message', (_e, method, params) => { if (method === 'Tracing.dataCollected') traceChunks.push(...params.value) })
  const traceDone = () => new Promise(r => { const on = (_e, method) => { if (method === 'Tracing.tracingComplete') { cdp.off('message', on); r() } }; cdp.on('message', on) })

  /** Measure one phase: `act` starts it (returns its start time), `ready` is a page test for its content. */
  const phase = async (name, act, ready, windowMs = 3000) => {
    const m0 = await metrics(), c0 = calls.length, e0 = events.length, s0 = snapshots, l0 = name === 'boot' ? 0 : await js('__bench.long.length')
    lag.reset()
    if (TRACE.has(name)) { traceChunks = []; await send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'v8.execute'] }, transferMode: 'ReportEvents' }) }
    if (PROFILE) { await send('Profiler.enable'); await send('Profiler.start'); profileMain.post('Profiler.start') }
    const t0 = await act()
    const content = ready ? await js(`__bench.waitFor(() => (${ready})(), 15000)`) : -1
    const first = await js(`new Promise(r => { const end = performance.now() + 5000; const f = () => { const x = __bench.frames.find(x => x[0] >= ${t0} - 1); x ? r(x[1]) : performance.now() > end ? r(-1) : setTimeout(f, 5) }; f() })`).catch(() => -1)
    const rest = t0 + windowMs - now()
    if (rest > 0) await sleep(rest)
    const m1 = await metrics()
    if (TRACE.has(name)) {
      const done = traceDone()
      await send('Tracing.end')
      await done
      fs.writeFileSync(path.join(OUT, `${name}.trace.json`), JSON.stringify({ traceEvents: traceChunks }))
    }
    if (PROFILE) {
      const { profile } = await send('Profiler.stop')
      fs.writeFileSync(path.join(OUT, `${name}.renderer.cpuprofile`), JSON.stringify(profile))
      await new Promise(r => profileMain.post('Profiler.stop', (err, res) => { if (!err) fs.writeFileSync(path.join(OUT, `${name}.main.cpuprofile`), JSON.stringify(res.profile)); r() }))
    }
    const ipc = calls.slice(c0), evs = events.slice(e0), long = (await js(`__bench.long.slice(${l0})`)).filter(([at]) => at >= t0)
    const early = ipc.filter(c => c.at - t0 < 1500)
    const d = k => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000
    result.phases[name] = {
      firstFrameMs: first > 0 ? first - t0 : undefined, contentMs: content > 0 ? content - t0 : undefined,
      dataMs: early.length ? Math.max(...early.map(c => c.end)) - t0 : 0,
      taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'),
      longTasks: long.length, longTaskMs: long.reduce((n, [, ms]) => n + ms, 0),
      ipcCalls: ipc.length, ipcKB: ipc.reduce((n, c) => n + bytes(c.result), 0) / 1024, ipcMainMs: ipc.reduce((n, c) => n + (c.end - c.at), 0),
      events: evs.length, eventKB: evs.reduce((n, e) => n + bytes(e.payload), 0) / 1024, snapshots: snapshots - s0,
      mainLagMaxMs: lag.max / 1e6, mainLagP99Ms: lag.percentile(99) / 1e6,
      heapMB: (m1.JSHeapUsedSize ?? 0) / 1048576, nodes: m1.Nodes ?? 0,
      ...(await js(`(() => { const n = s => document.querySelector(s)?.getElementsByTagName('*').length ?? 0; return { stageNodes: n('main.stage'), panelNodes: n('.genio-panel-content') } })()`))
    }
    for (const c of ipc) {
      const a = (result.ipc[c.method] ??= { calls: 0, ms: 0, maxMs: 0, kb: 0, errors: 0 })
      a.calls++; a.ms += c.end - c.at; a.maxMs = Math.max(a.maxMs, c.end - c.at); a.kb += bytes(c.result) / 1024; if (c.error) a.errors++
      delete c.result
    }
    for (const e of evs) delete e.payload
    console.log(`[screens] ${name}`, JSON.stringify(result.phases[name]))
  }

  // ---------------------------------------------------------------- the tour
  console.log('[screens] window ready, loading the renderer')
  const loadAt = now()
  const query = { project: PROJECT, wksp: binding.wksp }
  await phase('boot', async () => { void win.loadFile(path.join(APP_ROOT, 'out', 'renderer', 'index.html'), { query }); return loadAt },
    `() => document.querySelector('.chat-log [data-msg], .chat-log .msg')`, 6000)
  const fcp = await js(`(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1)`)
  result.phases.boot.fcpMs = fcp > 0 ? fcp + (await js('performance.timeOrigin')) - loadAt : undefined
  result.phases.boot.scriptTotalMs = (await metrics()).ScriptDuration * 1000
  await sleep(1500)
  await phase('idle-comms', async () => now(), undefined, 5000)

  const screens = (env.GENIO_SCREEN_LIST || 'squad,quests,status,systems,inventory,art-bible,play').split(',').filter(Boolean)
  const KEYS = { comms: '1', squad: '2', quests: '3', status: '5', 'art-bible': '6', systems: '8', inventory: '9', play: '0' }
  const shown = `() => { const s = document.querySelector('main.stage'); return s && s.firstElementChild && !s.querySelector('[data-loading]') }`
  for (const screen of screens) {
    if (!KEYS[screen]) continue
    await phase(screen, async () => js(`__bench.press(${JSON.stringify(KEYS[screen])})`), shown)
    await js(`__bench.press('1')`)
    await sleep(1500)
  }
  // The unit page with a long terminal, and the Modeller page when a live unit has a model.
  if (screens.includes('squad')) {
    await js(`__bench.press('2')`); await sleep(1500)
    await phase('unit-page', async () => js(`(() => { const at = performance.timeOrigin + performance.now(); document.querySelector('.unit-head')?.click(); __bench.frame().then(t => __bench.frames.push([at, t])); return at })()`),
      `() => document.querySelector('.detail-term .xterm-rows, .detail-term canvas, .detail-term .xterm-screen')`)
    await js(`__bench.press('1')`); await sleep(1500)
    const modeller = units.find(({ task }) => task.modeller)
    if (modeller) {
      await js(`__bench.press('2')`); await sleep(1500)
      await phase('modeller-page', async () => js(`(() => { const at = performance.timeOrigin + performance.now(); const head = [...document.querySelectorAll('.unit-head')].find(h => h.textContent.includes(${JSON.stringify(modeller.task.title.slice(0, 40))})); head?.click(); __bench.frame().then(t => __bench.frames.push([at, t])); return at })()`),
        `() => document.querySelector('.detail-canvas iframe, .modeller-view iframe')`, 5000)
      await js(`__bench.press('1')`); await sleep(1500)
    }
  }
  // Streamed chat while another screen is open, then on the chat itself.
  const stream = async (name, key) => {
    await js(`__bench.press(${JSON.stringify(key)})`); await sleep(2000)
    await phase(name, async () => {
      const at = now(), id = `bench-${Math.random().toString(16).slice(2)}`
      void (async () => { for (let i = 0; i < 150; i++) { bus.publish({ type: 'chat-delta', wksp: binding.wksp, id, text: `word ${i} of a streamed reply with **markdown** and \`code\`. ` }); await sleep(40) } })()
      return at
    }, undefined, 6000)
  }
  if (screens.includes('squad')) await stream('stream-on-squad', '2')
  await stream('stream-on-comms', '1')

  result.notes.consoleErrors = consoleErrors
  result.notes.ipcErrors = calls.filter(c => c.error).map(c => `${c.method}: ${c.error}`).slice(0, 30)
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2))
  for (const term of ctx.terminals.list()) ctx.terminals.kill(term.id)
  try { ctx.inventory.stop() } catch { /* best effort */ }
  app.exit(0)
}).catch(e => { console.error('[screens] failed', e); app.exit(1) })
