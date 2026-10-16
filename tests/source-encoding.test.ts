import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { hasMojibake, mojibake } from '../src/shared/encoding'

// UTF-8 saved after being read as Windows-1252: punctuation, zero-width characters, accents, arrows, emoji, CJK.
const repo = join(__dirname, '..')
const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : files(join(dir, e.name))) : /\.(tsx?|css|html|md|mjs|js|ps1|json)$/.test(e.name) ? [join(dir, e.name)] : [])
    : []

it('keeps source, tests, unit skills and docs free of mojibake', () => {
  const hits = [...['src', 'tests', 'resources', 'docs', 'scripts'].flatMap((d) => files(join(repo, d))), join(repo, 'README.md')].flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (hasMojibake(line) ? [`${relative(repo, f)}:${i + 1}`] : []))
  )
  expect(hits).toEqual([])
})

it('the guard catches every sequence class it is meant to', () => {
  for (const ch of ['–', '—', '’', '“', '”', '…', '·', '​', '‌', '•', 'é', 'É', '→', '▌', '✅', '\u{1F389}', '中', 'п'])
    expect(hasMojibake(`x ${mojibake(ch)} y`), JSON.stringify(ch)).toBe(true)
})
