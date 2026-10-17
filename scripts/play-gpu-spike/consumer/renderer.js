// Smoke consumer, page (main world): draws as PlayLive.tsx does. GPU frames from the preload are drawn as they come
// and return the credit on the port; JPEG frames are decoded with createImageBitmap. The scene's 20 blocks spell
// Unity's frame number: read back from what was drawn, they prove frame and orientation (GPU: every 30th frame,
// against the frame number in the message) and give JPEG frames their number for the latency join.
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000
const seconds = +new URLSearchParams(location.search).get('seconds')
const records = []
const validation = { checked: 0, ok: 0, bad: [] }
const STRIP_W = 8 + 20 * 36
const canvas = document.getElementById('c'), ctx = canvas.getContext('2d')
const probe = new OffscreenCanvas(STRIP_W, 48).getContext('2d', { willReadFrequently: true })
let port, first = 0, done = false

function frameNumber(source) {
  probe.drawImage(source, 0, 0, STRIP_W, 48, 0, 0, STRIP_W, 48)
  const px = probe.getImageData(0, 0, STRIP_W, 48).data
  let n = 0
  for (let b = 0; b < 20; b++) { const i = (24 * STRIP_W + 8 + b * 36 + 16) * 4; if (px[i] > 128) n |= 1 << b }
  return n
}
function record(r) {
  if (done) return
  records.push(r)
  if (!first) first = r.tDrawn
  if (r.tDrawn - first > seconds * 1e6) {
    done = true
    setTimeout(() => window.smoke.send('results', { drawn: records.length, fpsShown: (records.length - 1) / ((records.at(-1).tDrawn - records[0].tDrawn) / 1e6), validation, records }), 100)
  }
}
const size = (w, h) => { if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h } }

window.smoke.onPlayFrame('smoke', (frame, meta) => {
  try {
    size(frame.codedWidth, frame.codedHeight)
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
    const tDrawn = nowUs()
    if (meta.seq % 30 === 0) {
      const n = frameNumber(canvas); validation.checked++
      if (n === meta.seq) validation.ok++; else if (validation.bad.length < 10) validation.bad.push({ expected: meta.seq, got: n })
    }
    record({ path: 'gpu', seq: meta.seq, tRecv: meta.tRecv, tDrawn, w: canvas.width, h: canvas.height })
  } finally { port?.postMessage({ type: 'ready' }) }
})

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.type !== 'smoke-port' || !event.ports[0]) return
  port = event.ports[0]
  let decoding = false
  port.onmessage = async ({ data }) => {
    if (decoding || data?.type !== 'frame') return
    decoding = true
    const tRecv = nowUs()
    try {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data.bytes).buffer], { type: 'image/jpeg' }))
      size(bitmap.width, bitmap.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const tDrawn = nowUs()
      const seq = frameNumber(bitmap)
      bitmap.close()
      record({ path: 'jpeg', seq, tMain: data.tMain, tRecv, tDrawn, w: canvas.width, h: canvas.height, kb: data.bytes.byteLength / 1024 })
    } finally { decoding = false; port.postMessage({ type: 'ready' }) }
  }
  port.start(); port.postMessage({ type: 'ready' })
})
window.smoke.send('renderer-ready')
