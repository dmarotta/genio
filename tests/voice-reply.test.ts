import { describe, expect, it } from 'vitest'
import { ReplyVoice, SPEAK_LIMIT, sentences, speakable, type ReplyVoiceDeps } from '../src/renderer/src/lib/voice'

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
    system: (text) => system.push(text),
    systemStop: () => undefined,
    offer: (s) => { offers.push(s.total); return true }
  }
  return { voice: new ReplyVoice(deps), sources, calls, system, offers, cancels: () => cancels }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 0.01 s of audio at 24 kHz. */
const audio = (): { rate: number; pcm: Float32Array } => ({ rate: 24000, pcm: new Float32Array(240).fill(0.1) })

describe('sentences', () => {
  it('splits a speakable reply into sentences and long runs at a comma', () => {
    expect(sentences('Done. Want me to deploy it? Yes!\nNext line')).toEqual(['Done.', 'Want me to deploy it?', 'Yes!', 'Next line'])
    const long = `${'word '.repeat(50)}then, ${'more '.repeat(30)}end.`
    const parts = sentences(long)
    expect(parts.length).toBe(2)
    expect(parts[0].endsWith('then,')).toBe(true)
    expect(parts.every((p) => p.length <= 300)).toBe(true)
    expect(sentences('code block omitted. ...')).toEqual(['code block omitted.'])
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

  it('never offers after Not now, nor during the download', async () => {
    for (const h of [harness('missing', true), harness('downloading')]) {
      await h.voice.speak('Hello.')
      expect(h.system).toEqual(['Hello.'])
      expect(h.offers).toEqual([])
    }
  })

  it('speaks sentence by sentence with the same cleaning and cut, queuing each buffer right after the last', async () => {
    const h = harness('ready')
    const reply = `I changed \`src/main/voice-output.ts\`. ${'Long sentence here. '.repeat(60)}`
    const speaking = h.voice.speak(reply)
    await tick()
    const expected = sentences(speakable(reply))
    expect(speakable(reply).length).toBeLessThanOrEqual(SPEAK_LIMIT)
    expect(h.calls.map((c) => c.text)).toEqual([expected[0]])
    expect(expected[0]).toBe('I changed path.')
    h.calls[0].resolve(audio())
    await tick()
    // The next sentence is asked for as soon as the first is playing.
    expect(h.calls.length).toBe(2)
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
    const speaking = h.voice.speak('One. Two. Three.')
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
    const speaking = h.voice.speak('One. Two. Three.')
    await tick()
    h.calls[0].resolve(audio())
    await tick()
    h.calls[1].reject(new Error('The natural voice stopped.'))
    await speaking
    expect(h.system).toEqual([])
    // After the queued 0.02 s.
    await tick(60)
    expect(h.system).toEqual(['Two. Three.'])
  })

  it('a newer reply replaces the one being spoken', async () => {
    const h = harness('ready')
    const first = h.voice.speak('Old reply. Still old.')
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
