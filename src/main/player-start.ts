import fs from 'node:fs'
import { decodeBytes } from '@shared/encoding'
import { PLAYER_START_PHASES, type PlayerStartPhase, type PlayerStartStatus } from '@shared/play'
import { treeStats } from '../../resources/unit-skills/genio/lib/unity-seed.mjs'

/** Milliseconds spent in each phase of a start; the last complete start's weights the next start's bar. */
export type StartDurations = Partial<Record<PlayerStartPhase, number>>
interface Count { done: number; total: number }

// The markers Unity 6 writes to editor.log while it opens a project (the Play start speed Recon's evidence).
const REFRESH_START = /^Application\.AssetDatabase Initial Refresh Start\b/
const REFRESH_END = /^Application\.AssetDatabase Initial Refresh End\b/
const COMPILE = /^\[ScriptCompilation\] Requested script compilation\b|^Starting: .*bee_backend/
const BEE = /^\[\s*(\d+)\/(\d+)\s/
const RELOAD = /^Begin MonoManager ReloadAssembly\b/
const RELOADED = /^Domain Reload Profiling:/
const IMPORT = /^Importing '|^Start importing /
const LOADED = /^\[Project\] Loading completed\b/

/**
 * A Unity start's phase, read from its editor.log lines in order. The clock comes in with each line. The first domain
 * reload belongs to opening; packages unpack only when the copy's PackageCache was missing at launch (the log says
 * nothing until UPM finishes); a recompile after importing goes back to compiling.
 */
export class StartPhases {
  phase: PlayerStartPhase = 'opening'
  since: number
  /** Bee's node count while compiling: "[ 952/1238 ...]". */
  bee?: Count
  /** A known marker was seen, so this log is Unity's and the phases follow it. */
  recognized = false
  /** Unity wrote "[Project] Loading completed": the editor is ready or about to be. */
  complete = false
  private spent: StartDurations = {}
  private refreshing = false
  constructor(start: number, private coldPackages = false) { this.since = start }
  private enter(phase: PlayerStartPhase, now: number) {
    if (phase === this.phase) return
    this.spent[this.phase] = (this.spent[this.phase] ?? 0) + Math.max(0, now - this.since)
    this.phase = phase; this.since = now; this.bee = undefined
  }
  line(text: string, now: number) {
    if (this.complete) return
    let m: RegExpExecArray | null
    if (REFRESH_START.test(text)) { this.recognized = this.refreshing = true; if (this.coldPackages) this.enter('packages', now) }
    else if (REFRESH_END.test(text)) { this.recognized = true; this.enter('scene', now) }
    else if (LOADED.test(text)) this.recognized = this.complete = true
    else if (RELOAD.test(text)) { this.recognized = true; if (this.refreshing) this.enter('loading', now) }
    else if (RELOADED.test(text)) { if (this.phase === 'loading') this.enter('importing', now) }
    else if (COMPILE.test(text)) this.enter('compiling', now)
    else if ((m = BEE.exec(text))) {
      this.enter('compiling', now)
      const total = Number(m[2]), done = Math.min(total, Math.max(Number(m[1]), this.bee?.done ?? 0))
      if (total > 0) this.bee = { done, total }
    } else if (IMPORT.test(text) && this.refreshing && this.phase !== 'loading') this.enter('importing', now)
  }
  /** Time in each phase so far, the current one up to now. */
  durations(now: number): StartDurations {
    return { ...this.spent, [this.phase]: (this.spent[this.phase] ?? 0) + Math.max(0, now - this.since) }
  }
}

/**
 * The start's bar, 0–99, or undefined (indeterminate) when the project has no complete start on record. Segments are
 * weighted by the last start's phase durations. Inside the current phase a real count fills it (Bee nodes, PackageCache
 * bytes); without one, time against the last duration does, holding at the segment's end when the phase overruns.
 */
export function startBar(phase: PlayerStartPhase, elapsed: number, count: Count | undefined, last: StartDurations | undefined): number | undefined {
  const weight = (p: PlayerStartPhase) => last?.[p] ?? 0
  const total = PLAYER_START_PHASES.reduce((n, p) => n + weight(p), 0)
  if (!(total > 0)) return undefined
  const before = PLAYER_START_PHASES.slice(0, PLAYER_START_PHASES.indexOf(phase)).reduce((n, p) => n + weight(p), 0)
  const fraction = count && count.total > 0 ? Math.min(1, count.done / count.total) : weight(phase) > 0 ? Math.min(1, elapsed / weight(phase)) : 0
  return Math.min(99, Math.floor((100 * (before + fraction * weight(phase))) / total))
}

/** Durations read back from player.json: known phases with finite, non-negative times only. */
export function validDurations(value: unknown): StartDurations | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: StartDurations = {}
  for (const p of PLAYER_START_PHASES) {
    const ms = (value as Record<string, unknown>)[p]
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) out[p] = ms
  }
  return Object.keys(out).length ? out : undefined
}

const entries = (dir: string) => { try { return fs.readdirSync(dir).length } catch { return 0 } }
const SIZE_EVERY_MS = 5000

/**
 * One start's editor.log, read forward from where the last read stopped, so no marker is missed between polls. While
 * packages unpack, the copy's PackageCache is sized every few seconds against the main checkout's.
 */
export class StartLog {
  readonly phases: StartPhases
  private offset = 0
  private rest = Buffer.alloc(0)
  private grew: number
  private mainBytes?: number
  private packages?: Count
  private sizing = false
  private sizedAt = -Infinity
  private shown = 0
  /** caches: the copy's and the main checkout's Library/PackageCache. */
  constructor(readonly file: string, start: number, private caches?: { copy: string; main: string }) {
    const cold = !!caches && (entries(caches.copy) === 0 || entries(caches.copy) < entries(caches.main))
    this.phases = new StartPhases(start, cold)
    this.grew = start
    if (cold && caches && entries(caches.main)) {
      void treeStats(caches.main, { rejectLinks: false }).then(s => { this.mainBytes = s.bytes }, () => {})
    }
  }
  /** Reads what Unity wrote since the last call. A missing log is not an error: Unity has not created it yet. */
  read(now: number) {
    let size: number
    try { size = fs.statSync(this.file).size } catch { return }
    if (size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0) }
    if (size > this.offset) {
      this.grew = now
      const fd = fs.openSync(this.file, 'r')
      try {
        while (this.offset < size) {
          const chunk = Buffer.alloc(Math.min(1 << 20, size - this.offset))
          const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset)
          if (!n) break
          this.offset += n
          const data = Buffer.concat([this.rest, chunk.subarray(0, n)])
          const end = data.lastIndexOf(0x0a)
          // A line still being written waits for its end; an endless one is dropped.
          this.rest = end < 0 ? (data.length > 65536 ? Buffer.alloc(0) : data) : Buffer.from(data.subarray(end + 1))
          if (end >= 0) for (const line of decodeBytes(data.subarray(0, end)).split(/\r?\n/)) this.phases.line(line, now)
        }
      } finally { fs.closeSync(fd) }
    }
    if (this.phases.phase === 'packages' && this.caches && this.mainBytes && !this.sizing && now - this.sizedAt >= SIZE_EVERY_MS) {
      this.sizing = true; this.sizedAt = now
      const total = this.mainBytes
      void treeStats(this.caches.copy, { rejectLinks: false })
        .then(s => { this.packages = { done: s.bytes, total } }, () => {})
        .finally(() => { this.sizing = false })
    }
  }
  /** How long the log has not grown. */
  quietFor(now: number) { return now - this.grew }
  /** The phase and, with a previous start on record, the bar; the bar never moves back. */
  status(now: number, last: StartDurations | undefined): PlayerStartStatus {
    const p = this.phases
    const count = p.phase === 'compiling' ? p.bee : p.phase === 'packages' ? this.packages : undefined
    const bar = startBar(p.phase, p.durations(now)[p.phase] ?? 0, count, last)
    if (bar === undefined) return { phase: p.phase }
    this.shown = Math.max(this.shown, bar)
    return { phase: p.phase, bar: this.shown }
  }
}
