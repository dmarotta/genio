/** The voices that read Genio's replies aloud (Settings → General, docs/voice.md). */

/** The 11 speakers of Kokoro en v0.19 (sherpa-onnx tts-models kokoro-en-v0_19), by speaker id. */
export const NATURAL_VOICES = [
  { id: 'af', sid: 0, label: 'Default' },
  { id: 'af_bella', sid: 1, label: 'Bella' },
  { id: 'af_nicole', sid: 2, label: 'Nicole' },
  { id: 'af_sarah', sid: 3, label: 'Sarah' },
  { id: 'af_sky', sid: 4, label: 'Sky' },
  { id: 'am_adam', sid: 5, label: 'Adam' },
  { id: 'am_michael', sid: 6, label: 'Michael' },
  { id: 'bf_emma', sid: 7, label: 'Emma (British)' },
  { id: 'bf_isabella', sid: 8, label: 'Isabella (British)' },
  { id: 'bm_george', sid: 9, label: 'George (British)' },
  { id: 'bm_lewis', sid: 10, label: 'Lewis (British)' }
] as const

export type NaturalVoiceId = (typeof NATURAL_VOICES)[number]['id']
/** The Windows default voice. */
export const WINDOWS_VOICE = 'windows'
/** One Windows voice by its speech engine name: `windows:<name>`. */
const WINDOWS_PREFIX = 'windows:'
/** A saved reply voice: a Kokoro speaker, the Windows default or one Windows voice by name. */
export type ReplyVoiceId = NaturalVoiceId | typeof WINDOWS_VOICE | `${typeof WINDOWS_PREFIX}${string}`
export const DEFAULT_REPLY_VOICE: ReplyVoiceId = 'af'

export function isNaturalVoice(voice: string | undefined): voice is NaturalVoiceId {
  return NATURAL_VOICES.some((v) => v.id === voice)
}

export function isReplyVoice(voice: string | undefined): voice is ReplyVoiceId {
  return isNaturalVoice(voice) || voice === WINDOWS_VOICE || (!!voice?.startsWith(WINDOWS_PREFIX) && voice.length > WINDOWS_PREFIX.length)
}

/** The choice for a Windows voice name; no name is the Windows default. */
export function windowsVoice(name?: string): ReplyVoiceId {
  return name ? `${WINDOWS_PREFIX}${name}` : WINDOWS_VOICE
}

/** The Windows voice a choice names: '' for the Windows default, undefined when it is a natural voice. */
export function windowsVoiceName(voice: string | undefined): string | undefined {
  if (voice === WINDOWS_VOICE) return ''
  return voice?.startsWith(WINDOWS_PREFIX) ? voice.slice(WINDOWS_PREFIX.length) : undefined
}

/** The Kokoro speaker id of a saved choice: voice 0 for the default, a Windows voice or anything unknown. */
export function speakerId(voice: string | undefined): number {
  return NATURAL_VOICES.find((x) => x.id === voice)?.sid ?? 0
}
