// Real Chromium/WebGL check of Inventory's model thumbnails: main's thumbnail window (bundled from
// src/main/model-thumbnails.ts) draws every format through the real genio-viewer:// handler, which the
// test process runs (MODEL_THUMBS_BRIDGE). It records whether the window was ever visible or focused,
// how many windows drew, the timeout and the idle teardown. With `shots` it saves each WebP.
const { app, BrowserWindow, net, protocol } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { bundle, bridge, models, hang, results, shots } = JSON.parse(process.env.MODEL_THUMBS_E2E)
const { createModelThumbnailer } = require(bundle)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

protocol.registerSchemesAsPrivileged([
  { scheme: 'genio-viewer', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'genio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const handle = async req => {
    const res = await net.fetch(bridge + encodeURIComponent(req.url), { method: req.method })
    return new Response(req.method === 'HEAD' ? null : await res.arrayBuffer(), { status: res.status, headers: res.headers })
  }
  protocol.handle('genio-viewer', handle)
  protocol.handle('genio-media', handle)
  const out = { drawn: {}, windows: [], seen: { visible: false, focused: false }, console: [] }
  const created = []
  app.on('browser-window-created', (_e, w) => {
    created.push(w)
    w.on('show', () => { out.seen.visible = true })
    w.on('focus', () => { out.seen.focused = true })
    w.webContents.on('console-message', e => { if (out.console.length < 60) out.console.push(`[${e.level}] ${String(e.message).slice(0, 300)}`) })
  })
  // Pixels that differ from the dark background, read in a page of our own (never the thumbnail window).
  let checker
  const coverage = async webp => {
    if (!checker) { checker = new BrowserWindow({ show: false, webPreferences: { sandbox: true } }); await checker.loadURL('data:text/html,<meta charset=utf-8>') }
    return checker.webContents.executeJavaScript(`(async () => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(webp.toString('base64'))}), c => c.charCodeAt(0))], { type: 'image/webp' }))
      const c = new OffscreenCanvas(bitmap.width, bitmap.height), x = c.getContext('2d'); x.drawImage(bitmap, 0, 0)
      const d = x.getImageData(0, 0, c.width, c.height).data; let lit = 0
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 11) + Math.abs(d[i + 1] - 15) + Math.abs(d[i + 2] - 22) > 30) lit++
      return { width: bitmap.width, height: bitmap.height, lit: lit / (c.width * c.height) }
    })()`)
  }
  try {
    const thumbnails = createModelThumbnailer({ idleMs: 1500, timeoutMs: 6000 })
    const poll = setInterval(() => { for (const w of created) if (!w.isDestroyed() && w !== checker) { if (w.isVisible()) out.seen.visible = true; if (w.isFocused()) out.seen.focused = true } }, 20)
    for (const [name, url] of Object.entries(models)) {
      const started = Date.now()
      const r = await thumbnails.render(url)
      const entry = { ms: Date.now() - started }
      if (r.webp) {
        Object.assign(entry, { bytes: r.webp.length }, await coverage(r.webp))
        if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, `${name}.webp`), r.webp) }
      } else Object.assign(entry, { code: r.code, reason: r.reason })
      out.drawn[name] = entry
    }
    const live = () => created.filter(w => !w.isDestroyed() && w !== checker)
    out.windows.push({ after: 'models', made: created.filter(w => w !== checker).length, live: live().length })
    await wait(2500)
    out.windows.push({ after: 'idle', live: live().length })
    // A model that never finishes loading: the window is destroyed and the next model still draws.
    const started = Date.now()
    const hung = await thumbnails.render(hang)
    out.hang = { code: hung.code, reason: hung.reason, ms: Date.now() - started, live: live().length }
    const after = await thumbnails.render(models.glb)
    out.afterHang = after.webp ? 'drawn' : after.code
    thumbnails.stop()
    out.windows.push({ after: 'stop', live: live().length })
    clearInterval(poll)
  } catch (e) {
    out.error = String(e && e.stack || e)
  }
  fs.writeFileSync(results, JSON.stringify(out, null, 1))
  app.exit(0)
})
