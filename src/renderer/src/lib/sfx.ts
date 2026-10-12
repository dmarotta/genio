import type { Settings, SfxName } from '@shared/types'

/**
 * Tiny WebAudio synth: every UI sound is generated, no assets.
 * Short, soft, chiptune-ish; master volume follows settings.soundVolume.
 */
let ctx: AudioContext | undefined
let master: GainNode | undefined

function audio(): { ctx: AudioContext; out: GainNode } | undefined {
  try {
    if (!ctx) {
      ctx = new AudioContext()
      master = ctx.createGain()
      const comp = ctx.createDynamicsCompressor()
      master.connect(comp)
      comp.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return { ctx, out: master! }
  } catch {
    return undefined
  }
}

type Wave = OscillatorType

function tone(
  a: { ctx: AudioContext; out: GainNode },
  freq: number,
  start: number,
  dur: number,
  opts: { wave?: Wave; gain?: number; to?: number; attack?: number } = {}
): void {
  const { ctx: c, out } = a
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = opts.wave ?? 'square'
  const t0 = c.currentTime + start
  o.frequency.setValueAtTime(freq, t0)
  if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur)
  const peak = opts.gain ?? 0.18
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack ?? 0.008))
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g)
  g.connect(out)
  o.start(t0)
  o.stop(t0 + dur + 0.02)
}

function noise(a: { ctx: AudioContext; out: GainNode }, start: number, dur: number, gain = 0.08, hp = 2000): void {
  const { ctx: c, out } = a
  const len = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const src = c.createBufferSource()
  src.buffer = buf
  const f = c.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = hp
  const g = c.createGain()
  g.gain.value = gain
  src.connect(f)
  f.connect(g)
  g.connect(out)
  src.start(c.currentTime + start)
}

const patches: Record<SfxName, (a: { ctx: AudioContext; out: GainNode }) => void> = {
  blip: (a) => tone(a, 880, 0, 0.06, { wave: 'square', gain: 0.08 }),
  send: (a) => {
    tone(a, 520, 0, 0.07, { wave: 'triangle', gain: 0.14, to: 1040 })
    noise(a, 0, 0.05, 0.03, 4000)
  },
  spawn: (a) => {
    tone(a, 220, 0, 0.18, { wave: 'sawtooth', gain: 0.09, to: 880 })
    tone(a, 660, 0.12, 0.12, { wave: 'square', gain: 0.08 })
    tone(a, 990, 0.2, 0.14, { wave: 'square', gain: 0.07 })
  },
  ready: (a) => {
    tone(a, 784, 0, 0.1, { wave: 'square', gain: 0.1 })
    tone(a, 1175, 0.09, 0.16, { wave: 'square', gain: 0.1 })
  },
  merge: (a) => {
    const notes = [523, 659, 784, 1047]
    notes.forEach((n, i) => tone(a, n, i * 0.07, 0.14, { wave: 'square', gain: 0.1 }))
    tone(a, 1568, 0.3, 0.3, { wave: 'triangle', gain: 0.08 })
  },
  alert: (a) => {
    tone(a, 440, 0, 0.12, { wave: 'sawtooth', gain: 0.1 })
    tone(a, 330, 0.14, 0.18, { wave: 'sawtooth', gain: 0.1 })
  },
  decision: (a) => {
    tone(a, 660, 0, 0.09, { wave: 'triangle', gain: 0.14 })
    tone(a, 880, 0.1, 0.09, { wave: 'triangle', gain: 0.14 })
    tone(a, 660, 0.2, 0.12, { wave: 'triangle', gain: 0.12 })
  },
  levelup: (a) => {
    const notes = [392, 523, 659, 784, 1047, 1319]
    notes.forEach((n, i) => tone(a, n, i * 0.06, 0.16, { wave: 'square', gain: 0.09 }))
    tone(a, 1568, 0.38, 0.5, { wave: 'triangle', gain: 0.1 })
    noise(a, 0.36, 0.3, 0.025, 6000)
  },
  error: (a) => {
    tone(a, 180, 0, 0.16, { wave: 'square', gain: 0.12, to: 90 })
    noise(a, 0, 0.1, 0.04, 800)
  }
}

let lastAt = 0
export function playSfx(name: SfxName, settings: Settings | null | undefined): void {
  if (!settings || !settings.sound) return
  const now = performance.now()
  if (name === 'blip' && now - lastAt < 60) return
  lastAt = now
  const a = audio()
  if (!a) return
  a.out.gain.value = Math.max(0, Math.min(1, settings.soundVolume ?? 0.5))
  try {
    patches[name](a)
  } catch {
    /* audio unavailable */
  }
}
