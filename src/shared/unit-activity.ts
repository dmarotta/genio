/**
 * Has a ready unit taken up work again? A finished unit's CLI stays open and
 * keeps printing its own chrome (dialogs, tips, status-bar repaints, usage and
 * update notices), so output alone is no evidence. The one definition shared by
 * the Squad label, the unit clock, the tone and the unit cap.
 */
import type { Task, TerminalInfo } from './types'

/** Harnesses whose turn starts Genio sees directly (a prompt-submit hook): their output alone never counts as work. */
export const TURN_MARKED_HARNESSES = new Set(['claude'])

type ReadyFields = Pick<Task, 'readyAt' | 'lastStatusAt' | 'updatedAt' | 'resumedAt'> & Partial<Pick<Task, 'harness'>>

const time = (at?: string | number): number => (typeof at === 'number' ? at : Date.parse(at ?? '') || 0)

/** When the unit last said it was ready (0 when unknown). */
export const readySince = (task: Partial<ReadyFields>): number => time(task.readyAt ?? task.lastStatusAt ?? task.updatedAt)

/** A unit's closing summary streams on for a while after its ready line; sustained output counts only past this. */
export const OUTPUT_GRACE_MS = 60_000

/**
 * Evidence from the unit's live terminal after `ready`: a launch or relaunch,
 * or (only for a harness without a turn marker) sustained work-like output
 * past the closing-summary grace. 0 when there is none.
 */
export function terminalWorkAt(task: Partial<Pick<Task, 'harness'>>, terminal: Pick<TerminalInfo, 'processSpawnedAt' | 'workOutputAt'> | undefined, ready: number): number {
  if (!terminal) return 0
  const spawned = time(terminal.processSpawnedAt)
  const output = TURN_MARKED_HARNESSES.has(task.harness ?? '') ? 0 : time(terminal.workOutputAt)
  return Math.max(spawned > ready ? spawned : 0, output > ready + (ready ? OUTPUT_GRACE_MS : 0) ? output : 0)
}

/**
 * Positive evidence of work after the ready signal: a recorded resume (a new
 * status line, a delivered ping, a new turn, sustained output) or a launch
 * after it. Without a known ready time any such evidence counts.
 */
export function resumedAfterReady(task: Partial<ReadyFields>, terminal?: Pick<TerminalInfo, 'processSpawnedAt' | 'workOutputAt'>): boolean {
  const ready = readySince(task)
  return time(task.resumedAt) > ready || terminalWorkAt(task, terminal, ready) > 0
}

// ------------------------------------------------------------------ output fallback

/**
 * Idle CLI chrome by harness, matched on whitespace-free lower-case text (TUIs
 * position text with cursor moves, so stripped output loses its spaces).
 */
export const IDLE_CHROME: Record<string, RegExp[]> = {
  any: [
    /autocompact/, /compactat\d/, /^tip[:s]/, /\?forshortcuts/, /updateavailable|newversion|toupdate|npm(i|install)-g/,
    /usagelimit|ratelimit|limitresets|resetsat|approachingyour|planusage/, /contextleft|context(window)?:?\d+%|tokens?(left|used)/,
    /bypasspermissions|shift\+tab|esctocancel|ctrl\+[a-z]to/, /^[>›❯│|─━—\-_=*·•.]+$/
  ],
  claude: [/^\d+tokens/, /auto-?compact/, /compactingearlier|keepauto\(|enterconfirm|escnotnow|re-sendsthewholeconversation|summarizedonyournext/],
  codex: [/^codex(v[\d.]+)?$/, /^\/(model|status|approvals)/, /workingdirectory|sendmessage|pressenter/]
}

export interface ActivityMeterOptions {
  windowMs?: number
  bucketMs?: number
  /** distinct buckets with new text inside the window */
  minBuckets?: number
  /** new visible characters inside the window */
  minChars?: number
}

export interface ActivityMeter {
  /** Feeds ANSI-stripped output; true when the window now holds sustained work-like output. */
  push(plain: string, at: number): boolean
}

/**
 * Sustained output: new text (lines not already printed in the window) in
 * several separate moments, not a single dialog burst or a repaint loop.
 */
export function createActivityMeter(harness = '', opts: ActivityMeterOptions = {}): ActivityMeter {
  const windowMs = opts.windowMs ?? 15_000
  const bucketMs = opts.bucketMs ?? 1_000
  const minBuckets = opts.minBuckets ?? 4
  const minChars = opts.minChars ?? 400
  const chrome = [...IDLE_CHROME.any, ...(IDLE_CHROME[harness] ?? [])]
  const seen = new Map<string, number>()
  let samples: { at: number; chars: number }[] = []
  return {
    push(plain, at) {
      for (const [line, when] of seen) if (at - when > windowMs) seen.delete(line)
      samples = samples.filter(s => at - s.at <= windowMs)
      let chars = 0
      for (const raw of plain.split(/[\r\n]+/)) {
        const line = raw.replace(/\s+/g, '').toLowerCase()
        if (line.length < 4 || chrome.some(re => re.test(line))) continue
        const fresh = !seen.has(line)
        seen.set(line, at)
        if (fresh) chars += line.length
      }
      if (chars) samples.push({ at, chars })
      const buckets = new Set(samples.map(s => Math.floor(s.at / bucketMs))).size
      return buckets >= minBuckets && samples.reduce((n, s) => n + s.chars, 0) >= minChars
    }
  }
}
