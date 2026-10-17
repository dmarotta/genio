// Electron main for scripts/screen-benchmark.mjs (bundled by it): the real services and IPC handlers over the Base
// copy in GENIO_SCREEN_BASE, one project window on the built renderer, and a scripted tour measured with the DevTools
// protocol. Units get real PTYs that fill a long scrollback and keep printing. Nothing runs supervision or agents.
import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { Session } from 'node:inspector'
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
// '@main' and '@shared' are the measured checkout's (the launcher's working directory), wherever this file lives.
import { createApp, getCtx } from '@main/ctx'
import { registerIpc } from '@main/ipc'
import { createEventRouter } from '@main/event-router'
import { bus } from '@main/bus'
import { projectSnapshot } from '@main/project-windows'
import { registerMedia } from '@main/media-protocol'
import { playerInstanceService } from '@main/player-instance'
import { PlayStream } from '@main/play-stream'
import { MEDIA_SCHEME } from '@main/fal-service'
import { VIEWER_SCHEME } from '@shared/model-viewer'
import { API_PREFIX, EVENT_CHANNEL } from '@shared/api'

const env = process.env
const BASE = env.GENIO_SCREEN_BASE, PROJECT = env.GENIO_SCREEN_PROJECT || 'genio', OUT = env.GENIO_SCREEN_OUT, APP_ROOT = env.GENIO_SCREEN_APP_ROOT
const UNITS = Number(env.GENIO_SCREEN_UNITS || 6), PROFILE = env.GENIO_SCREEN_PROFILE === '1', SHOTS = env.GENIO_SCREEN_SHOTS === '1', PLAY_STREAM = env.GENIO_SCREEN_PLAY_STREAM === '1'
const RENDERER = env.GENIO_SCREEN_RENDERER || path.join(APP_ROOT, 'out', 'renderer'), PRELOAD = env.GENIO_SCREEN_PRELOAD || path.join(APP_ROOT, 'out', 'preload', 'index.js')
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

// A stand-in for com.genio.play's StreamSession: the same authenticated loopback socket, JPEG frames at the
// package's 30 fps cadence (one in flight, as Unity's single pending readback) and 'GA' audio packets every mixer
// block. Each frame carries a COM segment "GBENCH:<n>:<sent ms>" so the page can time it to paint.
const STAND_IN = `
const fs = require('fs'), path = require('path')
const [appRoot, port, token, dir, fps, statsFile] = process.argv.slice(2)
const WebSocket = require(require.resolve('ws', { paths: [appRoot] }))
const frames = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort().map(f => fs.readFileSync(path.join(dir, f)))
const ws = new WebSocket('ws://127.0.0.1:' + port + '/play', { headers: { Authorization: 'Bearer ' + token }, perMessageDeflate: false })
let n = 0, sent = 0, busy = 0, bytes = 0, audio = 0, sending = false
const stamp = (jpg, id) => { const text = Buffer.from('GBENCH:' + id + ':' + Date.now()); const seg = Buffer.alloc(4 + text.length); seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(text.length + 2, 2); text.copy(seg, 4); return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]) }
ws.on('open', () => {
  // Unity's cadence is frame-timed: schedule against the clock (Windows timers tick every ~15.6 ms, so a plain 33 ms
  // interval sends ~21 fps).
  const start = performance.now(), period = 1000 / Number(fps)
  const tick = () => {
    if (sending) busy++
    else { const frame = stamp(frames[n++ % frames.length], n); sending = true; ws.send(frame, () => { sending = false; sent++; bytes += frame.length }) }
    const k = Math.floor((performance.now() - start) / period) + 1
    setTimeout(tick, Math.max(0, start + k * period - performance.now()))
  }
  tick()
  let seq = 0
  setInterval(() => { const blocks = 1024, ch = 2, p = Buffer.alloc(24 + blocks * ch * 2); p[0] = 0x47; p[1] = 0x41; p[2] = 1; p[3] = ch; p.writeUInt32LE(seq++, 4); p.writeUInt32LE(48000, 8); p.writeUInt16LE(blocks, 12); p.writeDoubleLE(Date.now(), 16); ws.send(p); audio++ }, 1000 * 1024 / 48000)
  setInterval(() => fs.writeFileSync(statsFile, JSON.stringify({ sent, busy, bytes, audio })), 250)
})
ws.on('close', () => process.exit(0)); ws.on('error', () => process.exit(1))
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
  for (const m of ['playerInstancePlay', 'playerInstanceStartUnity', 'playerInstanceEnterPlay', 'playerInstanceRestart', ...(PLAY_STREAM ? [] : ['playerInstanceStream']), 'playerCopyEnsure', 'playerCopySync', 'playerCopyDelete', 'playPoolCap', 'playPoolLaunch']) {
    ipcMain.removeHandler(API_PREFIX + m)
    realHandle(API_PREFIX + m, async () => { throw new Error('not in the benchmark') })
  }
  // --play-stream: Play reports "playing" and its stream comes from the stand-in, through Genio's own PlayStream
  // socket and the real playerInstanceStream handler, MessagePort and live view. Nothing starts Unity.
  const play = { stream: undefined, child: undefined, received: 0, size: '', statsFile: path.join(OUT, 'stand-in.json') }
  const stopStandIn = () => { try { play.child?.kill() } catch { /* gone */ } play.child = undefined; play.stream?.close(); play.stream = undefined }
  if (PLAY_STREAM) {
    const service = playerInstanceService(ctx)
    const realStatus = service.status.bind(service)
    fs.writeFileSync(path.join(OUT, 'unity-stand-in.cjs'), STAND_IN)
    service.start = async () => undefined
    service.status = world => ({ ...realStatus(world), state: 'playing', pid: 4242, capabilities: { input: true } })
    service.stream = async (_world, width, height, onFrame, onDisconnect, onAudio) => {
      stopStandIn()
      const stream = play.stream = new PlayStream()
      const { port, token } = await stream.listen()
      play.size = `${width}x${height}`
      stream.onFrame = frame => { play.received++; onFrame(frame) }
      stream.onAudio = onAudio
      stream.onDisconnect = onDisconnect
      play.child = spawn(process.execPath, [path.join(OUT, 'unity-stand-in.cjs'), APP_ROOT, String(port), token, path.join(OUT, `frames-${width}x${height}`), '30', play.statsFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true })
      for (const end = Date.now() + 10_000; !stream.connected && Date.now() < end;) await sleep(20)
    }
    service.resize = async world => realStatus(world)
    service.detach = async () => { stopStandIn() }
    service.input = (_world, input) => { play.stream?.input(input) }
  }
  registerMedia(getCtx, { rendererDir: RENDERER })
  const router = createEventRouter({
    snapshot: () => ctx.snapshot(), terminal: id => ctx.terminals.get(id),
    windows: () => win && !win.isDestroyed() ? [{ binding, alive: () => !win.isDestroyed() && !win.webContents.isDestroyed(), send: (channel, payload) => { events.push({ at: now(), channel, type: payload?.type, payload }); win.webContents.send(channel, payload) } }] : []
  })
  bus.onEvent(ev => { if (ev.type !== 'navigate') router.publish(ev) })
  ctx.terminals.onAnyData(router.terminalData)

  win = new BrowserWindow({
    width: 1440, height: 900, show: false, backgroundColor: '#07090e', autoHideMenuBar: true, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07090e', symbolColor: '#00e5ff', height: 44 },
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
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
    // Checked every frame for 2 s, then every 100 ms: a selector that never matches must not load the page it measures.
    __bench.waitFor = (test, timeout) => new Promise(r => { const start = performance.now(), end = start + timeout; const f = () => { let ok = false; try { ok = test() } catch {} if (ok) __bench.frame().then(r); else if (performance.now() > end) r(-1); else if (performance.now() - start < 2000) requestAnimationFrame(f); else setTimeout(f, 100) }; f() })
    __bench.press = (key) => { const at = performance.timeOrigin + performance.now(); window.dispatchEvent(new KeyboardEvent('keydown', { key, code: 'Digit' + key, ctrlKey: true, bubbles: true })); __bench.frame().then(t => __bench.frames.push([at, t])); return at }
    // Play frames: decode time, and paint time of each stamped frame (its COM segment names it and its send time).
    __bench.play = { decodes: [], painted: [] }
    const ids = new WeakMap(), decode = window.createImageBitmap.bind(window), draw = CanvasRenderingContext2D.prototype.drawImage
    window.createImageBitmap = (src, ...rest) => {
      const t = performance.now()
      const id = src instanceof Blob ? src.slice(0, 64).arrayBuffer().then(b => /GBENCH:(\\d+):(\\d+)/.exec(new TextDecoder().decode(b))) : Promise.resolve(null)
      return decode(src, ...rest).then(bitmap => { __bench.play.decodes.push(performance.now() - t); ids.set(bitmap, id); return bitmap })
    }
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
      const out = draw.call(this, image, ...rest), id = ids.get(image)
      if (id) requestAnimationFrame(() => { const at = performance.timeOrigin + performance.now(); id.then(m => { if (m) __bench.play.painted.push([Number(m[1]), Number(m[2]), at]) }) })
      return out
    }
  ` })
  const js = code => win.webContents.executeJavaScript(code)
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  // Game-like frames for the stand-in, encoded by Chromium at Unity's quality 75: a sky, a ground, many lit shapes
  // and a noise texture that moves each frame (so every frame is a real JPEG of a busy scene, not a flat one).
  if (PLAY_STREAM) for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    const dir = path.join(OUT, `frames-${w}x${h}`)
    fs.mkdirSync(dir, { recursive: true })
    const urls = await js(`(() => {
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const g = c.getContext('2d')
      const noise = document.createElement('canvas'); noise.width = noise.height = 256; const n = noise.getContext('2d'), img = n.createImageData(256, 256)
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      for (let i = 0; i < img.data.length; i += 4) { const v = 80 + rnd() * 120; img.data[i] = v; img.data[i + 1] = v * 0.9; img.data[i + 2] = v * 0.7; img.data[i + 3] = 255 }
      n.putImageData(img, 0, 0); const pattern = g.createPattern(noise, 'repeat')
      const shapes = Array.from({ length: 220 }, () => ({ x: rnd() * ${w}, y: rnd() * ${h}, r: 8 + rnd() * 60, hue: rnd() * 360, v: rnd() * 6 - 3 }))
      const out = []
      for (let f = 0; f < 60; f++) {
        const sky = g.createLinearGradient(0, 0, 0, ${h}); sky.addColorStop(0, '#2a4d7a'); sky.addColorStop(0.55, '#9cc3e6'); sky.addColorStop(0.56, '#4c6b2f'); sky.addColorStop(1, '#2d3d1c')
        g.fillStyle = sky; g.fillRect(0, 0, ${w}, ${h})
        g.save(); g.globalAlpha = 0.45; g.translate(-f * 7, 0); g.fillStyle = pattern; g.fillRect(f * 7, ${h} * 0.55, ${w}, ${h}); g.restore()
        for (const s of shapes) { const x = (s.x + f * s.v * 4 + ${w}) % ${w}; const r = g.createRadialGradient(x - s.r / 3, s.y - s.r / 3, 1, x, s.y, s.r); r.addColorStop(0, 'hsl(' + s.hue + ',70%,70%)'); r.addColorStop(1, 'hsl(' + s.hue + ',60%,25%)'); g.fillStyle = r; g.beginPath(); g.arc(x, s.y, s.r, 0, 6.283); g.fill() }
        g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('HP 87  Gold 1240  Wave ' + f, 24, 44)
        out.push(c.toDataURL('image/jpeg', 0.75))
      }
      return out
    })()`)
    urls.forEach((u, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.jpg`), Buffer.from(u.split(',')[1], 'base64')))
    result.notes[`frameKB${w}x${h}`] = urls.reduce((s, u) => s + u.length * 0.75, 0) / urls.length / 1024
  }
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
    const m0 = await metrics(), c0 = calls.length, e0 = events.length, s0 = snapshots, l0 = name === 'boot' ? 0 : await js('__bench.long.length'), cpu0 = process.cpuUsage()
    lag.reset()
    if (TRACE.has(name)) { traceChunks = []; await send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline.invalidationTracking', 'blink', 'v8.execute'] }, transferMode: 'ReportEvents' }) }
    if (PROFILE) { await send('Profiler.enable'); await send('Profiler.start'); profileMain.post('Profiler.start') }
    const t0 = await act()
    const content = ready ? await js(`__bench.waitFor(() => (${ready})(), 15000)`) : -1
    const first = await js(`new Promise(r => { const end = performance.now() + 5000; const f = () => { const x = __bench.frames.find(x => x[0] >= ${t0} - 1); x ? r(x[1]) : performance.now() > end ? r(-1) : setTimeout(f, 5) }; f() })`).catch(() => -1)
    const rest = t0 + windowMs - now()
    if (rest > 0) await sleep(rest)
    const m1 = await metrics()
    if (SHOTS) fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG())
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
      // CPU time, not wall time: steadier when other processes load the machine.
      threadMs: d('ThreadTime'), processMs: d('ProcessTime'), layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0), styles: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0),
      mainCpuMs: (() => { const u = process.cpuUsage(cpu0); return (u.user + u.system) / 1000 })(),
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
  await phase('boot', async () => { void win.loadFile(path.join(RENDERER, 'index.html'), { query }); return loadAt },
    `() => document.querySelector('.chat-log [data-msg], .chat-log .msg')`, 6000)
  const fcp = await js(`(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1)`)
  result.phases.boot.fcpMs = fcp > 0 ? fcp + (await js('performance.timeOrigin')) - loadAt : undefined
  result.phases.boot.scriptTotalMs = (await metrics()).ScriptDuration * 1000
  // GENIO_SCREEN_CSS: a diagnostic stylesheet added after boot (to test what a style rule costs), never product code.
  if (env.GENIO_SCREEN_CSS) await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(env.GENIO_SCREEN_CSS)}; document.head.append(s) })()`)
  await sleep(1500)
  await phase('idle-comms', async () => now(), undefined, 5000)

  // The live Play view at one resolution for `seconds`: frames sent, received by main, decoded, painted; latency from
  // the stand-in's send to the painted frame; CPU of the main, renderer and GPU processes over the same window.
  const playPhase = async (name, resolution, seconds = 10, during) => {
    await js(`localStorage.setItem(${JSON.stringify(`genio.play.resolution.${PROJECT}`)}, ${JSON.stringify(resolution)})`)
    await phase(name, async () => js(`__bench.press('0')`), `() => document.querySelector('.play-live canvas')`, 1000)
    for (const end = Date.now() + 10_000; !play.stream?.connected && Date.now() < end;) await sleep(50)
    await sleep(1500)
    await js(`__bench.play = { decodes: [], painted: [] }`)
    const sent0 = (() => { try { return JSON.parse(fs.readFileSync(play.statsFile, 'utf8')) } catch { return { sent: 0, busy: 0, bytes: 0 } } })()
    const received0 = play.received, cpu0 = process.cpuUsage(), m0 = await metrics(), t0 = now()
    app.getAppMetrics()
    lag.reset()
    during?.()
    await sleep(seconds * 1000)
    const procs = app.getAppMetrics(), cpu = process.cpuUsage(cpu0), m1 = await metrics(), wall = (now() - t0) / 1000
    const sent1 = JSON.parse(fs.readFileSync(play.statsFile, 'utf8'))
    const stats = await js(`__bench.play`)
    const lat = stats.painted.map(([, sent, at]) => at - sent).sort((a, b) => a - b), dec = [...stats.decodes].sort((a, b) => a - b)
    const q = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : undefined
    const pct = type => procs.filter(p => p.type === type).reduce((n, p) => n + p.cpu.percentCPUUsage, 0)
    Object.assign(result.phases[name], {
      sentFps: (sent1.sent - sent0.sent) / wall, mainFps: (play.received - received0) / wall, decodedFps: stats.decodes.length / wall, paintedFps: stats.painted.length / wall,
      skippedAtSource: sent1.busy - sent0.busy, frameKB: (sent1.bytes - sent0.bytes) / Math.max(1, sent1.sent - sent0.sent) / 1024,
      latencyP50Ms: q(lat, 0.5), latencyP95Ms: q(lat, 0.95), decodeP50Ms: q(dec, 0.5), decodeP95Ms: q(dec, 0.95),
      rendererTaskPct: ((m1.TaskDuration - m0.TaskDuration) / wall) * 100, mainCpuPct: ((cpu.user + cpu.system) / 1000 / (wall * 1000)) * 100,
      gpuCpuPct: pct('GPU'), mainLagMaxMs: lag.max / 1e6, size: play.size
    })
    console.log(`[screens] ${name} stream`, JSON.stringify(result.phases[name]))
    await js(`__bench.press('1')`)
    await sleep(1500)
  }
  if (PLAY_STREAM) {
    await playPhase('play-720p', '1280x720')
    await playPhase('play-1080p', '1920x1080')
    // Genio streams a chat reply into the floating panel while the game plays.
    await playPhase('play-720p-chat', '1280x720', 10, () => void (async () => {
      const id = `bench-${Math.random().toString(16).slice(2)}`
      for (let i = 0; i < 240; i++) { bus.publish({ type: 'chat-delta', wksp: binding.wksp, id, text: `word ${i} of a streamed reply with **markdown** and \`code\`. ` }); await sleep(40) }
    })())
    stopStandIn()
  }

  const screens = (PLAY_STREAM ? '' : env.GENIO_SCREEN_LIST || 'squad,quests,status,systems,inventory,art-bible,play').split(',').filter(Boolean)
  const KEYS = { comms: '1', squad: '2', quests: '3', status: '5', 'art-bible': '6', systems: '8', inventory: '9', play: '0' }
  const shown = `() => { const s = document.querySelector('main.stage'); return s && s.firstElementChild && !s.querySelector('[data-loading]') }`
  for (const screen of screens) {
    if (!KEYS[screen]) continue
    await phase(screen, async () => js(`__bench.press(${JSON.stringify(KEYS[screen])})`), shown)
    await js(`__bench.press('1')`)
    await sleep(1500)
  }
  // The unit page with a long terminal, and the Modeller page when a live unit has a model.
  // Opens one unit's page from the Squad grid by its card title.
  const openUnit = task => js(`(() => { const at = performance.timeOrigin + performance.now(); const head = [...document.querySelectorAll('.unit-head')].find(h => h.textContent.includes(${JSON.stringify(task.title.slice(0, 40))})); head?.click(); __bench.frame().then(t => __bench.frames.push([at, t])); return at })()`)
  if (screens.includes('squad')) {
    const plain = units.find(({ task }) => !task.modeller && !task.generator)
    if (plain) {
      await js(`__bench.press('2')`); await sleep(1500)
      await phase('unit-page', async () => openUnit(plain.task), `() => document.querySelector('.detail-term .xterm-rows span')`)
      await js(`__bench.press('1')`); await sleep(1500)
    }
    const modeller = units.find(({ task }) => task.modeller)
    if (modeller) {
      await js(`__bench.press('2')`); await sleep(1500)
      await phase('modeller-page', async () => openUnit(modeller.task), `() => document.querySelector('.detail-canvas iframe, .modeller-view iframe')`, 5000)
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
