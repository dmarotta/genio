import { describe, expect, it } from 'vitest'
import * as dsp from '../resources/unit-skills/genio/skills/sound/scripts/dsp.mjs'
import type { Audio } from '../resources/unit-skills/genio/skills/sound/scripts/dsp.mjs'

const RATE = 48000

/** Generated fixtures: deterministic tones and noise, never recorded files. */
function tone(freq: number, seconds: number, amp = 0.5, { rate = RATE, channels = 1, phase = 0 } = {}): Audio {
  const n = Math.round(seconds * rate)
  return dsp.makeAudio(rate, Array.from({ length: channels }, () => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * freq * i / rate + phase))))
}
function noise(seconds: number, amp = 0.3, seed = 1, rate = RATE): Audio {
  let s = seed
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  return dsp.makeAudio(rate, [Float32Array.from({ length: Math.round(seconds * rate) }, () => amp * next())])
}
/** Through a 16-bit WAV, as FAL delivers it: the source info comes from the file. */
const via16 = (a: Audio): Audio => dsp.readWav(dsp.encodeWav(a, { bits: 16 }))
const concat = (...parts: Audio[]): Audio => dsp.makeAudio(parts[0].rate, [Float32Array.from(parts.flatMap((p) => [...p.data[0]]))])
const silence = (seconds: number): Audio => dsp.makeAudio(RATE, [new Float32Array(Math.round(seconds * RATE))])
const kinds = (w: string[]) => w.map((x) => x.split(':')[0])

describe('Sound Studio DSP: WAV in and out', () => {
  it('round-trips 16-bit, 24-bit and 32-bit float, mono and stereo, at the sample', () => {
    const a = tone(375, 0.25, 0.5, { channels: 2 })
    for (const bits of [16, 24, 32] as const) {
      const back = dsp.readWav(dsp.encodeWav(a, { bits }))
      expect(back.rate).toBe(RATE)
      expect(back.data).toHaveLength(2)
      expect(back.data[0].length).toBe(a.data[0].length)
      const tol = bits === 16 ? 1 / 32768 : bits === 24 ? 1 / 8388608 : 1e-7
      for (let i = 0; i < 2000; i += 37) expect(Math.abs(back.data[1][i] - a.data[1][i])).toBeLessThanOrEqual(tol)
      expect(back.info.source_bits).toBe(bits === 32 ? null : bits)
    }
  })

  it('reads 8-bit, WAVE_FORMAT_EXTENSIBLE, odd chunks and headerless 16-bit PCM', () => {
    const pcm16 = dsp.encodeWav(tone(375, 0.1), { bits: 16 })
    // An 8-bit file made by hand: unsigned samples around 128.
    const n = 480, b8 = Buffer.alloc(44 + n)
    b8.write('RIFF', 0, 'ascii'); b8.writeUInt32LE(36 + n, 4); b8.write('WAVEfmt ', 8, 'ascii'); b8.writeUInt32LE(16, 16)
    b8.writeUInt16LE(1, 20); b8.writeUInt16LE(1, 22); b8.writeUInt32LE(8000, 24); b8.writeUInt32LE(8000, 28); b8.writeUInt16LE(1, 32); b8.writeUInt16LE(8, 34)
    b8.write('data', 36, 'ascii'); b8.writeUInt32LE(n, 40)
    for (let i = 0; i < n; i++) b8[44 + i] = 128 + Math.round(64 * Math.sin(i / 5))
    const eight = dsp.readWav(b8)
    expect(eight).toMatchObject({ rate: 8000, info: { source_bits: 8 } })
    expect(Math.max(...eight.data[0])).toBeCloseTo(0.5, 1)
    // EXTENSIBLE fmt (40 bytes, sub-format PCM) and a LIST chunk with an odd size before data
    const ext = Buffer.alloc(12 + 48 + 10 + pcm16.length - 44 + 8)
    ext.write('RIFF', 0, 'ascii'); ext.write('WAVE', 8, 'ascii')
    ext.write('fmt ', 12, 'ascii'); ext.writeUInt32LE(40, 16); ext.writeUInt16LE(0xfffe, 20); ext.writeUInt16LE(1, 22); ext.writeUInt32LE(RATE, 24)
    ext.writeUInt32LE(RATE * 2, 28); ext.writeUInt16LE(2, 32); ext.writeUInt16LE(16, 34); ext.writeUInt16LE(22, 36); ext.writeUInt16LE(16, 38); ext.writeUInt16LE(1, 44)
    ext.write('LIST', 60, 'ascii'); ext.writeUInt32LE(1, 64)
    ext.write('data', 70, 'ascii'); ext.writeUInt32LE(pcm16.length - 44, 74); pcm16.copy(ext, 78, 44)
    expect(dsp.readWav(ext.subarray(0, 78 + pcm16.length - 44)).data[0]).toEqual(dsp.readWav(pcm16).data[0])
    const raw = dsp.readPcm16(pcm16.subarray(44), RATE, 1)
    expect(raw.data[0]).toEqual(dsp.readWav(pcm16).data[0])
    expect(() => dsp.readWav(Buffer.from('ID3 not a wav at all'))).toThrow(/Not a WAV/)
  })

  it('sees a float file that only holds 16-bit values as 16-bit', () => {
    const coarse = via16(tone(375, 0.1, 136 / 32768))
    const asFloat = dsp.readWav(dsp.encodeWav(coarse, { bits: 32 }))
    expect(asFloat.info.source_bits).toBe(16)
    expect(asFloat.info.eff_bits).toBeCloseTo(8.1, 1)
  })
})

describe('Sound Studio DSP: loudness and peaks', () => {
  it('measures BS.1770 loudness on the reference sine: -3.01 LUFS mono, 0 stereo, any rate', () => {
    expect(dsp.loudness(tone(997, 3, 1))).toBeCloseTo(-3.01, 2)
    expect(dsp.loudness(tone(997, 3, 1, { channels: 2 }))).toBeCloseTo(0, 2)
    expect(dsp.loudness(tone(997, 3, 1, { rate: 44100 }))).toBeCloseTo(-3.01, 1)
    expect(dsp.loudness(tone(997, 0.3))).toBeNull()
    expect(dsp.loudness(silence(1))).toBe(-Infinity)
  })

  it('normalizes to a peak or a loudness, and holds a loudness under the true-peak ceiling without a limiter', () => {
    const quietNoise = noise(2, 0.05)
    const peak = dsp.normalize(quietNoise, { peak_db: -1 })
    expect(dsp.measure(peak.audio).peak_dbfs).toBe(-1)
    const lufs = dsp.normalize(quietNoise, { lufs: -20 })
    expect(lufs.note).toBeUndefined()
    expect(dsp.loudness(lufs.audio)).toBeCloseTo(-20, 1)
    const capped = dsp.normalize(quietNoise, { lufs: -3 })
    expect(capped.note).toMatch(/held at .* LUFS by the -1 dBTP ceiling/)
    expect(dsp.measure(capped.audio).true_peak_dbtp).toBeLessThanOrEqual(-1)
    expect(() => dsp.normalize(tone(440, 0.2), { lufs: -16 })).toThrow(/400 ms/)
  })

  it('finds inter-sample peaks above the sample peak', () => {
    // A quarter-rate tone sampled at 45 degrees: samples reach 0.707 of the waveform's peak.
    const a = tone(RATE / 4, 0.1, 1, { phase: Math.PI / 4 })
    const m = dsp.measure(a)
    expect(m.peak_dbfs).toBeCloseTo(-3, 0)
    expect(m.true_peak_dbtp).toBeGreaterThan(-0.5)
  })
})

describe('Sound Studio DSP: metrics and warnings on generated takes', () => {
  it('a quiet take: about 8 effective bits, regenerate rather than normalize, even after normalizing', () => {
    const quiet = via16(noise(1, 136 / 32768))
    const m = dsp.measure(quiet)
    expect(m.eff_bits).toBeCloseTo(8.1, 1)
    expect(dsp.warningsFor(m).join('\n')).toMatch(/too quiet: .*8\.1 effective bits.*regenerate it rather than normalize/)
    // the quantization is baked in: a normalized copy still says so
    const loud = dsp.normalize(quiet, { peak_db: -1 }).audio
    expect(dsp.measure(loud).peak_dbfs).toBe(-1)
    expect(kinds(dsp.warningsFor(dsp.measure(loud)))).toContain('too quiet')
    // a quiet but fine 24-bit source is not flagged
    expect(kinds(dsp.warningsFor(dsp.measure(dsp.readWav(dsp.encodeWav(noise(1, 0.004), { bits: 24 })))))).not.toContain('too quiet')
  })

  it('a clipped take: flagged, and still flagged as a clipped source after turning it down', () => {
    const hot = tone(220, 1, 1.4)
    for (const ch of hot.data) for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-1, Math.min(1, ch[i]))
    const clipped = via16(hot)
    const m = dsp.measure(clipped)
    expect(m.clipped).toBeGreaterThan(1000)
    expect(dsp.warningsFor(m)[0]).toMatch(/^clipping: \d+ samples at full scale/)
    const down = dsp.gain(clipped, { db: -6 })
    const w = dsp.warningsFor(dsp.measure(down))
    expect(w.join('\n')).toMatch(/clipping: the source had \d+ clipped samples/)
    expect(kinds(dsp.warningsFor(dsp.measure(via16(tone(220, 1, 0.9)))))).not.toContain('clipping')
  })

  it('an early cut: content stops and silence runs to the end; trim fixes it', () => {
    const take = concat(noise(2, 0.3), silence(1.3))
    const m = dsp.measure(take)
    expect(m.tail_silence_s).toBeCloseTo(1.3, 1)
    expect(dsp.warningsFor(m).join('\n')).toMatch(/silence: the last 1\.3 s are silent \(cut early\?\)/)
    const trimmed = dsp.trim(take, { db: -60, pad_ms: 5 }).audio
    expect(dsp.measure(trimmed).duration_s).toBeCloseTo(2.005, 2)
    expect(kinds(dsp.warningsFor(dsp.measure(trimmed)))).not.toContain('silence')
    // silence before the sound and a silent take
    expect(dsp.warningsFor(dsp.measure(concat(silence(0.3), noise(1)))).join('\n')).toMatch(/0\.3 s of silence before the sound starts/)
    expect(dsp.warningsFor(dsp.measure(silence(1)))).toEqual([expect.stringMatching(/^silence: the take is silent/)])
  })

  it('a seam: a naive cut clicks at the loop point; the crossfade loop does not', () => {
    // 4.3 s of 437 Hz ends mid-cycle, and the bed changes level over its length.
    const bed = tone(437, 4.3, 0.5)
    for (let i = 0; i < bed.data[0].length; i++) bed.data[0][i] *= 0.4 + 0.6 * i / bed.data[0].length
    const raw = { ...bed, info: { ...bed.info, loop: true } }
    const naive = dsp.measure(raw)
    expect(naive.seam!.jump).toBeGreaterThan(3)
    expect(naive.seam!.step_db).toBeGreaterThan(3)
    expect(dsp.warningsFor(naive).join('\n')).toMatch(/seam click: the loop point jumps/)
    const looped = dsp.loop(bed, { crossfade_ms: 500 })
    expect(looped.info.loop).toBe(true)
    expect(looped.data[0].length).toBe(bed.data[0].length - 24000)
    const m = dsp.measure(looped)
    expect(m.seam!.jump).toBeLessThan(2)
    expect(m.seam!.step_db).toBeLessThan(1.5)
    expect(kinds(dsp.warningsFor(m))).not.toContain('seam click')
    // one-shots carry no seam
    expect(dsp.measure(bed).seam).toBeNull()
  })

  it('length drift against the length asked for', () => {
    expect(dsp.warningsFor(dsp.measure(noise(1.5), { expect_s: 2 })).join('\n')).toMatch(/length drift: 1\.5 s against 2 s expected/)
    expect(kinds(dsp.warningsFor(dsp.measure(noise(1.98), { expect_s: 2 })))).not.toContain('length drift')
  })
})

describe('Sound Studio DSP: ops', () => {
  it('fades, gains, cuts, resamples, varies pitch and rate, mixes layers and changes channels', () => {
    const a = tone(1000, 1, 0.5)
    const faded = dsp.fade(a, { in_ms: 10, out_ms: 30 })
    expect(faded.data[0][0]).toBe(0)
    expect(Math.abs(faded.data[0].at(-1)!)).toBeLessThan(0.001)
    expect(dsp.measure(dsp.gain(a, { db: -6 })).peak_dbfs).toBeCloseTo(-12, 0)
    expect(dsp.cut(a, { start_ms: 100, end_ms: 350 }).data[0].length).toBe(12000)
    const up = dsp.resample(tone(1000, 1, 0.5, { rate: 44100 }), RATE)
    expect(up.rate).toBe(RATE)
    expect(up.data[0].length).toBe(RATE)
    expect(dsp.measure(up).peak_dbfs).toBeCloseTo(-6, 0)
    // an octave up by varispeed halves the length; a 10% rate-up shortens by 1/1.1
    expect(dsp.applyOp(a, { pitch: { semitones: 12 } }).audio.data[0].length).toBe(24000)
    expect(dsp.applyOp(a, { rate: { factor: 1.1 } }).audio.data[0].length).toBe(Math.round(RATE / 1.1))
    // layering: a tail 0.5 s in makes the result 1.5 s long
    const layered = dsp.mix(a, noise(1, 0.1), { gain_db: -6, offset_ms: 500 })
    expect(layered.data[0].length).toBe(72000)
    expect(layered.data[0][100]).toBe(a.data[0][100])
    const stereo = dsp.channels(a, { count: 2 })
    expect(stereo.data).toHaveLength(2)
    expect(dsp.channels(stereo, { count: 1 }).data[0]).toEqual(a.data[0])
    expect(dsp.applyOps(a, [{ trim: {} }, { fade: { out_ms: 5 } }, { normalize: { peak_db: -1 } }]).notes).toEqual([])
  })

  it('checks ops before anything runs', () => {
    expect(dsp.checkOps([{ trim: { db: -50 } }, { mix: { take: 'body' } }])).toHaveLength(2)
    expect(() => dsp.checkOps([{ reverb: {} }])).toThrow(/Unknown op .*Ops: trim, cut/)
    expect(() => dsp.checkOps([{ trim: {}, fade: {} }])).toThrow(/Unknown op/)
    expect(() => dsp.checkOps([{ mix: {} }])).toThrow(/mix names a take/)
    expect(() => dsp.checkOps({ trim: {} })).toThrow(/ops is a list/)
  })
})

describe('Sound Studio DSP: review sheet', () => {
  const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)]
  it('renders a PNG with header, waveform and spectrogram, plus the seam panel for loops', () => {
    const shot = dsp.renderSheet(tone(440, 0.5), { title: 'laser-01' })
    expect(shot.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const [w, h] = size(shot)
    expect(w).toBe(1024)
    const bed = dsp.loop(noise(3), { crossfade_ms: 300 })
    const [, hl] = size(dsp.renderSheet(bed, { title: 'wind' }))
    expect(hl).toBeGreaterThan(h + 100)
    expect(size(dsp.renderSheet(silence(0.05), { width: 512 }))[0]).toBe(512)
  })
})
