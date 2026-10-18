import path from 'node:path'
import type { SpawnRequest } from '@shared/api'
import { readJson, writeJsonAtomic } from './util'

export class QuotaDeferredError extends Error {}

export type QuotaDeferred =
  | { kind: 'spawn'; request: SpawnRequest & { backlogId: string } }
  | { kind: 'relaunch'; id: string; note?: string; manual: boolean; initial?: boolean }

/** Only remembers already-requested operations; never grants permission or invents a quest spec. */
export class QuotaDeferredQueue {
  private readonly file: string
  private busy = false
  constructor(data: string) { this.file = path.join(data, 'usage', 'quota-deferred.json') }
  private entries(): Record<string, QuotaDeferred> { return readJson(this.file, {}) }
  has(): boolean { return Object.keys(this.entries()).length > 0 }
  put(key: string, entry: QuotaDeferred): void {
    const entries = this.entries()
    const prior = entries[key]
    if (entry.kind === 'relaunch' && prior?.kind === 'relaunch') entry.initial ??= prior.initial
    writeJsonAtomic(this.file, { ...entries, [key]: entry })
  }
  remove(key: string): void {
    const entries = this.entries()
    if (!(key in entries)) return
    delete entries[key]
    writeJsonAtomic(this.file, entries)
  }
  async drain(retry: (entry: QuotaDeferred) => Promise<boolean>): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      for (const [key, entry] of Object.entries(this.entries())) {
        // Re-read after awaits: cancellation or a successful parallel launch wins.
        if (!(key in this.entries())) continue
        if (await retry(entry)) this.remove(key)
      }
    } finally { this.busy = false }
  }
}
