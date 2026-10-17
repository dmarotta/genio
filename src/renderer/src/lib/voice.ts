/** Text-to-speech for Genio replies ("Read replies aloud"; the voice relay analogue). docs/voice.md */
import type { GenioApi } from '@shared/api'
import { WINDOWS_VOICE } from '@shared/reply-voice'

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
const PIECE_MAX = 200
/** A dot that does not end a sentence: e.g., i.e., etc., vs., titles and initials (decimals have no space after). */
const NOT_AN_END = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|cf|mr|mrs|ms|dr|st|jr|sr|inc|ltd|fig|[A-Za-z])\.$/i

/** The sentences of a speakable text, in order (long runs split at a comma). */
export function sentences(text: string): string[] {
  const out: string[] = []
  const lines = text.split(/\n+/).flatMap((line) => {
    const parts: string[] = []
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      if (parts.length && NOT_AN_END.test(parts[parts.length - 1])) parts[parts.length - 1] += ` ${s}`
      else parts.push(s)
    }
    return parts
  })
  for (let s of lines) {
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

/** The first chunk takes sentences until it has this many characters (a lone "Done." would leave a gap after it)... */
const FIRST_MIN = 30
/** ...and never grows past this, so speech still starts early. */
const FIRST_MAX = 80
const CHUNK_MAX = 200
/** Seconds Kokoro takes to make one second of speech with the helper's 4 threads (measured; docs/voice.md). */
const MAKE_TIME = 0.75

/**
 * A speakable text as the natural voice's requests: sentences joined into chunks, a short first one and then up to
 * about 200 characters. Fewer joins mean fewer pauses. Each chunk must be made before the speech queued ahead of it
 * runs out: that speech is the first chunk plus what every later one gained (it plays for 1 s and took 0.75 s to make),
 * so chunks grow as the lead does.
 */
export function chunks(text: string): string[] {
  const out: string[] = []
  let current = ''
  /** The speech queued ahead when the next chunk starts being made, in characters. */
  let lead = 0
  for (const s of sentences(text)) {
    const first = out.length === 0
    const max = first ? FIRST_MAX : Math.min(CHUNK_MAX, lead / MAKE_TIME)
    if (current && ((first && current.length >= FIRST_MIN) || current.length + 1 + s.length > max)) {
      lead += first ? current.length : (1 - MAKE_TIME) * current.length
      out.push(current)
      current = s
    } else {
      // A line without an end mark (a list item) still gets its pause.
      current = current ? `${/[.!?,;:]$/.test(current) ? current : `${current}.`} ${s}` : s
    }
  }
  if (current) out.push(current)
  return out
}

/** Silence kept before speech and after it: 0.15 s at every sentence end, inside a chunk or where two chunks meet. */
const LEAD_KEEP = 0.03
const TRAIL_KEEP = 0.12
const SILENT = 0.01

/**
 * The chunk without the extra silence Kokoro makes around each sentence (about 0.12 s before and 0.15 s after, so
 * about 0.27 s at every full stop): edges trimmed, and any longer silence inside cut to the same 0.15 s.
 */
export function trimSilence(pcm: Float32Array, rate: number): Float32Array {
  const lead = Math.round(LEAD_KEEP * rate)
  const trail = Math.round(TRAIL_KEEP * rate)
  const out = new Float32Array(pcm.length)
  let n = 0
  let i = 0
  while (i < pcm.length) {
    if (Math.abs(pcm[i]) >= SILENT) { out[n++] = pcm[i++]; continue }
    let end = i
    while (end < pcm.length && Math.abs(pcm[end]) < SILENT) end++
    const keepAfter = i === 0 ? 0 : trail
    const keepBefore = end === pcm.length ? 0 : lead
    if (end - i <= keepAfter + keepBefore) {
      out.set(pcm.subarray(i, end), n)
      n += end - i
    } else {
      out.set(pcm.subarray(i, i + keepAfter), n)
      n += keepAfter
      out.set(pcm.subarray(end - keepBefore, end), n)
      n += keepBefore
    }
    i = end
  }
  return out.subarray(0, n)
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
 * Speaks replies with the natural voice (Kokoro, through main's helper) when it is installed: one chunk of sentences per
 * request, one request ahead, each played (without Kokoro's extra silence) through an AudioContext queue as soon as it
 * arrives while the next is synthesized. stop() stops every
 * queued buffer at once and fails what main still has pending. The Windows voice takes over whenever it is the
 * chosen reply voice, or the natural voice is missing, declined or fails (for the rest of the reply).
 */
export class ReplyVoice {
  private ticket = 0
  private offered = false
  private ctx?: ReturnType<ReplyVoiceDeps['context']>
  private sources = new Set<AudioBufferSourceNode>()
  /** When the last queued buffer ends, in the context's time. */
  private end = 0

  constructor(private readonly deps: ReplyVoiceDeps) {}

  /** `voice` is the saved reply voice: 'windows' always speaks with the Windows voice (the Kokoro speaker is main's). */
  async speak(text: string, voice?: string): Promise<void> {
    const clean = speakable(text)
    if (!clean) return
    this.stop()
    if (voice === WINDOWS_VOICE) {
      this.deps.system(clean)
      return
    }
    const ticket = this.ticket
    let status: Awaited<ReturnType<ReplyVoiceDeps['status']>> | undefined
    try { status = await this.deps.status() } catch { status = undefined }
    if (ticket !== this.ticket) return
    if (status?.state !== 'ready') {
      if (status?.state === 'missing' && !status.declined && !this.offered) this.offered = this.deps.offer(status)
      this.deps.system(clean)
      return
    }
    const parts = chunks(clean)
    const ask = (i: number): Promise<{ rate: number; pcm: Float32Array }> | undefined => {
      if (i >= parts.length) return undefined
      const request = this.deps.synth(parts[i])
      request.catch(() => undefined)
      return request
    }
    // One request ahead: the helper starts the next chunk as soon as it finishes one, never waiting on the window.
    let next = ask(0)
    for (let i = 0; i < parts.length; i++) {
      const current = next!
      next = ask(i + 1)
      let audio: { rate: number; pcm: Float32Array }
      try {
        audio = await current
      } catch {
        if (ticket !== this.ticket) return
        // The rest in the Windows voice, once what is queued has played; the chunk asked for ahead is not needed.
        try { this.deps.cancel() } catch { /* no main */ }
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
    const pcm = trimSilence(audio.pcm, audio.rate)
    if (!pcm.length) return
    const ctx = (this.ctx ??= this.deps.context())
    void ctx.resume?.().catch(() => undefined)
    const buffer = ctx.createBuffer(1, pcm.length, audio.rate)
    buffer.getChannelData(0).set(pcm)
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

export function speak(text: string, replyVoice?: string): void {
  try {
    void voice().speak(text, replyVoice).catch(() => undefined)
  } catch {
    /* no speech */
  }
}

/** Stop Genio talking: the mic button, Esc in the chat box, and any message the player sends to the chat. */
export function stopSpeaking(): void {
  try {
    voice().stop()
  } catch {
    /* no speech */
  }
}
