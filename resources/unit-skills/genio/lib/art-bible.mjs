/**
 * A project's Art Bible: `.genio/art-bible.md`, committed markdown with a small
 * front matter. Node 18+, standard library only; shared by Genio's main
 * process, the unit helpers and the `genio-art` CLI.
 *
 *   ---
 *   schema: genio.art-bible.v1
 *   kind: game-3d-stylized            template id (optional)
 *   source: docs/ART_DIRECTION.md     optional: adopt an existing doc in place
 *   avoid: [photo textures, grunge]
 *   defaults: { image: png 1:1 1024, model: glb <=10k tris }
 *   ---
 *   # Art Bible: <name>
 *   ## Style · ## Palette (table) · ### Accents · ## References (captioned images)
 *   ## Do · ## Don't · ## <asset type> (Buildings, Wildlife, Audio, ...) · ## Review checklist
 *
 * A reference is a markdown image; its title carries `role type weight`
 * (`"style buildings 3"`). Untitled, it is a style reference at weight 1 for
 * the asset type of the section it sits in, or for every type.
 *
 * A project has a bible only when `.genio/art-bible.md` exists and is not
 * empty; nothing here looks for other docs. With `source:` the bible is a thin
 * pointer to an existing doc, which stays where it is and is never written
 * (founders-of-avalon's docs/ART_DIRECTION.md parses as it is). Both merge into one resolved bible:
 * the source wins on style, palette, references and checklist; the pointer
 * adds accents, avoid terms, reference weights and per-type notes. Every part
 * records the file it came from (`origins`, and `origin` on each item).
 *
 * compile() turns the resolved bible into what one provider can use: the full
 * style text and two references for Codex, the subject first and a short style
 * line for text-only FAL models, image_urls for edit models, colors for
 * Recraft, fixed_palette for Image2Pixel, and only their own section for
 * audio, voice and animation.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ART_BIBLE_SCHEMA = 'genio.art-bible.v1'
export const BIBLE_FILE = '.genio/art-bible.md'

export const LIMITS = Object.freeze({
  warnBytes: 16 * 1024, maxBytes: 64 * 1024, refs: 24, summary: 400, typeLine: 300, avoid: 20,
  codexStyle: 1200, codexPrompt: 4000, codexRefs: 2, falStyle: 350, editRefs: 4, recraftStyle: 200, recraftRefs: 4
})

export class ArtBibleError extends Error {}

/** Asset types, in screen order, and the heading or reference words that name them. */
export const ASSET_TYPES = Object.freeze({
  concepts: { title: 'Concepts', words: ['concept', 'concepts', 'concept art'] },
  sprites: { title: 'Sprites & icons', words: ['sprite', 'sprites', 'icon', 'icons', 'sprites and icons', 'icons and sprites', 'items'] },
  ui: { title: 'UI', words: ['ui', 'hud', 'interface', 'user interface'] },
  textures: { title: 'Textures', words: ['texture', 'textures', 'material', 'materials', 'materials and textures'] },
  models: { title: '3D models', words: ['3d', '3d model', '3d models', 'model', 'models', 'props'] },
  buildings: { title: 'Buildings', words: ['building', 'buildings', 'architecture'] },
  characters: { title: 'Characters', words: ['character', 'characters', 'npc', 'npcs'] },
  wildlife: { title: 'Wildlife', words: ['wildlife', 'animal', 'animals', 'creature', 'creatures'] },
  audio: { title: 'Audio', words: ['audio', 'sfx', 'sound', 'sounds', 'sound effects'] },
  music: { title: 'Music', words: ['music', 'soundtrack'] },
  voice: { title: 'Voice', words: ['voice', 'voices', 'vo', 'dialogue'] },
  animation: { title: 'Animation', words: ['animation', 'animations', 'motion'] }
})

const ROLES = ['style', 'subject', 'layout']

// ------------------------------------------------------------------ helpers

/** The git blob id of a file's bytes (`git hash-object`), the bible's version. */
export const gitBlobSha = (buf) => {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
}

const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/&/g, ' and ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
const slug = (s) => norm(s).replace(/'/g, '').replace(/ /g, '-')
const uniq = (items, key = (x) => String(x).toLowerCase()) => {
  const seen = new Set()
  return items.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)))
}

/** Markdown inline → plain text: images dropped, links to their text, emphasis and code marks removed. */
export function plainText(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Shorten to `max` characters: at a sentence end when one is near, else at a word with an ellipsis. */
export function clip(text, max) {
  const t = String(text ?? '').trim()
  if (t.length <= max) return t
  if (max <= 1) return ''
  const head = t.slice(0, max + 1)
  const sentence = Math.max(...['. ', '! ', '? ', '; '].map((p) => head.lastIndexOf(p)))
  if (sentence >= max * 0.4) return t.slice(0, sentence + 1).replace(/;$/, '.')
  const space = t.lastIndexOf(' ', max - 1)
  return (space > max * 0.4 ? t.slice(0, space) : t.slice(0, max - 1)).replace(/[\s,;:.]+$/, '') + '…'
}

/** The asset type a heading or word names (`Wildlife and beach props` → wildlife), or null. */
export function typeOfHeading(title) {
  const n = norm(title)
  for (const [id, t] of Object.entries(ASSET_TYPES)) if (t.words.includes(n)) return id
  const first = n.split(' ')[0]
  for (const [id, t] of Object.entries(ASSET_TYPES)) if (t.words.includes(first)) return id
  return null
}

/** A requested asset type as its canonical id: a known type (`building` → buildings) or a custom section slug. */
export function normalizeType(t) {
  if (t == null || !String(t).trim()) return null
  const n = norm(t)
  for (const [id, x] of Object.entries(ASSET_TYPES)) if (id === n || x.words.includes(n)) return id
  return slug(t)
}

function sectionRole(title) {
  const n = norm(title)
  if (/^(style|summary|overview|visual style|look and feel|art style)$/.test(n)) return 'style'
  if (/^(accents?|accent colou?rs?|accent palette)$/.test(n)) return 'accents'
  if (/\bpalettes?\b|^colou?rs?$/.test(n)) return 'palette'
  if (/^(references?|reference images?|style references?|moodboard|mood board)$/.test(n)) return 'references'
  if (/^(do|dos|do's)$/.test(n)) return 'do'
  if (/^(don't|dont|don'ts|donts|do not)$/.test(n)) return 'dont'
  if (/\bchecklist\b/.test(n)) return 'checklist'
  return null
}

// --------------------------------------------------------------- front matter

function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(line[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1])) && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      return line.slice(0, i).trimEnd()
    }
  }
  return line.trimEnd()
}

function splitTop(s) {
  const out = []
  let depth = 0, quote = '', cur = ''
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function scalar(raw) {
  const s = raw.trim()
  if (/^"(.*)"$/.test(s) || /^'(.*)'$/.test(s)) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map(scalar)
  if (s.startsWith('{') && s.endsWith('}')) {
    const o = {}
    for (const pair of splitTop(s.slice(1, -1))) {
      const m = /^([^:]+):(.*)$/.exec(pair)
      if (!m) throw new ArtBibleError(`not a key: value pair: "${pair}"`)
      o[scalar(m[1])] = scalar(m[2])
    }
    return o
  }
  if (s === 'true' || s === 'false') return s === 'true'
  if (s === 'null' || s === '~' || s === '') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

/**
 * Split `---` front matter off a markdown text. Supports the flat YAML subset
 * the bible uses: `key: value`, inline `[a, b]` lists and `{ k: v }` maps,
 * indented `- item` lists and `k: v` maps under a bare `key:`, quotes and
 * `# comments` (a `#` followed by a hex digit is a colour, not a comment).
 */
export function parseFrontMatter(text) {
  const t = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!/^---[ \t]*\n/.test(t)) return { data: {}, body: t, lines: 0, errors: [] }
  const lines = t.split('\n')
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l))
  if (end < 0) return { data: {}, body: t, lines: 0, errors: ['The front matter has no closing "---" line.'] }
  const data = {}, errors = []
  let open = null
  for (let i = 1; i < end; i++) {
    const line = stripComment(lines[i])
    if (!line.trim()) continue
    const indented = /^\s/.test(line)
    try {
      if (indented && open) {
        const item = /^\s+-\s*(.*)$/.exec(line)
        const pair = /^\s+([^:]+):(.*)$/.exec(line)
        if (item && (open.list || !open.map)) {
          open.list ??= []
          open.list.push(scalar(item[1]))
        } else if (pair && !open.list) {
          open.map ??= {}
          open.map[scalar(pair[1])] = scalar(pair[2])
        } else throw new ArtBibleError(`cannot read "${line.trim()}"`)
        data[open.key] = open.list ?? open.map
        continue
      }
      const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
      if (!m) throw new ArtBibleError(`cannot read "${line.trim()}"`)
      open = null
      if (m[2].trim()) data[m[1]] = scalar(m[2])
      else {
        data[m[1]] = null
        open = { key: m[1] }
      }
    } catch (e) {
      errors.push(`Front matter line ${i + 1}: ${e.message}.`)
    }
  }
  return { data, body: lines.slice(end + 1).join('\n'), lines: end + 1, errors }
}

// ------------------------------------------------------------------ markdown

const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi
const hexOf = (h) => {
  const x = h.slice(1).toUpperCase()
  return '#' + (x.length === 3 ? [...x].map((c) => c + c).join('') : x)
}
const IMAGE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/g
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

/** Paragraphs, list items and table rows of a section body (code fences already removed). */
function blocksOf(lines) {
  const paragraphs = [], items = [], rows = []
  let para = null, item = false
  for (const line of lines) {
    if (!line.trim()) {
      para = null
      item = false
      continue
    }
    if (/^\s*\|/.test(line)) {
      rows.push(line)
      para = null
      item = false
      continue
    }
    const li = LIST_ITEM.exec(line)
    if (li) {
      items.push(li[1])
      item = true
      para = null
    } else if (item) items[items.length - 1] += ' ' + line.trim()
    else if (para) para.push(line.trim())
    else paragraphs.push((para = [line.trim()]))
  }
  return { paragraphs: paragraphs.map((p) => plainText(p.join(' '))).filter(Boolean), items: items.map(plainText).filter(Boolean), rows }
}

/** Colour entries from table rows (`| Role | `#hex` | Use |`) and list items (`- Role #hex: use`). */
function colorsOf(lines, origin) {
  const out = []
  const { rows, items } = blocksOf(lines)
  for (const row of rows) {
    if (/^\s*\|?\s*:?-{2,}/.test(row)) continue
    const cells = row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const hexes = [...row.matchAll(HEX)].map((m) => hexOf(m[0]))
    if (!hexes.length) continue
    const text = cells.map((c) => plainText(c.replace(HEX, ''))).map((c) => c.replace(/^[\s,/]+|[\s,/]+$/g, ''))
    const nameAt = text.findIndex(Boolean)
    const name = nameAt >= 0 ? text[nameAt] : hexes[0]
    const useAt = text.findLastIndex((c, i) => c && i !== nameAt && !HEX.test(cells[i]))
    const use = useAt >= 0 ? text[useAt] : ''
    for (const hex of hexes) out.push({ name, hex, use, origin })
  }
  for (const it of items) {
    const hexes = [...it.matchAll(HEX)].map((m) => hexOf(m[0]))
    if (!hexes.length) continue
    const [before, ...after] = it.split(HEX)
    const name = before.replace(/[\s:,(–—-]+$/, '').trim() || hexes[0]
    const use = it.slice(it.lastIndexOf(after.at(-1) ?? '')).replace(/^[\s:,()–—-]+|[\s)]+$/g, '').trim()
    for (const hex of hexes) out.push({ name, hex, use: HEX.test(use) ? '' : use, origin })
  }
  return out
}

/** Text of a section: its paragraphs, else its list items joined. */
function textOf(lines) {
  const { paragraphs, items } = blocksOf(lines)
  return paragraphs.length ? paragraphs.join(' ') : items.join('; ')
}

/** A world-relative POSIX path for `href` as written in `file`, or a reason it has none. */
function resolveHref(file, href) {
  let h = href.replace(/^<|>$/g, '')
  try {
    h = decodeURI(h)
  } catch {
    /* keep the raw text */
  }
  if (/^(https?:|data:)/i.test(h)) return { external: true }
  if (/^[a-z]:[\\/]/i.test(h) || h.startsWith('//') || h.startsWith('\\')) return { outside: true }
  h = h.replace(/\\/g, '/').replace(/[?#].*$/, '')
  const joined = h.startsWith('/') ? h.slice(1) : path.posix.join(path.posix.dirname(file), h)
  const rel = path.posix.normalize(joined)
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) return { outside: true }
  return { path: rel }
}

function refTitle(title, issues, file) {
  const out = { role: 'style', types: [], weight: 1 }
  for (const tok of String(title ?? '').trim().split(/[\s,]+/).filter(Boolean)) {
    const n = tok.toLowerCase()
    if (ROLES.includes(n)) out.role = n
    else if (/^[1-3]$/.test(n)) out.weight = Number(n)
    else if (n === 'all' || n === '*') out.types = []
    else {
      const t = normalizeType(n)
      if (t && ASSET_TYPES[t]) out.types.push(t)
      else if (title) issues.push({ level: 'warning', file, message: `Reference title "${title}": "${tok}" is not a role (style, subject, layout), an asset type or a weight 1-3.` })
    }
  }
  out.types = uniq(out.types)
  return out
}

/**
 * Parse one markdown document (a bible, pointer or adopted source doc) without
 * touching the disk. `file` is its project-relative POSIX path; references are
 * resolved against it. `custom` lets unknown level-2 headings become custom
 * per-type sections (used for the bible itself, not for an adopted doc).
 */
export function parseArtBible(text, { file = BIBLE_FILE, custom = false, bytes } = {}) {
  const raw = String(text)
  const size = bytes ?? Buffer.byteLength(raw)
  const issues = []
  if (size > LIMITS.maxBytes) issues.push({ level: 'error', file, message: `${file} is ${Math.round(size / 1024)} KB; the limit is ${LIMITS.maxBytes / 1024} KB. Shorten it before Genio can compile it.` })
  else if (size > LIMITS.warnBytes) issues.push({ level: 'warning', file, message: `${file} is ${Math.round(size / 1024)} KB (over ${LIMITS.warnBytes / 1024} KB); generators use only its compiled summary.` })
  const fm = parseFrontMatter(raw)
  for (const e of fm.errors) issues.push({ level: 'error', file, message: `${file}: ${e}` })
  const front = fm.data
  if (front.schema != null && front.schema !== ART_BIBLE_SCHEMA) issues.push({ level: 'warning', file, message: `${file}: unknown schema "${front.schema}" (expected ${ART_BIBLE_SCHEMA}).` })

  // Headings and bodies; fenced code and HTML comments carry no bible content.
  const body = fm.body.replace(/<!--[\s\S]*?-->/g, '')
  const sections = [{ level: 0, title: '', lines: [] }]
  let fence = null
  for (const line of body.split('\n')) {
    const f = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (f) {
      fence = f[1]
      continue
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) sections.push({ level: h[1].length, title: plainText(h[2]), lines: [] })
    else sections.at(-1).lines.push(line)
  }
  const titleAt = sections.findIndex((s) => s.level === 1)
  const doc = {
    file, bytes: size, blob: null, front, title: titleAt > 0 ? sections[titleAt].title : null,
    style: null, palette: [], accents: [], references: [], do: [], dont: [], checklist: [], types: {}, issues
  }

  let paletteFound = false
  for (const [i, s] of sections.entries()) {
    if (i === titleAt || s.level === 0) continue
    const role = sectionRole(s.title)
    if (role === 'style' && !doc.style) {
      const t = textOf(s.lines)
      if (t) doc.style = { title: s.title, summary: clip(t, LIMITS.summary), text: t }
    } else if (role === 'palette') {
      paletteFound = true
      doc.palette.push(...colorsOf(s.lines, file))
    } else if (role === 'accents') doc.accents.push(...colorsOf(s.lines, file))
    else if (role === 'do' || role === 'dont') {
      const b = blocksOf(s.lines)
      doc[role].push(...(b.items.length ? b.items : b.paragraphs))
    } else if (role === 'checklist' && !doc.checklist.length) doc.checklist = blocksOf(s.lines).items
    else if (!role) {
      const known = typeOfHeading(s.title)
      const id = known ?? (custom && s.level === 2 ? slug(s.title) : null)
      const t = id && textOf(s.lines)
      if (t && !doc.types[id]) doc.types[id] = { title: s.title, line: clip(t, LIMITS.typeLine), text: t, custom: !known }
    }
    // References: every image in the document, typed by the section it sits in.
    const sectionType = role ? null : typeOfHeading(s.title)
    for (const line of s.lines) {
      for (const m of line.matchAll(IMAGE)) {
        const at = resolveHref(file, m[2])
        const title = m[3] ?? m[4]
        const ref = { path: at.path ?? null, href: m[2].replace(/^<|>$/g, ''), caption: plainText(m[1]), ...refTitle(title, issues, file), titled: title != null, section: s.title, section_type: sectionType, origin: file, weight_origin: file, exists: null, external: !!at.external }
        if (at.outside) issues.push({ level: 'warning', file, message: `Reference ${ref.href} lies outside the project and is ignored.` })
        else doc.references.push(ref)
      }
    }
  }
  // A palette table outside a Palette heading still counts (accents excluded).
  if (!paletteFound) {
    const accentLines = new Set(sections.filter((s) => sectionRole(s.title) === 'accents').flatMap((s) => s.lines))
    doc.palette = colorsOf(sections.flatMap((s) => s.lines.filter((l) => !accentLines.has(l))), file)
  }
  if (!doc.style) {
    const intro = textOf((sections[titleAt > 0 ? titleAt : 0] ?? sections[0]).lines)
    if (intro) doc.style = { title: null, summary: clip(intro, LIMITS.summary), text: intro }
  }
  const avoid = front.avoid == null ? [] : Array.isArray(front.avoid) ? front.avoid : [front.avoid]
  doc.avoid = avoid.filter((x) => x != null && String(x).trim()).map((x) => String(x).trim())
  return doc
}

// --------------------------------------------------------------------- merge

const filesOf = (items) => uniq(items.map((x) => x.origin).filter(Boolean))

/**
 * Merge a parsed bible with its parsed source doc (or null) into the resolved
 * bible. The source wins on style, palette, references and checklist; the
 * bible adds accents, avoid terms, reference weights, do/don't lines and
 * per-type notes. `origins` names the file behind every part.
 */
export function mergeArtBible(bible, source = null) {
  const src = source ?? null
  const pick = (key, has) => (src && has(src[key]) ? src : has(bible[key]) ? bible : null)
  const nonEmpty = (v) => Array.isArray(v) ? v.length > 0 : v != null
  const styleFrom = pick('style', nonEmpty)
  const paletteFrom = pick('palette', nonEmpty)
  const checklistFrom = pick('checklist', nonEmpty)
  const issues = [...(src?.issues ?? []), ...bible.issues]

  // References: the source's set and captions; the bible's matching entries set role, types and weight.
  let references = (src ?? bible).references.map((r) => ({ ...r }))
  if (src) {
    for (const r of bible.references) {
      const same = r.path && references.find((x) => x.path === r.path)
      if (same) {
        if (r.titled) Object.assign(same, { role: r.role, types: r.types, weight: r.weight, titled: true, weight_origin: r.origin })
        if (!same.caption && r.caption) same.caption = r.caption
      } else references.push({ ...r })
    }
  }
  references = uniq(references, (r) => r.path ?? r.href)
  if (references.length > LIMITS.refs) {
    issues.push({ level: 'warning', file: bible.file, message: `${references.length} references; only the first ${LIMITS.refs} are used.` })
    references = references.slice(0, LIMITS.refs)
  }

  const accents = uniq([...bible.accents, ...(src?.accents ?? [])], (c) => c.hex)
  let avoid = uniq([...(src?.avoid ?? []), ...bible.avoid])
  if (avoid.length > LIMITS.avoid) {
    issues.push({ level: 'warning', file: bible.file, message: `${avoid.length} avoid terms; only the first ${LIMITS.avoid} are used.` })
    avoid = avoid.slice(0, LIMITS.avoid)
  }
  const lines = (key) => uniq([...(src?.[key] ?? []).map((t) => ({ t, origin: src.file })), ...bible[key].map((t) => ({ t, origin: bible.file }))], (x) => x.t.toLowerCase())
  const doLines = lines('do'), dontLines = lines('dont')

  // Per-type notes: the bible's own line wins over the source's section.
  const types = {}, typeOrigins = {}
  for (const doc of [bible, src]) {
    for (const [id, t] of Object.entries(doc?.types ?? {})) {
      if (types[id]) continue
      types[id] = { ...t, origin: doc.file }
      typeOrigins[id] = doc.file
    }
  }

  const kind = bible.front.kind ?? src?.front.kind ?? null
  const defaults = { ...(src?.front.defaults && typeof src.front.defaults === 'object' ? src.front.defaults : {}), ...(bible.front.defaults && typeof bible.front.defaults === 'object' ? bible.front.defaults : {}) }
  const avoidOrigins = uniq([...(src?.avoid.length ? [src.file] : []), ...(bible.avoid.length ? [bible.file] : [])])

  return {
    schema: ART_BIBLE_SCHEMA,
    path: bible.file,
    source: src ? { path: src.file, blob: src.blob, bytes: src.bytes } : null,
    version: { blob: bible.blob, source_blob: src?.blob ?? null },
    title: src?.title ?? bible.title,
    kind,
    defaults,
    style: styleFrom?.style ?? null,
    palette: paletteFrom?.palette ?? [],
    accents,
    references,
    avoid,
    do: doLines.map((x) => x.t),
    dont: dontLines.map((x) => x.t),
    checklist: checklistFrom?.checklist ?? [],
    types,
    origins: {
      title: src?.title ? src.file : bible.title ? bible.file : null,
      kind: bible.front.kind != null ? bible.file : src?.front.kind != null ? src.file : null,
      defaults: uniq([...(src && src.front.defaults ? [src.file] : []), ...(bible.front.defaults ? [bible.file] : [])]),
      style: styleFrom?.file ?? null,
      palette: paletteFrom?.file ?? null,
      accents: filesOf(accents),
      references: filesOf(references),
      reference_weights: uniq(references.filter((r) => r.titled).map((r) => r.weight_origin)),
      avoid: avoidOrigins,
      do: filesOf(doLines),
      dont: filesOf(dontLines),
      checklist: checklistFrom?.file ?? null,
      types: typeOrigins
    },
    issues
  }
}

// ---------------------------------------------------------------------- disk

function readText(file) {
  const buf = fs.readFileSync(file)
  return { buf, text: buf.toString('utf8').replace(/^﻿/, '') }
}

const insideProject = (root, rel) => {
  const abs = path.resolve(root, ...rel.split('/'))
  const r = path.relative(root, abs)
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null
}

/** The validated project-relative path of a `source:` value, or an error message. */
function sourcePath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return { error: '`source:` must be a project-relative path to a markdown file.' }
  const v = value.trim().replace(/\\/g, '/')
  if (/^[a-z]:\//i.test(v) || v.startsWith('/')) return { error: `\`source: ${v}\` must be relative to the project root.` }
  const rel = path.posix.normalize(v)
  if (rel.startsWith('../') || rel === '..' || rel.split('/').includes('.git')) return { error: `\`source: ${v}\` must stay inside the project.` }
  if (rel === BIBLE_FILE) return { error: '`source:` cannot point at the Art Bible itself.' }
  if (!/\.(md|markdown)$/i.test(rel)) return { error: `\`source: ${v}\` must be a markdown file.` }
  const abs = insideProject(root, rel)
  if (!abs) return { error: `\`source: ${v}\` must stay inside the project.` }
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) return { error: `\`source: ${rel}\` does not exist.` }
  return { rel, abs }
}

/**
 * The project's resolved Art Bible, or null when `.genio/art-bible.md` is
 * missing or empty. `text` stands in for the file (checking an edit before it
 * is written); `file` reads the bible from elsewhere, such as a unit's launch
 * snapshot (GENIO_ART_BIBLE), while its references and `source:` still
 * resolve in `root`. Reference files are checked on disk; missing ones are
 * reported and never sent to a generator.
 */
export function loadArtBible(root, { text, file } = {}) {
  const rootAbs = path.resolve(root)
  if (!fs.statSync(rootAbs, { throwIfNoEntry: false })?.isDirectory()) throw new ArtBibleError(`Project folder not found: ${rootAbs}`)
  let buf
  if (text != null) buf = Buffer.from(String(text), 'utf8')
  else {
    try {
      buf = readText(file ? path.resolve(file) : path.join(rootAbs, '.genio', 'art-bible.md')).buf
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  const raw = buf.toString('utf8').replace(/^﻿/, '')
  if (!raw.trim()) return null
  const bible = parseArtBible(raw, { file: BIBLE_FILE, custom: true, bytes: buf.length })
  bible.blob = gitBlobSha(buf)
  let source = null
  if (bible.front.source != null) {
    const s = sourcePath(rootAbs, bible.front.source)
    if (s.error) bible.issues.push({ level: 'error', file: BIBLE_FILE, message: s.error })
    else {
      const { buf: sbuf, text: stext } = readText(s.abs)
      source = parseArtBible(stext, { file: s.rel, bytes: sbuf.length })
      source.blob = gitBlobSha(sbuf)
      if (source.front.source != null) source.issues.push({ level: 'warning', file: s.rel, message: `${s.rel} has its own \`source:\`; adopted docs are not followed further.` })
    }
  }
  const resolved = mergeArtBible(bible, source)
  resolved.root = rootAbs
  for (const r of resolved.references) {
    if (r.external || !r.path) continue
    const abs = insideProject(rootAbs, r.path)
    r.exists = !!abs && !!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()
    if (!r.exists) resolved.issues.push({ level: 'warning', file: r.origin, message: `Reference ${r.path} is missing; it is skipped.` })
  }
  return resolved
}

/** Counts for a quick look (the CLI's `show --brief`). */
export function summarize(bible) {
  if (!bible) return null
  return {
    path: bible.path, source: bible.source?.path ?? null, version: bible.version, title: bible.title, kind: bible.kind,
    style: bible.style?.summary ?? null, palette: bible.palette.length, accents: bible.accents.length,
    references: bible.references.length, missing_references: bible.references.filter((r) => r.exists === false).map((r) => r.path),
    checklist: bible.checklist.length, avoid: bible.avoid.length, do: bible.do.length, dont: bible.dont.length,
    types: Object.keys(bible.types), errors: bible.issues.filter((i) => i.level === 'error').length,
    warnings: bible.issues.filter((i) => i.level === 'warning').length
  }
}

// --------------------------------------------------------------------- write

/** The raw text of `.genio/art-bible.md`, or null when the project has none. */
export function readArtBibleText(root) {
  try {
    return readText(path.join(path.resolve(root), '.genio', 'art-bible.md')).text
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

/**
 * Write `.genio/art-bible.md` (a plain file edit; Genio never commits it).
 * The text is checked first: a bible that would not compile is refused, and
 * so is a `source:` that does not resolve. Returns the resolved bible.
 */
export function writeArtBible(root, text) {
  const rootAbs = path.resolve(root)
  const bible = loadArtBible(rootAbs, { text })
  const errors = bible?.issues.filter((i) => i.level === 'error') ?? []
  if (errors.length) throw new ArtBibleError(`Not written: ${errors.map((e) => e.message).join(' ')}`)
  const target = path.join(rootAbs, '.genio', 'art-bible.md')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, String(text), 'utf8')
  return loadArtBible(rootAbs)
}

// ------------------------------------------------------------------ compile

const SOUND = ['audio', 'music', 'voice']

/**
 * Which compile rules a generation follows: codex, fal-text, fal-edit,
 * recraft, recraft-style, image2pixel, 3d, audio, music, voice or animation.
 */
export function targetOf({ provider, endpoint } = {}) {
  const p = String(provider ?? '').trim().toLowerCase()
  const e = String(endpoint ?? '').trim().toLowerCase()
  if (p === 'codex') return 'codex'
  if (p === 'uthana' || p === 'animation') return 'animation'
  if ([...SOUND, '3d'].includes(p)) return p
  if (!e) {
    if (p === 'fal') return 'fal-text'
    if (!p) return 'codex'
    throw new ArtBibleError(`Unknown provider "${provider}" (use codex, fal with an endpoint, or uthana).`)
  }
  if (/image2pixel/.test(e)) return 'image2pixel'
  if (/recraft.*create-style/.test(e)) return 'recraft-style'
  if (/recraft/.test(e)) return 'recraft'
  if (/meshy|hunyuan-?3d|trellis|tripo|rodin|hyper3d|(^|\/)3d|to-3d|image-to-3d|text-to-3d/.test(e)) return '3d'
  if (/tts|text-to-speech|speech|voice|kokoro|dia-tts|chatterbox/.test(e)) return 'voice'
  if (/music|lyria|stable-audio|ace-step|cassette|diffrhythm|beatoven/.test(e)) return 'music'
  if (/audio|sfx|sound|mmaudio|elevenlabs/.test(e)) return 'audio'
  if (/(^|[/-])edit($|[/-])|kontext|nano-banana.*edit|multi|reference|redux/.test(e)) return 'fal-edit'
  return 'fal-text'
}

const propsOf = (schema) => {
  if (!schema) return null
  if (Array.isArray(schema)) return Object.fromEntries(schema.map((k) => [k, {}]))
  if (typeof schema !== 'object') return null
  return schema.properties && typeof schema.properties === 'object' ? schema.properties : schema
}

/** Whether an endpoint's input takes `key`: from its schema when given, else from what the endpoint is known to accept. */
function takes(schema, key, endpoint, guess) {
  const props = propsOf(schema)
  if (props) return Object.prototype.hasOwnProperty.call(props, key)
  return guess.test(String(endpoint ?? '').toLowerCase())
}

const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`)
const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)

/** Palette entries grouped by name (`foliage greens #627D4D/#779354`), in three detail levels. */
function paletteTexts(colors) {
  const groups = []
  for (const c of colors) {
    const g = groups.find((x) => x.name === c.name)
    if (g) g.hexes.push(c.hex)
    else groups.push({ name: c.name, hexes: [c.hex], use: c.use })
  }
  return [
    groups.map((g) => `${lc(g.name)} ${g.hexes.join('/')}${g.use ? ` (${lc(g.use)})` : ''}`).join(', '),
    groups.map((g) => `${lc(g.name)} ${g.hexes.join('/')}`).join(', '),
    groups.map((g) => lc(g.name)).join(', ')
  ]
}

/**
 * Fit text parts into a budget. Each part has `alts` (most to least detailed;
 * null drops it). Steps run in order until the counted parts fit: `next:key`
 * moves to the next alternative, `clip:key` shortens it, `drop:key` removes it.
 */
function fit(parts, budget, steps, { counted = () => true, sep = '\n', notes } = {}) {
  const live = () => parts.filter((p) => p.alts[p.i] && counted(p))
  const size = () => live().map((p) => p.alts[p.i]).join(sep).length
  for (const step of steps) {
    if (size() <= budget) break
    const [op, key] = step.split(':')
    const p = parts.find((x) => x.key === key && x.alts[x.i])
    if (!p) continue
    if (op === 'next' && p.i < p.alts.length - 1) p.i++
    else if (op === 'drop') p.i = p.alts.length
    else if (op === 'clip') {
      const over = size() - budget
      const t = p.alts[p.i]
      const keep = Math.max(80, t.length - over)
      p.alts = [...p.alts.slice(0, p.i), clip(t, keep), ...p.alts.slice(p.i + 1)]
    } else continue
    notes?.push(`Shortened to fit ${budget} characters: ${op === 'next' ? 'less detail in' : op === 'clip' ? 'clipped' : 'dropped'} ${key}.`)
  }
  if (size() > budget) {
    const last = live().at(-1)
    if (last && !last.fixed) {
      const others = live().filter((p) => p !== last).map((p) => p.alts[p.i]).join(sep).length
      last.alts[last.i] = clip(last.alts[last.i], Math.max(0, budget - others - (others ? sep.length : 0)))
      notes?.push(`Shortened to fit ${budget} characters: clipped ${last.key}.`)
    }
  }
  return parts
}
const part = (key, ...alts) => ({ key, alts: alts.map((a) => a || null), i: 0 })
const textOfParts = (parts, sep, filter = () => true) => parts.filter((p) => p.alts[p.i] && filter(p)).map((p) => p.alts[p.i]).join(sep)

/**
 * References for an asset type, best first: titled for the type, then
 * untitled in that type's section, then untitled general ones; refs titled or
 * placed for another type are left out. Missing and external files never are.
 */
export function selectRefs(bible, type, limit = LIMITS.codexRefs) {
  if (!bible) return []
  const t = normalizeType(type)
  const ranked = []
  for (const [index, r] of bible.references.entries()) {
    if (r.external || !r.path || r.exists === false) continue
    let tier
    if (r.types.length) tier = !t ? 0 : r.types.includes(t) ? 3 : null
    else if (r.section_type) tier = !t ? 0 : r.section_type === t ? 2 : null
    else tier = 1
    if (tier != null) ranked.push({ r, tier, index })
  }
  ranked.sort((a, b) => b.tier - a.tier || b.r.weight - a.r.weight || ROLES.indexOf(a.r.role) - ROLES.indexOf(b.r.role) || a.index - b.index)
  return ranked.slice(0, limit).map((x) => x.r)
}

function refOut(bible, r) {
  const file = bible.root ? path.join(bible.root, ...r.path.split('/')) : null
  return { path: r.path, file, caption: r.caption, role: r.role, types: r.types, weight: r.weight }
}

function refNote(refs) {
  if (!refs.length) return ''
  const how = { style: 'style only, do not copy its subject', subject: 'keep this subject consistent', layout: 'follow its layout' }
  const list = refs.map((r, i) => `${i + 1}) ${clip(r.caption || path.posix.basename(r.path), 90)}${refs.every((x) => x.role === 'style') ? '' : ` [${how[r.role]}]`}`).join('; ')
  return sentence(refs.every((r) => r.role === 'style')
    ? `The attached images are STYLE references only; do not copy their subjects: ${list}`
    : `Attached references: ${list}`)
}

/** Resolve the requested asset type against the bible; unknown custom types are noted, not fatal. */
function typeFor(bible, requested, notes) {
  const t = normalizeType(requested)
  if (!t) return null
  if (!ASSET_TYPES[t] && !bible.types[t]) {
    notes.push(`The Art Bible has no "${requested}" section; only the general style applies.`)
    return null
  }
  return t
}

/**
 * Compile the Art Bible for one generation. Pass `world` (project root) or an
 * already loaded `bible`, plus `provider` (codex | fal | uthana), `endpoint`,
 * the endpoint's input `schema` when known, the asset `type` and the
 * `subject`. Returns the prompt (subject first), `prefix` (the compiled style
 * text that follows the subject), `negative`, `refs` (project-relative and
 * absolute paths), `palette`, provider `params` to merge into the input, what
 * was `applied`, `notes`, and the bible `version` for provenance. With no
 * bible (missing or empty file) it returns null: no style is applied.
 */
export function compile(opts = {}) {
  const target = targetOf(opts)
  const bible = opts.bible !== undefined ? opts.bible : opts.world ? loadArtBible(opts.world) : null
  if (!bible) return null
  const subject = plainText(opts.subject ?? '')
  const notes = []
  const out = { target, type: null, prompt: subject, prefix: '', negative: '', refs: [], palette: [], params: {}, applied: [], notes, version: null, path: null }
  const errors = bible.issues.filter((i) => i.level === 'error')
  if (errors.length) throw new ArtBibleError(`The Art Bible cannot be compiled: ${errors.map((e) => e.message).join(' ')}`)
  out.version = bible.version
  out.path = bible.path
  const endpoint = opts.endpoint
  const schema = opts.schema
  const withSubject = (style, sep = ' ') => (style ? (subject ? `${sentence(subject)}${sep}${style}` : style) : subject)

  // Audio, music, voice and animation: only their own section, never the visual style.
  if ([...SOUND, 'animation'].includes(target)) {
    const asked = normalizeType(opts.type)
    const type = target === 'animation' ? 'animation' : SOUND.includes(asked) ? asked : target
    out.type = type
    const line = bible.types[type]?.line
    if (line) {
      out.prefix = line
      out.applied.push('type')
    } else notes.push(`The Art Bible has no ${ASSET_TYPES[type].title} section; nothing applied.`)
    out.prompt = withSubject(out.prefix)
    return out
  }

  const type = typeFor(bible, opts.type, notes)
  out.type = type
  const typeEntry = type ? bible.types[type] : null
  const typeLine = typeEntry ? `${typeEntry.title}: ${typeEntry.line}` : ''
  const accentHexes = new Set(bible.accents.map((c) => c.hex))
  const base = bible.palette.filter((c) => !accentHexes.has(c.hex))
  out.palette = [...base.map((c) => ({ name: c.name, hex: c.hex })), ...bible.accents.map((c) => ({ name: c.name, hex: c.hex, accent: true }))]
  const summary = bible.style?.summary ?? ''

  if (target === '3d') {
    const models = bible.types.models
    const model = bible.defaults?.model
    out.prefix = [models ? `3D: ${models.line}` : '', model ? `Model: ${model}.` : ''].filter(Boolean).join(' ')
    if (models) out.applied.push('type')
    if (model) out.applied.push('defaults')
    if (!out.prefix) notes.push('The Art Bible has no 3D models section or model defaults; nothing applied.')
    notes.push('Image-to-3D: start from a concept image made with the Art Bible.')
    out.prompt = withSubject(out.prefix)
    out.palette = []
    return out
  }

  if (target === 'image2pixel') {
    const hexes = uniq(out.palette.map((c) => c.hex))
    if (hexes.length) {
      const items = propsOf(schema)?.fixed_palette?.items
      const asRgb = items && (items.type === 'object' || items.properties)
      out.params.fixed_palette = asRgb ? hexes.map(rgbOf) : hexes
      if (takes(schema, 'max_colors', endpoint, /image2pixel/)) out.params.max_colors = hexes.length
      out.applied.push('palette')
      if (!schema) notes.push('fixed_palette sent as hex strings; check the endpoint schema.')
    } else notes.push('The Art Bible has no palette; nothing applied.')
    out.prompt = subject
    return out
  }

  if (target === 'recraft-style') {
    out.refs = selectRefs(bible, type, LIMITS.recraftRefs).map((r) => refOut(bible, r))
    if (out.refs.length) out.applied.push('refs')
    notes.push('Create the style once per Art Bible version from these references and reuse its style_id.')
    return out
  }

  if (target === 'codex') {
    const [palFull, palHex, palNames] = paletteTexts(base)
    const [accFull, accHex, accNames] = paletteTexts(bible.accents)
    const parts = [
      { ...part('subject', subject), fixed: true },
      part('summary', summary && `Art direction: ${sentence(summary)}`),
      part('palette', palFull && `Palette: ${palFull}.`, palHex && `Palette: ${palHex}.`, palNames && `Palette: ${palNames}.`),
      part('accents', accFull && `Accents, small and local only: ${accFull}.`, accHex && `Accents, small and local only: ${accHex}.`, accNames && `Accents, small and local only: ${accNames}.`),
      part('do', bible.do.length && `Do: ${bible.do.join('; ')}.`),
      part('dont', bible.dont.length && `Don't: ${bible.dont.join('; ')}.`),
      part('avoid', bible.avoid.length && `Avoid: ${bible.avoid.join(', ')}.`),
      part('type', typeLine),
      part('refs', '')
    ]
    const STYLE = new Set(['summary', 'palette', 'accents', 'do', 'dont', 'avoid'])
    const drops = ['drop:do', 'drop:dont', 'next:palette', 'next:accents', 'next:palette', 'next:accents', 'clip:summary', 'drop:summary']
    fit(parts, LIMITS.codexStyle, drops, { counted: (p) => STYLE.has(p.key), notes })
    const refs = selectRefs(bible, type, LIMITS.codexRefs)
    parts.find((p) => p.key === 'refs').alts = [refNote(refs) || null]
    fit(parts, opts.limit ?? LIMITS.codexPrompt, ['drop:type', ...drops, 'drop:refs'], { notes })
    out.prompt = textOfParts(parts, '\n')
    out.prefix = textOfParts(parts, '\n', (p) => p.key !== 'subject')
    out.negative = bible.avoid.join(', ')
    if (parts.find((p) => p.key === 'refs').alts[0] && parts.find((p) => p.key === 'refs').i === 0) out.refs = refs.map((r) => refOut(bible, r))
    out.applied = appliedOf(parts, out.refs)
    return out
  }

  // FAL image models: subject first, then a short line of keywords and colour names (no hex lists).
  const [, , names] = paletteTexts(base)
  const [, , accentNames] = paletteTexts(bible.accents)
  const budget = target === 'recraft' ? LIMITS.recraftStyle : LIMITS.falStyle
  const parts = [
    part('summary', summary && `Style: ${sentence(summary)}`),
    part('type', typeLine && sentence(typeLine)),
    part('palette', names && `Colors: ${names}.`),
    part('accents', accentNames && `Small accents: ${accentNames}.`)
  ]
  const steps = target === 'recraft' ? ['drop:type', 'drop:palette', 'drop:accents', 'clip:summary'] : ['drop:type', 'clip:summary', 'drop:accents', 'drop:palette']
  fit(parts, budget, steps, { sep: ' ', notes })
  out.prefix = textOfParts(parts, ' ')
  out.applied = appliedOf(parts, [])

  if (bible.avoid.length && takes(schema, 'negative_prompt', endpoint, /ideogram|stable-diffusion|sdxl|sd3|hidream|playground|lora/)) {
    out.negative = bible.avoid.join(', ')
    out.params.negative_prompt = out.negative
    out.applied.push('negative')
  } else if (bible.avoid.length) notes.push('This endpoint takes no negative_prompt; avoid terms were left out.')

  if (target === 'fal-edit') {
    if (takes(schema, 'image_urls', endpoint, /./)) {
      const refs = selectRefs(bible, type, LIMITS.editRefs)
      if (refs.length) {
        out.refs = refs.map((r) => refOut(bible, r))
        out.params.image_urls = out.refs.map((r) => `@file:${r.file ?? r.path}`)
        out.prefix += `${out.prefix ? ' ' : ''}Use the reference images for style only; do not copy their subjects.`
        out.applied.push('refs')
      }
    } else notes.push('This endpoint takes no image_urls; references were left out.')
  }

  if (target === 'recraft') {
    const hexes = uniq(out.palette.map((c) => c.hex))
    if (hexes.length && takes(schema, 'colors', endpoint, /recraft/)) {
      out.params.colors = hexes.map(rgbOf)
      out.applied.push('colors')
    }
    if (opts.styleId) {
      out.params.style_id = String(opts.styleId)
      out.applied.push('style_id')
    } else if (/style/.test(String(endpoint ?? ''))) notes.push('No style_id: create one with recraft/v4/create-style from `genio-art refs` once per Art Bible version.')
  }

  out.prompt = withSubject(out.prefix)
  return out
}

function rgbOf(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// --------------------------------------------------------------- generators

/** What Codex's image_gen takes as an attached reference. */
const CODEX_REF = /\.(png|jpe?g|webp|gif)$/i
const EDIT_NOTE = 'Use the reference images for style only; do not copy their subjects.'
const withStop = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`)

/**
 * What a generation's provenance records about the Art Bible: its version,
 * the asset type, the references sent and what was applied. Null when nothing
 * was applied, so a record never claims a style the asset did not get.
 */
export function bibleStamp(compiled) {
  if (!compiled?.applied?.length) return null
  return {
    blob: compiled.version?.blob ?? null,
    ...(compiled.version?.source_blob ? { source_blob: compiled.version.source_blob } : {}),
    type: compiled.type ?? null,
    refs: compiled.refs.map((r) => r.path),
    applied: [...compiled.applied]
  }
}

/**
 * A Codex image prompt with the Art Bible applied: the player's prompt
 * first, then the compiled style, plus the absolute paths of the type
 * references to attach (only image formats Codex takes). Null without a
 * bible; `stamp` is null when nothing was applied.
 */
export function applyToCodex({ bible, type, prompt, limit = LIMITS.codexPrompt } = {}) {
  if (!bible) return null
  const own = String(prompt ?? '').trim()
  const usable = { ...bible, references: bible.references.filter((r) => !r.path || CODEX_REF.test(r.path)) }
  const compiled = compile({ bible: usable, provider: 'codex', type, subject: own, limit })
  const joined = [own, compiled.prefix].filter(Boolean).join('\n')
  return {
    prompt: joined.length <= limit ? joined : compiled.prompt,
    refs: compiled.refs.map((r) => r.file).filter(Boolean),
    compiled,
    stamp: bibleStamp(compiled)
  }
}

/**
 * A FAL model input with the Art Bible applied. The text goes into `prompt`
 * only (subject first); an input without one gets only palette parameters
 * (Image2Pixel), and spoken text (TTS) is never touched. Values the request
 * already sets win over the bible's, except `negative_prompt`, which is
 * extended, and `image_urls`, which gains the type references after the
 * request's own (within the schema's maxItems). `kind` is the catalogue's
 * output kind when known: an audio or model endpoint whose id does not say
 * so still gets only its own section. Null without a bible.
 */
export function applyToFal(input, { bible, endpoint, schema, type, kind } = {}) {
  if (!bible) return null
  let target = targetOf({ provider: 'fal', endpoint })
  if (kind === 'audio' && !SOUND.includes(target)) target = 'audio'
  if (kind === 'model' && target !== '3d') target = '3d'
  const prompt = typeof input?.prompt === 'string' && input.prompt.trim() ? input.prompt.trim() : null
  const none = (note) => ({ input, compiled: null, stamp: null, notes: [note] })
  if (target === 'voice') return none('Spoken text never gets the Art Bible; nothing applied.')
  if (target === 'recraft-style') return none('Recraft create-style takes the references from `genio-art refs`; nothing applied.')
  if (!prompt && target !== 'image2pixel') return none('This input has no prompt; nothing applied.')
  const provider = [...SOUND, '3d'].includes(target) ? target : 'fal'
  const compiled = compile({ bible, provider, endpoint, schema, type, subject: prompt ?? '' })
  const out = { ...input }
  const applied = new Set(compiled.applied)
  let prefix = compiled.prefix
  for (const [k, v] of Object.entries(compiled.params)) {
    if (k === 'negative_prompt') {
      const own = typeof input.negative_prompt === 'string' ? input.negative_prompt.trim() : ''
      out.negative_prompt = own ? `${own}, ${v}` : v
    } else if (k === 'image_urls') {
      const own = Array.isArray(input.image_urls) ? input.image_urls : []
      const max = propsOf(schema)?.image_urls?.maxItems
      const room = Number.isInteger(max) ? Math.max(0, max - own.length) : v.length
      const add = v.filter((x) => !own.includes(x)).slice(0, room)
      compiled.refs = compiled.refs.filter((r) => add.includes(`@file:${r.file ?? r.path}`))
      if (add.length) out.image_urls = [...own, ...add]
      else {
        applied.delete('refs')
        prefix = prefix.replace(EDIT_NOTE, '').trim()
        compiled.notes.push('No room for reference images in image_urls; references were left out.')
      }
    } else if (input[k] !== undefined || (k === 'max_colors' && input.fixed_palette !== undefined)) {
      applied.delete({ fixed_palette: 'palette', colors: 'colors', style_id: 'style_id' }[k])
      compiled.notes.push(`The request sets ${k}; the Art Bible's was not used.`)
    } else out[k] = v
  }
  if (prompt && prefix) out.prompt = `${withStop(prompt)} ${prefix}`
  compiled.prefix = prefix
  compiled.applied = [...applied]
  return { input: out, compiled, stamp: bibleStamp(compiled), notes: compiled.notes }
}

/** A motion prompt with the Art Bible's Animation line after it. Null without a bible. */
export function applyToMotion({ bible, prompt } = {}) {
  if (!bible) return null
  const own = String(prompt ?? '').trim()
  const compiled = compile({ bible, provider: 'uthana', subject: own })
  return { prompt: compiled.prefix ? `${withStop(own)} ${compiled.prefix}` : own, compiled, stamp: bibleStamp(compiled) }
}

function appliedOf(parts, refs) {
  const has = (k) => parts.some((p) => p.key === k && p.alts[p.i])
  return [
    ...(has('summary') ? ['style'] : []),
    ...(has('palette') || has('accents') ? ['palette'] : []),
    ...(has('do') || has('dont') ? ['do'] : []),
    ...(has('avoid') ? ['avoid'] : []),
    ...(has('type') ? ['type'] : []),
    ...(refs.length ? ['refs'] : [])
  ]
}
