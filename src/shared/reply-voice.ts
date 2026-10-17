/** The voices that read Genio's replies aloud (Settings → General, docs/voice.md). */

/** The 11 speakers of Kokoro en v0.19 (sherpa-onnx tts-models kokoro-en-v0_19), by speaker id, then the Windows voice. */
export const REPLY_VOICES = [
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
  { id: 'bm_lewis', sid: 10, label: 'Lewis (British)' },
  { id: 'windows', label: 'Windows voice' }
] as const

export type ReplyVoiceId = (typeof REPLY_VOICES)[number]['id']
export const REPLY_VOICE_IDS = REPLY_VOICES.map((v) => v.id) as [ReplyVoiceId, ...ReplyVoiceId[]]
export const DEFAULT_REPLY_VOICE: ReplyVoiceId = 'af'
export const WINDOWS_VOICE: ReplyVoiceId = 'windows'

/** The Kokoro speaker id of a saved choice: voice 0 for the default, the Windows voice or anything unknown. */
export function speakerId(voice: string | undefined): number {
  const v = REPLY_VOICES.find((x) => x.id === voice)
  return v && 'sid' in v ? v.sid : 0
}
