import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { artBibleMediaUrl, artBibleRefPath, readArtBibleView, writeArtBibleFile } from '../src/main/art-bible'
import { hasArtBible, paletteStrip, refLabel } from '../src/shared/art-bible'

let tmp: string
const put = (rel: string, text: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true })
  fs.writeFileSync(path.join(tmp, rel), text)
}
const read = (rel: string): string => fs.readFileSync(path.join(tmp, rel), 'utf8')
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-art-bible-screen-')) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const BIBLE = `---
avoid: [grunge, rim lights]
---
# Art Bible: Test

## Style
Chunky low-poly shapes and soft daylight.

## Palette
| Role | Color | Use |
|---|---|---|
| Limestone | \`#CBBF9F\` | walls |

### Accents
| Aether | \`#53D9D1\` | crystals only |

## References
![Smithy](art-bible/refs/smithy.png "style buildings 3")
![](art-bible/refs/gone.png)
![Web](https://example.com/a.png)

## Do
- Big roofs
## Don't
- Tiny shingles
`

describe('Art Bible screen data', () => {
  it('has no bible when the file is missing or empty', () => {
    const missing = readArtBibleView('alpha', tmp)
    expect(missing).toMatchObject({ path: '.genio/art-bible.md', text: null, source: null, bible: null })
    expect(hasArtBible(missing)).toBe(false)
    put('.genio/art-bible.md', '  \n')
    const empty = readArtBibleView('alpha', tmp)
    expect(empty.bible).toBeNull()
    expect(hasArtBible(empty)).toBe(false)
  })

  it('shows style, palette, references, do and don\'t and avoid terms', () => {
    put('.genio/art-bible.md', BIBLE)
    put('.genio/art-bible/refs/smithy.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const v = readArtBibleView('alpha', tmp)
    expect(hasArtBible(v)).toBe(true)
    const b = v.bible!
    expect(b.style?.summary).toContain('Chunky low-poly')
    expect(b.palette).toEqual([{ name: 'Limestone', hex: '#CBBF9F', use: 'walls' }])
    expect(b.accents.map(c => c.name)).toEqual(['Aether'])
    expect(paletteStrip(b)).toEqual(['#CBBF9F', '#53D9D1'])
    expect(b.do).toEqual(['Big roofs'])
    expect(b.dont).toEqual(['Tiny shingles'])
    expect(b.avoid).toEqual(['grunge', 'rim lights'])
    const [smithy, gone, web] = b.references
    expect(smithy).toMatchObject({ path: '.genio/art-bible/refs/smithy.png', role: 'style', types: ['buildings'], weight: 3, exists: true, url: artBibleMediaUrl('alpha', '.genio/art-bible/refs/smithy.png') })
    expect(gone).toMatchObject({ exists: false, url: null })
    expect(refLabel(gone)).toBe('gone.png')
    expect(web).toMatchObject({ external: true, url: null })
    expect(b.issues.some(i => i.message.includes('gone.png'))).toBe(true)
    expect(b.source).toBeNull()
  })

  it('serves only reference images the bible lists, even inside .genio', async () => {
    put('.genio/art-bible.md', BIBLE)
    put('.genio/art-bible/refs/smithy.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    put('.genio/art-bible/refs/other.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(await artBibleRefPath(tmp, '.genio/art-bible/refs/smithy.png')).toBe(fs.realpathSync(path.join(tmp, '.genio/art-bible/refs/smithy.png')))
    expect(await artBibleRefPath(tmp, '.genio/art-bible/refs/other.png')).toBeUndefined()
    expect(await artBibleRefPath(tmp, '.genio/art-bible.md')).toBeUndefined()
    expect(await artBibleRefPath(tmp, '../secret.png')).toBeUndefined()
  })

  it('reads and edits the source doc in place for a bible with a source: line', () => {
    put('docs/ART.md', '# Art direction\n\n## Style\nPainted forests.\n')
    put('.genio/art-bible.md', '---\nsource: docs/ART.md\navoid: [neon]\n---\n')
    const v = readArtBibleView('alpha', tmp)
    expect(v.source).toEqual({ path: 'docs/ART.md', text: '# Art direction\n\n## Style\nPainted forests.\n' })
    expect(v.bible).toMatchObject({ source: 'docs/ART.md', avoid: ['neon'] })
    expect(v.bible!.style?.summary).toBe('Painted forests.')
    const saved = writeArtBibleFile('alpha', tmp, 'source', '# Art direction\n\n## Style\nInked forests.\n')
    expect(read('docs/ART.md')).toContain('Inked forests.')
    expect(saved.bible!.style?.summary).toBe('Inked forests.')
  })

  it('saves the bible as a plain file and refuses text that would not compile', () => {
    put('.genio/art-bible.md', BIBLE)
    const saved = writeArtBibleFile('alpha', tmp, 'bible', BIBLE.replace('Big roofs', 'Broad roofs'))
    expect(saved.bible!.do).toEqual(['Broad roofs'])
    expect(read('.genio/art-bible.md')).toContain('Broad roofs')
    expect(() => writeArtBibleFile('alpha', tmp, 'bible', '---\nsource: docs/none.md\n---\n')).toThrow(/does not exist/)
    expect(read('.genio/art-bible.md')).toContain('Broad roofs')
  })

  it('has no source doc to save without a source: line', () => {
    put('.genio/art-bible.md', BIBLE)
    expect(() => writeArtBibleFile('alpha', tmp, 'source', '# x')).toThrow(/no source doc/)
    expect(() => writeArtBibleFile('alpha', tmp, 'other' as never, '# x')).toThrow(/Unknown/)
  })
})
