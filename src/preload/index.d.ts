import type { GenioApi } from '../shared/api'
import type { GenioEvent } from '../shared/types'

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
