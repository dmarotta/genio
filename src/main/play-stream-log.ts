import fs from 'node:fs'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

/** The log is kept small: past this size the next write moves it aside (one older file, so twice this at most). */
export const STREAM_LOG_MAX_BYTES = 128 * 1024
/** A stall this long on the main thread is written when it is seen, not only when the session ends. */
export const STALL_NOTE_MS = 1000

export interface StallMonitor { start(): void; stop(): void; /** longest main-thread delay since the last call, ms */ longest(): number }

/** Node's event loop delay histogram: native, no timer on the main thread, no file write. */
function loopMonitor(): StallMonitor {
  const h = monitorEventLoopDelay({ resolution: 20 })
  return { start: () => h.enable(), stop: () => h.disable(), longest: () => { const v = h.max / 1e6; h.reset(); return Number.isFinite(v) ? v : 0 } }
}

interface Session { startedAt: number; path: string; size: string; fallbacks: string[]; longestStall: number }

/**
 * What the next report about a stream needs: the path a session ran on (GPU shared textures or JPEG), any fallback
 * reason, and the longest main-thread stall seen while it ran. A small text file in Genio's data folder, no UI.
 * Writes are asynchronous, in order, and never throw; the main thread does not wait for the disk.
 */
export class StreamLog {
  private session?: Session
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private noted = 0
  constructor(private file: string, private options: { now?: () => number; monitor?: StallMonitor; maxBytes?: number; sampleMs?: number } = {}) {
    this.monitor = options.monitor ?? loopMonitor()
  }
  private monitor: StallMonitor
  private now() { return (this.options.now ?? Date.now)() }

  /** A stream begins on `path`. A new size on a running session (resize) only records the path it now has. */
  begin(streamPath: 'gpu' | 'jpeg', width: number, height: number) {
    const size = `${width}x${height}`
    if (this.session) {
      if (this.session.path !== streamPath) this.line(`path changed to ${streamPath} ${size}`)
      this.session.path = streamPath; this.session.size = size
      return
    }
    this.session = { startedAt: this.now(), path: streamPath, size, fallbacks: [], longestStall: 0 }
    this.line(`stream start: path=${streamPath} ${size}`)
    this.monitor.start(); this.monitor.longest()
    this.timer = setInterval(() => this.sample(), this.options.sampleMs ?? 1000); this.timer.unref?.()
  }
  /** The GPU path gave way to JPEG. */
  fallback(reason: string, detail?: string) {
    if (!this.session) return
    const text = detail ? `${reason} (${detail})` : reason
    this.session.fallbacks.push(text); this.session.path = 'jpeg'
    this.line(`fallback to JPEG: ${text}`)
  }
  /** The session is over (stopped, disconnected or the editor gone). Safe to call twice. */
  end() {
    const s = this.session
    if (!s) return
    this.sample()
    this.session = undefined
    clearInterval(this.timer); this.timer = undefined; this.monitor.stop()
    const seconds = Math.round((this.now() - s.startedAt) / 1000)
    this.line(`stream end: path=${s.path} ${s.size} fallback=${s.fallbacks.length ? s.fallbacks.join('; ') : 'none'} longestStall=${Math.round(s.longestStall)}ms duration=${seconds}s`)
    this.noted = 0
  }
  private sample() {
    const s = this.session
    if (!s) return
    const v = this.monitor.longest()
    if (v > s.longestStall) s.longestStall = v
    // A real stall is worth a line at once, but only when it is a new worst, so a long bad spell writes a few lines.
    if (v >= STALL_NOTE_MS && v > this.noted) { this.noted = v; this.line(`main-thread stall ${Math.round(v)}ms`) }
  }
  private line(text: string) {
    const entry = `${new Date(this.now()).toISOString()} ${text}\n`
    this.chain = this.chain.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
        const size = await fs.promises.stat(this.file).then(s => s.size, () => 0)
        if (size > (this.options.maxBytes ?? STREAM_LOG_MAX_BYTES)) await fs.promises.rename(this.file, `${this.file}.1`)
        await fs.promises.appendFile(this.file, entry)
      } catch { /* a log that cannot be written never affects Play */ }
    })
  }
  /** Resolves when every line so far is on disk (tests, and a clean exit). */
  flush(): Promise<unknown> { return this.chain }
}
