// Smoke consumer, preload (isolated world): src/preload/index.ts's Play parts. GPU frames arrive as shared textures;
// the page's listener draws the VideoFrame through contextBridge, then the frame closes and the texture is released.
// The JPEG port is handed to the page as Genio's preload does.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron')

const nowUs = () => (performance.timeOrigin + performance.now()) * 1000
ipcRenderer.on('port', event => { window.postMessage({ type: 'smoke-port' }, '*', event.ports) })

const playFrames = new Map()
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, meta) => {
  const tRecv = nowUs()
  try {
    const listener = playFrames.get(String(meta?.world))
    if (!listener) return
    const frame = importedSharedTexture.getVideoFrame()
    try { listener(frame, { seq: meta.seq, width: meta.width, height: meta.height, tRecv }) } finally { frame.close() }
  } catch { /* a lost GPU: main falls back to JPEG */ } finally { importedSharedTexture.release() }
})

contextBridge.exposeInMainWorld('smoke', {
  onPlayFrame(world, fn) { playFrames.set(world, fn); return () => { if (playFrames.get(world) === fn) playFrames.delete(world) } },
  send(channel, data) { if (['renderer-ready', 'results'].includes(channel)) ipcRenderer.send(channel, data) }
})
