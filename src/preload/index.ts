import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { API_METHODS, API_PREFIX, EVENT_CHANNEL, type GenioApi } from '@shared/api'
import type { GenioEvent } from '@shared/types'

const TERM_CHANNEL = 'genio:term-data'

// Transfer the port out of the isolated preload; Unity credentials stay in main.
ipcRenderer.on('genio:play-port', (event, data: { world: string }) => {
  window.postMessage({ type: 'genio:play-port', world: data.world }, '*', event.ports)
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
  /** absolute path of a dropped file ('' when it has none) */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('genio', bridge)
