import fs from 'node:fs'
import { decodeBytes } from '@shared/encoding'
import type { PlayerStartPhase, PlayerStartStatus } from '@shared/play'

// The markers Unity 6 writes to editor.log while it opens a project (the Play start speed Recon's evidence).
const REFRESH_START = /^Application\.AssetDatabase Initial Refresh Start\b/
const REFRESH_END = /^Application\.AssetDatabase Initial Refresh End\b/
const COMPILE = /^\[ScriptCompilation\] Requested script compilation\b|^Starting: .*bee_backend/
const BEE = /^\[\s*\d+\/\d+\s/
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
  /** A known marker was seen, so this log is Unity's and the phases follow it. */
  recognized = false
  /** Unity wrote "[Project] Loading completed": the editor is ready or about to be. */
  complete = false
  private refreshing = false
  constructor(start: number, private coldPackages = false) { this.since = start }
  private enter(phase: PlayerStartPhase, now: number) {
    if (phase === this.phase) return
    this.phase = phase; this.since = now
  }
  line(text: string, now: number) {
    if (this.complete) return
    if (REFRESH_START.test(text)) { this.recognized = this.refreshing = true; if (this.coldPackages) this.enter('packages', now) }
    else if (REFRESH_END.test(text)) { this.recognized = true; this.enter('scene', now) }
    else if (LOADED.test(text)) this.recognized = this.complete = true
    else if (RELOAD.test(text)) { this.recognized = true; if (this.refreshing) this.enter('loading', now) }
    else if (RELOADED.test(text)) { if (this.phase === 'loading') this.enter('importing', now) }
    else if (COMPILE.test(text) || BEE.test(text)) this.enter('compiling', now)
    else if (IMPORT.test(text) && this.refreshing && this.phase !== 'loading') this.enter('importing', now)
  }
}

const entries = (dir: string) => { try { return fs.readdirSync(dir).length } catch { return 0 } }

/**
 * One start's editor.log, read forward from where the last read stopped, so no marker is missed between polls.
 */
export class StartLog {
  readonly phases: StartPhases
  private offset = 0
  private rest = Buffer.alloc(0)
  private grew: number
  /** caches: the copy's and the main checkout's Library/PackageCache. */
  constructor(readonly file: string, start: number, private caches?: { copy: string; main: string }) {
    const cold = !!caches && (entries(caches.copy) === 0 || entries(caches.copy) < entries(caches.main))
    this.phases = new StartPhases(start, cold)
    this.grew = start
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
  }
  /** How long the log has not grown. */
  quietFor(now: number) { return now - this.grew }
  /** The phase and when it began. */
  status(): PlayerStartStatus { return { phase: this.phases.phase, since: this.phases.since } }
}
