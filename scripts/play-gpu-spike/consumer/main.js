// Spike consumer, Electron main: the Recon e90c PoC consumer, fed by a real Unity editor instead of a stand-in. It serves
// the same authenticated loopback WebSocket as src/main/play-stream.ts (token, Host and /play checks, one client),
// writes the run request the editor's SpikeDriver picks up, and gets frames to the renderer:
//   gpu:  'GR' ring and 'GF' frame messages → sharedTexture.importSharedTexture + sendSharedTexture, one frame in flight;
//         allReferencesReleased → {"type":"free"} back to Unity.
//   jpeg: JPEG messages → PlayStream's 25 ms throttle, latest wins → a MessagePort with one credit, as ipc.ts does.
const { app, BrowserWindow, sharedTexture, MessageChannelMain, ipcMain, screen } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const argv = process.argv.slice(process.argv.indexOf(__dirname) + 1)
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
const mode = opt('mode', 'gpu')
const W = +opt('w', 1280), H = +opt('h', 720), fps = +opt('fps', 60), seconds = +opt('seconds', 15)
const label = opt('label', `${mode}-${W}x${H}-${fps}`)
const project = opt('project'), outDir = opt('out'), ws = require(opt('ws'))
const out = path.join(outDir, `${label}.json`)
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000

app.setName('genio-spike-83f6-consumer')
app.setPath('userData', path.join(outDir, 'userdata'))
app.disableDomainBlockingFor3DAPIs()

let win, client, credit = false, port1, latest, lastFrame = 0, inFlight = false
const rings = new Map()
const counters = { messages: 0, framesIn: 0, dropsBusy: 0, dropsThrottle: 0, importErrors: 0, sendErrors: 0, rejected: 0, connections: 0, ringsIn: 0, freesSent: 0, importUs: [], sendUs: [] }
const metrics = [], events = [], ringLog = []
const T0 = nowUs()
const log = (...a) => { events.push(`[${((nowUs() - T0) / 1000).toFixed(1)} ms] ${a.join(' ')}`) }
const free = (gen, slot) => { try { client?.send(JSON.stringify({ type: 'free', gen, slot })); counters.freesSent++ } catch { /* closed */ } }

function onRing(b) {
  const n = b[3], gen = b.readUInt32LE(4), w = b.readUInt32LE(8), h = b.readUInt32LE(12)
  const luid = (BigInt(b.readInt32LE(20)) << 32n | BigInt(b.readUInt32LE(16))).toString(16), format = b.readUInt32LE(24), flags = b.readUInt32LE(28)
  const handles = []; for (let s = 0; s < n; s++) handles.push(b.readBigUInt64LE(32 + 8 * s))
  rings.set(gen, { gen, w, h, luid, format, flags, handles })
  counters.ringsIn++; ringLog.push({ gen, w, h, luid, format, flags, handles: handles.map(String), tMain: nowUs() })
  log('ring', gen, `${w}x${h}`, 'luid', luid, 'flags', flags, 'handles', handles.join(','))
}
function onGpuFrame(b) {
  counters.framesIn++
  const tMain = nowUs()
  const slot = b[3], gen = b.readUInt32LE(4), frame = b.readUInt32LE(8), t0 = b.readDoubleLE(16) * 1000, tReady = b.readDoubleLE(24) * 1000
  const ring = rings.get(gen)
  if (!ring) { log('frame for unknown ring', gen); return }
  if (inFlight) { counters.dropsBusy++; free(gen, slot); return }
  let imported
  try {
    const handle = Buffer.alloc(8); handle.writeBigUInt64LE(ring.handles[slot])
    imported = sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'rgba', codedSize: { width: ring.w, height: ring.h }, handle: { ntHandle: handle } }, allReferencesReleased: () => free(gen, slot) })
  } catch (e) { counters.importErrors++; if (counters.importErrors < 10) log('import failed', gen, slot, frame, e.message); free(gen, slot); return }
  const tImported = nowUs(); counters.importUs.push(tImported - tMain)
  inFlight = true
  sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }, { gen, slot, frame, t0, tReady, tMain, tImported, flags: ring.flags })
    .then(() => { counters.sendUs.push(nowUs() - tImported); imported.release() })
    .catch(e => { counters.sendErrors++; if (counters.sendErrors < 10) log('send failed', frame, e.message); inFlight = false; imported.release() })
}
ipcMain.on('drawn', () => { inFlight = false })
ipcMain.on('snapshot', (_e, url) => fs.writeFileSync(path.join(outDir, `${label}.png`), Buffer.from(url.split(',')[1], 'base64')))

function onJpeg(frame) {
  counters.framesIn++
  const now = Date.now()
  if (now - lastFrame < 25) { counters.dropsThrottle++; return }  // play-stream.ts's throttle
  lastFrame = now
  if (latest) counters.dropsBusy++
  latest = { bytes: frame, tMain: nowUs() }
  sendJpeg()
}
function sendJpeg() {
  if (!credit || !latest) return
  credit = false
  const l = latest; latest = undefined
  port1.postMessage({ type: 'frame', bytes: new Uint8Array(l.bytes), tMain: l.tMain })
}

function handleCount(pid) {
  if (!pid) return undefined
  try { return +execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).HandleCount`], { encoding: 'utf8' }).trim() } catch { return undefined }
}

const fail = why => {
  log('failed:', why)
  fs.writeFileSync(out, JSON.stringify({ label, failed: why, counters: { ...counters, importUs: summarize(counters.importUs), sendUs: summarize(counters.sendUs) }, rings: ringLog, events }, null, 2))
  console.log(`FAILED ${why} ${out}`); app.exit(2)
}
setTimeout(() => fail('watchdog'), (seconds + 120) * 1000).unref()
app.on('child-process-gone', (_e, d) => log('child-process-gone', JSON.stringify(d)))

app.whenReady().then(async () => {
  const gpuInfo = await app.getGPUInfo('complete').catch(e => String(e))
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({ width: 660, height: 400, x: area.x + 8, y: area.y + area.height - 408, show: false, focusable: false, skipTaskbar: true,
    title: 'Genio spike 83f6', webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  const ready = new Promise(resolve => ipcMain.once('renderer-ready', resolve))
  await win.loadFile(path.join(__dirname, 'index.html'), { query: { mode, seconds: String(seconds) } })
  win.showInactive()
  await ready
  if (mode === 'jpeg') {
    const ch = new MessageChannelMain(); port1 = ch.port1
    port1.on('message', ({ data }) => { if (data?.type === 'ready') { credit = true; sendJpeg() } })
    port1.start()
    win.webContents.postMessage('port', null, [ch.port2])
  }

  // PlayStream's server, checks included.
  const token = crypto.randomBytes(32).toString('hex')
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new ws.WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false })
  let port = 0
  server.on('upgrade', (req, socket, head) => {
    const auth = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${token}`)
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}` || req.url !== '/play' || client || auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
      counters.rejected++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    wss.handleUpgrade(req, socket, head, c => {
      client = c; counters.connections++; log('unity connected')
      c.on('error', () => c.terminate())
      c.on('message', (data, binary) => {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data)
        counters.messages++
        if (!binary) return
        if (b[0] === 0x47 && b[1] === 0x52 && b[2] === 1) onRing(b)
        else if (b[0] === 0x47 && b[1] === 0x46 && b[2] === 1 && b.length === 32) onGpuFrame(b)
        else if (b[0] === 0x47 && b[1] === 0x41) { /* audio: not part of this spike */ }
        else if (b[0] === 0xff && b[1] === 0xd8) onJpeg(b)
      })
      c.once('close', () => { if (client === c) { client = undefined; log('unity disconnected') } })
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port

  const gpuPid = () => app.getAppMetrics().find(p => p.type === 'GPU')?.pid
  const gpuHandlesBefore = handleCount(gpuPid()), mainHandlesBefore = handleCount(process.pid)
  const id = `${label}-${Date.now()}`
  const request = { id, mode, port, token, pid: process.pid, w: W, h: H, fps, seconds: seconds + 4, resizeAt: +opt('resize-at', 0), resizeW: +opt('resize-w', 1920), resizeH: +opt('resize-h', 1080) }
  const spikeDir = path.join(project, 'spike')
  fs.writeFileSync(path.join(spikeDir, 'request.tmp'), JSON.stringify(request)); fs.renameSync(path.join(spikeDir, 'request.tmp'), path.join(spikeDir, 'request.json'))
  log('request written', id)

  app.getAppMetrics()
  const sampler = setInterval(() => metrics.push(app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage }))), 1000)
  const results = await new Promise(resolve => ipcMain.once('results', (_e, r) => resolve(r)))
  clearInterval(sampler)
  // The editor writes its side once its run ends.
  const unityFile = path.join(spikeDir, `result-${id}.json`)
  let unity
  for (let i = 0; i < 300 && !unity; i++) { await new Promise(r => setTimeout(r, 100)); try { unity = JSON.parse(fs.readFileSync(unityFile, 'utf8')) } catch { /* not yet */ } }
  try { fs.rmSync(unityFile, { force: true }) } catch { }
  await new Promise(r => setTimeout(r, 1500))  // the editor closes the rings' handles in this process
  const steady = metrics.slice(2)
  const avg = type => { const v = steady.flatMap(s => s.filter(p => p.type === type).map(p => p.cpu)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined }
  const report = { label, mode, W, H, fps, seconds, electron: process.versions.electron, chrome: process.versions.chrome,
    counters: { ...counters, importUs: summarize(counters.importUs), sendUs: summarize(counters.sendUs) },
    cpuShareOfAllCores: { browser: avg('Browser'), gpu: avg('GPU'), renderer: avg('Tab') },
    handles: { gpuBefore: gpuHandlesBefore, gpuAfter: handleCount(gpuPid()), mainBefore: mainHandlesBefore, mainAfter: handleCount(process.pid) },
    rings: ringLog, renderer: results, unity, gpuInfo: { gpuDevice: gpuInfo?.gpuDevice, auxAttributes: gpuInfo?.auxAttributes && { d3d11FeatureLevel: gpuInfo.auxAttributes.d3d11FeatureLevel, glRenderer: gpuInfo.auxAttributes.glRenderer } }, events }
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`RESULT ${out}`)
  app.exit(0)
})

function summarize(v) {
  if (!v.length) return undefined
  const s = [...v].sort((a, b) => a - b), q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1), avg: s.reduce((a, b) => a + b, 0) / s.length }
}
