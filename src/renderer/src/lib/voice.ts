/** Text-to-speech for Genio replies ("Read replies aloud"; the voice relay analogue). docs/voice.md */

/** About how much of a reply is read: cut at a sentence end near here. */
export const SPEAK_LIMIT = 600

/** A file or folder path: a drive, ~ or ./ start, a file extension, or at least two separators (not "and/or"). */
const PATH = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])(?:[^\s`'"<>|,;()]*[^\s`'"<>|,;()\].!?:])?|(?:[\w@.-]+[\\/]){2,}[\w@.-]*|(?:[\w@.-]+[\\/])+[\w@-]+\.[A-Za-z][\w]{0,5}\b/g

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

export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const clean = speakable(text)
    if (!clean) return
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

/** Stop Genio talking: the mic button and Esc in the chat box. */
export function stopSpeaking(): void {
  pending++
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* no speech */
  }
}
