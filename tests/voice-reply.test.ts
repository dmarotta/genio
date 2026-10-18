import { describe, expect, it } from 'vitest'
import { ReplyVoice, SPEAK_LIMIT, chunks, pickSystemVoice, sentences, speakable, systemVoices, trimSilence, windowsVoiceLabel, type ReplyVoiceDeps } from '../src/renderer/src/lib/voice'

// The natural voice's player with a fake AudioContext and fake main calls: no audio device, no helper.
class FakeSource {
  buffer: { duration: number } | null = null
  started?: number
  stopped = false
  onended: (() => void) | null = null
  connect(): void {}
  start(at: number): void { this.started = at }
  stop(): void { this.stopped = true }
}

interface Deferred { text: string; resolve: (a: { rate: number; pcm: Float32Array }) => void; reject: (e: Error) => void }

function harness(state: 'missing' | 'downloading' | 'ready', declined = false) {
  const sources: FakeSource[] = []
  const calls: Deferred[] = []
  const system: string[] = []
  const offers: number[] = []
  let cancels = 0
  const ctx = {
    currentTime: 0,
    destination: {},
    createBuffer: (_ch: number, n: number, rate: number) => { const data = new Float32Array(n); return { duration: n / rate, getChannelData: () => data } },
    createBufferSource: () => { const s = new FakeSource(); sources.push(s); return s }
  }
  const deps: ReplyVoiceDeps = {
    status: async () => ({ state, declined, received: 0, total: 328_520_409 }),
    synth: (text) => new Promise((resolve, reject) => calls.push({ text, resolve, reject })),
    cancel: () => { cancels++ },
    context: () => ctx as unknown as ReturnType<ReplyVoiceDeps['context']>,
    system: (text, name) => system.push(name ? `${name}: ${text}` : text),
    systemStop: () => undefined,
    offer: (s) => { offers.push(s.total); return true }
  }
  return { voice: new ReplyVoice(deps), sources, calls, system, offers, cancels: () => cancels }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 0.01 s of audio at 24 kHz. */
const audio = (): { rate: number; pcm: Float32Array } => ({ rate: 24000, pcm: new Float32Array(240).fill(0.1) })

/** Three sentences long enough to be a chunk each (the first chunk takes sentences until it has 30 characters). */
const S1 = 'The first sentence is long enough.'
const S2 = 'The second sentence is long enough.'
const S3 = 'The third sentence is long enough.'

describe('sentences', () => {
  it('splits a speakable reply into sentences and long runs at a comma', () => {
    expect(sentences('Done. Want me to deploy it? Yes!\nNext line')).toEqual(['Done.', 'Want me to deploy it?', 'Yes!', 'Next line'])
    const long = `${'word '.repeat(30)}then, ${'more '.repeat(20)}end.`
    const parts = sentences(long)
    expect(parts.length).toBe(2)
    expect(parts[0].endsWith('then,')).toBe(true)
    expect(parts.every((p) => p.length <= 200)).toBe(true)
    expect(sentences('code block omitted. ...')).toEqual(['code block omitted.'])
  })

  it('never splits at an abbreviation, an initial or a decimal', () => {
    expect(sentences('Use e.g. the 1.5 build. Ask Dr. Lee, i.e. the lead, vs. J. Smith. Done.'))
      .toEqual(['Use e.g. the 1.5 build.', 'Ask Dr. Lee, i.e. the lead, vs. J. Smith.', 'Done.'])
  })
})

describe('chunks', () => {
  it('joins a very short first sentence to the next, so no gap follows it, and keeps the first chunk short', () => {
    expect(chunks('Done. I fixed the crash in the player controller. The jump now checks the ground first.'))
      .toEqual(['Done. I fixed the crash in the player controller.', 'The jump now checks the ground first.'])
    const first = chunks(`Ok. Yes. ${'This sentence makes the first chunk too long to join. '.repeat(3)}`)[0]
    expect(first).toBe('Ok. Yes. This sentence makes the first chunk too long to join.')
    expect(first.length).toBeLessThanOrEqual(80)
  })

  it('grows later chunks as the speech queued ahead grows, up to about 200 characters', () => {
    const text = 'This is one sentence of about forty chars. '.repeat(20)
    const parts = chunks(text)
    expect(parts.join(' ')).toBe(text.trim())
    // 42 characters each: one per chunk while the lead is short, then two, three and four (171, under 200).
    expect(parts.map((p) => p.length)).toEqual([42, 42, 42, 42, 85, 85, 128, 171, 171, 42])
  })

  it('gives a line without an end mark its pause when it is joined', () => {
    expect(chunks('Changes\nFixed the jump\nAdded tests')).toEqual(['Changes. Fixed the jump. Added tests'])
  })
})

describe('trimSilence', () => {
  // At 1000 samples per second: one sample is 1 ms.
  const tone = (ms: number): number[] => new Array(ms).fill(0.3)
  const quiet = (ms: number): number[] => new Array(ms).fill(0.001)

  it('keeps 30 ms before speech and 120 ms after it, and cuts a long silence inside to 150 ms', () => {
    const pcm = new Float32Array([...quiet(120), ...tone(100), ...quiet(270), ...tone(100), ...quiet(155)])
    const out = trimSilence(pcm, 1000)
    expect(out.length).toBe(30 + 100 + 150 + 100 + 120)
    expect(out[29]).toBeCloseTo(0.001)
    expect(out[30]).toBeCloseTo(0.3)
    expect(out[130 + 149]).toBeCloseTo(0.001)
    expect(out[130 + 150]).toBeCloseTo(0.3)
  })

  it('leaves short silences (a comma) and speech untouched, and drops a chunk with no speech', () => {
    const pcm = new Float32Array([...tone(50), ...quiet(80), ...tone(50)])
    expect([...trimSilence(pcm, 1000)]).toEqual([...pcm])
    expect(trimSilence(new Float32Array(quiet(500)), 1000).length).toBe(0)
  })
})

describe('ReplyVoice', () => {
  it('uses the Windows voice while the natural voice is missing and offers it once', async () => {
    const h = harness('missing')
    await h.voice.speak('First reply. With `code`.')
    await h.voice.speak('Second reply.')
    expect(h.system).toEqual(['First reply. With code.', 'Second reply.'])
    expect(h.offers).toEqual([328_520_409])
    expect(h.calls).toEqual([])
  })

  it('speaks with the Windows voice when it is the chosen voice, even with the natural voice installed', async () => {
    const h = harness('ready')
    await h.voice.speak('First reply. With `code`.', 'windows')
    expect(h.system).toEqual(['First reply. With code.'])
    expect(h.calls).toEqual([])
    expect(h.offers).toEqual([])
    const missing = harness('missing')
    await missing.voice.speak('Hello.', 'windows')
    expect(missing.system).toEqual(['Hello.'])
    expect(missing.offers).toEqual([])
    const kokoro = harness('ready')
    void kokoro.voice.speak('Hello.', 'bf_emma')
    await tick()
    expect(kokoro.calls.map((c) => c.text)).toEqual(['Hello.'])
    expect(kokoro.system).toEqual([])
  })

  it('speaks with the chosen Windows voice by name, and a natural voice with the Windows default until it is installed', async () => {
    const h = harness('ready')
    await h.voice.speak('Hello.', 'windows:Microsoft Zira Desktop - English (United States)')
    expect(h.system).toEqual(['Microsoft Zira Desktop - English (United States): Hello.'])
    expect(h.calls).toEqual([])
    const missing = harness('missing', true)
    await missing.voice.speak('Hello.', 'bf_emma')
    expect(missing.system).toEqual(['Hello.'])
    expect(missing.calls).toEqual([])
  })

  it('never offers after Not now, nor during the download', async () => {
    for (const h of [harness('missing', true), harness('downloading')]) {
      await h.voice.speak('Hello.')
      expect(h.system).toEqual(['Hello.'])
      expect(h.offers).toEqual([])
    }
  })

  it('speaks chunk by chunk with the same cleaning and cut, one request ahead, queuing each buffer right after the last', async () => {
    const h = harness('ready')
    const reply = `I changed \`src/main/voice-output.ts\`. ${'Long sentence here. '.repeat(60)}`
    const speaking = h.voice.speak(reply)
    await tick()
    const expected = chunks(speakable(reply))
    expect(speakable(reply).length).toBeLessThanOrEqual(SPEAK_LIMIT)
    expect(expected[0]).toBe('I changed path. Long sentence here.')
    // The second chunk is asked for at once, so the helper makes it while the first one travels and plays.
    expect(h.calls.map((c) => c.text)).toEqual([expected[0], expected[1]])
    h.calls[0].resolve(audio())
    await tick()
    expect(h.calls.length).toBe(3)
    h.calls[1].resolve(audio())
    await tick()
    expect(h.sources.map((s) => s.started)).toEqual([0.02, 0.03])
    for (let i = 2; i < expected.length; i++) { h.calls[i].resolve(audio()); await tick() }
    await speaking
    expect(h.calls.map((c) => c.text)).toEqual(expected)
    expect(h.system).toEqual([])
  })

  it('stop() stops every queued buffer at once and plays nothing that arrives after it', async () => {
    const h = harness('ready')
    const speaking = h.voice.speak(`${S1} ${S2} ${S3}`)
    await tick()
    h.calls[0].resolve(audio())
    await tick()
    h.calls[1].resolve(audio())
    await tick()
    expect(h.sources.length).toBe(2)
    const before = h.cancels()
    h.voice.stop()
    expect(h.sources.every((s) => s.stopped)).toBe(true)
    expect(h.cancels()).toBe(before + 1)
    // Main fails what it still had; even a late answer starts no new buffer.
    h.calls[2].resolve(audio())
    await speaking
    expect(h.sources.length).toBe(2)
    expect(h.system).toEqual([])
  })

  it('falls back to the Windows voice for the rest of the reply when a sentence fails', async () => {
    const h = harness('ready')
    const speaking = h.voice.speak(`${S1} ${S2} ${S3}`)
    await tick()
    h.calls[0].resolve(audio())
    await tick()
    h.calls[1].reject(new Error('The natural voice stopped.'))
    await speaking
    expect(h.system).toEqual([])
    // After the queued 0.02 s.
    await tick(60)
    expect(h.system).toEqual([`${S2} ${S3}`])
  })

  it('queues each chunk without Kokoro\'s extra silence around it', async () => {
    const h = harness('ready')
    const speaking = h.voice.speak('Hello there, this is one chunk.')
    await tick()
    // 0.12 s of silence, 0.5 s of speech, 0.15 s of silence: 0.03 + 0.5 + 0.12 s are queued.
    const pcm = new Float32Array(Math.round(0.77 * 24000))
    pcm.fill(0.2, Math.round(0.12 * 24000), Math.round(0.62 * 24000))
    h.calls[0].resolve({ rate: 24000, pcm })
    await speaking
    expect(h.sources[0].buffer!.duration).toBeCloseTo(0.65, 3)
  })

  it('a newer reply replaces the one being spoken', async () => {
    const h = harness('ready')
    const first = h.voice.speak(`${S1} ${S2}`)
    await tick()
    h.calls[0].resolve(audio())
    await tick()
    const second = h.voice.speak('New reply.')
    expect(h.sources[0].stopped).toBe(true)
    h.calls[1].resolve(audio())
    await tick()
    expect(h.calls.at(-1)!.text).toBe('New reply.')
    h.calls.at(-1)!.resolve(audio())
    await Promise.all([first, second])
    expect(h.sources.length).toBe(2)
    expect(h.sources[1].stopped).toBe(false)
  })
})

describe('Windows voices', () => {
  const voice = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice
  const david = voice('Microsoft David Desktop - English (United States)', 'en-US')
  const zira = voice('Microsoft Zira Desktop - English (United States)', 'en-US')
  const elsa = voice('Microsoft Elsa - Italian (Italy)', 'it-IT')
  const online = voice('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false)

  it('lists only the voices installed on this PC, once each, under plain names', () => {
    expect(systemVoices([elsa, david, online, zira, david]).map((v) => v.name)).toEqual([elsa.name, david.name, zira.name])
    expect([david, elsa].map((v) => windowsVoiceLabel(v.name))).toEqual(['David - English (United States)', 'Elsa - Italian (Italy)'])
  })

  it('speaks with the chosen voice while it is installed, else with the default', () => {
    expect(pickSystemVoice([elsa, david, zira], zira.name)).toBe(zira)
    expect(pickSystemVoice([elsa, david, zira], elsa.name)).toBe(elsa)
    // The saved voice was removed from Windows: the default (an English voice of this PC).
    expect(pickSystemVoice([elsa, david], zira.name)).toBe(david)
    expect(pickSystemVoice([elsa, david])).toBe(david)
  })
})
