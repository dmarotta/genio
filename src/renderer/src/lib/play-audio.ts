/**
 * Play's game sound in the renderer. Unity's AudioTap sends the listener's mix as 'GA' v1 packets (src/main/play-stream.ts);
 * the live view hands them to an AudioWorklet (play-audio-worklet.ts) that plays them from the ring below. Pure: no Web
 * Audio here, so the timing is testable.
 */

/** 'G' 'A', version, channels, seq u32, rate u32, frames u16, reserved u16, capture time f64; interleaved int16 follows. */
export const AUDIO_HEADER = 24
/** The worklet's registered name (play-audio-worklet.ts). */
export const PLAY_AUDIO_PROCESSOR = 'genio-play-audio'
/** The live view acks main's audio in batches of this many packets (main sends at most AUDIO_IN_FLIGHT = 12 ahead). */
export const AUDIO_ACK_EVERY = 10
/** The delay the ring keeps between Unity's mix and the speakers, on top of the transport and the output device. */
export const TARGET_MS = 60
const FADE_MS = 5
/** The drift trim bends the pitch by at most 0.5 % (about 9 cents), in proportion to how far the delay is off target. */
const MAX_TRIM = 0.005
/** How long the measured delay is averaged over, so packet bursts and the pull cadence do not steer the trim. */
const SMOOTH_S = 1

export interface AudioPacket { seq: number; rate: number; channels: number; frames: number; time: number; samples: Int16Array }

/** A 'GA' v1 packet, or undefined when it is malformed (main already validated it; this is the renderer's own guard). */
export function parseAudioPacket(bytes: Uint8Array): AudioPacket | undefined {
  if (bytes.length < AUDIO_HEADER || bytes[0] !== 0x47 || bytes[1] !== 0x41 || bytes[2] !== 1) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const channels = bytes[3], seq = view.getUint32(4, true), rate = view.getUint32(8, true), frames = view.getUint16(12, true), time = view.getFloat64(16, true)
  if (channels < 1 || channels > 2 || rate < 8000 || rate > 192_000 || frames < 1 || bytes.length !== AUDIO_HEADER + frames * channels * 2) return undefined
  return { seq, rate, channels, frames, time, samples: new Int16Array(bytes.slice(AUDIO_HEADER).buffer) }
}

/**
 * A stereo ring between the packets (pushed at Unity's rate) and the worklet (pulled at the output's rate).
 * - Priming: silence until TARGET_MS is buffered, then a 5 ms fade-in. An underrun outputs silence and primes again.
 * - Drift: the two clocks never quite agree, so the read step is trimmed by up to ±0.5 % toward the target delay.
 *   The same interpolating read converts Unity's rate to the output's.
 * - Overrun: a push that would not fit, or a delay that averages above twice the target (a burst after a stall),
 *   drops the oldest audio back to the target.
 * - Flush: a new Unity session (a resize, a reconnect) drops the old audio with a 5 ms fade-out.
 */
export class AudioRing {
  readonly target: number
  readonly capacity: number
  private readonly left: Float32Array
  private readonly right: Float32Array
  private readonly fadeFrames: number
  private readonly fadeL: Float32Array
  private readonly fadeR: Float32Array
  private fadeLength = 0
  private fadeAt = 0
  private fadeIn = 0
  /** Absolute frames: write is whole, read advances by the trimmed step and is fractional. */
  private write = 0
  private read = 0
  private priming = true
  private smooth = 0
  underruns = 0
  overruns = 0

  constructor(readonly rate: number, readonly outRate: number, targetMs = TARGET_MS) {
    this.target = Math.round(rate * targetMs / 1000)
    this.capacity = Math.max(rate, this.target * 4)
    this.left = new Float32Array(this.capacity); this.right = new Float32Array(this.capacity)
    this.fadeFrames = Math.max(1, Math.round(outRate * FADE_MS / 1000))
    this.fadeL = new Float32Array(this.fadeFrames); this.fadeR = new Float32Array(this.fadeFrames)
  }

  /** Buffered source frames: the delay the ring adds. */
  get level(): number { return this.write - this.read }
  get levelMs(): number { return this.level * 1000 / this.rate }
  get playing(): boolean { return !this.priming }

  /** Interleaved int16 frames, mono or stereo. */
  push(samples: Int16Array, channels: number): void {
    const frames = Math.floor(samples.length / channels)
    if (frames < 1) return
    // Room for the frames plus the one the interpolation reads ahead: otherwise keep the newest `target` frames.
    if (this.write + frames - Math.floor(this.read) > this.capacity - 1) {
      this.overruns++
      this.read = Math.max(this.read, this.write + frames - this.target)
      if (!this.priming) this.fadeIn = this.fadeFrames
    }
    for (let i = 0; i < frames; i++) {
      const at = (this.write + i) % this.capacity
      const l = samples[i * channels] / 32768
      this.left[at] = l; this.right[at] = channels > 1 ? samples[i * channels + 1] / 32768 : l
    }
    this.write += frames
  }

  /** One render quantum: fills both outputs completely. */
  pull(outL: Float32Array, outR: Float32Array): void {
    const n = outL.length
    let i = 0
    for (; i < n && this.fadeAt < this.fadeLength; i++, this.fadeAt++) { outL[i] = this.fadeL[this.fadeAt]; outR[i] = this.fadeR[this.fadeAt] }
    if (this.priming) {
      if (this.level < this.target) { this.silence(outL, outR, i); return }
      this.priming = false; this.fadeIn = this.fadeFrames; this.smooth = this.level
    }
    this.smooth += (this.level - this.smooth) * Math.min(1, n / (this.outRate * SMOOTH_S))
    if (this.smooth > this.target * 2) {
      this.overruns++
      this.read = this.write - this.target; this.smooth = this.target; this.fadeIn = this.fadeFrames
    }
    const trim = Math.max(-MAX_TRIM, Math.min(MAX_TRIM, MAX_TRIM * (this.smooth - this.target) / this.target))
    const step = this.rate / this.outRate * (1 + trim)
    for (; i < n; i++) {
      if (this.read + 1 >= this.write) {
        this.underruns++; this.priming = true
        this.silence(outL, outR, i); return
      }
      const gain = this.fadeIn > 0 ? 1 - this.fadeIn-- / this.fadeFrames : 1
      this.frame(outL, outR, i, gain)
      this.read += step
    }
  }

  /** Drops everything buffered and primes again; `fade` plays the next 5 ms of the old audio out, ramped to silence. */
  flush(fade = true): void {
    this.fadeLength = 0; this.fadeAt = 0
    if (fade && !this.priming) {
      const step = this.rate / this.outRate
      for (let k = 0; k < this.fadeFrames && this.read + 1 < this.write; k++, this.read += step) {
        this.frame(this.fadeL, this.fadeR, k, 1 - (k + 1) / this.fadeFrames)
        this.fadeLength = k + 1
      }
    }
    this.read = this.write; this.priming = true; this.fadeIn = 0; this.smooth = 0
  }

  private frame(outL: Float32Array, outR: Float32Array, i: number, gain: number): void {
    const whole = Math.floor(this.read), f = this.read - whole
    const a = whole % this.capacity, b = (whole + 1) % this.capacity
    outL[i] = (this.left[a] + (this.left[b] - this.left[a]) * f) * gain
    outR[i] = (this.right[a] + (this.right[b] - this.right[a]) * f) * gain
  }

  private silence(outL: Float32Array, outR: Float32Array, from: number): void { outL.fill(0, from); outR.fill(0, from) }
}

/**
 * The worklet's state: packets in, render quanta out. A seq that goes back is a new Unity stream session (a resize or a
 * reconnect behind the same port), so the old audio is flushed with a fade; a new rate starts a new ring. A seq gap is
 * audio main dropped for a slow renderer and simply plays on.
 */
export class PlayAudioPlayer {
  ring?: AudioRing
  private seq?: number
  constructor(readonly outRate: number, readonly targetMs = TARGET_MS) {}

  packet(bytes: Uint8Array): void {
    const p = parseAudioPacket(bytes)
    if (!p) return
    if (!this.ring || this.ring.rate !== p.rate) this.ring = new AudioRing(p.rate, this.outRate, this.targetMs)
    else if (this.seq !== undefined && p.seq <= this.seq) this.ring.flush(true)
    this.seq = p.seq
    this.ring.push(p.samples, p.channels)
  }

  render(outL: Float32Array, outR: Float32Array): void {
    if (this.ring) this.ring.pull(outL, outR)
    else { outL.fill(0); outR.fill(0) }
  }

  /** After a mute: whatever was buffered is stale, so it goes without a fade (the output was silent anyway). */
  flush(): void { this.ring?.flush(false); this.seq = undefined }
}
