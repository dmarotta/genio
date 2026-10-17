import { describe, expect, it } from 'vitest'
import { SPEAK_LIMIT, speakable } from '../src/renderer/src/lib/voice'

describe('read replies aloud: what is spoken', () => {
  it('skips code, tables and links', () => {
    const text = speakable('Done.\n```ts\nconst a = 1\n```\n| Unit | State |\n|---|---|\n| a | ok |\nSee https://example.com/x for more.')
    expect(text).toContain('code block omitted')
    expect(text).not.toMatch(/const a|Unit|State|example\.com/)
    expect(text).toContain('See link for more.')
  })
  it('says "path" for file paths but keeps ordinary slashes', () => {
    expect(speakable('I changed `src/main/voice-input.ts` and C:\\Users\\me\\.genio\\data\\voice.')).toBe('I changed path and path.')
    expect(speakable('Edit docs/voice.md and ./scripts/check-help.mjs, and/or ~/notes.')).toBe('Edit path and path, and/or path.')
    expect(speakable('Read/write access stays.')).toBe('Read/write access stays.')
  })
  it('cuts long replies at a sentence end near 600 characters', () => {
    const sentence = 'This sentence is about fifty characters long, ok. '
    const spoken = speakable(sentence.repeat(30))
    expect(spoken.length).toBeLessThanOrEqual(SPEAK_LIMIT)
    expect(spoken.length).toBeGreaterThan(SPEAK_LIMIT / 2)
    expect(spoken.endsWith('ok.')).toBe(true)
    const run = speakable('word '.repeat(300))
    expect(run.length).toBeLessThanOrEqual(SPEAK_LIMIT + 1)
    expect(run.endsWith('word.')).toBe(true)
  })
  it('keeps short replies as they are, minus markdown', () => {
    expect(speakable('**Merged** the fix. _Tests_ pass.')).toBe('Merged the fix. Tests pass.')
  })
})
