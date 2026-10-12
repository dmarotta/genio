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
import { appendJsonl, nowIso, readJson, readJsonl, writeJson, writeText } from './util'

interface AckCursor {
  through: number
  at?: string
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
    return rows.filter((w) => w.seq > cursor.through)
  }

  function compactIfNeeded(): void {
    const acked = rows.filter((w) => w.seq <= cursor.through)
    if (acked.length <= COMPACT_AFTER) return
    const keep = [...acked.slice(-KEEP_ACKED), ...rows.filter((w) => w.seq > cursor.through)]
    rows = keep
    writeText(home.wakesFile, keep.map((w) => JSON.stringify(w)).join('\n') + (keep.length ? '\n' : ''))
  }

  function withAck(w: Wake): Wake {
    return w.seq <= cursor.through ? { ...w, ackedAt: w.ackedAt ?? cursor.at } : w
  }

  return {
    enqueue(input: { kind: WakeKind; reason: string; taskId?: string; lines?: string[]; routine?: boolean }): Wake {
      load()
      const wake: Wake = {
        seq: ++maxSeq,
        ts: nowIso(),
        wksp: home.name,
        kind: input.kind,
        reason: oneLine(input.reason),
        lines: (input.lines ?? []).map((l) => oneLine(l)).slice(0, 40),
        routine: input.routine ?? false,
        ...(input.taskId ? { taskId: input.taskId } : {})
      }
      rows.push(wake)
      try {
        appendJsonl(home.wakesFile, wake)
      } catch {
        /* keep in memory; next compaction rewrites the file */
      }
      bus.publish({ type: 'wake', wake })
      return wake
    },

    pending(): Wake[] {
      return pendingRows()
    },

    drain(): { text: string; ackThrough: number; count: number } {
      const queued = pendingRows()
      const out: string[] = []
      out.push(`EVENTS (${queued.length})`)
      if (!queued.length) out.push('  (none queued)')
      for (const w of queued) {
        const tag = w.routine ? ' [routine]' : ''
        const task = w.taskId ? ` {${w.taskId}}` : ''
        out.push(`#${w.seq} ${w.kind}:${task} ${w.reason}${tag}`)
        for (const l of w.lines) out.push(`    ${l}`)
      }

      // UNREAD STATUS: status lines newly surfaced through queued signal events.
      const unread: string[] = []
      for (const w of queued) {
        if (w.kind !== 'signal') continue
        for (const l of w.lines) unread.push(`${w.taskId ?? '?'}: ${l}`)
      }
      out.push('')
      out.push(`UNREAD STATUS (${unread.length})`)
      if (!unread.length) out.push('  (nothing new)')
      for (const u of unread) out.push(`  ${u}`)

      // OPEN CHOICES: every open decision in this base, even with no queued event.
      let open: { id: string; taskId?: string; key: string; question: string; source: string }[] = []
      try {
        open = getCtx().home(home.name).decisions.list(false)
      } catch {
        open = []
      }
      out.push('')
      out.push(`OPEN CHOICES (${open.length})`)
      if (!open.length) out.push('  (none)')
      for (const d of open) {
        out.push(`  ${d.id} task=${d.taskId ?? '-'} key=${d.key} source=${d.source}: ${oneLine(d.question)}`)
      }

      const ackThrough = queued.length ? queued[queued.length - 1].seq : cursor.through
      out.push('')
      out.push(queued.length ? `ACK REQUIRED: through #${ackThrough}` : 'ACK REQUIRED: none')
      return { text: out.join('\n'), ackThrough, count: queued.length }
    },

    ack(throughSeq: number): void {
      load()
      if (!Number.isFinite(throughSeq) || throughSeq <= cursor.through) return
      cursor = { through: Math.min(throughSeq, maxSeq), at: nowIso() }
      try {
        writeJson(home.wakesAckFile, cursor)
      } catch {
        /* cursor stays in memory; events are re-presented after restart (safe) */
      }
      try {
        compactIfNeeded()
      } catch {
        /* compaction is an optimisation */
      }
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
