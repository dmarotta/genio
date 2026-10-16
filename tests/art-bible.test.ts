import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ArtBibleError, LIMITS, compile, gitBlobSha, loadArtBible, normalizeType, parseArtBible, parseFrontMatter,
  readArtBibleText, selectRefs, targetOf, writeArtBible, type ResolvedBible
} from '../resources/unit-skills/genio/lib/art-bible.mjs'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = path.join(APP_ROOT, 'resources', 'unit-skills', 'genio', 'lib', 'genio-art.mjs')
// founders-of-avalon's docs/ART_DIRECTION.md, byte for byte: the bible must read it without edits.
const FOUNDERS_DOC = path.join(APP_ROOT, 'tests', 'fixtures', 'art-bible', 'founders', 'docs', 'ART_DIRECTION.md')

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-art-bible-')) })
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const put = (rel: string, text: string | Buffer = ''): string => {
  const file = path.join(tmp, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const NATIVE = `---
schema: genio.art-bible.v1
kind: game-3d-stylized          # template id
avoid: [photo textures, grunge, "outlines, thick"]
defaults: { image: png 1:1 1024, sprite: transparent, model: glb <=10k tris }
---
# Art Bible: Test Valley

## Style
A stylized low-poly valley with broad solid-colour regions and soft daylight.

Never toy-like.

## Palette
| Role | Color | Use |
|---|---|---|
| Warm limestone | \`#CBBF9F\` | walls, arches |
| Blue slate | \`#344F60\` | roofs, recesses |

### Accents
| Cyan Aether | \`#53D9D1\` | crystals only |

## References
![Blacksmith: stone workshop](../art/blacksmith.png "style building 3")
![Sheep sheet](../art/sheep.png "style wildlife 2")
![Mood](../art/mood.png)

## Do
- Fix weak forms with recesses and roof breaks
## Don't
- Modelled brickwork, tiny shingles

## Buildings
Chunky readable masses, large roofs, recesses.
## Wildlife
Legless rounded silhouette, matte colours, simple oval eyes.
## Audio
Warm acoustic medieval; soft transients.
## Weather
Light drizzle only.

## Review checklist
1. **Silhouette:** recognizable at city distance
2. Surfaces: no noisy textures
`

function nativeWorld(text = NATIVE): ResolvedBible {
  put('.genio/art-bible.md', text)
  for (const f of ['art/blacksmith.png', 'art/sheep.png', 'art/mood.png']) put(f, 'png')
  const b = loadArtBible(tmp)
  if (!b) throw new Error('no bible')
  return b
}

/** A copy of founders' doc plus the 15 images it links (placeholders) and a thin pointer bible. */
function foundersWorld(pointer: string): ResolvedBible {
  const doc = fs.readFileSync(FOUNDERS_DOC)
  put('docs/ART_DIRECTION.md', doc)
  for (const m of doc.toString('utf8').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) put(`docs/${m[1]}`, 'img')
  put('.genio/art-bible.md', pointer)
  const b = loadArtBible(tmp)
  if (!b) throw new Error('no bible')
  return b
}

const POINTER = `---
schema: genio.art-bible.v1
source: docs/ART_DIRECTION.md
avoid: [photo textures, grunge, scratches, glossy plastic, rim lights]
---
# Art Bible

### Accents
| Cyan Aether | \`#53D9D1\` | crystals only |
| Ember orange | \`#EF8B36\` | hearth and hot metal |

## References
![](../docs/art-references/ironhearth-blacksmith.jpg "style buildings 3")
![](../docs/art-references/asterhold-citadel.png "style buildings 2")
![](../docs/art-references/meadow-sheep.png "style wildlife 3")

## Buildings
Chunky readable masses, large roofs, recesses; production buildings look used.

## Animation
Soft, cozy, small bobs.
`

describe('front matter', () => {
  it('reads the flat YAML subset: inline lists and maps, block lists, quotes, comments, hex values', () => {
    const fm = parseFrontMatter('\uFEFF---\r\nkind: game # comment\r\navoid: [a, "b, c", #fff]\r\ndefaults: { image: png 1:1 1024, model: glb <=10k tris }\r\ntags:\r\n  - one\r\n  - two\r\nsize:\r\n  w: 3\r\n---\r\n# Body')
    expect(fm.errors).toEqual([])
    expect(fm.data).toEqual({ kind: 'game', avoid: ['a', 'b, c', '#fff'], defaults: { image: 'png 1:1 1024', model: 'glb <=10k tris' }, tags: ['one', 'two'], size: { w: 3 } })
    expect(fm.body.trim()).toBe('# Body')
  })

  it('reports broken front matter as an error that stops compiling', () => {
    put('.genio/art-bible.md', '---\nkind game\n---\n# X\n## Style\nFlat.\n')
    const b = loadArtBible(tmp)!
    expect(b.issues.some((i) => i.level === 'error' && /line 2/.test(i.message))).toBe(true)
    expect(() => compile({ bible: b, provider: 'codex', subject: 'a mill' })).toThrow(ArtBibleError)
  })
})

describe('parser', () => {
  it('reads every fixed heading of a native bible', () => {
    const b = nativeWorld()
    expect(b.kind).toBe('game-3d-stylized')
    expect(b.defaults).toEqual({ image: 'png 1:1 1024', sprite: 'transparent', model: 'glb <=10k tris' })
    expect(b.avoid).toEqual(['photo textures', 'grunge', 'outlines, thick'])
    expect(b.title).toBe('Art Bible: Test Valley')
    expect(b.style?.summary).toBe('A stylized low-poly valley with broad solid-colour regions and soft daylight. Never toy-like.')
    expect(b.palette.map((c) => [c.name, c.hex, c.use])).toEqual([['Warm limestone', '#CBBF9F', 'walls, arches'], ['Blue slate', '#344F60', 'roofs, recesses']])
    expect(b.accents.map((c) => [c.name, c.hex, c.use])).toEqual([['Cyan Aether', '#53D9D1', 'crystals only']])
    expect(b.references.map((r) => [r.path, r.role, r.types, r.weight, r.exists])).toEqual([
      ['art/blacksmith.png', 'style', ['buildings'], 3, true],
      ['art/sheep.png', 'style', ['wildlife'], 2, true],
      ['art/mood.png', 'style', [], 1, true]
    ])
    expect(b.do).toEqual(['Fix weak forms with recesses and roof breaks'])
    expect(b.dont).toEqual(['Modelled brickwork, tiny shingles'])
    expect(b.checklist).toEqual(['Silhouette: recognizable at city distance', 'Surfaces: no noisy textures'])
    expect(Object.keys(b.types)).toEqual(['buildings', 'wildlife', 'audio', 'weather'])
    expect(b.types.weather).toMatchObject({ custom: true, line: 'Light drizzle only.' })
    expect(b.issues).toEqual([])
  })

  it('versions the bible by its git blob id', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    const b = nativeWorld()
    expect(b.version).toEqual({ blob: gitBlobSha(Buffer.from(NATIVE)), source_blob: null })
  })

  it('ignores code fences and comments, and flags references outside the project', () => {
    const doc = parseArtBible('# T\n## Style\nFlat colour.\n```\n## Palette\n| x | #FFFFFF | y |\n```\n<!-- ![](a.png) -->\n![](../../x.png)\n![](https://example.com/a.png)\n', { file: '.genio/art-bible.md' })
    expect(doc.palette).toEqual([])
    expect(doc.references.map((r) => [r.path, r.external])).toEqual([[null, true]])
    expect(doc.issues.some((i) => /outside the project/.test(i.message))).toBe(true)
  })

  it('has no bible without the file, or with an empty one', () => {
    expect(loadArtBible(tmp)).toBeNull()
    expect(compile({ world: tmp, provider: 'codex', subject: 'a mill' })).toBeNull()
    put('.genio/art-bible.md', '\uFEFF  \n\n')
    expect(loadArtBible(tmp)).toBeNull()
    expect(compile({ world: tmp, provider: 'fal', endpoint: 'fal-ai/flux/schnell', subject: 'a mill' })).toBeNull()
  })

  it('never looks at other docs on its own', () => {
    put('docs/ART_DIRECTION.md', fs.readFileSync(FOUNDERS_DOC))
    expect(loadArtBible(tmp)).toBeNull()
  })

  it('warns at 16 KB and refuses to compile above 64 KB', () => {
    const big = (kb: number): string => `# T\n## Style\nFlat.\n\n${'x'.repeat(kb * 1024)}\n`
    put('.genio/art-bible.md', big(20))
    expect(loadArtBible(tmp)!.issues.map((i) => i.level)).toEqual(['warning'])
    put('.genio/art-bible.md', big(70))
    const b = loadArtBible(tmp)!
    expect(b.issues.map((i) => i.level)).toEqual(['error'])
    expect(() => compile({ bible: b, provider: 'codex' })).toThrow(/64 KB/)
  })

  it('normalizes asset type names', () => {
    expect(['building', 'Sprites & icons', 'icon', '3D', 'animal', 'sfx', 'motion', 'Weather'].map(normalizeType))
      .toEqual(['buildings', 'sprites', 'sprites', 'models', 'wildlife', 'audio', 'animation', 'weather'])
  })
})

describe('founders-of-avalon doc through source:', () => {
  it('parses the doc without edits: 10 palette colours, 15 references, 7 checklist items', () => {
    const b = foundersWorld(POINTER)
    expect(fs.readFileSync(path.join(tmp, 'docs', 'ART_DIRECTION.md'))).toEqual(fs.readFileSync(FOUNDERS_DOC))
    expect(b.palette).toHaveLength(10)
    expect(b.palette.map((c) => c.hex)).toEqual(['#CBBF9F', '#8B9690', '#344F60', '#B79757', '#776048', '#627D4D', '#779354', '#91AA67', '#53D9D1', '#EF8B36'])
    expect(b.palette.filter((c) => c.name === 'Foliage greens')).toHaveLength(3)
    expect(b.references).toHaveLength(15)
    expect(b.references.every((r) => r.exists && r.path?.startsWith('docs/art-references/'))).toBe(true)
    expect(b.checklist).toHaveLength(7)
    expect(b.checklist[0]).toBe('Silhouette: recognizable at city distance, with emphasis that suits its role.')
    expect(b.style?.summary.startsWith('A fully 3D stylized low-poly world')).toBe(true)
    expect(b.style!.summary.length).toBeLessThanOrEqual(LIMITS.summary)
    expect(b.issues.filter((i) => i.level === 'error')).toEqual([])
  })

  it('merges the pointer extras and names the file behind every part', () => {
    const b = foundersWorld(POINTER)
    expect(b.source).toMatchObject({ path: 'docs/ART_DIRECTION.md', blob: gitBlobSha(fs.readFileSync(FOUNDERS_DOC)) })
    expect(b.origins).toMatchObject({
      style: 'docs/ART_DIRECTION.md', palette: 'docs/ART_DIRECTION.md', checklist: 'docs/ART_DIRECTION.md',
      references: ['docs/ART_DIRECTION.md'], reference_weights: ['.genio/art-bible.md'],
      accents: ['.genio/art-bible.md'], avoid: ['.genio/art-bible.md']
    })
    expect(b.origins.types).toMatchObject({ buildings: '.genio/art-bible.md', animation: '.genio/art-bible.md', characters: 'docs/ART_DIRECTION.md', wildlife: 'docs/ART_DIRECTION.md' })
    expect(b.accents.map((c) => c.hex)).toEqual(['#53D9D1', '#EF8B36'])
    const smith = b.references.find((r) => r.path === 'docs/art-references/ironhearth-blacksmith.jpg')!
    expect(smith).toMatchObject({ types: ['buildings'], weight: 3, origin: 'docs/ART_DIRECTION.md', weight_origin: '.genio/art-bible.md' })
    expect(smith.caption).toMatch(/^Ironhearth blacksmith/)
    // Untitled source refs take the type of their section.
    expect(b.references.find((r) => r.path === 'docs/art-references/merlin.png')?.section_type).toBe('characters')
  })

  it('the source wins on palette, references and checklist', () => {
    const b = foundersWorld(POINTER.replace('# Art Bible', '# Art Bible\n## Palette\n| Hot pink | `#FF00FF` | x |\n## Review checklist\n1. Pink\n## References\n![New ref](../docs/extra.png)'))
    expect(b.palette).toHaveLength(10)
    expect(b.checklist).toHaveLength(7)
    expect(b.references).toHaveLength(16)
    expect(b.references.at(-1)).toMatchObject({ path: 'docs/extra.png', origin: '.genio/art-bible.md' })
  })

  it('refuses a source outside the project or missing', () => {
    for (const src of ['../elsewhere.md', 'C:/x.md', 'docs/missing.md', '.genio/art-bible.md']) {
      put('.genio/art-bible.md', `---\nsource: ${src}\n---\n# B\n`)
      expect(loadArtBible(tmp)!.issues.some((i) => i.level === 'error'), src).toBe(true)
    }
  })

  it('ranks references for a type: titled, then its section, never another type', () => {
    const b = foundersWorld(POINTER)
    expect(selectRefs(b, 'building', 2).map((r) => r.path)).toEqual(['docs/art-references/ironhearth-blacksmith.jpg', 'docs/art-references/asterhold-citadel.png'])
    expect(selectRefs(b, 'wildlife', 4).map((r) => r.path)).toEqual(['docs/art-references/meadow-sheep.png', 'docs/art-references/shore-crab.png', 'docs/art-references/silverfin-fish-v2.png', 'docs/art-references/land-bird.png'])
    const chars = selectRefs(b, 'characters', 24).map((r) => r.path)
    expect(chars.slice(0, 3)).toEqual(['docs/art-references/merlin.png', 'docs/art-references/villager-female.png', 'docs/art-references/villager-male.png'])
    expect(chars).not.toContain('docs/art-references/meadow-sheep.png')
    expect(chars).not.toContain('docs/art-references/ironhearth-blacksmith.jpg')
  })
})

describe('compile per provider', () => {
  const hex = /#[0-9A-F]{6}/i

  it('picks the target from provider and endpoint', () => {
    expect([
      ['codex'], ['fal', 'fal-ai/flux/schnell'], ['fal', 'fal-ai/nano-banana/edit'], ['fal', 'fal-ai/flux-3/edit'], ['fal', 'recraft/v4/style/text-to-image'],
      ['fal', 'recraft/v4/create-style'], ['fal', 'fal-ai/image2pixel'], ['fal', 'fal-ai/meshy/v6/text-to-3d'], ['fal', 'fal-ai/elevenlabs/tts/v3'],
      ['fal', 'fal-ai/stable-audio'], ['fal', 'fal-ai/elevenlabs/sound-effects'], ['uthana']
    ].map(([provider, endpoint]) => targetOf({ provider, endpoint }))).toEqual([
      'codex', 'fal-text', 'fal-edit', 'fal-edit', 'recraft', 'recraft-style', 'image2pixel', '3d', 'voice', 'music', 'audio', 'animation'
    ])
  })

  it('codex: subject, full style with hex palette within 1,200 characters, type line, avoid, two type refs', () => {
    const b = foundersWorld(POINTER)
    const c = compile({ bible: b, provider: 'codex', type: 'building', subject: 'A windmill' })!
    expect(c.prompt.startsWith('A windmill\nArt direction: A fully 3D stylized')).toBe(true)
    const style = c.prefix.split('\n').filter((l) => !/^(Buildings:|The attached images)/.test(l)).join('\n')
    expect(style.length).toBeLessThanOrEqual(LIMITS.codexStyle)
    expect(c.prefix).toContain('blue slate #344F60')
    expect(c.prefix).toContain('Accents, small and local only: cyan Aether #53D9D1')
    expect(c.prefix).toContain('Avoid: photo textures, grunge, scratches, glossy plastic, rim lights.')
    expect(c.prefix).toContain('Buildings: Chunky readable masses')
    expect(c.prefix).toContain('STYLE references only; do not copy their subjects')
    expect(c.refs.map((r) => r.path)).toEqual(['docs/art-references/ironhearth-blacksmith.jpg', 'docs/art-references/asterhold-citadel.png'])
    expect(c.refs.every((r) => r.file && fs.existsSync(r.file))).toBe(true)
    expect(c.version).toEqual(b.version)
    expect(c.applied).toEqual(['style', 'palette', 'avoid', 'type', 'refs'])
  })

  it('codex: a bloated bible is cut down in the drop order and never passes the prompt limit', () => {
    const long = (n: number, w: string): string => Array.from({ length: n }, (_, i) => `${w} ${i} with several extra descriptive words`).join('\n- ')
    const text = NATIVE.replace('- Fix weak forms with recesses and roof breaks', `- ${long(30, 'do')}`).replace('Chunky readable masses, large roofs, recesses.', 'Chunky masses. '.repeat(40))
    const b = nativeWorld(text)
    const c = compile({ bible: b, provider: 'codex', type: 'buildings', subject: 'A windmill' })!
    expect(c.notes.some((n) => /dropped do/.test(n))).toBe(true)
    expect(c.prefix).not.toContain('Do:')
    expect(c.prefix).toContain('Palette: warm limestone #CBBF9F')
    expect(c.prompt.length).toBeLessThanOrEqual(LIMITS.codexPrompt)
    const tight = compile({ bible: b, provider: 'codex', type: 'buildings', subject: 'A windmill', limit: 300 })!
    expect(tight.prompt.length).toBeLessThanOrEqual(300)
    expect(tight.prompt.startsWith('A windmill')).toBe(true)
    expect(tight.prefix).not.toContain('Buildings:')
  })

  it('text-only FAL: subject first, at most 350 characters of style, colour names without hex', () => {
    const b = foundersWorld(POINTER)
    for (const type of ['building', 'wildlife', undefined]) {
      const c = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/flux/schnell', type, subject: 'A red fox' })!
      expect(c.prompt.startsWith('A red fox. Style: ')).toBe(true)
      expect(c.prefix.length).toBeLessThanOrEqual(LIMITS.falStyle)
      expect(c.prompt).not.toMatch(hex)
      expect(c.prompt).toContain('warm limestone')
      expect(c.params).toEqual({})
      expect(c.refs).toEqual([])
    }
  })

  it('text-only FAL: negative_prompt only where the schema has it', () => {
    const b = foundersWorld(POINTER)
    const withNeg = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/some/model', schema: { properties: { prompt: {}, negative_prompt: {} } }, subject: 'A mill' })!
    expect(withNeg.params).toEqual({ negative_prompt: 'photo textures, grunge, scratches, glossy plastic, rim lights' })
    const without = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/some/model', schema: { properties: { prompt: {} } }, subject: 'A mill' })!
    expect(without.params).toEqual({})
    expect(without.notes.some((n) => /negative_prompt/.test(n))).toBe(true)
    expect(compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/ideogram/v3', subject: 'A mill' })!.params.negative_prompt).toBeTruthy()
  })

  it('edit models: up to four type references as image_urls', () => {
    const b = foundersWorld(POINTER)
    const c = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/nano-banana/edit', schema: { properties: { prompt: {}, image_urls: {} } }, type: 'wildlife', subject: 'A red fox' })!
    expect(c.target).toBe('fal-edit')
    const urls = c.params.image_urls as string[]
    expect(urls).toHaveLength(LIMITS.editRefs)
    expect(urls[0]).toBe(`@file:${path.join(tmp, 'docs', 'art-references', 'meadow-sheep.png')}`)
    expect(c.prompt.startsWith('A red fox. ')).toBe(true)
    expect(c.prompt).toContain('reference images for style only')
    const noUrls = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/flux-3/edit', schema: { properties: { prompt: {}, image_url: {} } }, subject: 'x' })!
    expect(noUrls.params.image_urls).toBeUndefined()
  })

  it('recraft: colors from the palette, a short style line and the style_id when given', () => {
    const b = foundersWorld(POINTER)
    const c = compile({ bible: b, provider: 'fal', endpoint: 'recraft/v4/style/text-to-image', subject: 'A sword icon', styleId: 'st-1' })!
    expect(c.params.colors).toHaveLength(10)
    expect((c.params.colors as unknown[])[0]).toEqual({ r: 0xcb, g: 0xbf, b: 0x9f })
    expect(c.params.style_id).toBe('st-1')
    expect(c.prefix.length).toBeLessThanOrEqual(LIMITS.recraftStyle)
    const create = compile({ bible: b, provider: 'fal', endpoint: 'recraft/v4/create-style', type: 'building' })!
    expect(create.refs.map((r) => r.path).slice(0, 2)).toEqual(['docs/art-references/ironhearth-blacksmith.jpg', 'docs/art-references/asterhold-citadel.png'])
  })

  it('image2pixel: fixed_palette and max_colors from the palette, prompt untouched', () => {
    const b = foundersWorld(POINTER)
    const c = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/image2pixel', subject: '' })!
    expect(c.params.fixed_palette).toEqual(['#CBBF9F', '#8B9690', '#344F60', '#B79757', '#776048', '#627D4D', '#779354', '#91AA67', '#53D9D1', '#EF8B36'])
    expect(c.params.max_colors).toBe(10)
    expect(c.prompt).toBe('')
    const rgb = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/image2pixel', schema: { properties: { fixed_palette: { type: 'array', items: { type: 'object' } } } } })!
    expect((rgb.params.fixed_palette as unknown[])[0]).toEqual({ r: 0xcb, g: 0xbf, b: 0x9f })
    expect(rgb.params.max_colors).toBeUndefined()
  })

  it('audio, voice and animation get only their own section, never the visual style', () => {
    const b = nativeWorld()
    const audio = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/elevenlabs/sound-effects', type: 'building', subject: 'Door creak' })!
    expect(audio).toMatchObject({ type: 'audio', prompt: 'Door creak. Warm acoustic medieval; soft transients.', params: {}, refs: [], palette: [] })
    const voice = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/elevenlabs/tts/v3', subject: 'Hello' })!
    expect(voice.prompt).toBe('Hello')
    expect(voice.notes[0]).toMatch(/no Voice section/)
    const f = foundersWorld(POINTER)
    const motion = compile({ bible: f, provider: 'uthana', subject: 'sheep idle' })!
    expect(motion.prompt).toBe('sheep idle. Soft, cozy, small bobs.')
    for (const c of [audio, voice, motion]) expect(c.prompt).not.toMatch(/limestone|slate|Style:|Avoid/i)
  })

  it('3D: the 3D models line and model defaults only', () => {
    const b = nativeWorld(NATIVE.replace('## Weather', '## 3D models\nLow segment counts, smooth normals on round forms.\n## Weather'))
    const c = compile({ bible: b, provider: 'fal', endpoint: 'fal-ai/meshy/v6/text-to-3d', subject: 'A barrel' })!
    expect(c.prompt).toBe('A barrel. 3D: Low segment counts, smooth normals on round forms. Model: glb <=10k tris.')
    expect(c.palette).toEqual([])
  })
})

describe('write helpers', () => {
  it('writes a valid bible and refuses one that would not compile', () => {
    put('docs/ART_DIRECTION.md', fs.readFileSync(FOUNDERS_DOC))
    const b = writeArtBible(tmp, '---\nsource: docs/ART_DIRECTION.md\n---\n# Art Bible\n')!
    expect(b.palette).toHaveLength(10)
    expect(readArtBibleText(tmp)).toBe('---\nsource: docs/ART_DIRECTION.md\n---\n# Art Bible\n')
    expect(fs.readFileSync(path.join(tmp, 'docs', 'ART_DIRECTION.md'))).toEqual(fs.readFileSync(FOUNDERS_DOC))
    expect(() => writeArtBible(tmp, '---\nsource: docs/nope.md\n---\n')).toThrow(/Not written/)
    expect(readArtBibleText(tmp)).toContain('docs/ART_DIRECTION.md')
  })
})

describe('genio-art CLI', () => {
  const run = (args: string[]): Promise<{ code: number; out: any; err: string }> => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: tmp }, (e, stdout, stderr) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0
      let out: any = null
      try { out = JSON.parse(stdout) } catch { out = stdout }
      resolve({ code, out, err: stderr })
    })
  })

  it('shows, compiles, ranks refs and checks without writing anything', async () => {
    foundersWorld(POINTER)
    const before = fs.readFileSync(path.join(tmp, '.genio', 'art-bible.md'), 'utf8')
    const show = await run(['show', '--world', tmp])
    expect(show.code).toBe(0)
    expect(show.out.origins.palette).toBe('docs/ART_DIRECTION.md')
    expect((await run(['show', '--world', tmp, '--brief'])).out).toMatchObject({ palette: 10, references: 15, checklist: 7, accents: 2 })
    const c = await run(['compile', '--world', tmp, '--provider', 'codex', '--type', 'building', '--subject', 'A windmill'])
    expect(c.out.refs).toHaveLength(2)
    expect(c.out.prompt.startsWith('A windmill')).toBe(true)
    expect((await run(['refs', '--world', tmp, '--type', 'wildlife', '--limit', '1'])).out.refs[0].path).toBe('docs/art-references/meadow-sheep.png')
    expect((await run(['check', '--world', tmp])).out.ok).toBe(true)
    expect(fs.readFileSync(path.join(tmp, '.genio', 'art-bible.md'), 'utf8')).toBe(before)
  })

  it('prints null without a bible, exits 3 on an invalid one and 2 on usage errors', async () => {
    expect((await run(['compile', '--world', tmp, '--provider', 'codex', '--subject', 'x'])).out).toBeNull()
    put('.genio/art-bible.md', '---\nsource: ../out.md\n---\n# B\n')
    const check = await run(['check', '--world', tmp])
    expect(check.code).toBe(3)
    expect(check.out.ok).toBe(false)
    expect((await run(['compile', '--world', tmp])).code).toBe(3)
    expect((await run(['show'])).code).toBe(2)
    expect((await run(['import', '--world', tmp])).code).toBe(2)
  })
})
