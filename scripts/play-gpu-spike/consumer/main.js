// Smoke consumer, Electron main: Genio's own Play stream code against a real Unity editor. run-spike.mjs bundles
// src/main/play-stream.ts (with play-gpu.ts and shared-texture.ts) into --bundle; this file adds what ipc.ts and
// player-instance.ts do around it: the sink (one frame per renderer credit, newest wins, GPU frames delivered to the
// preload, JPEG frames over a MessagePort), the resize swap (a new PlayStream and session, the old one's frames held),
// and the editor-lifetime fallback. Faults can be injected: import failures from --fail-imports-at s, and a killed
// GPU process at --kill-gpu-at s.
const { app, BrowserWindow, MessageChannelMain, ipcMain, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const argv = process.argv.slice(process.argv.indexOf(__dirname) + 1)
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
const mode = opt('mode', 'gpu')
const W = +opt('w', 1280), H = +opt('h', 720), seconds = +opt('seconds', 15)
const resizeAt = +opt('resize-at', 0), RW = +opt('resize-w', 1920), RH = +opt('resize-h', 1080)
const failImportsAt = +opt('fail-imports-at', 0), killGpuAt = +opt('kill-gpu-at', 0)
const label = opt('label', `${mode}-${W}x${H}`)
const project = opt('project'), outDir = opt('out')
const { PlayStream, textureApi } = require(opt('bundle'))
const out = path.join(outDir, `${label}.json`)
const WORLD = 'smoke'
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000

app.setName('genio-play-gpu-smoke')
app.setPath('userData', path.join(outDir, 'userdata'))

let win, port1, credit = false, latest, fallback, failing = false, stream, started = 0
const counters = { textures: 0, jpegs: 0, audio: 0, dropped: 0, deliverFailed: 0, sessions: 0 }
const arrivals = new Map(), jpegArrivals = new WeakMap(), fallbacks = [], events = [], metrics = []
const T0 = nowUs()
const log = (...a) => { events.push(`[${((nowUs() - T0) / 1000).toFixed(1)} ms] ${a.join(' ')}`) }

// The texture API Genio uses, with import failures injected on request.
const real = textureApi()
const api = { available: real.available, send: real.send, gpus: real.gpus, onGpuGone: real.onGpuGone,
  importTexture: (...args) => { if (failing) throw new Error('injected import failure'); return real.importTexture(...args) } }

// ipc.ts's sink.
const send = () => {
  if (!credit || !latest) return
  const frame = latest; latest = undefined
  if (Buffer.isBuffer(frame)) { credit = false; port1.postMessage({ type: 'frame', bytes: new Uint8Array(frame), tMain: jpegArrivals.get(frame) }); return }
  if (!frame.live) { frame.drop(); counters.dropped++; return }
  credit = false
  frame.deliver(win.webContents.mainFrame, WORLD).then(sent => { if (!sent) { counters.deliverFailed++; credit = true; send() } })
}
const offer = frame => {
  if (Buffer.isBuffer(frame)) { counters.jpegs++; jpegArrivals.set(frame, nowUs()) }
  else { counters.textures++; arrivals.set(frame.seq, nowUs()) }
  if (latest && !Buffer.isBuffer(latest)) { latest.drop(); counters.dropped++ }
  latest = frame; send()
}

// player-instance.ts's runtime: a fast-path PlayStream unless this editor already fell back.
async function open(w, h) {
  const fast = mode === 'gpu' && !fallback && api.available
  const next = new PlayStream(fast ? { api, devices: await api.gpus(), width: w, height: h, playing: () => true, onFallback: (reason, detail) => {
    fallback ??= reason; fallbacks.push({ atMs: (nowUs() - started) / 1000, reason, detail }); log('fallback', reason, detail ?? '')
  } } : undefined)
  next.onFrame = offer; next.onTexture = offer; next.onAudio = () => { counters.audio++ }
  next.onDisconnect = () => log('unity disconnected')
  const credentials = await next.listen()
  counters.sessions++
  return { next, credentials, fast }
}
const request = r => {
  const spikeDir = path.join(project, 'spike')
  fs.writeFileSync(path.join(spikeDir, 'request.tmp'), JSON.stringify(r)); fs.renameSync(path.join(spikeDir, 'request.tmp'), path.join(spikeDir, 'request.json'))
}
const until = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return test() }

async function resize() {
  const old = stream
  const { next, credentials, fast } = await open(RW, RH)
  // Unity drops the old session when the new one starts; the old ring's frames are never imported from here on.
  old.holdTextures(true)
  request({ id: `${label}-session-${Date.now()}`, mode: 'session', ...credentials, pid: fast ? process.pid : 0, w: RW, h: RH })
  const ok = await until(() => next.connected, 10_000)
  log('resized', `${RW}x${RH}`, fast ? 'gpu' : 'jpeg', ok ? 'connected' : 'NOT connected')
  old.close(); stream = next
}

function handleCount(pid) {
  if (!pid) return undefined
  try { return +execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { encoding: 'utf8' }).trim() } catch { return undefined }
}
const fail = why => {
  log('failed:', why)
  fs.writeFileSync(out, JSON.stringify({ label, failed: why, counters, fallbacks, events }, null, 2))
  console.log(`FAILED ${why} ${out}`); app.exit(2)
}
setTimeout(() => fail('watchdog'), (seconds + 150) * 1000).unref()
app.on('child-process-gone', (_e, d) => log('child-process-gone', JSON.stringify(d)))

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({ width: 660, height: 400, x: area.x + 8, y: area.y + area.height - 408, show: false, focusable: false, skipTaskbar: true,
    title: 'Genio Play GPU smoke', webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const ready = new Promise(resolve => ipcMain.once('renderer-ready', resolve))
  await win.loadFile(path.join(__dirname, 'index.html'), { query: { seconds: String(seconds) } })
  win.showInactive()
  await ready
  const ch = new MessageChannelMain(); port1 = ch.port1
  port1.on('message', ({ data }) => { if (data?.type === 'ready') { credit = true; send() } })
  port1.start()
  win.webContents.postMessage('port', null, [ch.port2])

  const gpuPid = () => app.getAppMetrics().find(p => p.type === 'GPU')?.pid
  const handlesBefore = { main: handleCount(process.pid), gpu: handleCount(gpuPid()) }
  const first = await open(W, H); stream = first.next
  const id = `${label}-${Date.now()}`
  request({ id, mode: first.fast ? 'gpu' : 'jpeg', ...first.credentials, pid: process.pid, w: W, h: H, seconds: seconds + 4 })
  log('request written', id, first.fast ? 'gpu' : 'jpeg')
  await until(() => stream.connected, 120_000)
  started = nowUs()
  if (resizeAt) setTimeout(() => void resize().catch(e => log('resize failed', e.message)), resizeAt * 1000)
  if (failImportsAt) setTimeout(() => { failing = true; log('imports fail from now on') }, failImportsAt * 1000)
  if (killGpuAt) setTimeout(() => { const pid = gpuPid(); log('killing GPU process', pid); try { process.kill(pid) } catch (e) { log('kill failed', e.message) } }, killGpuAt * 1000)

  app.getAppMetrics()
  const sampler = setInterval(() => metrics.push(app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage }))), 1000)
  const results = await new Promise(resolve => ipcMain.once('results', (_e, r) => resolve(r)))
  clearInterval(sampler)
  for (const r of results.records) r.tMain ??= arrivals.get(r.seq)
  // The editor writes its side once its run ends.
  const unityFile = path.join(project, 'spike', `result-${id}.json`)
  let unity
  for (let i = 0; i < 300 && !unity; i++) { await new Promise(r => setTimeout(r, 100)); try { unity = JSON.parse(fs.readFileSync(unityFile, 'utf8')) } catch { /* not yet */ } }
  try { fs.rmSync(unityFile, { force: true }) } catch { }
  stream.close()
  await new Promise(r => setTimeout(r, 1500))  // the editor closes the rings' handles in this process
  const steady = metrics.slice(2)
  const avg = type => { const v = steady.flatMap(s => s.filter(p => p.type === type).map(p => p.cpu)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined }
  const report = { label, mode, W, H, seconds, electron: process.versions.electron, counters, fallbacks,
    cpuShareOfAllCores: { browser: avg('Browser'), gpu: avg('GPU'), renderer: avg('Tab') },
    handles: { before: handlesBefore, after: { main: handleCount(process.pid), gpu: handleCount(gpuPid()) } },
    renderer: results, unity, devices: await api.gpus(), events }
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`RESULT ${out}`)
  app.exit(0)
})
