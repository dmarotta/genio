import { EventEmitter } from 'node:events'
import type { GenioEvent } from '@shared/types'

/**
 * Process-wide event bus. Services publish GenioEvents here; the window layer
 * forwards them to the renderer, and services may also subscribe to each other.
 */
class Bus extends EventEmitter {
  publish(ev: GenioEvent): void {
    this.emit('event', ev)
  }
  onEvent(fn: (ev: GenioEvent) => void): () => void {
    this.on('event', fn)
    return () => this.off('event', fn)
  }
  toast(level: 'info' | 'success' | 'warn' | 'error', title: string, body?: string): void {
    this.publish({ type: 'toast', level, title, body })
  }
}

export const bus = new Bus()
bus.setMaxListeners(100)
