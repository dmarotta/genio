import { contextBridge, ipcRenderer, sharedTexture, webUtils, type IpcRendererEvent } from 'electron'
import { API_METHODS, API_PREFIX, EVENT_CHANNEL, type GenioApi } from '@shared/api'
import type { GenioEvent } from '@shared/types'

const TERM_CHANNEL = 'genio:term-data'

// Transfer the port out of the isolated preload; Unity credentials stay in main.
ipcRenderer.on('genio:play-port', (event, data: { world: string }) => {
  window.postMessage({ type: 'genio:play-port', world: data.world }, '*', event.ports)
})

// Play's fast path: main sends each GPU frame as a shared texture. The live view draws the VideoFrame synchronously inside
// its listener (contextBridge passes the frame itself, not a copy); then the frame closes and the texture is released,
// which lets main free the slot back to Unity. A world without a listener releases the frame at once.
type PlayFrameListener = (frame: VideoFrame, meta: { seq: number; width: number; height: number }) => void
const playFrames = new Map<string, PlayFrameListener>()
sharedTexture?.setSharedTextureReceiver?.(async ({ importedSharedTexture }, meta: { world?: string; seq: number; width: number; height: number }) => {
  try {
    const listener = playFrames.get(String(meta?.world))
    if (!listener) return
    const frame = importedSharedTexture.getVideoFrame()
    try { listener(frame, { seq: meta.seq, width: meta.width, height: meta.height }) } finally { frame.close() }
  } catch { /* a lost GPU: main falls back to JPEG */ } finally { importedSharedTexture.release() }
})

// Each method maps to ipcRenderer.invoke('genio:<method>', ...args). Built as a
// plain object: contextBridge cannot clone a Proxy.
const api = Object.fromEntries(
  API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(API_PREFIX + m, ...args)])
) as unknown as GenioApi

const bridge = {
  api,
  on(fn: (e: GenioEvent) => void): () => void {
    const h = (_e: IpcRendererEvent, ev: GenioEvent): void => fn(ev)
    ipcRenderer.on(EVENT_CHANNEL, h)
    return () => ipcRenderer.off(EVENT_CHANNEL, h)
  },
  onTerminalData(fn: (batch: { id: string; data: string; at?: string }[]) => void): () => void {
    const h = (_e: IpcRendererEvent, batch: { id: string; data: string; at?: string }[]): void => fn(batch)
    ipcRenderer.on(TERM_CHANNEL, h)
    return () => ipcRenderer.off(TERM_CHANNEL, h)
  },
  /** Play's GPU frames for one project's live view; returns the unsubscribe. */
  onPlayFrame(world: string, fn: PlayFrameListener): () => void {
    playFrames.set(world, fn)
    return () => { if (playFrames.get(world) === fn) playFrames.delete(world) }
  },
  /** absolute path of a dropped file ('' when it has none) */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('genio', bridge)
