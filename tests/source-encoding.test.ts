import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

// UTF-8 punctuation saved after being read as Windows-1252: en/em dash, apostrophe, quotes, ellipsis, middle dot.
const MOJIBAKE = /â€[“”™œ˜¦\u009d]|Â[ -¿]/
const root = join(__dirname, '..', 'src')
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|css|html)$/.test(e.name) ? [join(dir, e.name)] : []))

it('keeps source text free of mojibake', () => {
  const hits = files(root).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (MOJIBAKE.test(line) ? [`${relative(root, f)}:${i + 1}`] : []))
  )
  expect(hits).toEqual([])
})
