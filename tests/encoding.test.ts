import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { completeLines, decodeBytes, decodeCp1252, hasMojibake, lineStart, mojibake, repairMojibake, TextStream, trimZeroWidth, utf8End } from '../src/shared/encoding'
import { cleanChatMessage } from '../src/shared/chat'
import type { ChatMessage } from '../src/shared/types'
import { readJsonl, readText, runShell } from '../src/main/util'

const SAMPLE = 'It’s “done” – café, naïve, über, señor · © 2026 — 50°C … → ✅ \u{1F389} \u{1F468}‍\u{1F469}‍\u{1F467} 中文 한국어 привет αβγ €5'
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')
const utf16le = (s: string): Buffer => Buffer.from(s, 'utf16le')

/** A deterministic random source, so a failing split can be replayed. */
function rng(seed: number): () => number {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

describe('TextStream: characters split between chunks', () => {
  it('decodes a multi-byte character split at every byte offset', () => {
    const bytes = utf8(SAMPLE)
    for (let k = 0; k <= bytes.length; k++) {
      const s = new TextStream()
      expect(s.write(bytes.subarray(0, k)) + s.write(bytes.subarray(k)) + s.end(), `split at ${k}`).toBe(SAMPLE)
    }
  })

  it('decodes every two-way split of a UTF-16LE line, and of an ANSI line', () => {
    for (const [bytes, text] of [[utf16le('note: café 中文 \u{1F389}\r\n'), 'note: café 中文 \u{1F389}\r\n'], [Buffer.from('note: café ½\r\n', 'latin1'), 'note: café ½\r\n']] as const) {
      for (let k = 0; k <= bytes.length; k++) {
        const s = new TextStream()
        expect(s.write(bytes.subarray(0, k)) + s.write(bytes.subarray(k)) + s.end(), `split at ${k}`).toBe(text)
      }
    }
  })

  it('shows an unfinished UTF-8 line at once, holding back only a split character', () => {
    const s = new TextStream()
    const bytes = utf8('progress ✅')
    expect(s.write(bytes.subarray(0, bytes.length - 1))).toBe('progress ')
    expect(s.write(bytes.subarray(bytes.length - 1))).toBe('✅')
  })

  it('streams a long emoji and CJK message in random chunk sizes exactly', () => {
    const message = Array.from({ length: 400 }, (_, i) => `${i} ${SAMPLE}\n`).join('')
    const bytes = utf8(message)
    for (let seed = 1; seed <= 25; seed++) {
      const next = rng(seed)
      const s = new TextStream()
      let out = ''
      for (let at = 0; at < bytes.length;) {
        const size = 1 + Math.floor(next() * 37)
        out += s.write(bytes.subarray(at, at + size))
        at += size
      }
      expect(out + s.end()).toBe(message)
    }
  })

  it('streams a child process that writes in random chunk sizes through runShell exactly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-encoding-'))
    try {
      const message = Array.from({ length: 60 }, (_, i) => `${i} ${SAMPLE}\n`).join('') + SAMPLE
      const script = path.join(dir, 'chunks.js')
      fs.writeFileSync(script, [
        `const bytes = Buffer.from(${JSON.stringify(message)}, 'utf8')`,
        'let seed = 7, at = 0',
        'const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 23) + 1',
        'const tick = () => { if (at >= bytes.length) return; const n = next(); process.stdout.write(bytes.subarray(at, at + n)); at += n; setTimeout(tick, 1) }',
        'tick()'
      ].join('\n'))
      const seen: string[] = []
      const line = `"${process.execPath}" "${script}"`
      // cmd /s strips one outer pair of quotes
      const r = await runShell(process.platform === 'win32' ? `"${line}"` : line, { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, onData: (d) => seen.push(d), timeoutMs: 60_000 })
      expect(r.code).toBe(0)
      expect(r.stdout).toBe(message)
      expect(seen.join('')).toBe(message)
      expect(r.stdout).not.toContain('�')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('decodeBytes: whatever wrote the file', () => {
  it('strips a UTF-8 BOM and BOMs left mid-file by concatenated writes', () => {
    expect(decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('a’\n'), Buffer.from([0xef, 0xbb, 0xbf]), utf8('b\n')]))).toBe('a’\nb\n')
  })

  it('reads UTF-16LE with a BOM, without one, and UTF-16BE with a BOM', () => {
    const text = 'working: café — 中文 \u{1F389}\r\ndone: ok\r\n'
    expect(decodeBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(text)]))).toBe(text)
    expect(decodeBytes(utf16le(text))).toBe(text)
    expect(decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16le(text).swap16()]))).toBe(text)
  })

  it('reads an append-only log that mixes UTF-8, PowerShell UTF-16 and ANSI lines', () => {
    const bytes = Buffer.concat([
      utf8('working: Genio’s own line\n'),
      Buffer.from([0xff, 0xfe]), utf16le('note: 中文 from Out-File\r\n'), utf16le('note: second wide ✅\r\n'),
      utf8('note: back to UTF-8 …\n'),
      Buffer.from('note: ANSI café ', 'latin1'), Buffer.from([0x96]), Buffer.from(' Add-Content\r\n', 'latin1'),
      utf16le('note: no BOM this time\r\n')
    ])
    expect(decodeBytes(bytes).split('\n')).toEqual([
      'working: Genio’s own line',
      'note: 中文 from Out-File\r', 'note: second wide ✅\r',
      'note: back to UTF-8 …',
      'note: ANSI café – Add-Content\r',
      'note: no BOM this time\r',
      ''
    ])
  })

  it('falls back to Windows-1252 only for bytes that are not valid UTF-8', () => {
    expect(decodeBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94, 0x0a]))).toBe('café “q”\n')
    expect(decodeBytes(utf8('café “q”\n'))).toBe('café “q”\n')
    expect(decodeCp1252(Buffer.from([0x80, 0x81, 0x9d, 0xff]))).toBe('€\u0081\u009dÿ')
  })

  it('readText and readJsonl decode PowerShell files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-encoding-'))
    try {
      const f = path.join(dir, 'wakes.jsonl')
      fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le(`${JSON.stringify({ text: SAMPLE })}\r\n`)]))
      fs.appendFileSync(f, `${JSON.stringify({ text: 'utf8 ✅' })}\n`)
      expect(readJsonl<{ text: string }>(f).map((r) => r.text)).toEqual([SAMPLE, 'utf8 ✅'])
      fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(SAMPLE)]))
      expect(readText(f)).toBe(SAMPLE)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('byte offsets never land inside a character', () => {
  it('completeLines counts the NUL of a UTF-16 newline and stops before an unfinished line', () => {
    expect(completeLines(utf8('a\nb'))).toBe(2)
    expect(completeLines(utf16le('a\nb'))).toBe(4)
    expect(completeLines(utf8('no newline'))).toBe(0)
  })

  it('tailing a growing UTF-16 log in pieces loses and garbles nothing', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `note: ${i} 中文 \u{1F389} café\r\n`)
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), ...lines.map(utf16le)])
    const next = rng(3)
    let offset = 0
    let written = 0
    let out = ''
    while (written < bytes.length) {
      written = Math.min(bytes.length, written + 1 + Math.floor(next() * 40))
      const fresh = bytes.subarray(offset, written)
      const n = completeLines(fresh)
      out += decodeBytes(fresh.subarray(0, n))
      offset += n
    }
    expect(out).toBe(lines.join(''))
  })

  it('utf8End keeps back a sequence a byte cap cut short; lineStart skips a partial first line', () => {
    const bytes = utf8('ab中')
    for (let cap = 0; cap <= bytes.length; cap++) expect(Buffer.from(bytes.subarray(0, utf8End(bytes, cap))).toString('utf8')).not.toContain('�')
    expect(utf8End(bytes, 3)).toBe(2)
    expect(utf8End(bytes, 5)).toBe(5)
    // the last bytes of a log, read from an offset that fell inside a character
    const tail = Buffer.concat([utf8('中文').subarray(1), utf8('\nwhole ✅\n')])
    expect(decodeBytes(tail.subarray(lineStart(tail)))).toBe('whole ✅\n')
  })
})

describe('repairMojibake: UTF-8 that was read as Windows-1252', () => {
  it('repairs every character of a mixed sample, once or twice garbled', () => {
    expect(hasMojibake(mojibake(SAMPLE))).toBe(true)
    expect(repairMojibake(mojibake(SAMPLE))).toBe(SAMPLE)
    expect(repairMojibake(mojibake(mojibake(SAMPLE)))).toBe(SAMPLE)
  })

  it.each([['’'], ['“'], ['”'], ['–'], ['—'], ['…'], ['·'], ['é'], [' '], ['‌'], ['​'], ['•'], ['→'], ['✅'], ['\u{1F680}'], ['﻿']])('repairs %j', (ch) => {
    expect(hasMojibake(mojibake(`a${ch}b`))).toBe(true)
    expect(repairMojibake(mojibake(`a${ch}b`))).toBe(`a${ch}b`)
  })

  it.each([
    'Straße“', 'CAFÉ…', 'café…', 'Größe', '«quote»', 'NÃO', 'Äpfel', 'Æsir Øre',
    'à côté', '€5 £5', '½ ¼', 'Âge', 'plain ASCII', SAMPLE
  ])('leaves real text alone: %s', (text) => {
    expect(hasMojibake(text)).toBe(false)
    expect(repairMojibake(text)).toBe(text)
  })

  it('trims stray zero-width characters at the ends only', () => {
    expect(trimZeroWidth('​hi‌ there‌\n')).toBe('hi‌ there\n')
    expect(trimZeroWidth('﻿‍')).toBe('')
  })
})

describe('chat display repair', () => {
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: 'm', wksp: 'genio', role: 'genio', text: '', ts: '2026-10-16T00:00:00.000Z', ...over })

  it('repairs the screenshot: a sentence ending in a garbled zero-width non-joiner', () => {
    const garbled = `I'll verify that diagnosis before acting on it.${mojibake('‌')}`
    expect(cleanChatMessage(msg({ text: garbled })).text).toBe("I'll verify that diagnosis before acting on it.")
    expect(cleanChatMessage(msg({ role: 'system', text: `ok${mojibake('’')}s` })).text).toBe('ok’s')
  })

  it('never touches the player, keeps clean messages identical, and repairs tool results the same way', () => {
    const player = msg({ role: 'player', text: mojibake('’') })
    expect(cleanChatMessage(player)).toBe(player)
    const clean = msg({ text: SAMPLE })
    expect(cleanChatMessage(clean)).toBe(clean)
    const tools = [{ id: 't', name: 'read', input: mojibake('’'), result: `out ${mojibake('—')}` }]
    expect(cleanChatMessage(msg({ text: '```\ncode\n```', tools })).tools).toEqual([{ ...tools[0], result: 'out —' }])
  })

  it('repairs a garbled stream the same however its deltas were cut', () => {
    const message = Array.from({ length: 40 }, (_, i) => `${i} ${SAMPLE}`).join('\n')
    const garbled = mojibake(message)
    for (let seed = 1; seed <= 10; seed++) {
      const next = rng(seed)
      let m = msg({ text: '', partial: true })
      for (let at = 0; at < garbled.length;) {
        const size = 1 + Math.floor(next() * 9)
        m = cleanChatMessage({ ...m, text: m.text + garbled.slice(at, at + size), partial: true })
        at += size
      }
      expect(cleanChatMessage({ ...m, partial: false }).text).toBe(message)
    }
  })
})
