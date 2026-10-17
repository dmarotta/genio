/** Text-to-speech for Genio replies ("Read replies aloud"; the voice relay analogue). docs/voice.md */
import type { GenioApi } from '@shared/api'

/** About how much of a reply is read: cut at a sentence end near here. */
export const SPEAK_LIMIT = 600

/** A file or folder path: a drive, ~ or ./ start, a file extension, or at least two separators (not "and/or"). */
const PATH = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])(?:[^\s`'"<>|,;()]*[^\s`'"<>|,;()\].!?:])?|(?:[\w@.-]+[\\/]){2,}(?:[\w@.-]*[\w@-])?|(?:[\w@.-]+[\\/])+[\w@-]+\.[A-Za-z][\w]{0,5}\b/g

/** A reply as it is spoken: no code, tables, URLs or paths read out character by character, cut at a sentence end. */
export function speakable(text: string, limit = SPEAK_LIMIT): string {
  const clean = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' code block omitted. ')
    .split('\n')
    .filter((line) => !/^\s*\|.*\|\s*$/.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(PATH, 'path')
    .replace(/[*_#>|[\]()]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return cut(clean, limit)
}

/** The text up to the last sentence end before `limit` (or the first one a little after it), else up to the last word. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text
  const ends = [...text.matchAll(/[.!?](?=\s|$)/g)].map((m) => (m.index ?? 0) + 1)
  const before = ends.filter((i) => i <= limit).at(-1)
  if (before && before >= limit / 2) return text.slice(0, before)
  const after = ends.find((i) => i > limit && i <= limit * 1.3)
  if (after) return text.slice(0, after)
  const space = text.lastIndexOf(' ', limit)
  return text.slice(0, space > 0 ? space : limit) + '.'
}

/** A piece longer than this is split at its last comma or semicolon before it. */
const PIECE_MAX = 300

/** The sentences of a speakable text, in order, for the natural voice: one request each, so the first plays early. */
export function sentences(text: string): string[] {
  const out: string[] = []
  for (let s of text.split(/(?<=[.!?])\s+|\n+/)) {
    s = s.trim()
    while (s.length > PIECE_MAX) {
      const at = Math.max(s.lastIndexOf(', ', PIECE_MAX), s.lastIndexOf('; ', PIECE_MAX))
      const end = at > PIECE_MAX / 3 ? at + 1 : Math.max(s.lastIndexOf(' ', PIECE_MAX), 1)
      out.push(s.slice(0, end).trim())
      s = s.slice(end).trim()
    }
    if (/[\p{L}\p{N}]/u.test(s)) out.push(s)
  }
  return out
}

let pending = 0

/** Chromium fills the voice list a moment after start; wait for it once (briefly). */
function voicesReady(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (): void => {
      synth.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(synth.getVoices())
    }
    const timer = setTimeout(done, 1500)
    synth.addEventListener('voiceschanged', done)
  })
}

/** The Windows voice (speechSynthesis): the fallback whenever the natural voice is missing, declined or fails. */
function systemSpeak(clean: string): void {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    synth.cancel()
    const ticket = ++pending
    void voicesReady(synth).then((voices) => {
      // The mic, Esc or a newer reply came first.
      if (ticket !== pending) return
      const u = new SpeechSynthesisUtterance(clean)
      const pick = voices.find((v) => /en-(US|GB)/i.test(v.lang) && /natural|neural|aria|guy|jenny/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang))
      if (pick) u.voice = pick
      u.rate = 1.05
      u.pitch = 0.95
      synth.speak(u)
    })
  } catch {
    /* no speech */
  }
}

function systemStop(): void {
  pending++
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* no speech */
  }
}

/** What the natural voice needs from the page: main's voice calls, an audio context, the Windows voice and the offer. */
export interface ReplyVoiceDeps {
  status(): Promise<{ state: 'missing' | 'downloading' | 'ready'; declined: boolean; received: number; total: number }>
  synth(text: string): Promise<{ rate: number; pcm: Float32Array }>
  cancel(): void
  context(): Pick<AudioContext, 'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource'> & { resume?: () => Promise<void> }
  system(text: string): void
  systemStop(): void
  /** Offer the natural voice download (once per session); true when a chat box showed the offer. */
  offer(status: { received: number; total: number }): boolean
}

/**
 * Speaks replies with the natural voice (Kokoro, through main's helper) when it is installed: one sentence per request,
 * each played through an AudioContext queue as soon as it arrives while the next is synthesized. stop() stops every
 * queued buffer at once and fails what main still has pending. The Windows voice takes over whenever the natural
 * voice is missing, declined or fails (for the rest of the reply).
 */
export class ReplyVoice {
  private ticket = 0
  private offered = false
  private ctx?: ReturnType<ReplyVoiceDeps['context']>
  private sources = new Set<AudioBufferSourceNode>()
  /** When the last queued buffer ends, in the context's time. */
  private end = 0

  constructor(private readonly deps: ReplyVoiceDeps) {}

  async speak(text: string): Promise<void> {
    const clean = speakable(text)
    if (!clean) return
    this.stop()
    const ticket = this.ticket
    let status: Awaited<ReturnType<ReplyVoiceDeps['status']>> | undefined
    try { status = await this.deps.status() } catch { status = undefined }
    if (ticket !== this.ticket) return
    if (status?.state !== 'ready') {
      if (status?.state === 'missing' && !status.declined && !this.offered) this.offered = this.deps.offer(status)
      this.deps.system(clean)
      return
    }
    const parts = sentences(clean)
    for (let i = 0; i < parts.length; i++) {
      let audio: { rate: number; pcm: Float32Array }
      try {
        audio = await this.deps.synth(parts[i])
      } catch {
        if (ticket !== this.ticket) return
        // The rest in the Windows voice, once what is queued has played.
        const rest = parts.slice(i).join(' ')
        const wait = this.ctx ? Math.max(0, this.end - this.ctx.currentTime) : 0
        setTimeout(() => { if (ticket === this.ticket) this.deps.system(rest) }, wait * 1000)
        return
      }
      if (ticket !== this.ticket) return
      this.play(audio)
    }
  }

  private play(audio: { rate: number; pcm: Float32Array }): void {
    if (!audio.pcm.length) return
    const ctx = (this.ctx ??= this.deps.context())
    void ctx.resume?.().catch(() => undefined)
    const buffer = ctx.createBuffer(1, audio.pcm.length, audio.rate)
    buffer.getChannelData(0).set(audio.pcm)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const at = Math.max(ctx.currentTime + 0.02, this.end)
    source.onended = () => this.sources.delete(source)
    source.start(at)
    this.end = at + buffer.duration
    this.sources.add(source)
  }

  /** Stop at once: every queued buffer, main's pending sentences and the Windows voice. */
  stop(): void {
    this.ticket++
    for (const source of this.sources) {
      try { source.stop() } catch { /* already ended */ }
    }
    this.sources.clear()
    this.end = 0
    try { this.deps.cancel() } catch { /* no main */ }
    this.deps.systemStop()
  }
}

type Offer = (status: { received: number; total: number }) => boolean
const offerListeners = new Set<Offer>()

/** A chat box that can show the natural voice offer (MicButton); the first that takes it returns true. */
export function onVoiceOffer(fn: Offer): () => void {
  offerListeners.add(fn)
  return () => offerListeners.delete(fn)
}

/** Main's API without the store (the store imports this file). */
const mainApi = (): GenioApi => (window as unknown as { genio: { api: GenioApi } }).genio.api

let replyVoice: ReplyVoice | undefined
function voice(): ReplyVoice {
  return (replyVoice ??= new ReplyVoice({
    status: () => mainApi().voiceOutputStatus(),
    synth: (text) => mainApi().voiceSynth(text),
    cancel: () => void mainApi().voiceSynthCancel().catch(() => undefined),
    context: () => new AudioContext(),
    system: systemSpeak,
    systemStop,
    offer: (status) => [...offerListeners].some((fn) => fn(status))
  }))
}

export function speak(text: string): void {
  try {
    void voice().speak(text).catch(() => undefined)
  } catch {
    /* no speech */
  }
}

/** Stop Genio talking: the mic button and Esc in the chat box. */
export function stopSpeaking(): void {
  try {
    voice().stop()
  } catch {
    /* no speech */
  }
}
