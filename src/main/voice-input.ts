/**
 * Voice input: a local speech-to-text model for the chat's mic button (docs/voice.md).
 * - Install only on the player's yes: the whisper.cpp v1.8.2 OpenBLAS runtime and ggml-small.en-q5_1.bin, from pinned
 *   URLs with pinned SHA-256, into Genio's data folder (never a project). Resumable; a hash mismatch deletes the file.
 * - whisper-server runs lazily on 127.0.0.1 at a random port, CPU only, above-normal priority; it exits after 10 idle
 *   minutes and when Genio quits.
 * - Audio arrives as 16 kHz mono Float32 from the renderer and stays in memory: it is never written to disk.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { VoiceStatus } from '@shared/api'
import type { AppCtx } from './services'
import { bus } from './bus'
import { killTree } from './util'

export const VOICE_RATE = 16_000
/** The renderer stops at 60 s; a little slack for the last worklet buffers. */
export const VOICE_MAX_SAMPLES = 61 * VOICE_RATE
/** `-ac 768` makes the encoder look at the first 15.4 s of a window only, so longer clips are sent in parts. */
const PART_MAX_S = 15
const PART_TARGET_S = 14
const IDLE_MS = 10 * 60_000
const START_TIMEOUT_MS = 60_000
const INFERENCE_TIMEOUT_MS = 120_000

export interface VoiceDownload { file: string; url: string; sha256: string; size: number }
/** Pinned: the runtime from the whisper.cpp GitHub release, the model from a fixed Hugging Face revision. */
export const VOICE_DOWNLOADS: { runtime: VoiceDownload; model: VoiceDownload } = {
  runtime: {
    file: 'whisper-blas-bin-x64.zip',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.2/whisper-blas-bin-x64.zip',
    sha256: 'ffad94bc6a3e00530cc53900b9b3fe921c13282e946b7189161fb4304b661a97',
    size: 16_399_272
  },
  model: {
    file: 'ggml-small.en-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.en-q5_1.bin',
    sha256: 'bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30',
    size: 190_098_681
  }
}
/** What the server needs from the release zip (the rest of it is other tools). */
export const RUNTIME_FILES = ['whisper-server.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll', 'ggml-blas.dll', 'libopenblas.dll']
/** The terms small.en misses without a hint; the project and unit names are added per request. */
export const VOICE_VOCABULARY = ['Genio', 'Unity', 'Modeller', 'FAL', 'Uthana', 'Codex', 'Gauntlet', 'Art Bible', 'recon', 'merge', 'rebase', 'Steer']

export const serverArgs = (model: string, port: number): string[] =>
  ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'en', '-t', '4', '-bs', '1', '-bo', '1', '-nf', '-ac', '768', '-ng']

/** The one-line vocabulary prompt: Genio's terms, then project and unit names, deduplicated and kept short. */
export function voicePrompt(names: string[] = []): string {
  const seen = new Set<string>()
  const words: string[] = []
  for (const raw of [...VOICE_VOCABULARY, ...names]) {
    const w = raw.replace(/\s+/g, ' ').trim()
    if (!w || seen.has(w.toLowerCase())) continue
    if ([...words, w].join(', ').length > 400) break
    seen.add(w.toLowerCase())
    words.push(w)
  }
  return words.join(', ') + '.'
}

const FRAME = 480 // 30 ms
const SPEECH_RMS = 0.02
const SILENCE_RMS = 0.01
const SPEECH_MIN_S = 0.25

/** Whether a clip holds speech: some 30 ms frames above the speech level (`silent`: nothing even near it, skip the model). */
export function speechLevel(pcm: Float32Array): { speech: boolean; silent: boolean } {
  let loud = 0, peak = 0
  for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
    let sum = 0
    for (let i = at; i < at + FRAME; i++) sum += pcm[i] * pcm[i]
    const rms = Math.sqrt(sum / FRAME)
    if (rms > peak) peak = rms
    if (rms >= SPEECH_RMS) loud++
  }
  return { speech: (loud * FRAME) / VOICE_RATE >= SPEECH_MIN_S, silent: peak < SILENCE_RMS }
}

/** What Whisper writes for silence or noise: dropped whenever the clip has no speech in it. */
const HALLUCINATION = /^(?:thank you(?: (?:very much|so much|for watching))?|thanks(?: for watching)?|you|bye|okay|so|\.+)[.!?]*$/i

/** The transcript as it goes into the chat box: no non-speech tags, and no silence hallucination. */
export function cleanTranscript(text: string, speech: boolean): string {
  const t = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:silence|music|applause|laughs?|laughter|inaudible|blank[ _]audio|noise)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!speech && HALLUCINATION.test(t)) return ''
  return t
}

/** Clips over 15 s split at the quietest 100 ms between 11 and 14.5 s, then again for the rest. */
export function splitClip(pcm: Float32Array, rate = VOICE_RATE): Float32Array[] {
  const parts: Float32Array[] = []
  const win = rate / 10, step = rate / 100
  let rest = pcm
  while (rest.length > PART_MAX_S * rate) {
    let best = PART_TARGET_S * rate, quietest = Infinity
    for (let at = (PART_TARGET_S - 3) * rate; at + win <= (PART_TARGET_S + 0.5) * rate; at += step) {
      let sum = 0
      for (let i = at; i < at + win; i++) sum += rest[i] * rest[i]
      // Ties go to the later point, nearer 14 s.
      if (sum <= quietest) { quietest = sum; best = at + win / 2 }
    }
    parts.push(rest.subarray(0, best))
    rest = rest.subarray(best)
  }
  parts.push(rest)
  return parts
}

/** 16-bit mono PCM WAV, in memory. */
export function encodeWav(pcm: Float32Array, rate = VOICE_RATE): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVE', 8)
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i] || 0)) * 32767), 44 + i * 2)
  return out
}

/** The named files of a zip (deflate or stored), by base name only so nothing can land outside `dir`. */
export function extractZip(zip: Buffer, names: string[], dir: string): void {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const wanted = new Set(names.map(n => n.toLowerCase()))
  const found = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip directory')
    const method = zip.readUInt16LE(at + 10), packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const base = path.posix.basename(zip.toString('utf8', at + 46, at + 46 + nameLength).replace(/\\/g, '/'))
    at += 46 + nameLength + extra + comment
    if (!wanted.has(base.toLowerCase())) continue
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip entry')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + packed)
    const data = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : undefined
    if (!data || data.length !== size) throw new Error(`cannot unpack ${base}`)
    fs.writeFileSync(path.join(dir, base), data)
    found.add(base.toLowerCase())
  }
  const missing = [...wanted].filter(n => !found.has(n))
  if (missing.length) throw new Error(`the runtime is missing ${missing.join(', ')}`)
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export interface VoiceInputOptions {
  /** Genio's own voice folder (`<data>/voice`). */
  dir: string
  /** The pinned files (tests pass their own). */
  downloads?: typeof VOICE_DOWNLOADS
  fetch?: typeof fetch
  /** Starts the server; the default runs the downloaded whisper-server.exe. */
  spawnServer?: (exe: string, args: string[], cwd: string) => ChildProcess
  /** Project and unit names for the vocabulary prompt. */
  names?: () => string[]
  unlock: (id: string) => void
  publish?: (status: Pick<VoiceStatus, 'state' | 'received' | 'total'> & { error?: string }) => void
  idleMs?: number
}

interface Server { proc: ChildProcess; port: number; ready: Promise<void> }

export class VoiceInput {
  private install?: Promise<void>
  private received = 0
  private server?: Server
  private idle?: ReturnType<typeof setTimeout>
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly opts: VoiceInputOptions) {}

  private get runtimeDir(): string { return path.join(this.opts.dir, 'runtime') }
  private get downloads(): typeof VOICE_DOWNLOADS { return this.opts.downloads ?? VOICE_DOWNLOADS }
  private get modelFile(): string { return path.join(this.opts.dir, this.downloads.model.file) }
  private get marker(): string { return path.join(this.opts.dir, 'ready.json') }
  private get total(): number { return this.downloads.runtime.size + this.downloads.model.size }

  /** Installed: the marker names the pinned hashes and every file is in place. */
  ready(): boolean {
    try {
      const m = JSON.parse(fs.readFileSync(this.marker, 'utf8')) as { runtime?: string; model?: string }
      return m.runtime === this.downloads.runtime.sha256 && m.model === this.downloads.model.sha256 &&
        fs.existsSync(this.modelFile) && RUNTIME_FILES.every(f => fs.existsSync(path.join(this.runtimeDir, f)))
    } catch { return false }
  }

  status(): Pick<VoiceStatus, 'state' | 'received' | 'total'> {
    const state = this.ready() ? 'ready' : this.install ? 'downloading' : 'missing'
    return { state, received: state === 'ready' ? this.total : this.received, total: this.total }
  }

  /** The one-time download, only ever started by the player's yes in the consent panel. Concurrent calls share it. */
  installModel(): Promise<void> {
    if (this.ready()) return Promise.resolve()
    this.install ??= this.download().then(
      () => { this.install = undefined; this.publish() },
      (e: unknown) => { this.install = undefined; this.publish(String((e as Error)?.message ?? e)); throw e }
    )
    return this.install
  }

  private publish(error?: string): void {
    this.opts.publish?.({ ...this.status(), ...(error ? { error } : {}) })
  }

  private async download(): Promise<void> {
    fs.mkdirSync(this.runtimeDir, { recursive: true })
    const { runtime, model } = this.downloads
    this.received = 0
    if (!RUNTIME_FILES.every(f => fs.existsSync(path.join(this.runtimeDir, f)))) {
      const zip = path.join(this.opts.dir, runtime.file)
      await this.fetchVerified(runtime, zip, 0)
      extractZip(fs.readFileSync(zip), RUNTIME_FILES, this.runtimeDir)
      fs.rmSync(zip, { force: true })
    }
    this.received = runtime.size
    if (!fs.existsSync(this.modelFile)) await this.fetchVerified(model, this.modelFile, runtime.size)
    fs.writeFileSync(this.marker, JSON.stringify({ runtime: runtime.sha256, model: model.sha256 }, null, 2))
  }

  /** Download to `<file>.part`, resuming what an earlier try left; verify; then move into place. */
  private async fetchVerified(d: VoiceDownload, file: string, before: number): Promise<void> {
    const part = file + '.part'
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0
    if (have > d.size) { fs.rmSync(part, { force: true }); have = 0 }
    if (have < d.size) {
      const res = await (this.opts.fetch ?? fetch)(d.url, { headers: have ? { Range: `bytes=${have}-` } : {} })
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
      // A server that ignores the range sends the whole file again.
      if (res.status !== 206) have = 0
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' })
      let last = 0
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
          have += chunk.length
          this.received = before + have
          if (Date.now() - last > 250) { last = Date.now(); this.publish() }
        }
      } finally {
        await new Promise<void>(r => out.end(() => r()))
      }
    }
    if (await sha256File(part) !== d.sha256) {
      fs.rmSync(part, { force: true })
      throw new Error('The download was damaged and has been deleted. Try again.')
    }
    fs.renameSync(part, file)
  }

  /** Text for the chat box ('' when no speech was heard). One request at a time. */
  transcribe(pcm: Float32Array): Promise<string> {
    const run = this.queue.then(() => this.transcribeNow(pcm))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async transcribeNow(pcm: Float32Array): Promise<string> {
    if (!this.ready()) throw new Error('The speech model is not installed.')
    if (pcm.length > VOICE_MAX_SAMPLES) pcm = pcm.subarray(0, VOICE_MAX_SAMPLES)
    const level = speechLevel(pcm)
    if (level.silent) return ''
    const port = await this.ensureServer()
    clearTimeout(this.idle)
    try {
      const prompt = voicePrompt(this.opts.names?.() ?? [])
      const texts: string[] = []
      for (const part of splitClip(pcm)) texts.push(await this.infer(port, part, prompt))
      const text = cleanTranscript(texts.join(' '), level.speech)
      if (text) this.opts.unlock('chat-voice')
      return text
    } finally {
      this.armIdle()
    }
  }

  private async infer(port: number, pcm: Float32Array, prompt: string): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(encodeWav(pcm))], { type: 'audio/wav' }), 'speech.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    form.append('prompt', prompt)
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(INFERENCE_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`The speech model failed (HTTP ${res.status}).`)
    const body = await res.json() as { text?: string; error?: string }
    if (body.error) throw new Error(`The speech model failed: ${body.error}`)
    return (body.text ?? '').trim()
  }

  private armIdle(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stopServer(), this.opts.idleMs ?? IDLE_MS)
    this.idle.unref?.()
  }

  /** Start whisper-server on the first use; later calls reuse it until it idles out. */
  private async ensureServer(): Promise<number> {
    if (this.stopped) throw new Error('Genio is closing.')
    if (!this.server) {
      const port = await freePort()
      const exe = path.join(this.runtimeDir, 'whisper-server.exe')
      const args = serverArgs(this.modelFile, port)
      const proc = this.opts.spawnServer
        ? this.opts.spawnServer(exe, args, this.runtimeDir)
        : spawn(exe, args, { cwd: this.runtimeDir, windowsHide: true, stdio: 'ignore' })
      const server: Server = { proc, port, ready: Promise.resolve() }
      server.ready = this.waitUp(server)
      this.server = server
      proc.once('exit', () => { if (this.server === server) this.server = undefined })
      try { if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL) } catch { /* best effort */ }
      server.ready.catch(() => { if (this.server === server) this.stopServer() })
    }
    const s = this.server
    await s.ready
    return s.port
  }

  private async waitUp(s: Server): Promise<void> {
    let exited = false
    s.proc.once('exit', () => { exited = true })
    s.proc.once('error', () => { exited = true })
    const until = Date.now() + START_TIMEOUT_MS
    while (Date.now() < until) {
      if (exited) throw new Error('The speech model could not start.')
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('The speech model did not start in time.')
  }

  /** Whether whisper-server is running (tests and the idle timer). */
  running(): boolean { return !!this.server }

  stopServer(): void {
    clearTimeout(this.idle)
    const s = this.server
    this.server = undefined
    if (s?.proc.pid && s.proc.exitCode === null) killTree(s.proc.pid)
  }

  /** Genio is quitting: stop the server and refuse new work. */
  stop(): void {
    this.stopped = true
    this.stopServer()
  }
}

const services = new WeakMap<AppCtx, VoiceInput>()
export function voiceInput(ctx: AppCtx): VoiceInput {
  let service = services.get(ctx)
  if (!service) {
    service = new VoiceInput({
      dir: path.join(ctx.main.home.data, 'voice'),
      names: () => {
        const s = ctx.snapshot()
        const live = s.tasks.filter(t => !['merged', 'done', 'failed', 'cleaned'].includes(t.state))
        return [...s.projects.map(p => p.name), ...live.map(t => t.title)]
      },
      unlock: id => { try { ctx.stats.unlock(id) } catch { /* stats unavailable */ } },
      publish: status => bus.publish({ type: 'voice-install', ...status })
    })
    services.set(ctx, service)
  }
  return service
}
