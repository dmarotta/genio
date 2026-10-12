/** Text-to-speech for Genio replies (voice relay analogue). */
export function speak(text: string): void {
  try {
    const synth = window.speechSynthesis
    if (!synth) return
    const clean = text
      .replace(/```[\s\S]*?```/g, ' code block omitted. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[*_#>|[\]()]/g, '')
      .slice(0, 900)
    if (!clean.trim()) return
    synth.cancel()
    const u = new SpeechSynthesisUtterance(clean)
    const voices = synth.getVoices()
    const pick = voices.find((v) => /en-(US|GB)/i.test(v.lang) && /natural|neural|aria|guy|jenny/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang))
    if (pick) u.voice = pick
    u.rate = 1.05
    u.pitch = 0.95
    synth.speak(u)
  } catch {
    /* no speech */
  }
}
