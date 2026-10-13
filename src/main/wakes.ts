/**
 * Durable event queue (companion state/.wake-queue + fm-wake-drain.sh).
 *
 * Every actionable overwatch event is appended to state/wakes.jsonl with a
 * monotonically increasing seq. Genio drains the queue at the start of a
 * handling turn and acknowledges *after* the turn completes, so a crash
 * mid-turn re-presents the same events (idempotent re-handling).
 */
import fs from 'node:fs'
import type { Wake, WakeKind } from '@shared/types'
import { bus } from './bus'
import type { Home } from './home'
import type { AppCtx, WakeService } from './services'
import { appendJsonl, nowIso, readJson, readJsonl, writeJsonAtomic, writeText } from './util'

interface AckCursor {
  through: number
  at?: string
  /** Out-of-order per-event acknowledgements, durable even if the turn fails. */
  events?: Record<string, string>
}

const COMPACT_AFTER = 500
const KEEP_ACKED = 100

export function createWakeService(getCtx: () => AppCtx, home: Home): WakeService {
  let loaded = false
  let rows: Wake[] = []
  let maxSeq = 0
  let cursor: AckCursor = { through: 0 }

  function load(): void {
    if (loaded) return
    loaded = true
    rows = readJsonl<Wake>(home.wakesFile).filter((w) => typeof w.seq === 'number')
    rows.sort((a, b) => a.seq - b.seq)
    maxSeq = rows.reduce((m, w) => Math.max(m, w.seq), 0)
    cursor = readJson<AckCursor>(home.wakesAckFile, { through: 0 })
    if (typeof cursor.through !== 'number' || cursor.through < 0) cursor = { through: 0 }
    // A cursor past the last row (file truncated by hand) must not swallow new events.
    if (cursor.through > maxSeq) maxSeq = cursor.through
  }

  function pendingRows(): Wake[] {
    load()
    return rows.filter((w) => !isAcked(w))
  }

  const isAcked = (w: Wake): boolean => w.seq <= cursor.through || !!cursor.events?.[w.seq]

  function compactIfNeeded(): void {
    const acked = rows.filter(isAcked)
    if (acked.length <= COMPACT_AFTER) return
    const keep = [...acked.slice(-KEEP_ACKED), ...rows.filter(w => !isAcked(w))].sort((a, b) => a.seq - b.seq)
    rows = keep
    writeText(home.wakesFile, keep.map((w) => JSON.stringify(w)).join('\n') + (keep.length ? '\n' : ''))
  }

  function withAck(w: Wake): Wake {
    return isAcked(w) ? { ...w, ackedAt: w.ackedAt ?? cursor.events?.[w.seq] ?? cursor.at } : w
  }

  function acknowledge(seqs: number[]): void {
    load()
    const at = nowIso()
    const events = { ...cursor.events }
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || !rows.some(w => w.seq === seq)) throw new Error(`Unknown event #${seq}`)
      if (seq > cursor.through) events[seq] = at
    }
    let through = cursor.through
    const firstPending = rows.find(w => w.seq > through && !events[w.seq])
    through = firstPending ? firstPending.seq - 1 : maxSeq
    for (const seq of Object.keys(events)) if (Number(seq) <= through) delete events[seq]
    const next = { through, at, events }
    // Persist before acknowledging in memory. A failed disk write must not
    // claim an event was handled; replay after a crash remains safe.
    writeJsonAtomic(home.wakesAckFile, next)
    cursor = next
    try { compactIfNeeded() } catch { /* compaction is an optimisation */ }
  }

  return {
    enqueue(input: { kind: WakeKind; reason: string; taskId?: string; lines?: string[]; routine?: boolean }): Wake {
      load()
      const wake: Wake = {
        seq: maxSeq + 1,
        ts: nowIso(),
        wksp: home.name,
        kind: input.kind,
        reason: oneLine(input.reason),
        lines: [...new Set((input.lines ?? []).map((l) => oneLine(l)))],
        routine: input.routine ?? false,
        ...(input.taskId ? { taskId: input.taskId } : {})
      }
      appendJsonl(home.wakesFile, wake)
      maxSeq = wake.seq
      rows.push(wake)
      bus.publish({ type: 'wake', wake })
      return wake
    },

    pending(): Wake[] {
      return pendingRows()
    },

    drain(): { text: string; ackThrough: number; count: number } {
      const queued = pendingRows()
      const out: string[] = []
      let size = 300
      let count = 0
      let ackThrough = cursor.through
      for (const w of queued) {
        const tag = w.routine ? ' [routine]' : ''
        const task = w.taskId ? ` {${w.taskId}}` : ''
        const header = `#${w.seq} ${w.kind}:${task}${tag}`
        const details = [...new Set([w.reason, ...w.lines])].join('\n  ')
        // Large events keep their durable identity and an explicit continuation;
        // event_read pages the complete details, including errors and URLs.
        const block = details.length > 1200
          ? `${header} details: event_read(seq=${w.seq}) REQUIRED before handling/ack`
          : `${header} ${details}`
        if (count && size + block.length > 2000) break
        out.push(block)
        size += block.length + 1
        count++
        ackThrough = w.seq
      }
      out.unshift(`EVENTS (${count}; ${queued.length} pending)`)
      if (!count) out.push('  (none queued)')
      out.push('Open choices: choice_list when needed (not repeated here).')
      out.push(count ? `ACK: events_ack(seqs=[handled IDs]) after each event; successful turn also acks through #${ackThrough}.` : 'ACK REQUIRED: none')
      if (count < queued.length) out.push('Remaining events follow after this batch is handled.')
      return { text: out.join('\n'), ackThrough, count }
    },

    ack(throughSeq: number): void {
      load()
      if (!Number.isSafeInteger(throughSeq) || throughSeq <= cursor.through) return
      acknowledge(rows.filter(w => w.seq <= throughSeq && !isAcked(w)).map(w => w.seq))
    },

    ackEvents: acknowledge,

    get(seq: number): Wake | undefined {
      load()
      const w = rows.find(w => w.seq === seq)
      return w ? withAck(w) : undefined
    },

    recent(n: number): Wake[] {
      load()
      const list = n > 0 ? rows.slice(-n) : rows.slice()
      return list.map(withAck)
    }
  }
}

function oneLine(s: string): string {
  return String(s ?? '').replace(/\s*\r?\n\s*/g, ' ⏎ ').trim()
}

/** test helper: remove queue files */
export function resetWakeFiles(home: Home): void {
  for (const f of [home.wakesFile, home.wakesAckFile]) {
    try {
      fs.unlinkSync(f)
    } catch {
      /* absent */
    }
  }
}
