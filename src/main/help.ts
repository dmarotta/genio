/**
 * Genio's bundled help: the docs listed in docs/help/help-set.json (the player-facing docs plus the
 * plain-language glossary, docs/help/glossary.md). The chat searches them with genio_help, units read
 * them through GENIO_HELP_DOCS. docs/** ships beside out/** in a packaged build (asar off), so the set
 * lives at <app>/docs in dev and when packaged. The index is built in memory at first use and rebuilt
 * when a file changes; nothing here writes a file or calls a model. scripts/check-help.mjs fails the
 * build when a listed doc is missing.
 */
import fs from 'node:fs'
import path from 'node:path'

export const HELP_SET = path.join('help', 'help-set.json')
export const HELP_EXCERPTS = 5
const CHUNK_CHARS = 1500

/** Where the help set may be: the app's docs folder, then a packaged install's for a bundle that moved. */
export function helpDocsRoots(appRoot: string, resourcesPath: string | undefined = process.resourcesPath): string[] {
  const roots = [path.join(appRoot, 'docs')]
  if (resourcesPath) roots.push(path.join(resourcesPath, 'app', 'docs'))
  return [...new Set(roots)]
}

/** The docs folder holding the help set, or undefined when this install has none. */
export function helpDocsDir(appRoot: string, resourcesPath?: string): string | undefined {
  return helpDocsRoots(appRoot, resourcesPath).find(dir => fs.existsSync(path.join(dir, HELP_SET)))
}

/** The help set's docs, relative to the docs folder. */
export function helpSetDocs(dir: string): string[] {
  const set = JSON.parse(fs.readFileSync(path.join(dir, HELP_SET), 'utf8')) as { docs?: unknown }
  if (!Array.isArray(set.docs) || set.docs.some(d => typeof d !== 'string')) throw new Error(`${HELP_SET} must list docs as strings`)
  return set.docs as string[]
}

interface Chunk { file: string; heading: string; own: Set<string>; text: string; tf: Map<string, number>; length: number }
interface HelpIndex { chunks: Chunk[]; df: Map<string, number>; avg: number; docs: string[]; missing: string[] }

/** Question words, plus \mode\, which names every mode in the docs and tells none apart. */
const STOP = new Set(('a about an and are as at be between by can could did difference do does doing explain for from genio get go goes going happen happens how i if ' +
  'in into is it its me mean means mode modes my of on or should so tell that the their them then there thing things this to us was we what when where ' +
  'which who why will with work works would you your').split(' '))
/** Words a player uses for a term the docs spell differently. */
const ALIAS: Record<string, string[]> = {
  quiet: ['dnd'], disturb: ['dnd'], away: ['afk'], yolo: ['auto', 'loot'], automerge: ['auto', 'loot'],
  approve: ['approval'], mute: ['muted', 'sound'], cost: ['spend'], price: ['spend'], money: ['spend']
}

/** Lowercased words with a light plural fold: "units" and "unit" match. */
export function helpTerms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

function counts(words: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1)
  return m
}

/** Paragraphs under their heading path; a long paragraph splits at line breaks. */
function chunksOf(file: string, text: string): Chunk[] {
  const out: Chunk[] = []
  const heads: string[] = []
  let block: string[] = []
  let fenced = false
  const flush = (): void => {
    const body = block.join('\n').trim()
    block = []
    if (!body) return
    const pieces: string[] = []
    let piece = ''
    for (const line of body.split('\n')) {
      if (piece && piece.length + line.length > CHUNK_CHARS) { pieces.push(piece); piece = '' }
      piece = piece ? `${piece}\n${line}` : line
    }
    if (piece) pieces.push(piece)
    const heading = heads.filter(Boolean).join(' › ') || file
    const own = new Set(helpTerms(heads.filter(Boolean).at(-1) ?? ''))
    for (const p of pieces) {
      const words = helpTerms(p)
      out.push({ file, heading, own, text: p, tf: counts([...words, ...own]), length: words.length + own.size })
    }
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const h = !fenced && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      heads.length = h[1].length - 1
      heads.push(h[2].trim())
      continue
    }
    if (!fenced && !line.trim()) flush()
    else block.push(line)
  }
  flush()
  return out
}

const cache = new Map<string, { sig: string; index: HelpIndex }>()

function statSig(file: string): string {
  try {
    const s = fs.statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'missing'
  }
}

/** The in-memory index for a docs folder, rebuilt when the set or one of its docs changes. */
export function helpIndex(dir: string): HelpIndex {
  const docs = helpSetDocs(dir)
  const sig = [statSig(path.join(dir, HELP_SET)), ...docs.map(d => statSig(path.join(dir, d)))].join('|')
  const hit = cache.get(dir)
  if (hit?.sig === sig) return hit.index
  const chunks: Chunk[] = []
  const missing: string[] = []
  for (const doc of docs) {
    let text: string
    try { text = fs.readFileSync(path.join(dir, doc), 'utf8') } catch { missing.push(doc); continue }
    chunks.push(...chunksOf(`docs/${doc.replace(/\\/g, '/')}`, text))
  }
  const df = new Map<string, number>()
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avg = chunks.reduce((n, c) => n + c.length, 0) / Math.max(1, chunks.length)
  const index = { chunks, df, avg, docs, missing }
  cache.set(dir, { sig, index })
  return index
}

/** BM25 over paragraphs, a bonus for words in the paragraph's own heading, scaled by how much of the question matched. */
function score(index: HelpIndex, c: Chunk, terms: string[]): number {
  const n = index.chunks.length
  let s = 0, matched = 0
  for (const t of terms) {
    const tf = c.tf.get(t)
    if (!tf) continue
    matched++
    const df = index.df.get(t) ?? 0
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.length / index.avg))
    if (c.own.has(t)) s += idf * 1.5
  }
  return matched ? s * (0.4 + 0.6 * matched / terms.length) : 0
}

/** The question's search terms: stop words dropped, player words widened to the docs' terms. */
function queryTerms(query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !STOP.has(w)).flatMap(helpTerms).filter(w => !STOP.has(w))
  return [...new Set(words.flatMap(w => [w, ...(ALIAS[w] ?? [])]))]
}

export interface HelpMatch { file: string; heading: string; text: string; score: number }

/** The best matching excerpts, at most two per heading. topic narrows to docs or headings that name it. */
export function findHelp(dir: string, query: string, opts: { topic?: string; limit?: number } = {}): { matches: HelpMatch[]; index: HelpIndex; topicMissed: boolean } {
  const index = helpIndex(dir)
  const topic = opts.topic?.trim().toLowerCase()
  const inTopic = (c: Chunk): boolean => !topic || c.file.toLowerCase().includes(topic) || c.heading.toLowerCase().includes(topic)
  const pool = index.chunks.filter(inTopic)
  const terms = queryTerms(query)
  const ranked = terms.length ? pool.map(c => ({ c, s: score(index, c, terms) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s) : []
  const perHeading = new Map<string, number>()
  const matches: HelpMatch[] = []
  for (const { c, s } of ranked) {
    const key = `${c.file}#${c.heading}`
    if ((perHeading.get(key) ?? 0) >= 2) continue
    perHeading.set(key, (perHeading.get(key) ?? 0) + 1)
    matches.push({ file: c.file, heading: c.heading, text: c.text, score: s })
    if (matches.length >= (opts.limit ?? HELP_EXCERPTS)) break
  }
  return { matches, index, topicMissed: !!topic && !pool.length }
}

/** genio_help's answer: excerpts with their source, or a plain statement that the help does not cover it. */
export function searchHelp(dir: string, query: string, opts: { topic?: string; limit?: number } = {}): string {
  const { matches, index, topicMissed } = findHelp(dir, query, opts)
  const missing = index.missing.length ? `\n(Missing from this install: ${index.missing.join(', ')}.)` : ''
  const topics = index.docs.map(d => d.replace(/\.md$/i, '')).join(', ')
  if (topicMissed) return `No help doc or heading matches the topic "${opts.topic}". Topics: ${topics}. Search again without topic or with one of these.${missing}`
  if (!matches.length) {
    return `No help docs match "${query}"${opts.topic ? ` in topic "${opts.topic}"` : ''}. Genio's bundled help does not cover this: say so plainly instead of guessing. Searched: ${topics}.${missing}`
  }
  const parts = matches.map((m, i) => `[${i + 1}] ${m.file} — ${m.heading}\n${m.text}`)
  return `Genio help: ${matches.length} excerpt${matches.length === 1 ? '' : 's'} for "${query}", best first. Answer from them and name the source doc.\n\n${parts.join('\n\n')}${missing}`
}
