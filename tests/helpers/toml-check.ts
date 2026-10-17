/**
 * A strict reader for the TOML that a Codex config.toml holds: [tables] with
 * dotted bare, 'literal' or "basic" keys, and key = value lines whose value is a
 * string, boolean, number or one-line array of those. Anything else, a repeated
 * table or a repeated key throws, so a passing file is valid TOML.
 */
export function readToml(src: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = { '': {} }
  let current = tables['']
  src.split(/\r?\n/).forEach((raw, i) => {
    const fail = (why: string): never => { throw new Error(`line ${i + 1}: ${why}: ${raw}`) }
    let at = 0
    const ws = (): void => { while (raw[at] === ' ' || raw[at] === '\t') at++ }
    const end = (): void => { ws(); if (at < raw.length && raw[at] !== '#') fail('trailing text') }
    const basic = (): string => {
      let out = ''
      for (at++; at < raw.length; at++) {
        const c = raw[at]
        if (c === '"') { at++; return out }
        if (c < ' ' && c !== '\t') fail('control character in string')
        if (c !== '\\') { out += c; continue }
        const e = raw[++at]
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
        if (e in simple) out += simple[e]
        else if (e === 'u' || e === 'U') {
          const n = e === 'u' ? 4 : 8
          const hex = raw.slice(at + 1, at + 1 + n)
          if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail('bad unicode escape')
          out += String.fromCodePoint(parseInt(hex, 16))
          at += n
        } else fail('bad escape')
      }
      return fail('unterminated string')
    }
    const literal = (): string => {
      const close = raw.indexOf("'", at + 1)
      if (close < 0) fail('unterminated literal string')
      const s = raw.slice(at + 1, close)
      at = close + 1
      return s
    }
    const key = (): string[] => {
      const parts: string[] = []
      for (;;) {
        ws()
        if (raw[at] === '"') parts.push(basic())
        else if (raw[at] === "'") parts.push(literal())
        else {
          const m = /^[A-Za-z0-9_-]+/.exec(raw.slice(at))
          if (!m) fail('bad key')
          parts.push(m![0])
          at += m![0].length
        }
        ws()
        if (raw[at] !== '.') return parts
        at++
      }
    }
    const value = (): unknown => {
      ws()
      if (raw[at] === '"') return basic()
      if (raw[at] === "'") return literal()
      if (raw[at] === '[') {
        const items: unknown[] = []
        at++
        for (;;) {
          ws()
          if (raw[at] === ']') { at++; return items }
          items.push(value())
          ws()
          if (raw[at] === ',') at++
          else if (raw[at] !== ']') fail('bad array')
        }
      }
      const m = /^(true|false|[+-]?\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)(?=\s|#|,|\]|$)/.exec(raw.slice(at))
      if (!m) fail('bad value')
      at += m![0].length
      return m![1] === 'true' ? true : m![1] === 'false' ? false : Number(m![1].replace(/_/g, ''))
    }

    ws()
    if (at >= raw.length || raw[at] === '#') return
    if (raw[at] === '[') {
      if (raw[at + 1] === '[') fail('arrays of tables are not expected here')
      at++
      const name = JSON.stringify(key())
      if (raw[at] !== ']') fail('bad table header')
      at++
      end()
      if (tables[name]) fail('table defined twice')
      current = tables[name] = {}
      return
    }
    const k = JSON.stringify(key())
    if (raw[at] !== '=') fail('expected =')
    at++
    const v = value()
    end()
    if (k in current) fail('key defined twice')
    current[k] = v
  })
  return tables
}

/** The trust level a parsed config gives `folder` (the table key exactly as written). */
export const trustOf = (tables: Record<string, Record<string, unknown>>, folder: string): unknown =>
  tables[JSON.stringify(['projects', folder])]?.[JSON.stringify(['trust_level'])]
