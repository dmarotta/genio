/**
 * Replay log: an opt-in,
 * append-only JSONL activity record that outside tools can follow.
 * Delivery is at-least-once; records are never rewritten.
 */
import type { LedgerRecord } from '@shared/types'
import type { AppCtx, LedgerService } from './services'
import { appendJsonl, nowIso, readJsonl } from './util'

export function createLedgerService(getCtx: () => AppCtx): LedgerService {
  const file = (): string => getCtx().main.home.ledgerFile

  return {
    record(rec) {
      try {
        if (!getCtx().settings.get().ledger) return
        const full: LedgerRecord = {
          v: 1,
          ts: nowIso(),
          home: rec.home ?? 'main',
          event: rec.event,
          ...(rec.task ? { task: rec.task } : {}),
          ...(rec.project ? { project: rec.project } : {}),
          ...(rec.data ? { data: capData(rec.data) } : {})
        }
        appendJsonl(file(), full)
      } catch {
        /* the ledger is optional; never break the caller */
      }
    },
    tail(n) {
      try {
        const all = readJsonl<LedgerRecord>(file())
        return n > 0 ? all.slice(-n) : all
      } catch {
        return []
      }
    }
  }
}

/** Keep free text bounded (status text is capped at 2000 chars). */
function capData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) : v
  }
  return out
}
