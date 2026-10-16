/**
 * The sandboxed viewer frame: draws what the Inventory window asks for and reports back by postMessage.
 * Opened as viewer3d.html?thumbnail in main's hidden window, it instead draws one thumbnail per call.
 */
import { DEFAULT_VIEWER_SETTINGS, MODEL_PREVIEW_MAX_TEXTURE, MODEL_THUMB_SIZE, type FromViewer, type ModelThumbnailResult, type ToViewer } from '@shared/model-viewer'
import { createViewer, ViewerError, type Viewer } from './viewer'
import './viewer3d.css'

// The frame's origin is opaque, so its messages cannot name a target origin; they carry no secrets.
let requestId: number | undefined
const post = (message: FromViewer): void => window.parent.postMessage(message.type === 'ready' || requestId === undefined ? message : { ...message, requestId }, '*')
const canvas = document.getElementById('view') as HTMLCanvasElement
const thumbnails = new URLSearchParams(location.search).has('thumbnail')
let viewer: Viewer | undefined, broken: ViewerError | undefined
if (thumbnails) canvas.style.width = canvas.style.height = `${MODEL_THUMB_SIZE}px`
try {
  viewer = createViewer(canvas, {
    decoderPath: import.meta.env.DEV ? new URL('./decoders/', location.href).href : undefined,
    maxTexture: thumbnails ? 512 : MODEL_PREVIEW_MAX_TEXTURE,
    labels: thumbnails ? undefined : document.getElementById('labels') ?? undefined,
    onTime: thumbnails ? undefined : (clip, time, playing) => post({ type: 'time', clip, time, playing }),
    onProgress: thumbnails ? undefined : progress => post({ type: 'progress', progress })
  })
} catch (e) {
  broken = e instanceof ViewerError ? e : new ViewerError('no-webgl', e instanceof Error ? e.message : String(e))
  if (!thumbnails) post({ type: 'failed', code: 'no-webgl', reason: broken.message })
}

const base64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

if (thumbnails) {
  /** Main calls this through executeJavaScript, one model at a time, and validates what comes back. */
  (window as unknown as { genioThumbnail(url: string): Promise<ModelThumbnailResult> }).genioThumbnail = async url => {
    if (!viewer) return { code: 'no-webgl', reason: broken?.message ?? 'WebGL is unavailable here, so the model cannot be drawn.' }
    // Each model starts as a fresh frame would: upright as stored, no floor grid at thumbnail size.
    viewer.set({ ...DEFAULT_VIEWER_SETTINGS, grid: false })
    try {
      await viewer.open(String(url))
      return { webp: await base64(await viewer.snapshot(MODEL_THUMB_SIZE)) }
    } catch (e) {
      return e instanceof ViewerError && e.code !== 'cancelled' ? { code: e.code, reason: e.message } : { code: 'unreadable', reason: e instanceof Error ? e.message : String(e) }
    } finally { viewer.clear() }
  }
} else {
  let opening = 0
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !viewer) return
    const message = event.data as ToViewer
    switch (message?.type) {
      case 'open': {
        requestId = message.requestId
        const id = ++opening
        void viewer.open(String(message.url)).then(model => { if (id === opening) post({ type: 'loaded', model }) }, (e: unknown) => {
          if (id !== opening) return
          if (!(e instanceof ViewerError)) post({ type: 'failed', code: 'unreadable', reason: e instanceof Error ? e.message : String(e) })
          else if (e.code !== 'cancelled') post({ type: 'failed', code: e.code, reason: e.message })
        })
        break
      }
      case 'cancel': ++opening; viewer.clear(); break
      case 'hello': post({ type: 'ready' }); break
      case 'settings': viewer.set(message.settings); break
      case 'playback': viewer.playback(message.playback); break
      case 'frame': viewer.frame(); break
      case 'texture-previews': post({ type: 'texture-previews', previews: viewer.texturePreviews() }); break
    }
  })
  post({ type: 'ready' })
}
window.addEventListener('pagehide', () => viewer?.dispose())
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault()
  viewer?.clear()
  if (!thumbnails) post({ type: 'failed', code: 'no-webgl', reason: 'The graphics context was lost. Retry to start a fresh preview.' })
})
