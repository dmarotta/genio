import { describe, expect, it } from 'vitest'
import { AUDIO_HEADER, AudioRing, PlayAudioPlayer, TARGET_MS, parseAudioPacket } from '../src/renderer/src/lib/play-audio'

const QUANTUM = 128
const samples = (frames: number, value: number, channels = 2) => new Int16Array(frames * channels).fill(Math.round(value * 32767))
/** A 'GA' v1 packet as Unity's AudioTap sends it. */
function packet(seq: number, frames: number, { rate = 48000, channels = 2, value = 0.5 } = {}): Uint8Array {
  const bytes = new Uint8Array(AUDIO_HEADER + frames * channels * 2), view = new DataView(bytes.buffer)
  bytes.set([0x47, 0x41, 1, channels]); view.setUint32(4, seq, true); view.setUint32(8, rate, true); view.setUint16(12, frames, true); view.setFloat64(16, 1.7e12, true)
  for (let i = 0; i < frames * channels; i++) view.setInt16(AUDIO_HEADER + i * 2, Math.round(value * 32767), true)
  return bytes
}
const pull = (ring: { pull?: AudioRing['pull']; render?: PlayAudioPlayer['render'] }, frames = QUANTUM) => {
  const l = new Float32Array(frames), r = new Float32Array(frames)
  if (ring.pull) ring.pull(l, r); else ring.render!(l, r)
  return [l, r] as const
}

describe('AudioRing', () => {
  it('stays silent until 60 ms is buffered, then fades in over 5 ms', () => {
    const ring = new AudioRing(48000, 48000)
    expect(ring.target).toBe(2880)
    ring.push(samples(2000, 0.5), 2)
    expect([...pull(ring)[0]].every(v => v === 0)).toBe(true)
    expect(ring.playing).toBe(false)
    ring.push(samples(1000, 0.5), 2)
    const [l, r] = pull(ring, 512)
    expect(ring.playing).toBe(true)
    expect(l[0]).toBe(0)
    expect(l[120]).toBeGreaterThan(0.2); expect(l[120]).toBeLessThan(0.3)
    expect(l[300]).toBeCloseTo(0.5, 3); expect(r[300]).toBeCloseTo(0.5, 3)
    // Slightly above the target, so the trim reads a hair faster than 1:1.
    expect(ring.level).toBeLessThan(3000 - 512); expect(ring.level).toBeGreaterThan(3000 - 513)
  })

  it('underruns into silence, then primes to the target again before playing', () => {
    const ring = new AudioRing(48000, 48000)
    ring.push(samples(2880, 0.5), 2)
    for (let i = 0; i < 22; i++) pull(ring) // 2816 frames played
    const [l] = pull(ring)
    expect(l[10]).toBeCloseTo(0.5, 3)
    expect([...l.slice(70)].every(v => v === 0)).toBe(true)
    expect(ring.underruns).toBe(1); expect(ring.playing).toBe(false)
    ring.push(samples(1500, 0.5), 2)
    expect([...pull(ring)[0]].every(v => v === 0)).toBe(true)
    ring.push(samples(1500, 0.5), 2)
    expect(pull(ring, 512)[0][400]).toBeCloseTo(0.5, 3)
    expect(ring.underruns).toBe(1)
  })

  it('on overrun keeps the newest 60 ms and drops the rest', () => {
    const ring = new AudioRing(48000, 48000)
    ring.push(samples(46000, 0.1), 2)
    expect(ring.overruns).toBe(0)
    ring.push(samples(4000, 0.9), 2)
    expect(ring.overruns).toBe(1)
    expect(ring.level).toBe(ring.target)
    const [l] = pull(ring, 1024)
    expect([...l.slice(240)].every(v => Math.abs(v - 0.9) < 1e-3)).toBe(true)
  })

  it('cuts a burst after a stall back to the target instead of keeping the delay', () => {
    const ring = new AudioRing(48000, 48000)
    ring.push(samples(2880, 0.5), 2)
    pull(ring)
    ring.push(samples(9600, 0.5), 2) // 200 ms at once
    for (let t = 0; t < 48000; t += QUANTUM) { ring.push(samples(QUANTUM, 0.5), 2); pull(ring) }
    expect(ring.overruns).toBe(1); expect(ring.underruns).toBe(0)
    expect(ring.levelMs).toBeGreaterThan(40); expect(ring.levelMs).toBeLessThan(80)
  })

  it.each([
    [+200, 48000], [-200, 48000], [+200, 44100], [-200, 44100]
  ])('holds 40-100 ms over 10 minutes with %i ppm drift from %i Hz', (ppm, rate) => {
    const ring = new AudioRing(rate, 48000)
    const block = 1024, perPacket = block / (rate * (1 + ppm / 1e6)), perPull = QUANTUM / 48000
    const data = samples(block, 0.25), l = new Float32Array(QUANTUM), r = new Float32Array(QUANTUM)
    let next = 0, min = Infinity, max = 0
    for (let t = 0; t < 600; t += perPull) {
      while (next <= t) { ring.push(data, 2); next += perPacket }
      ring.pull(l, r)
      if (t > 1) { min = Math.min(min, ring.levelMs); max = Math.max(max, ring.levelMs) }
    }
    expect(ring.underruns).toBe(0); expect(ring.overruns).toBe(0)
    expect(min).toBeGreaterThanOrEqual(40); expect(max).toBeLessThanOrEqual(100)
    expect(l[64]).toBeCloseTo(0.25, 3)
  })

  it('flushes with a 5 ms fade-out, or at once', () => {
    const ring = new AudioRing(48000, 48000)
    ring.push(samples(6000, 0.5), 2)
    pull(ring, 512)
    ring.flush()
    expect(ring.level).toBe(0); expect(ring.playing).toBe(false)
    const [l] = pull(ring, 512)
    expect(l[0]).toBeCloseTo(0.5 * (1 - 1 / 240), 3)
    for (let i = 1; i < 240; i++) expect(l[i]).toBeLessThan(l[i - 1])
    expect(l[239]).toBe(0)
    expect([...l.slice(240)].every(v => v === 0)).toBe(true)
    ring.push(samples(6000, 0.5), 2); pull(ring, 512)
    ring.flush(false)
    expect([...pull(ring)[0]].every(v => v === 0)).toBe(true)
  })
})

describe('PlayAudioPlayer', () => {
  it('reads GA v1 packets, plays mono on both sides, and rejects malformed ones', () => {
    expect(parseAudioPacket(packet(7, 256))).toMatchObject({ seq: 7, rate: 48000, channels: 2, frames: 256, time: 1.7e12 })
    expect(parseAudioPacket(packet(1, 256).subarray(0, 100))).toBeUndefined()
    const bad = packet(1, 4); bad[0] = 0xff
    expect(parseAudioPacket(bad)).toBeUndefined()
    const player = new PlayAudioPlayer(48000)
    expect([...pull(player)[0]].every(v => v === 0)).toBe(true)
    for (let seq = 0; seq < 3; seq++) player.packet(packet(seq, 1024, { channels: 1, value: -0.25 }))
    const [l, r] = pull(player, 512)
    expect(l[400]).toBeCloseTo(-0.25, 3); expect(r[400]).toBeCloseTo(-0.25, 3)
  })

  it('flushes on a new Unity session (seq goes back) and plays the new one after it primes', () => {
    const player = new PlayAudioPlayer(48000)
    for (let seq = 10; seq < 14; seq++) player.packet(packet(seq, 1024))
    pull(player, 512)
    player.packet(packet(16, 1024)) // a gap is dropped audio: it plays on
    expect(player.ring!.playing).toBe(true)
    player.packet(packet(0, 1024, { value: -0.5 }))
    expect(player.ring!.level).toBe(1024)
    const [l] = pull(player, 512)
    expect(l[0]).toBeGreaterThan(0.45); expect(l[300]).toBe(0)
    player.packet(packet(1, 1024, { value: -0.5 })); player.packet(packet(2, 1024, { value: -0.5 }))
    expect(pull(player, 512)[0][400]).toBeCloseTo(-0.5, 3)
    player.packet(packet(3, 1024, { rate: 44100 }))
    expect(player.ring!.rate).toBe(44100)
    expect(player.ring!.target).toBe(Math.round(44100 * TARGET_MS / 1000))
  })
})
