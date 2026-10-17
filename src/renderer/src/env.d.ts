/// <reference types="vite/client" />
import type { GenioApi } from '@shared/api'
import type { GenioEvent } from '@shared/types'

export interface TerminalDataChunk {
  id: string
  data: string
}

export interface GenioBridge {
  api: GenioApi
  on(fn: (e: GenioEvent) => void): () => void
  onTerminalData(fn: (batch: { id: string; data: string; at?: string }[]) => void): () => void
  /** Play's GPU frames for one project's live view: draw the frame inside fn; returns the unsubscribe. */
  onPlayFrame(world: string, fn: (frame: VideoFrame, meta: { seq: number; width: number; height: number }) => void): () => void
  /** absolute path of a dropped file ('' when it has none) */
  pathForFile(file: File): string
  platform: string
}

declare global {
  interface Window {
    genio: {
      api: GenioApi
      on(fn: (e: GenioEvent) => void): () => void
      onTerminalData(fn: (batch: { id: string; data: string; at?: string }[]) => void): () => void
      /** Play's GPU frames for one project's live view: draw the frame inside fn; returns the unsubscribe. */
      onPlayFrame(world: string, fn: (frame: VideoFrame, meta: { seq: number; width: number; height: number }) => void): () => void
      pathForFile(file: File): string
      platform: string
    }
  }
}

export {}
