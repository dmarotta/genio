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
      pathForFile(file: File): string
      platform: string
    }
  }
}

export {}
