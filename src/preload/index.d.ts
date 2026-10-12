import type { GenioApi } from '../shared/api'
import type { GenioEvent } from '../shared/types'

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
