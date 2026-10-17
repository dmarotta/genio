/**
 * Voice output: Kokoro, the natural voice for "Read replies aloud" (docs/voice.md).
 * - Install only on the player's yes, a consent separate from the speech model's: the sherpa-onnx Node addon (Apache-2.0,
 *   with espeak-ng, GPL-3.0, built in) and Kokoro en v0.19 (Apache-2.0), from pinned URLs with pinned SHA-256, into
 *   Genio's data folder. Genio never ships either. They only ever load in their own helper process
 *   (resources/kokoro-helper.cjs), which Genio talks to over pipes: text in, PCM out.
 * - The helper starts on the first sentence, with 2 threads at above-normal priority, and keeps the model loaded; it
 *   exits after 10 idle minutes and when Genio quits.
 * - One sentence per request, in order, each with the Kokoro speaker id of the saved reply voice (read per request, so a
 *   new choice applies from the next sentence without restarting the helper). Cancel rejects every pending request at
 *   once; a sentence the helper is already working on is dropped when it arrives.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { VoiceOutputStatus } from '@shared/api'
import type { AppCtx } from './services'
import { bus } from './bus'
import { killTree } from './util'
import { fetchVerified, type VoiceDownload } from './voice-input'
import { speakerId } from '@shared/reply-voice'

const IDLE_MS = 10 * 60_000
const START_TIMEOUT_MS = 60_000
const SENTENCE_TIMEOUT_MS = 60_000
export const VOICE_THREADS = 2
/** The longest text one request takes (the renderer sends one sentence of a reply cut near 600 characters). */
export const SYNTH_MAX_CHARS = 1000

/** Pinned: the addon from the npm registry, the model from the sherpa-onnx tts-models release. */
export const VOICE_OUTPUT_DOWNLOADS: { runtime: VoiceDownload; model: VoiceDownload } = {
  runtime: {
    file: 'sherpa-onnx-win-x64-1.13.8.tgz',
    url: 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.8.tgz',
    sha256: 'fe522f02a5c113c2567a43982107ef41ae517f9a431931e90731e7e4d4341073',
    size: 8_894_875
  },
  model: {
    file: 'kokoro-en-v0_19.tar.bz2',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    sha256: '912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7',
    size: 319_625_534
  }
}
/** What the helper needs from the addon package (the rest is its JavaScript loader and readme). */
export const ADDON_FILES = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll']
/** The model archive's folder, and the files the helper reads from it. */
export const MODEL_DIR = 'kokoro-en-v0_19'
export const MODEL_FILES = ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/phontab']

/** The named regular files of a tar archive, by base name only so nothing can land outside `dir`. */
export function extractTar(tar: Buffer, names: string[], dir: string): void {
  const wanted = new Set(names.map(n => n.toLowerCase()))
  const found = new Set<string>()
  const field = (at: number, length: number): string => tar.toString('utf8', at, at + length).replace(/\0[\s\S]*$/, '')
  for (let at = 0; at + 512 <= tar.length;) {
    if (tar.subarray(at, at + 512).every(b => b === 0)) break
    const size = parseInt(field(at + 124, 12).trim() || '0', 8)
    const type = tar[at + 156]
    const base = path.posix.basename(field(at, 100).replace(/\\/g, '/'))
    const body = at + 512
    // '0' or NUL: a regular file (pax and long-name headers are skipped like any other entry).
    if ((type === 0x30 || type === 0) && wanted.has(base.toLowerCase())) {
      if (body + size > tar.length) throw new Error(`cannot unpack ${base}`)
      fs.writeFileSync(path.join(dir, base), tar.subarray(body, body + size))
      found.add(base.toLowerCase())
    }
    at = body + Math.ceil(size / 512) * 512
  }
  const missing = [...wanted].filter(n => !found.has(n))
  if (missing.length) throw new Error(`the voice runtime is missing ${missing.join(', ')}`)
}

/** Unpack a .tar.bz2 with Windows' own tar (bsdtar refuses absolute paths and `..`). */
function untarBz2(archive: string, dir: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xjf', archive, '-C', dir], { windowsHide: true, stdio: 'ignore' })
    p.once('error', reject)
    p.once('exit', code => (code === 0 ? resolve() : reject(new Error(`The voice could not be unpacked (tar exit ${code}).`))))
  })
}

export interface VoiceAudio { rate: number; pcm: Float32Array }

export interface VoiceOutputOptions {
  /** Genio's own folder for the voice (`<data>/voice/kokoro`). */
  dir: string
  /** resources/kokoro-helper.cjs */
  helperScript: string
  /** The pinned files (tests pass their own). */
  downloads?: typeof VOICE_OUTPUT_DOWNLOADS
  fetch?: typeof fetch
  /** Unpacks the model archive into a folder; the default runs Windows' tar. */
  unpack?: (archive: string, dir: string) => Promise<void>
  /** The addon the helper loads; tests pass a fake one (no model). */
  addonFile?: string
  /** Runs the helper as Node; the default is Genio's own Electron with ELECTRON_RUN_AS_NODE. */
  execPath?: string
  unlock: (id: string) => void
  /** The Kokoro speaker id to speak with (the saved reply voice); 0 when unset. */
  speaker?: () => number
  publish?: (status: Pick<VoiceOutputStatus, 'state' | 'received' | 'total'> & { error?: string }) => void
  idleMs?: number
  sentenceTimeoutMs?: number
}

interface Pending { resolve: (a: VoiceAudio) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface Helper { proc: ChildProcess; ready: Promise<void>; pending: Map<number, Pending> }

export class VoiceOutput {
  private install?: Promise<void>
  private received = 0
  private helper?: Helper
  private idle?: ReturnType<typeof setTimeout>
  private stopped = false
  private nextId = 1
  /** Bumped by cancel(): a request that started before it never answers. */
  private generation = 0

  constructor(private readonly opts: VoiceOutputOptions) {}

  private get runtimeDir(): string { return path.join(this.opts.dir, 'runtime') }
  private get modelDir(): string { return path.join(this.opts.dir, MODEL_DIR) }
  private get downloads(): typeof VOICE_OUTPUT_DOWNLOADS { return this.opts.downloads ?? VOICE_OUTPUT_DOWNLOADS }
  private get marker(): string { return path.join(this.opts.dir, 'ready.json') }
  private get declinedFile(): string { return path.join(this.opts.dir, 'declined') }
  private get total(): number { return this.downloads.runtime.size + this.downloads.model.size }

  /** Installed: the marker names the pinned hashes and every file is in place. */
  ready(): boolean {
    try {
      const m = JSON.parse(fs.readFileSync(this.marker, 'utf8')) as { runtime?: string; model?: string }
      return m.runtime === this.downloads.runtime.sha256 && m.model === this.downloads.model.sha256 &&
        ADDON_FILES.every(f => fs.existsSync(path.join(this.runtimeDir, f))) &&
        MODEL_FILES.every(f => fs.existsSync(path.join(this.modelDir, f)))
    } catch { return false }
  }

  status(): VoiceOutputStatus {
    const state = this.ready() ? 'ready' : this.install ? 'downloading' : 'missing'
    return { state, received: state === 'ready' ? this.total : this.received, total: this.total, declined: fs.existsSync(this.declinedFile) }
  }

  /** The player said Not now: replies keep the Windows voice and the offer stays away until Read replies aloud is turned on again. */
  decline(): void {
    fs.mkdirSync(this.opts.dir, { recursive: true })
    fs.writeFileSync(this.declinedFile, new Date().toISOString())
  }

  resetDecline(): void {
    fs.rmSync(this.declinedFile, { force: true })
  }

  /** The one-time download, only ever started by the player's yes in the consent panel. Concurrent calls share it. */
  installVoice(): Promise<void> {
    if (this.ready()) return Promise.resolve()
    this.install ??= this.download().then(
      () => { this.install = undefined; this.resetDecline(); this.publish() },
      (e: unknown) => { this.install = undefined; this.publish(String((e as Error)?.message ?? e)); throw e }
    )
    return this.install
  }

  private publish(error?: string): void {
    const { state, received, total } = this.status()
    this.opts.publish?.({ state, received, total, ...(error ? { error } : {}) })
  }

  private async download(): Promise<void> {
    fs.mkdirSync(this.runtimeDir, { recursive: true })
    const { runtime, model } = this.downloads
    const fetch = this.opts.fetch
    this.received = 0
    if (!ADDON_FILES.every(f => fs.existsSync(path.join(this.runtimeDir, f)))) {
      const tgz = path.join(this.opts.dir, runtime.file)
      await fetchVerified(runtime, tgz, { fetch, progress: have => { this.received = have; this.publish() } })
      extractTar(gunzipSync(fs.readFileSync(tgz)), ADDON_FILES, this.runtimeDir)
      fs.rmSync(tgz, { force: true })
    }
    this.received = runtime.size
    if (!MODEL_FILES.every(f => fs.existsSync(path.join(this.modelDir, f)))) {
      const archive = path.join(this.opts.dir, model.file)
      if (!fs.existsSync(archive)) await fetchVerified(model, archive, { fetch, progress: have => { this.received = runtime.size + have; this.publish() } })
      const tmp = path.join(this.opts.dir, 'unpack.tmp')
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.mkdirSync(tmp)
      try {
        await (this.opts.unpack ?? untarBz2)(archive, tmp)
        const unpacked = path.join(tmp, MODEL_DIR)
        if (!MODEL_FILES.every(f => fs.existsSync(path.join(unpacked, f)))) throw new Error('The voice archive is missing files.')
        fs.rmSync(this.modelDir, { recursive: true, force: true })
        fs.renameSync(unpacked, this.modelDir)
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      fs.rmSync(archive, { force: true })
    }
    fs.writeFileSync(this.marker, JSON.stringify({ runtime: runtime.sha256, model: model.sha256 }, null, 2))
  }

  /** One sentence as mono PCM. Requests are answered in order; cancel() rejects every pending one at once. */
  async synth(text: string): Promise<VoiceAudio> {
    if (!this.ready()) throw new Error('The natural voice is not installed.')
    const generation = this.generation
    const helper = await this.ensureHelper()
    if (generation !== this.generation) throw new Error('Cancelled.')
    clearTimeout(this.idle)
    try {
      const audio = await this.request(helper, text)
      this.opts.unlock('voice-natural')
      return audio
    } finally {
      this.armIdle()
    }
  }

  private request(h: Helper, text: string): Promise<VoiceAudio> {
    const id = this.nextId++
    return new Promise<VoiceAudio>((resolve, reject) => {
      const timer = setTimeout(() => {
        h.pending.delete(id)
        reject(new Error('The natural voice took too long.'))
      }, this.opts.sentenceTimeoutMs ?? SENTENCE_TIMEOUT_MS)
      h.pending.set(id, { resolve, reject, timer })
      h.proc.stdin?.write(JSON.stringify({ id, text, sid: this.opts.speaker?.() ?? 0 }) + '\n')
    })
  }

  /** Stop speaking: every pending request fails now, and what the helper still sends for them is dropped. */
  cancel(): void {
    this.generation++
    const h = this.helper
    if (!h) return
    for (const [id, p] of h.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('Cancelled.'))
      h.pending.delete(id)
    }
  }

  private armIdle(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.stopHelper(), this.opts.idleMs ?? IDLE_MS)
    this.idle.unref?.()
  }

  /** Start the helper on the first sentence; later sentences reuse it until it idles out. */
  private async ensureHelper(): Promise<Helper> {
    if (this.stopped) throw new Error('Genio is closing.')
    if (!this.helper) {
      const proc = spawn(this.opts.execPath ?? process.execPath,
        [this.opts.helperScript, this.opts.addonFile ?? path.join(this.runtimeDir, 'sherpa-onnx.node'), this.modelDir, String(VOICE_THREADS)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      const helper: Helper = { proc, ready: Promise.resolve(), pending: new Map() }
      helper.ready = this.listen(helper)
      this.helper = helper
      try { if (proc.pid) os.setPriority(proc.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL) } catch { /* best effort */ }
      helper.ready.catch(() => { if (this.helper === helper) this.stopHelper() })
    }
    const h = this.helper
    await h.ready
    return h
  }

  /** Read the helper's frames; resolves on its 'ready' frame. */
  private listen(h: Helper): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error('The natural voice did not start in time.')), START_TIMEOUT_MS)
      let buf: Buffer = Buffer.alloc(0)
      const failAll = (message: string): void => {
        clearTimeout(startup)
        reject(new Error(message))
        for (const [id, p] of h.pending) { clearTimeout(p.timer); p.reject(new Error(message)); h.pending.delete(id) }
      }
      h.proc.stdout?.on('data', (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        for (;;) {
          if (buf.length < 4) return
          const headLength = buf.readUInt32LE(0)
          if (buf.length < 8 + headLength) return
          const payloadLength = buf.readUInt32LE(4 + headLength)
          if (buf.length < 8 + headLength + payloadLength) return
          let head: { type?: string; id?: number; rate?: number; message?: string }
          try { head = JSON.parse(buf.toString('utf8', 4, 4 + headLength)) } catch { head = {} }
          const at = 8 + headLength
          // Copied out so the samples are aligned and the frame buffer can go.
          const pcm = head.type === 'audio' ? new Float32Array(new Uint8Array(buf.subarray(at, at + payloadLength)).buffer) : undefined
          buf = buf.subarray(at + payloadLength)
          if (head.type === 'ready') { clearTimeout(startup); resolve() }
          else if (head.type === 'fatal') failAll(`The natural voice could not start: ${head.message ?? 'unknown error'}`)
          else {
            const p = h.pending.get(head.id ?? -1)
            if (!p) continue
            clearTimeout(p.timer)
            h.pending.delete(head.id!)
            if (pcm && head.rate) p.resolve({ rate: head.rate, pcm })
            else p.reject(new Error(`The natural voice failed: ${head.message ?? 'no audio'}`))
          }
        }
      })
      h.proc.once('error', e => failAll(`The natural voice could not start: ${e.message}`))
      h.proc.once('exit', () => {
        if (this.helper === h) this.helper = undefined
        failAll('The natural voice stopped.')
      })
    })
  }

  /** Whether the helper is running (tests and the idle timer). */
  running(): boolean { return !!this.helper }

  stopHelper(): void {
    clearTimeout(this.idle)
    const h = this.helper
    this.helper = undefined
    if (!h) return
    h.proc.stdin?.end()
    if (h.proc.pid && h.proc.exitCode === null) killTree(h.proc.pid)
  }

  /** Genio is quitting: stop the helper and refuse new work. */
  stop(): void {
    this.stopped = true
    this.cancel()
    this.stopHelper()
  }
}

const services = new WeakMap<AppCtx, VoiceOutput>()
export function voiceOutput(ctx: AppCtx): VoiceOutput {
  let service = services.get(ctx)
  if (!service) {
    const s = new VoiceOutput({
      dir: path.join(ctx.main.home.data, 'voice', 'kokoro'),
      helperScript: path.join(ctx.appRoot, 'resources', 'kokoro-helper.cjs'),
      unlock: id => { try { ctx.stats.unlock(id) } catch { /* stats unavailable */ } },
      speaker: () => speakerId(ctx.settings.get().replyVoice),
      publish: status => bus.publish({ type: 'voice-output-install', ...status })
    })
    // Turning Read replies aloud on again brings back an offer the player put off.
    let on = ctx.settings.get().voice
    bus.onEvent(ev => {
      if (ev.type !== 'settings') return
      if (!on && ev.settings.voice) { try { s.resetDecline() } catch { /* best effort */ } }
      on = ev.settings.voice
    })
    services.set(ctx, s)
    service = s
  }
  return service
}
