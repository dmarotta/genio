// Spike consumer, renderer side (isolated world, as Genio's preload). Draws each frame on a 2D canvas as PlayLive.tsx
// does and records times. The scene's 20 blocks spell Unity's frame number: read back from what was drawn, they prove
// the frame and its orientation (gpu: every 30th frame, against the frame number Unity announced), and give the JPEG
// path its frame number for the latency join (every drawn frame, read after the draw is timed).
const { ipcRenderer, sharedTexture } = require('electron')

const nowUs = () => (performance.timeOrigin + performance.now()) * 1000
const q = new URLSearchParams(location.search)
const mode = q.get('mode'), seconds = +q.get('seconds')
const records = []
const validation = { checked: 0, ok: 0, bad: [] }
const STRIP_W = 8 + 20 * 36
let canvas, ctx, probe, first = 0, done = false

function readFrameNumber(source, sx, sy) {
  probe.drawImage(source, sx, sy, STRIP_W, 48, 0, 0, STRIP_W, 48)
  const px = probe.getImageData(0, 0, STRIP_W, 48).data
  let n = 0
  for (let b = 0; b < 20; b++) { const i = (24 * STRIP_W + 8 + b * 36 + 16) * 4; if (px[i] > 128) n |= 1 << b }
  return n
}
let snapped = false
function check(expected) {
  // One picture of what was drawn, to see the orientation and the strip.
  if (!snapped && validation.checked === 3) { snapped = true; ipcRenderer.send('snapshot', canvas.toDataURL('image/png')) }
  const n = readFrameNumber(canvas, 0, 0)
  validation.checked++
  if (n === expected) validation.ok++; else if (validation.bad.length < 10) validation.bad.push({ expected, got: n })
}
function record(r) {
  if (done) return
  records.push(r)
  requestAnimationFrame(() => { r.tRaf = nowUs() })
  if (!first) first = r.tDrawn
  if (r.tDrawn - first > seconds * 1e6) finish()
}
function finish() {
  done = true
  setTimeout(() => {
    const span = (records.at(-1).tDrawn - records[0].tDrawn) / 1e6
    ipcRenderer.send('results', { drawn: records.length, fpsShown: (records.length - 1) / span, validation, records })
  }, 100)
}

window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('c')
  ctx = canvas.getContext('2d')
  probe = new OffscreenCanvas(STRIP_W, 48).getContext('2d', { willReadFrequently: true })
  if (mode === 'gpu') {
    sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, meta) => {
      const tRecv = nowUs()
      const frame = imported.getVideoFrame()
      const w = frame.codedWidth, h = frame.codedHeight
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      // Unity renders into textures bottom-up on D3D (ring flag bit 0): flip while drawing, for free.
      if (meta.flags & 1) { ctx.setTransform(1, 0, 0, -1, 0, h); ctx.drawImage(frame, 0, 0, w, h); ctx.setTransform(1, 0, 0, 1, 0, 0) }
      else ctx.drawImage(frame, 0, 0, w, h)
      const tDrawn = nowUs()
      frame.close()
      imported.release(); ipcRenderer.send('drawn')
      if (meta.frame % 30 === 0) check(meta.frame)
      record({ ...meta, tRecv, tDrawn, w, h })
    })
  }
  ipcRenderer.on('port', e => {
    const port = e.ports[0]
    let decoding = false
    port.onmessage = async ({ data }) => {
      if (decoding || data?.type !== 'frame') return
      decoding = true
      const tRecv = nowUs()
      try {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(data.bytes).buffer], { type: 'image/jpeg' }))
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        const tDrawn = nowUs()
        const frame = readFrameNumber(bitmap, 0, 0)
        bitmap.close()
        record({ frame, tMain: data.tMain, tRecv, tDrawn, w: canvas.width, h: canvas.height, kb: data.bytes.byteLength / 1024 })
      } finally { decoding = false; port.postMessage({ type: 'ready' }) }
    }
    port.start(); port.postMessage({ type: 'ready' })
  })
  ipcRenderer.send('renderer-ready')
})
