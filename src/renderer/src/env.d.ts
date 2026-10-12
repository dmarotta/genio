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
  onTerminalData(fn: (batch: { id: string; data: string }[]) => void): () => void
  platform: string
}

declare global {
  interface Window {
    genio: {
      api: GenioApi
      on(fn: (e: GenioEvent) => void): () => void
      onTerminalData(fn: (batch: { id: string; data: string }[]) => void): () => void
      platform: string
    }
  }
}

export {}
