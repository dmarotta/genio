import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { PLAY_SCROLL_LIMIT, type PlayInput } from '@shared/play'
import { GpuSession, type GpuFallback, type TextureFrame } from './play-gpu'
import type { GpuDevice, TextureApi } from './shared-texture'

export const MAX_FRAME = 4 * 1024 * 1024
/** The 'GA' v1 audio header (com.genio.play's AudioTap): 'G' 'A', version, channels, seq u32, rate u32, frames u16,
 * reserved u16, capture time f64 (Unix ms), all little-endian; interleaved int16 samples follow. */
export const AUDIO_HEADER = 24
export const AUDIO_MAX_FRAMES = 4096
export interface PlayAudio { seq: number; rate: number; channels: number; frames: number; time: number }
/**
 * Where a Play's frames and sound come from, as the playerInstanceStream sink (one frame per renderer credit,
 * latest wins; audio outside the credits) consumes them. PlayStream is Unity's loopback WebSocket; frames arrive as JPEGs
 * or, on the fast path, as shared GPU textures (play-gpu.ts), and the sink takes either.
 */
export interface PlayFrameSource {
  /** A complete frame, newest first: a source keeps at most one, never a queue. */
  onFrame?: (frame: Buffer) => void
  /** A shared-texture frame on the fast path; the sink frees every one it does not deliver. */
  onTexture?: (frame: TextureFrame) => void
  /** A 'GA' v1 audio packet, header included, in arrival order. */
  onAudio?: (packet: Buffer) => void
  onDisconnect?: () => void
  readonly connected: boolean
  input(input: PlayInput): void
  close(): void
}
/** What a fast-path session needs: the texture API, Chromium's GPUs, the size asked of Unity, and whether the game plays. */
export interface PlayStreamGpu {
  api: TextureApi; devices: GpuDevice[]; width: number; height: number
  playing(): boolean
  onFallback(reason: GpuFallback, detail?: string): void
}
/** One authenticated Unity client; bounded latest-frame storage, never a frame queue. Audio packets pass straight through. */
export class PlayStream implements PlayFrameSource {
  private server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
  private ws = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
  private client?: WebSocket
  private token = randomBytes(32).toString('hex')
  private port = 0
  private lastInput = 0
  private pendingScroll = 0
  private lastFrame = 0
  private closed = false
  private gpu?: GpuSession
  private watchdog?: ReturnType<typeof setInterval>
  latest?: Buffer
  onFrame?: (frame: Buffer) => void
  onTexture?: (frame: TextureFrame) => void
  /** Every valid audio packet, header included, in arrival order: never throttled or coalesced. */
  onAudio?: (packet: Buffer) => void
  onDisconnect?: () => void
  get connected(): boolean { return this.client?.readyState === WebSocket.OPEN }
  /** With gpu, Unity is asked for the fast path; JPEG frames are taken either way (its fallback). */
  constructor(gpu?: PlayStreamGpu) {
    if (!gpu) return
    this.gpu = new GpuSession({ ...gpu, send: m => this.text(m), onTexture: f => this.onTexture?.(f), onFallback: gpu.onFallback })
    this.watchdog = setInterval(() => this.gpu?.watch(gpu.playing()), 250); this.watchdog.unref?.()
  }
  /** Still on the fast path: asked for, and no fallback yet. */
  get gpuActive(): boolean { return this.gpu?.active === true }
  /** During a resize: this session's frames stop being live until released (a failed swap). */
  holdTextures(on: boolean): void { this.gpu?.hold(on) }
  async listen(): Promise<{ port: number; token: string }> {
    this.server.on('upgrade', (req, socket, head) => {
      const auth = Buffer.from(req.headers.authorization ?? '')
      const expected = Buffer.from(`Bearer ${this.token}`)
      if (this.closed || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${this.port}` || req.url !== '/play' || this.client || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
      }
      this.ws.handleUpgrade(req, socket, head, client => {
        this.client = client
        this.gpu?.connected()
        client.on('error', () => client.terminate())
        client.on('message', (data, binary) => {
          const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          // Audio first: the frame throttle below would drop most of it. A JPEG starts FF D8, so 'GA' never collides.
          if (binary && frame[0] === 0x47 && frame[1] === 0x41) {
            if (!validateAudio(frame)) { client.close(1003); return }
            this.onAudio?.(frame); return
          }
          // The fast path's ring, frame and end messages; only a session that asked for it may send them.
          if (binary && frame[0] === 0x47) { if (!this.gpu?.message(frame)) client.close(1003); return }
          if (!binary || frame.length < 4 || frame.length > MAX_FRAME || frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) { client.close(1003); return }
          const now = Date.now()
          if (now - this.lastFrame < 25) return
          this.lastFrame = now; this.latest = frame; this.onFrame?.(frame)
        })
        client.once('close', () => { if (this.client === client) { this.client = undefined; this.latest = undefined; this.gpu?.close(); this.onDisconnect?.() } })
      })
    })
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.port = (this.server.address() as { port: number }).port
    return { port: this.port, token: this.token }
  }
  input(input: PlayInput): void {
    validateInput(input)
    if (!this.connected) throw new Error('Unity stream is disconnected')
    const now = Date.now()
    // Continuous state supersedes the preceding packet; release must always get through. Wheel notches are deltas, not
    // state: a superseded packet's scroll rides on the next one so no notch is lost.
    if (input.type !== 'release' && now - this.lastInput < 8) { this.pendingScroll = clampScroll(this.pendingScroll + (input.scroll ?? 0)); return }
    if (this.client!.bufferedAmount > 65536) { this.client!.terminate(); throw new Error('Unity input stalled') }
    this.lastInput = now
    if (input.type === 'state' && this.pendingScroll) input = { ...input, scroll: clampScroll((input.scroll ?? 0) + this.pendingScroll) }
    this.pendingScroll = 0
    this.client!.send(JSON.stringify(input))
  }
  /** A fast-path message to Unity (free a slot, switch to JPEG); dropped when the socket is gone. */
  private text(message: object): void {
    try { if (this.connected) this.client!.send(JSON.stringify(message)) } catch { /* closing */ }
  }
  close(): void {
    this.closed = true; this.onFrame = undefined; this.onTexture = undefined; this.onAudio = undefined; this.latest = undefined
    clearInterval(this.watchdog); this.gpu?.close()
    this.client?.terminate(); this.ws.close(); this.server.close()
  }
}

/** A 'GA' v1 packet's header, or undefined when it is malformed: wrong magic or version, 1–2 channels,
 * 8–192 kHz, 1–AUDIO_MAX_FRAMES frames, a finite capture time, and exactly the samples the header promises. */
export function validateAudio(packet: Buffer): PlayAudio | undefined {
  if (packet.length < AUDIO_HEADER || packet[0] !== 0x47 || packet[1] !== 0x41 || packet[2] !== 1) return undefined
  const channels = packet[3], seq = packet.readUInt32LE(4), rate = packet.readUInt32LE(8), frames = packet.readUInt16LE(12), time = packet.readDoubleLE(16)
  if (channels < 1 || channels > 2 || rate < 8000 || rate > 192_000 || frames < 1 || frames > AUDIO_MAX_FRAMES || !Number.isFinite(time)) return undefined
  if (packet.length !== AUDIO_HEADER + frames * channels * 2) return undefined
  return { seq, rate, channels, frames, time }
}

const clampScroll = (n: number): number => Math.max(-PLAY_SCROLL_LIMIT, Math.min(PLAY_SCROLL_LIMIT, n))
/** Beyond this many notches a scroll value is garbage, not a fast spin: rejected rather than clamped. */
const SCROLL_REJECT = 10_000

/** Throws on a malformed packet; clamps a state's optional scroll to PLAY_SCROLL_LIMIT notches in place. */
export function validateInput(input: PlayInput): void {
  if (!input || !['state', 'release'].includes(input.type)) throw new Error('Invalid stream input')
  if (input.type === 'release') return
  if (!Array.isArray(input.keys) || input.keys.length > 32 || input.keys.some(k => typeof k !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,24}$/.test(k)) ||
    ![input.x, input.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 7 ||
    !Array.isArray(input.axes) || input.axes.length !== 6 || input.axes.some(n => !Number.isFinite(n) || n < -1 || n > 1) ||
    !Number.isInteger(input.gamepadButtons) || input.gamepadButtons < 0 || input.gamepadButtons > 65535 ||
    (input.scroll !== undefined && (typeof input.scroll !== 'number' || !Number.isFinite(input.scroll) || Math.abs(input.scroll) > SCROLL_REJECT))) throw new Error('Invalid stream input state')
  if (input.scroll !== undefined) input.scroll = clampScroll(input.scroll)
}
