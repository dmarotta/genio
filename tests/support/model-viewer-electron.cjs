// Real Chromium/WebGL check of Inventory's 3D viewer: the sandboxed frame under the app's CSP, what it can
// reach, every format, playback, and 100 open/close cycles that must leave no GPU resources behind.
// genio-viewer:// is answered by the real handler, which the test process runs (MODEL_VIEWER_BRIDGE).
// With MODEL_VIEWER_SHOTS=<dir> it also saves a screenshot of the frame per model.
const { app, BrowserWindow, net, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const { base, bridge, models, probes, results, previews, shots } = JSON.parse(process.env.MODEL_VIEWER_E2E)

protocol.registerSchemesAsPrivileged([
  { scheme: 'genio-viewer', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'genio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const viewer = async req => {
    const res = await net.fetch(bridge + encodeURIComponent(req.url), { method: req.method })
    return new Response(req.method === 'HEAD' ? null : await res.arrayBuffer(), { status: res.status, headers: res.headers })
  }
  protocol.handle('genio-viewer', viewer)
  // genio-media://model is the granted model; any other host stands in for project files the frame must not reach.
  protocol.handle('genio-media', req => new URL(req.url).hostname === 'model' ? viewer(req) : new Response('project file', { headers: { 'Access-Control-Allow-Origin': '*' } }))
  const out = { frame: {}, probes: {}, leak: undefined, console: [] }
  // Shown (inactive): a hidden window gets no animation frames, and playback is part of the check.
  const win = new BrowserWindow({ width: 900, height: 700, show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false, contextIsolation: true } })
  win.showInactive()
  win.webContents.on('console-message', e => { if (out.console.length < 60) out.console.push(`[${e.level}] ${String(e.message).slice(0, 300)}`) })
  const js = code => win.webContents.executeJavaScript(code)
  const until = async (code, ms = 20000) => {
    const deadline = Date.now() + ms
    for (;;) { const v = await js(code); if (v) return v; if (Date.now() > deadline) return undefined; await wait(50) }
  }
  try {
    await win.loadURL(base + '/parent.html')
    await js('openFrame()')
    const frame = win.webContents.mainFrame.frames[0]
    for (const [name, url] of Object.entries(models)) {
      await js(`window.log.length = 0; send({ type: 'open', url: ${JSON.stringify(url)}, name: ${JSON.stringify(name)} })`)
      const result = await until(`window.log.find(m => m.type === 'loaded' || m.type === 'failed')`)
      const entry = { result: result ?? { type: 'no answer' }, progress: await js(`window.log.filter(m => m.type === 'progress').map(m => m.progress)`) }
      if (shots) {
        fs.mkdirSync(shots, { recursive: true })
        await wait(400)
        fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG())
      }
      if (previews.includes(name)) {
        await js(`window.log.length = 0; send({ type: 'texture-previews' })`)
        entry.previews = await until(`window.log.find(m => m.type === 'texture-previews')`, 5000)
        // Green of the preview's top texel row and the one below it (a 32 px texture drawn at 96 px).
        const url = entry.previews?.previews?.[0]?.url
        if (url) entry.rows = await frame.executeJavaScript(`new Promise(resolve => { const i = new Image(); i.onload = () => {
          const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0)
          resolve([x.getImageData(4, 0, 1, 1).data[1], x.getImageData(4, 4, 1, 1).data[1]]) }; i.src = ${JSON.stringify(url)} })`)
      }
      if (name === 'textured') {
        await wait(1500)
        entry.times = await js(`window.log.filter(m => m.type === 'time').map(m => m.time)`)
        await js(`send({ type: 'settings', settings: { wireframe: true, grid: true, bounds: true, skeleton: true, clay: true, background: 'checker', upAxis: 'z' } })`)
        await wait(300)
        entry.labels = await frame.executeJavaScript(`[...document.querySelectorAll('#labels span')].filter(s => !s.hidden).map(s => s.textContent)`)
        await js(`send({ type: 'settings', settings: { wireframe: false, grid: true, bounds: false, skeleton: false, clay: false, background: 'dark', upAxis: 'y' } })`)
      }
      out.frame[name] = entry
    }
    out.cancellation = {};
    for (const [phase, name, id] of [['reading','slow',501], ['textures','wide',503]]) {
      await js(`window.log.length = 0; send({ type:'open', url:${JSON.stringify(models[name])}, name:'cancel test', requestId:${id} })`)
      if (phase === 'textures') await until(`window.log.find(m => m.type === 'progress' && m.requestId === ${id} && m.progress.phase === 'geometry')`)
      else await wait(30)
      await js(`send({type:'cancel'}); send({ type:'open', url:${JSON.stringify(models.fbxAscii)}, name:'next', requestId:${id+1} })`)
      const next = await until(`window.log.find(m => m.type === 'loaded' && m.requestId === ${id+1})`)
      await wait(600)
      out.cancellation[phase] = !!next && !await js(`window.log.some(m => ['loaded','failed'].includes(m.type) && m.requestId === ${id})`)
    }
    out.probes = await frame.executeJavaScript(`(async () => {
      const r = {}
      const status = async url => { try { return (await fetch(url)).status } catch (e) { return 'blocked' } }
      r.origin = self.origin
      r.ownBridge = typeof window.genio
      try { r.parentBridge = typeof window.parent.genio } catch (e) { r.parentBridge = e.name }
      try { r.parentDocument = !!window.parent.document } catch (e) { r.parentDocument = e.name }
      r.media = await status('genio-media://world/zoo/Assets/Models/robot_textured_anim.glb')
      r.web = await status('https://example.com/')
      r.local = await status(${JSON.stringify(base + '/parent.html')})
      for (const [k, url] of Object.entries(${JSON.stringify(probes)})) r[k] = await status(url)
      try { const w = window.open('https://example.com/'); r.popup = w ? 'opened' : 'refused' } catch (e) { r.popup = e.name }
      return r
    })()`)
    // The leak test: the viewer core in a plain page, 100 open/render/clear cycles over every model.
    await win.loadURL(base + '/leak.html')
    await until('!!window.runLeak', 20000)
    out.leak = await js(`runLeak(${JSON.stringify(Object.values(models))}, 100)`)
  } catch (e) {
    out.error = String(e && e.stack || e)
  }
  fs.writeFileSync(results, JSON.stringify(out, null, 1))
  win.destroy()
  app.quit()
})
