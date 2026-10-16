/**
 * Genio's own small audio DSP for the Sound Studio. Node 18+, standard library only:
 * no ffmpeg, no sox, no native module.
 *
 *   WAV in (8/16/24/32-bit PCM, 32/64-bit float, WAVE_FORMAT_EXTENSIBLE) and out (16/24-bit PCM, 32-bit float)
 *   ops: trim, cut, fade, gain, normalize (peak or BS.1770 LUFS), loop (equal-power crossfade),
 *        pitch and rate (varispeed by resampling), mix (layering), channels (mono/stereo), resample
 *   metrics: peak, true peak, RMS, LUFS, clipping, effective bits, silence, loop seam, length
 *   warnings: information for the agent and the player, never a gate
 *   review sheet: a PNG with a metrics header, waveform, log-frequency spectrogram and loop seam
 *
 * Audio is { rate, data: Float32Array[] (one per channel), info } where info carries what the
 * source was (bit depth, effective bits, clipping) through every op, because a quiet or clipped
 * source stays so however it is processed later.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

export const MASTER_RATE = 48000
/** Warn below this many effective bits in the source: regenerate rather than normalize. */
export const QUIET_BITS = 12
const SILENCE_DB = -60
const CLIP = 0.9999
const SEAM_MS = 50

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity)
const fromDb = (d) => 10 ** (d / 20)
const round = (x, k = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** k) / 10 ** k : null)
const frames = (a) => a.data[0]?.length ?? 0

export function makeAudio(rate, data, info = {}) {
  return { rate, data, info: { source_bits: null, eff_bits: null, source_clipped: 0, loop: false, ...info } }
}

// ---------------------------------------------------------------------------------------------
// WAV

const FMT_PCM = 1, FMT_FLOAT = 3, FMT_EXT = 0xfffe

/** Decode a WAV buffer (or file path). Reads what the source was for the quiet and clipping checks. */
export function readWav(input) {
  const buf = typeof input === 'string' ? fs.readFileSync(input) : input
  const tag = buf.toString('ascii', 0, 4)
  if (buf.length < 12 || !['RIFF', 'RF64'].includes(tag) || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file (no RIFF/WAVE header). The Sound Studio reads WAV only: ask FAL for PCM/WAV output.')
  let off = 12, fmt = null, data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), body = off + 8
    let size = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      // Streamed or RF64 files carry 0 or 0xFFFFFFFF here: the data runs to the end of the file.
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body
      data = { at: body, size }
    } else if (id === 'fmt ') {
      let format = buf.readUInt16LE(body)
      if (format === FMT_EXT && size >= 26) format = buf.readUInt16LE(body + 24)
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), align: buf.readUInt16LE(body + 12), bits: buf.readUInt16LE(body + 14) }
    }
    off = body + size + (size & 1)
  }
  if (!fmt || !data) throw new Error(`WAV without ${fmt ? 'a data' : 'an fmt'} chunk.`)
  const { format, channels, rate, bits } = fmt
  const ok = (format === FMT_PCM && [8, 16, 24, 32].includes(bits)) || (format === FMT_FLOAT && [32, 64].includes(bits))
  if (!ok || !channels || !rate) throw new Error(`Unsupported WAV: format ${format}, ${bits}-bit, ${channels} channel(s). Use PCM 8/16/24/32-bit or float 32/64-bit.`)
  const step = bits / 8, align = fmt.align || step * channels
  const n = Math.floor(data.size / align)
  const out = Array.from({ length: channels }, () => new Float32Array(n))
  for (let c = 0; c < channels; c++) {
    const ch = out[c]
    for (let i = 0, p = data.at + c * step; i < n; i++, p += align) {
      if (format === FMT_FLOAT) ch[i] = bits === 32 ? buf.readFloatLE(p) : buf.readDoubleLE(p)
      else if (bits === 16) ch[i] = buf.readInt16LE(p) / 32768
      else if (bits === 24) ch[i] = buf.readIntLE(p, 3) / 8388608
      else if (bits === 32) ch[i] = buf.readInt32LE(p) / 2147483648
      else ch[i] = (buf[p] - 128) / 128
    }
  }
  return makeAudio(rate, out, sourceInfo(out, format === FMT_FLOAT ? quantizedBits(out) : bits))
}

/** Raw little-endian 16-bit PCM (FAL's audio/L16 when it comes without a header). */
export function readPcm16(buf, rate, channels) {
  const n = Math.floor(buf.length / (2 * channels))
  const out = Array.from({ length: channels }, () => new Float32Array(n))
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = buf.readInt16LE((i * channels + c) * 2) / 32768
  return makeAudio(rate, out, sourceInfo(out, 16))
}

/** A float source that only holds 16-bit (or 8-bit) values is as coarse as that integer source. */
function quantizedBits(data) {
  for (const bits of [8, 16]) {
    const q = 2 ** (bits - 1)
    let exact = true
    for (const ch of data) {
      for (let i = 0; i < ch.length && exact; i += 7) { const v = ch[i] * q; if (Math.abs(v - Math.round(v)) > 1e-4) exact = false }
      if (!exact) break
    }
    if (exact) return bits
  }
  return null // genuine float: no quantization concern
}

/** Bit depth, effective bits (how many of them the loudest sample uses) and clipped samples of a source. */
function sourceInfo(data, bits) {
  let peak = 0, clipped = 0
  for (const ch of data) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; if (v >= CLIP) clipped++ }
  const eff = bits == null ? null : peak > 0 ? Math.min(bits, Math.log2(peak * 2 ** (bits - 1)) + 1) : 0
  return { source_bits: bits, eff_bits: eff == null ? null : round(eff, 1), source_clipped: clipped }
}

/** Encode as WAV: 16 or 24-bit PCM (rounded, clamped) or 32-bit float. */
export function encodeWav(audio, { bits = 16 } = {}) {
  if (![16, 24, 32].includes(bits)) throw new Error('bits is 16, 24 or 32 (float)')
  const channels = audio.data.length, n = frames(audio), step = bits / 8, align = step * channels
  const buf = Buffer.alloc(44 + n * align)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * align, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(bits === 32 ? FMT_FLOAT : FMT_PCM, 20)
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(audio.rate, 24); buf.writeUInt32LE(audio.rate * align, 28)
  buf.writeUInt16LE(align, 32); buf.writeUInt16LE(bits, 34); buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * align, 40)
  const max = bits === 16 ? 32767 : 8388607, scale = max + 1
  for (let c = 0; c < channels; c++) {
    const ch = audio.data[c]
    for (let i = 0, p = 44 + c * step; i < n; i++, p += align) {
      if (bits === 32) { buf.writeFloatLE(ch[i], p); continue }
      const v = Math.max(-scale, Math.min(max, Math.round(ch[i] * scale)))
      if (bits === 16) buf.writeInt16LE(v, p)
      else buf.writeIntLE(v, p, 3)
    }
  }
  return buf
}

export function writeWav(file, audio, opts) {
  const tmp = `${file}.${process.pid}.part`
  fs.writeFileSync(tmp, encodeWav(audio, opts))
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------------------------
// Resampling: windowed sinc (Kaiser), table driven

const ZEROS = 16, TABLE_OS = 512
let sincTable = null

function besselI0(x) {
  let sum = 1, term = 1
  for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break }
  return sum
}

function table() {
  if (sincTable) return sincTable
  const beta = 8.6, n = ZEROS * TABLE_OS, t = new Float64Array(n + 2), i0 = besselI0(beta)
  for (let j = 0; j <= n + 1; j++) {
    const x = j / TABLE_OS, r = Math.min(1, x / ZEROS)
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    t[j] = sinc * besselI0(beta * Math.sqrt(1 - r * r)) / i0
  }
  return (sincTable = t)
}

/** Resample one channel by `ratio` = outRate / inRate (band-limited when going down). */
function resampleChannel(x, ratio, outLength) {
  const t = table(), n = x.length
  const out = new Float32Array(outLength)
  const fc = Math.min(1, ratio), half = ZEROS / fc, inv = 1 / ratio
  for (let i = 0; i < outLength; i++) {
    const pos = i * inv, lo = Math.max(0, Math.ceil(pos - half)), hi = Math.min(n - 1, Math.floor(pos + half))
    let acc = 0
    for (let k = lo; k <= hi; k++) {
      const u = Math.abs(pos - k) * fc * TABLE_OS, j = u | 0
      if (j >= ZEROS * TABLE_OS) continue
      acc += x[k] * (t[j] + (t[j + 1] - t[j]) * (u - j))
    }
    out[i] = acc * fc
  }
  return out
}

export function resample(audio, rate) {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw new Error('resample rate must be 8000-192000 Hz')
  if (rate === audio.rate) return audio
  const ratio = rate / audio.rate, len = Math.round(frames(audio) * ratio)
  return { ...audio, rate, data: audio.data.map((ch) => resampleChannel(ch, ratio, len)) }
}

/** Varispeed: play `factor` times faster (higher and shorter above 1). The rate stays. */
function varispeed(audio, factor) {
  if (!(factor >= 0.25 && factor <= 4)) throw new Error('rate factor must be 0.25-4 (pitch: within ±24 semitones)')
  if (factor === 1) return audio
  const ratio = 1 / factor, len = Math.max(1, Math.round(frames(audio) * ratio))
  return { ...audio, data: audio.data.map((ch) => resampleChannel(ch, ratio, len)) }
}

// ---------------------------------------------------------------------------------------------
// Ops

const map = (audio, fn) => ({ ...audio, data: audio.data.map(fn) })
const slice = (audio, a, b) => map(audio, (ch) => ch.slice(a, b))
const ms = (audio, v) => Math.round((Number(v) || 0) * audio.rate / 1000)

/** Per-frame peak over channels. */
function framePeak(audio, i) {
  let p = 0
  for (const ch of audio.data) { const v = Math.abs(ch[i]); if (v > p) p = v }
  return p
}

export function trim(audio, { db: threshold = SILENCE_DB, pad_ms = 5, start = true, end = true } = {}) {
  const n = frames(audio), lim = fromDb(threshold)
  let a = 0, b = n
  if (start) while (a < n && framePeak(audio, a) < lim) a++
  if (end) while (b > a && framePeak(audio, b - 1) < lim) b--
  if (a >= b) return { audio, note: `trim: the whole take is below ${threshold} dB; nothing trimmed` }
  const pad = ms(audio, pad_ms)
  return { audio: slice(audio, Math.max(0, a - pad), Math.min(n, b + pad)) }
}

export function cut(audio, { start_ms = 0, end_ms } = {}) {
  const n = frames(audio), a = Math.max(0, Math.min(n, ms(audio, start_ms))), b = end_ms == null ? n : Math.max(a, Math.min(n, ms(audio, end_ms)))
  if (b - a < 1) throw new Error('cut leaves no audio')
  return slice(audio, a, b)
}

const curve = (t, shape) => (shape === 'equal' ? Math.sin(t * Math.PI / 2) : t)

export function fade(audio, { in_ms = 0, out_ms = 0, shape = 'linear' } = {}) {
  const n = frames(audio), fi = Math.min(n, ms(audio, in_ms)), fo = Math.min(n, ms(audio, out_ms))
  return map(audio, (src) => {
    const ch = src.slice()
    for (let i = 0; i < fi; i++) ch[i] *= curve(i / fi, shape)
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= curve(i / fo, shape)
    return ch
  })
}

export function gain(audio, { db: d = 0 } = {}) {
  const g = fromDb(Number(d))
  return map(audio, (ch) => ch.map((v) => v * g))
}

/** Peak (sample peak, `peak_db`) or BS.1770 loudness (`lufs`, held under a true-peak `ceiling_db`). Never a limiter. */
export function normalize(audio, { peak_db, lufs, ceiling_db = -1 } = {}) {
  if (peak_db == null && lufs == null) throw new Error('normalize needs peak_db or lufs')
  if (peak_db != null) {
    const p = peakOf(audio)
    if (!p) return { audio, note: 'normalize: the take is silent' }
    return { audio: gain(audio, { db: Number(peak_db) - db(p) }) }
  }
  const now = loudness(audio)
  if (now == null) throw new Error('normalize lufs needs at least 400 ms of audio (BS.1770 gates on 400 ms blocks); use peak_db for short takes')
  if (!Number.isFinite(now)) return { audio, note: 'normalize: the take is silent' }
  let want = Number(lufs) - now
  const tp = truePeak(audio), room = Number(ceiling_db) - db(tp)
  let note
  if (want > room) {
    note = `normalize: held at ${round(now + room, 1)} LUFS by the ${ceiling_db} dBTP ceiling (asked ${lufs}); no limiter is applied`
    want = room
  }
  return { audio: gain(audio, { db: want }), note }
}

/** A whole-file loop: the tail crossfades into the head with equal power, so the end runs into the start. */
export function loop(audio, { crossfade_ms = 500 } = {}) {
  const n = frames(audio), x = ms(audio, crossfade_ms)
  if (x < 1 || n < 2 * x + 1) throw new Error(`loop needs a take longer than twice the crossfade (${crossfade_ms} ms)`)
  const data = audio.data.map((ch) => {
    const out = new Float32Array(n - x)
    for (let i = 0; i < x; i++) {
      const t = (i + 0.5) / x
      out[i] = ch[i] * Math.sin(t * Math.PI / 2) + ch[n - x + i] * Math.cos(t * Math.PI / 2)
    }
    out.set(ch.subarray(x, n - x), x)
    return out
  })
  return { ...audio, data, info: { ...audio.info, loop: true } }
}

/** Layer `other` on top at `gain_db`, starting `offset_ms` in; the result is as long as the longer part. */
export function mix(audio, other, { gain_db = 0, offset_ms = 0 } = {}) {
  let b = resample(other, audio.rate)
  b = channels(b, { count: audio.data.length })
  const off = ms(audio, offset_ms), g = fromDb(Number(gain_db))
  if (off < 0) throw new Error('mix offset_ms must be 0 or more')
  const n = Math.max(frames(audio), off + frames(b))
  const data = audio.data.map((ch, c) => {
    const out = new Float32Array(n)
    out.set(ch)
    const src = b.data[c]
    for (let i = 0; i < src.length; i++) out[off + i] += src[i] * g
    return out
  })
  const effs = [audio.info.eff_bits, other.info.eff_bits].filter((v) => v != null)
  return { ...audio, data, info: { ...audio.info, eff_bits: effs.length ? Math.min(...effs) : null, source_clipped: audio.info.source_clipped + other.info.source_clipped } }
}

/** Mono (channel average) or stereo (mono copied to both sides, or the first two channels). */
export function channels(audio, { count = 1 } = {}) {
  const have = audio.data.length
  if (count === have) return audio
  if (count === 1) {
    const out = new Float32Array(frames(audio))
    for (const ch of audio.data) for (let i = 0; i < out.length; i++) out[i] += ch[i] / have
    return { ...audio, data: [out] }
  }
  if (count === 2) return { ...audio, data: have === 1 ? [audio.data[0], audio.data[0].slice()] : audio.data.slice(0, 2) }
  throw new Error('channels is 1 (mono) or 2 (stereo)')
}

/** The op names a recipe may use, with what they take. */
export const OPS = {
  trim: 'db (-60), pad_ms (5), start, end',
  cut: 'start_ms, end_ms',
  fade: 'in_ms, out_ms, shape linear|equal',
  gain: 'db',
  normalize: 'peak_db, or lufs with ceiling_db (-1 dBTP)',
  loop: 'crossfade_ms (500)',
  pitch: 'semitones (varispeed: higher is also shorter)',
  rate: 'factor (varispeed: 1.1 is 10% faster and higher)',
  mix: 'take, gain_db, offset_ms',
  mono: '{}',
  stereo: '{}',
  resample: 'rate (the master stays 48 kHz unless you say otherwise)'
}

/** One op of a recipe, e.g. {"fade": {"out_ms": 30}}. `take(ref)` resolves a mix layer. */
export function applyOp(audio, op, { take } = {}) {
  const keys = Object.keys(op ?? {})
  if (keys.length !== 1 || !OPS[keys[0]]) throw new Error(`Unknown op ${JSON.stringify(op)}. Ops: ${Object.keys(OPS).join(', ')}`)
  const name = keys[0], arg = op[name] ?? {}
  if (typeof arg !== 'object' || Array.isArray(arg)) throw new Error(`Op ${name} takes an object: ${OPS[name]}`)
  switch (name) {
    case 'trim': return trim(audio, arg)
    case 'normalize': return normalize(audio, arg)
    case 'cut': return { audio: cut(audio, arg) }
    case 'fade': return { audio: fade(audio, arg) }
    case 'gain': return { audio: gain(audio, arg) }
    case 'loop': return { audio: loop(audio, arg) }
    case 'pitch': return { audio: varispeed(audio, 2 ** (Number(arg.semitones ?? 0) / 12)) }
    case 'rate': return { audio: varispeed(audio, Number(arg.factor ?? 1)) }
    case 'mono': return { audio: channels(audio, { count: 1 }) }
    case 'stereo': return { audio: channels(audio, { count: 2 }) }
    case 'resample': return { audio: resample(audio, Number(arg.rate)) }
    case 'mix': {
      if (!take) throw new Error('mix needs a take resolver')
      return { audio: mix(audio, take(arg.take), arg) }
    }
  }
}

/** Check a recipe's ops without running them (before any paid call). */
export function checkOps(ops) {
  if (ops == null) return []
  if (!Array.isArray(ops)) throw new Error('ops is a list, like [{"trim": {"db": -60}}, {"fade": {"out_ms": 30}}]')
  for (const op of ops) {
    const keys = Object.keys(op ?? {})
    if (keys.length !== 1 || !OPS[keys[0]]) throw new Error(`Unknown op ${JSON.stringify(op)}. Ops: ${Object.keys(OPS).join(', ')}`)
    const arg = op[keys[0]]
    if (arg != null && (typeof arg !== 'object' || Array.isArray(arg))) throw new Error(`Op ${keys[0]} takes an object: ${OPS[keys[0]]}`)
    if (keys[0] === 'mix' && typeof arg?.take !== 'string') throw new Error('mix names a take: {"mix": {"take": "body-01", "gain_db": -6}}')
  }
  return ops
}

export function applyOps(audio, ops = [], ctx) {
  const notes = []
  for (const op of ops) {
    const r = applyOp(audio, op, ctx)
    audio = r.audio
    if (r.note) notes.push(r.note)
  }
  return { audio, notes }
}

// ---------------------------------------------------------------------------------------------
// Metrics

function peakOf(audio) {
  let p = 0
  for (const ch of audio.data) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > p) p = v }
  return p
}

/**
 * True peak by 4x oversampling (BS.1770 Annex 2 style), linear. Only sample pairs within 12 dB of
 * the peak so far are interpolated: real audio never overshoots between samples by more.
 */
export function truePeak(audio) {
  const t = table(), os = 4
  let p = peakOf(audio)
  for (const ch of audio.data) {
    const n = ch.length
    for (let i = 0; i < n - 1; i++) {
      if (Math.max(Math.abs(ch[i]), Math.abs(ch[i + 1])) < p / 4) continue
      for (let ph = 1; ph < os; ph++) {
        const pos = i + ph / os
        let acc = 0
        for (let k = Math.max(0, i - ZEROS + 1); k <= Math.min(n - 1, i + ZEROS); k++) {
          const u = Math.abs(pos - k) * TABLE_OS, j = u | 0
          if (j < ZEROS * TABLE_OS) acc += ch[k] * (t[j] + (t[j + 1] - t[j]) * (u - j))
        }
        const v = Math.abs(acc)
        if (v > p) p = v
      }
    }
  }
  return p
}

function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float64Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}

/** The two BS.1770 K-weighting stages for any sample rate (libebur128's derivation: the spec's coefficients at 48 kHz). */
function kWeights(fs) {
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196, K = Math.tan(Math.PI * f0 / fs)
    const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / Q + K * K
    return [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
  })()
  const highpass = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan(Math.PI * f0 / fs), a0 = 1 + K / Q + K * K
    return [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
  })()
  return [shelf, highpass]
}

/** Integrated loudness, LUFS (BS.1770-4 gating). null under 400 ms, -Infinity when silent. */
export function loudness(audio) {
  const fs = audio.rate, block = Math.round(0.4 * fs), hop = Math.round(0.1 * fs), n = frames(audio)
  if (n < block) return null
  const [shelf, hp] = kWeights(fs)
  const weighted = audio.data.slice(0, 5).map((ch) => biquad(biquad(ch, shelf), hp))
  // Running sums of squares per channel make each block O(1).
  const cums = weighted.map((y) => {
    const c = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + y[i] * y[i]
    return c
  })
  const G = [1, 1, 1, 1.41, 1.41] // L, R, C, Ls, Rs
  const blocks = []
  for (let s = 0; s + block <= n; s += hop) blocks.push(cums.map((c) => (c[s + block] - c[s]) / block))
  const L = (z) => -0.691 + 10 * Math.log10(z.reduce((a, v, c) => a + G[c] * v, 0))
  const mean = (bs) => bs[0].map((_, c) => bs.reduce((a, b) => a + b[c], 0) / bs.length)
  const abs = blocks.filter((z) => L(z) > -70)
  if (!abs.length) return -Infinity
  const rel = L(mean(abs)) - 10
  const gated = abs.filter((z) => L(z) > rel)
  return L(mean(gated))
}

/** Leading and trailing silence, seconds, in 10 ms windows below -60 dBFS. */
function silence(audio) {
  const n = frames(audio), w = Math.max(1, Math.round(audio.rate / 100)), lim = fromDb(SILENCE_DB) ** 2
  const quiet = (a) => {
    let s = 0
    const b = Math.min(n, a + w)
    for (const ch of audio.data) for (let i = a; i < b; i++) s += ch[i] * ch[i]
    return s / ((b - a) * audio.data.length) < lim
  }
  let lead = 0, tail = 0
  while (lead < n && quiet(lead)) lead += w
  while (tail < n - lead && quiet(Math.max(0, n - tail - w))) tail += w
  return { lead: Math.min(n, lead) / audio.rate, tail: Math.min(n - Math.min(n, lead), tail) / audio.rate }
}

/**
 * The loop seam: how the last sample runs into the first, against the usual step between
 * neighbouring samples around it (about 1 is seamless), and the level change across it.
 */
export function seam(audio) {
  const n = frames(audio), w = Math.min(Math.floor(n / 2), Math.round(audio.rate * SEAM_MS / 1000))
  if (w < 4) return null
  const mono = channels(audio, { count: 1 }).data[0]
  let d2 = 0, count = 0, tailE = 0, headE = 0
  for (let i = n - w + 1; i < n; i++) { d2 += (mono[i] - mono[i - 1]) ** 2; count++ }
  for (let i = 1; i < w; i++) { d2 += (mono[i] - mono[i - 1]) ** 2; count++ }
  for (let i = n - w; i < n; i++) tailE += mono[i] ** 2
  for (let i = 0; i < w; i++) headE += mono[i] ** 2
  const usual = Math.sqrt(d2 / count), join = Math.abs(mono[0] - mono[n - 1])
  const rms = (e) => Math.sqrt(e / w)
  return {
    jump: round(usual > 1e-9 ? join / usual : join > 1e-6 ? 99 : 0, 2),
    step_db: round(rms(tailE) > 1e-9 && rms(headE) > 1e-9 ? Math.abs(db(rms(tailE)) - db(rms(headE))) : 0, 2)
  }
}

/**
 * Everything the agent needs to judge a take without hearing it. `expect_s` is the length asked
 * for (a FAL duration, or a recipe's expect_s); `loop` adds the seam.
 */
export function measure(audio, { loop: isLoop = audio.info.loop, expect_s = null } = {}) {
  const n = frames(audio), peak = peakOf(audio)
  let sum = 0, clipped = 0
  for (const ch of audio.data) for (let i = 0; i < ch.length; i++) { sum += ch[i] * ch[i]; if (Math.abs(ch[i]) >= CLIP) clipped++ }
  const lufs = loudness(audio), quiet = silence(audio)
  let corr = null
  if (audio.data.length === 2 && n) {
    const [l, r] = audio.data
    let lr = 0, ll = 0, rr = 0
    for (let i = 0; i < n; i++) { lr += l[i] * r[i]; ll += l[i] * l[i]; rr += r[i] * r[i] }
    corr = ll && rr ? round(lr / Math.sqrt(ll * rr), 2) : null
  }
  return {
    duration_s: round(n / audio.rate, 3), samples: n, rate: audio.rate, channels: audio.data.length,
    peak_dbfs: peak ? round(db(peak), 1) : null, true_peak_dbtp: peak ? round(db(truePeak(audio)), 1) : null,
    rms_dbfs: sum ? round(db(Math.sqrt(sum / (n * audio.data.length))), 1) : null,
    lufs: lufs == null || !Number.isFinite(lufs) ? null : round(lufs, 1),
    clipped, source_clipped: audio.info.source_clipped ?? 0,
    source_bits: audio.info.source_bits ?? null, eff_bits: audio.info.eff_bits ?? null,
    lead_silence_s: round(quiet.lead, 2), tail_silence_s: round(quiet.tail, 2),
    stereo_corr: corr, loop: Boolean(isLoop), seam: isLoop ? seam(audio) : null,
    expect_s: expect_s ?? null
  }
}

/** Plain-language warnings from metrics. Information only: nothing is ever refused for them. */
export function warningsFor(m) {
  const w = []
  if (m.peak_dbfs == null || m.peak_dbfs < SILENCE_DB) {
    w.push(`silence: the take is silent (peak ${m.peak_dbfs ?? '-inf'} dBFS)`)
    return w
  }
  if (m.eff_bits != null && m.eff_bits < QUIET_BITS) w.push(`too quiet: the source uses about ${m.eff_bits} effective bits (under ${QUIET_BITS}); regenerate it rather than normalize, which would raise its quantization noise`)
  if (m.clipped > 0) w.push(`clipping: ${m.clipped} samples at full scale`)
  else if (m.source_clipped > 0) w.push(`clipping: the source had ${m.source_clipped} clipped samples; turning it down keeps the flattened peaks`)
  const long = (s) => s >= 0.25 && s >= 0.1 * m.duration_s
  if (long(m.tail_silence_s)) w.push(`silence: the last ${m.tail_silence_s} s are silent (cut early?); trim it or regenerate`)
  if (m.lead_silence_s >= 0.1) w.push(`silence: ${m.lead_silence_s} s of silence before the sound starts; trim it`)
  if (m.seam && (m.seam.jump > 3 || m.seam.step_db > 3)) w.push(`seam click: the loop point jumps ${m.seam.jump}x the usual sample step with a ${m.seam.step_db} dB level step; add a loop crossfade`)
  if (m.expect_s && Math.abs(m.duration_s - m.expect_s) > Math.max(0.05, 0.05 * m.expect_s)) w.push(`length drift: ${m.duration_s} s against ${m.expect_s} s expected`)
  return w
}

// ---------------------------------------------------------------------------------------------
// Review sheet (PNG through zlib)

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

// 5x7 glyphs, one row per number, MSB on the left.
const GLYPHS = {
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31], ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], ';': [0, 12, 12, 0, 12, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '/': [0, 1, 2, 4, 8, 16, 0], '%': [24, 25, 2, 4, 8, 19, 3], '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8], '=': [0, 0, 31, 0, 31, 0, 0], _: [0, 0, 0, 0, 0, 0, 31], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4],
  '|': [4, 4, 4, 4, 4, 4, 4], '<': [2, 4, 8, 16, 8, 4, 2], '>': [8, 4, 2, 1, 2, 4, 8], "'": [4, 4, 8, 0, 0, 0, 0], x: [0, 0, 17, 10, 4, 10, 17]
}

class Canvas {
  constructor(w, h, bg) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 3); this.rect(0, 0, w, h, bg) }
  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const p = ((y | 0) * this.w + (x | 0)) * 3
    this.px[p] = r; this.px[p + 1] = g; this.px[p + 2] = b
  }
  rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c) }
  hline(x0, x1, y, c, dash = 0) { for (let i = x0; i < x1; i++) if (!dash || (i >> dash) % 2 === 0) this.set(i, y, c) }
  vline(x, y0, y1, c) { for (let j = Math.min(y0, y1); j <= Math.max(y0, y1); j++) this.set(x, j, c) }
  text(x, y, s, c, scale = 2) {
    for (const ch of String(s)) {
      const g = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?']
      for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] & (16 >> b)) this.rect(x + b * scale, y + r * scale, scale, scale, c)
      x += 6 * scale
      if (x > this.w - 6 * scale) return
    }
  }
}

const COLORS = { bg: [17, 19, 24], panel: [26, 29, 36], grid: [58, 63, 76], text: [220, 224, 232], dim: [140, 146, 160], warn: [255, 176, 64], wave: [96, 200, 255], wave2: [160, 140, 255], guide1: [230, 80, 80], guide6: [200, 160, 60], seam: [255, 90, 90] }

/** A dark-to-bright ramp for the spectrogram (dB from -100 to 0). */
function heat(t) {
  t = Math.max(0, Math.min(1, t))
  const stops = [[0, [10, 10, 20]], [0.3, [70, 20, 110]], [0.55, [190, 50, 80]], [0.8, [250, 150, 40]], [1, [255, 250, 210]]]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, a] = stops[i - 1], [t1, b] = stops[i], u = (t - t0) / (t1 - t0)
      return a.map((v, k) => Math.round(v + (b[k] - v) * u))
    }
  }
  return stops.at(-1)[1]
}

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
      }
    }
  }
}

function drawWave(cv, data, x0, y0, w, h, from = 0, to = data[0].length) {
  const lanes = data.length, lh = Math.floor(h / lanes), n = to - from
  data.forEach((ch, c) => {
    const top = y0 + c * lh, mid = top + lh / 2, amp = lh / 2 - 2
    cv.rect(x0, top, w, lh - 1, COLORS.panel)
    for (const [lvl, col] of [[fromDb(-1), COLORS.guide1], [fromDb(-6), COLORS.guide6]]) {
      cv.hline(x0, x0 + w, Math.round(mid - lvl * amp), col, 2); cv.hline(x0, x0 + w, Math.round(mid + lvl * amp), col, 2)
    }
    cv.hline(x0, x0 + w, Math.round(mid), COLORS.grid)
    for (let x = 0; x < w; x++) {
      const a = from + Math.floor(x * n / w), b = Math.max(a + 1, from + Math.floor((x + 1) * n / w))
      let lo = Infinity, hi = -Infinity
      for (let i = a; i < b && i < to; i++) { if (ch[i] < lo) lo = ch[i]; if (ch[i] > hi) hi = ch[i] }
      if (lo === Infinity) continue
      cv.vline(x0 + x, Math.round(mid - Math.min(1, hi) * amp), Math.round(mid - Math.max(-1, lo) * amp), c ? COLORS.wave2 : COLORS.wave)
    }
  })
}

function drawSpectrogram(cv, audio, x0, y0, w, h) {
  const mono = channels(audio, { count: 1 }).data[0], N = 2048, n = mono.length, nyq = audio.rate / 2, fmin = 40
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)))
  const rows = Array.from({ length: h }, (_, r) => {
    const f0 = fmin * (nyq / fmin) ** (r / h), f1 = fmin * (nyq / fmin) ** ((r + 1) / h)
    const b0 = Math.max(1, Math.floor(f0 * N / audio.rate)), b1 = Math.max(b0, Math.min(N / 2 - 1, Math.floor(f1 * N / audio.rate)))
    return [b0, b1]
  })
  const re = new Float64Array(N), im = new Float64Array(N), norm = N / 4
  for (let x = 0; x < w; x++) {
    const centre = Math.round((x + 0.5) * n / w)
    for (let i = 0; i < N; i++) { const k = centre - N / 2 + i; re[i] = k >= 0 && k < n ? mono[k] * win[i] : 0; im[i] = 0 }
    fft(re, im)
    for (let r = 0; r < h; r++) {
      const [b0, b1] = rows[r]
      let m = 0
      for (let b = b0; b <= b1; b++) { const v = re[b] * re[b] + im[b] * im[b]; if (v > m) m = v }
      cv.set(x0 + x, y0 + h - 1 - r, heat((db(Math.sqrt(m) / norm) + 100) / 100))
    }
  }
  for (const f of [100, 1000, 10000]) {
    if (f >= nyq) continue
    const y = y0 + h - 1 - Math.round(h * Math.log(f / fmin) / Math.log(nyq / fmin))
    cv.hline(x0, x0 + 6, y, COLORS.text)
    cv.text(x0 + 10, y - 3, f >= 1000 ? `${f / 1000}K` : String(f), COLORS.text, 1)
  }
}

/**
 * The review sheet: a metrics header, the waveform per channel with -1 and -6 dB guides, a
 * log-frequency spectrogram (40 Hz to Nyquist) and, for a loop, the last 50 ms joined to the first 50 ms.
 */
export function renderSheet(audio, { title = 'take', metrics = measure(audio), warnings = warningsFor(metrics), width = 1024 } = {}) {
  const head = 66, waveH = 220, specH = 200, seamH = metrics.loop ? 130 : 0, gap = 8
  const height = head + waveH + gap + specH + (seamH ? gap + seamH + 16 : 0) + gap
  const cv = new Canvas(width, height, COLORS.bg)
  const m = metrics, v = (x, unit = '') => (x == null ? '-' : `${x}${unit}`)
  cv.text(8, 6, `${title}   ${v(m.duration_s, ' S')}   ${m.rate} HZ   ${m.channels === 1 ? 'MONO' : `${m.channels} CH`}${m.loop ? '   LOOP' : ''}`, COLORS.text)
  cv.text(8, 26, `PEAK ${v(m.peak_dbfs)}  TP ${v(m.true_peak_dbtp)}  RMS ${v(m.rms_dbfs)}  LUFS ${v(m.lufs)}  BITS ${v(m.eff_bits)}${m.seam ? `  SEAM ${m.seam.jump}/${m.seam.step_db}DB` : ''}`, COLORS.dim)
  cv.text(8, 46, warnings.length ? `! ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1})` : ''}` : 'NO WARNINGS', warnings.length ? COLORS.warn : COLORS.dim)
  let y = head
  drawWave(cv, audio.data, 0, y, width, waveH)
  y += waveH + gap
  drawSpectrogram(cv, audio, 0, y, width, specH)
  y += specH + gap
  if (seamH) {
    const n = frames(audio), w = Math.min(Math.floor(n / 2), Math.round(audio.rate * SEAM_MS / 1000))
    const joined = audio.data.map((ch) => { const out = new Float32Array(2 * w); out.set(ch.subarray(n - w), 0); out.set(ch.subarray(0, w), w); return out })
    cv.text(8, y, `LOOP SEAM: LAST ${SEAM_MS} MS | FIRST ${SEAM_MS} MS`, COLORS.dim, 1)
    drawWave(cv, joined, 0, y + 12, width, seamH)
    cv.vline(width / 2, y + 12, y + 12 + seamH, COLORS.seam)
  }
  return encodePng(width, height, cv.px)
}
