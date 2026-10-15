/** The sandboxed viewer frame: draws what the Inventory window asks for and reports back by postMessage. */
import { MODEL_PREVIEW_MAX_TEXTURE, type FromViewer, type ToViewer } from '@shared/model-viewer'
import { createViewer, ViewerError, type Viewer } from './viewer'
import './viewer3d.css'

// The frame's origin is opaque, so its messages cannot name a target origin; they carry no secrets.
const post = (message: FromViewer): void => window.parent.postMessage(message, '*')
const canvas = document.getElementById('view') as HTMLCanvasElement
let viewer: Viewer | undefined
try {
  viewer = createViewer(canvas, {
    decoderPath: import.meta.env.DEV ? new URL('./decoders/', location.href).href : undefined,
    maxTexture: MODEL_PREVIEW_MAX_TEXTURE,
    labels: document.getElementById('labels') ?? undefined,
    onTime: (clip, time, playing) => post({ type: 'time', clip, time, playing })
  })
} catch (e) {
  post({ type: 'failed', code: 'no-webgl', reason: e instanceof Error ? e.message : String(e) })
}

let opening = 0
window.addEventListener('message', event => {
  if (event.source !== window.parent || !viewer) return
  const message = event.data as ToViewer
  switch (message?.type) {
    case 'open': {
      const id = ++opening
      void viewer.open(String(message.url)).then(model => { if (id === opening) post({ type: 'loaded', model }) }, (e: unknown) => {
        if (id !== opening) return
        if (!(e instanceof ViewerError)) post({ type: 'failed', code: 'unreadable', reason: e instanceof Error ? e.message : String(e) })
        else if (e.code !== 'cancelled') post({ type: 'failed', code: e.code, reason: e.message })
      })
      break
    }
    case 'settings': viewer.set(message.settings); break
    case 'playback': viewer.playback(message.playback); break
    case 'frame': viewer.frame(); break
    case 'texture-previews': post({ type: 'texture-previews', previews: viewer.texturePreviews() }); break
  }
})
window.addEventListener('pagehide', () => viewer?.dispose())
post({ type: 'ready' })
