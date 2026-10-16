/**
 * Text that crossed a code page. On Windows, units and scripts write status
 * lines and logs through PowerShell 5.1 (UTF-16LE or ANSI) and cmd (OEM), and
 * UTF-8 read back as Windows-1252 turns an apostrophe into three Latin-1
 * letters. Readers decode bytes here; the chat repairs text that was already
 * garbled upstream (a model repeating a mangled tool result, an old history).
 * Source stays ASCII: every non-ASCII character below is a \u escape.
 */

// Windows-1252 bytes 0x80-0x9F. The five unassigned bytes keep their C1 code point, as WHATWG decoders do.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
]
const cp1252Char = (b: number): number => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b)
const CP1252_BYTE = new Map<number, number>()
for (let b = 0; b < 0x100; b++) CP1252_BYTE.set(cp1252Char(b), b)

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const UTF16 = new TextDecoder('utf-16le', { ignoreBOM: true })
const EMPTY = new Uint8Array(0)

const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return UTF8.decode(bytes)
  } catch {
    return undefined
  }
}

export function decodeCp1252(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(cp1252Char(b))
  return s
}

/** What a Windows-1252 reader makes of UTF-8 text: the damage repairMojibake undoes. */
export function mojibake(text: string): string {
  return decodeCp1252(new TextEncoder().encode(text))
}

/** UTF-16LE as PowerShell 5.1 `>`, `>>` and `Out-File` write it: ASCII has a NUL high byte. */
function wideRatio(bytes: Uint8Array, at: number, stop: number): boolean {
  let pairs = 0
  let zeros = 0
  for (let i = at; i + 1 < stop; i += 2) {
    pairs++
    if (bytes[i + 1] === 0 && bytes[i] !== 0) zeros++
  }
  return pairs > 0 && zeros * 2 >= pairs
}

/**
 * Decode a text file whatever wrote it: UTF-8 (BOM or not), UTF-16 with a BOM
 * or without one, and Windows-1252 for bytes that are not valid UTF-8. Decided
 * line by line, because an append-only log can hold lines from several
 * writers (Genio's UTF-8 next to a unit's PowerShell UTF-16).
 */
export function decodeBytes(bytes: Uint8Array): string {
  if (bytes.indexOf(0) < 0) {
    const s = utf8(bytes)
    if (s !== undefined) return s.replace(/﻿/g, '')
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2)
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]
      swapped[i - 1] = bytes[i]
    }
    return UTF16.decode(swapped).replace(/﻿/g, '')
  }
  let out = ''
  let at = 0
  let wide = false
  while (at < bytes.length) {
    if (bytes[at] === 0xef && bytes[at + 1] === 0xbb && bytes[at + 2] === 0xbf) {
      at += 3
      wide = false
      continue
    }
    if (bytes[at] === 0xff && bytes[at + 1] === 0xfe) {
      at += 2
      wide = true
      continue
    }
    // the high byte of a UTF-16 newline another read already consumed
    if (bytes[at] === 0 && !wide) {
      at++
      continue
    }
    const lf = bytes.indexOf(0x0a, at)
    const stop = lf < 0 ? bytes.length : lf
    const probe = Math.min(bytes.length, stop + 2)
    wide = wideRatio(bytes, at, probe) || (wide && (bytes.subarray(at, probe).indexOf(0) >= 0 || utf8(bytes.subarray(at, stop)) === undefined))
    if (wide) {
      let end = at
      while (end + 1 < bytes.length && !(bytes[end] === 0x0a && bytes[end + 1] === 0)) end += 2
      if (end + 1 < bytes.length) {
        out += UTF16.decode(bytes.subarray(at, end)) + '\n'
        at = end + 2
      } else {
        // a read that ended between a UTF-16 newline and its NUL
        const rest = bytes.subarray(at)
        out += rest.length % 2 && rest[rest.length - 1] === 0x0a ? UTF16.decode(rest.subarray(0, -1)) + '\n' : UTF16.decode(rest)
        at = bytes.length
      }
    } else {
      const line = bytes.subarray(at, stop)
      out += (utf8(line) ?? decodeCp1252(line)) + (lf < 0 ? '' : '\n')
      at = stop + 1
    }
  }
  return out.replace(/﻿/g, '')
}

/** Byte length through the last complete line, counting the NUL after a UTF-16LE newline. */
export function completeLines(bytes: Uint8Array): number {
  const lf = bytes.lastIndexOf(0x0a)
  if (lf < 0) return 0
  return bytes[lf + 1] === 0 ? lf + 2 : lf + 1
}

/** Where whole UTF-8 characters end: before a trailing sequence a byte cap cut short. */
export function utf8End(bytes: Uint8Array, end = bytes.length): number {
  for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
    const b = bytes[i]
    if (b < 0x80) return end
    if (b >= 0xc0) return i + (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2) <= end ? end : i
  }
  return end
}

/** Where a read that began mid-file reaches its first whole line. */
export function lineStart(bytes: Uint8Array): number {
  const lf = bytes.indexOf(0x0a)
  return lf < 0 ? 0 : bytes[lf + 1] === 0 ? lf + 2 : lf + 1
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * Decode a byte stream chunk by chunk (stdout, a pipe, a growing log). A
 * character or line split between two chunks is held until it is whole, so
 * it never turns into replacement characters or mojibake.
 */
export class TextStream {
  private rest: Uint8Array = EMPTY

  write(chunk: Uint8Array): string {
    const bytes = this.rest.length ? concat(this.rest, chunk) : chunk
    const lines = completeLines(bytes)
    let text = lines ? decodeBytes(bytes.subarray(0, lines)) : ''
    let tail = bytes.subarray(lines)
    // An unfinished line shows at once while it is plain UTF-8; anything else waits for its newline.
    if (tail.indexOf(0) < 0) {
      const end = utf8End(tail)
      const s = utf8(tail.subarray(0, end))
      if (s !== undefined) {
        text += s.replace(/﻿/g, '')
        tail = tail.subarray(end)
      }
    }
    if (tail.length > 64 * 1024) {
      text += decodeBytes(tail)
      tail = EMPTY
    }
    this.rest = new Uint8Array(tail)
    return text
  }

  end(): string {
    const s = this.rest.length ? decodeBytes(this.rest) : ''
    this.rest = EMPTY
    return s
  }
}

const hex = (c: number): string => '\\u' + c.toString(16).padStart(4, '0')
const bytesClass = (from: number, to: number): string => {
  let s = ''
  for (let b = from; b <= to; b++) s += hex(cp1252Char(b))
  return `[${s}]`
}
const CONT = bytesClass(0x80, 0xbf)
// One UTF-8 character read as Windows-1252. Leads are the ones real text almost never puts before
// such a character: Latin-1, Latin Extended-A, Greek, Cyrillic (2 bytes); punctuation, symbols,
// CJK, Hangul, fullwidth, BOM (3 bytes); emoji (4 bytes).
const SEQUENCE = `${bytesClass(0xc2, 0xc5)}${CONT}|${bytesClass(0xce, 0xd1)}${CONT}|${bytesClass(0xe2, 0xef)}${CONT}{2}|${bytesClass(0xf0, 0xf3)}${CONT}{3}`
const SEQUENCES = new RegExp(SEQUENCE, 'g')
const RUNS = new RegExp(`(?:${SEQUENCE})+`, 'g')

/** Code points a repaired sequence may produce: anything else means the text was real, not mojibake. */
const PLAUSIBLE: [number, number][] = [
  [0xa0, 0x24f], [0x370, 0x4ff], [0x2000, 0x2bff], [0x3000, 0x9fff], [0xac00, 0xd7a3],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xff00, 0xfffd], [0x1f000, 0x1faff]
]
const C1 = (c: number): boolean => c >= 0x80 && c < 0xa0
const plausible = (s: string, c1: boolean): boolean => {
  const c = s.codePointAt(0) ?? 0
  return (c1 && C1(c)) || PLAUSIBLE.some(([a, z]) => c >= a && c <= z)
}

function repairSequence(seq: string, c1: boolean): string {
  const bytes = new Uint8Array(seq.length)
  for (let i = 0; i < seq.length; i++) bytes[i] = CP1252_BYTE.get(seq.charCodeAt(i)) ?? 0
  const fixed = utf8(bytes)
  return fixed !== undefined && plausible(fixed, c1) ? fixed : seq
}

/** Undo UTF-8 read as Windows-1252 (twice over, if it happened twice). Correct text comes back unchanged. */
export function repairMojibake(text: string, depth = 0): string {
  return text.replace(RUNS, (run) => {
    // Twice-garbled text passes through C1 controls (the quote U+201D is E2 80 9D), which the next pass consumes.
    const once = run.replace(SEQUENCES, (seq) => repairSequence(seq, true))
    if (once === run) return run
    const done = depth < 2 ? repairMojibake(once, depth + 1) : once
    return [...done].some((ch) => C1(ch.charCodeAt(0))) ? run.replace(SEQUENCES, (seq) => repairSequence(seq, false)) : done
  })
}

/** True when text holds a UTF-8 character that was decoded as Windows-1252. */
export function hasMojibake(text: string): boolean {
  return repairMojibake(text) !== text
}

/** Zero-width characters and BOMs left over at the ends of a message. */
export function trimZeroWidth(text: string): string {
  return text.replace(/^(\s*)[​-‍⁠﻿]+/, '$1').replace(/[​-‍⁠﻿]+(\s*)$/, '$1')
}
