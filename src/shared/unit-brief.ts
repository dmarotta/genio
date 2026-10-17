/**
 * The Brief tab's short mission summary. The brief file a unit receives holds
 * the mission, then Genio's rules, skills, tools and contract text; the player
 * reads only the title, their own ask, and a few plain lines on what the unit
 * will do. That summary is written by Genio at deploy (deploy, quest_add,
 * plan steps); older units and units deployed without one get it derived from
 * the brief's mission spec, never from its boilerplate.
 */

/** About this many characters: 3 to 8 lines on the unit page. */
export const SUMMARY_CHARS = 600

const INTENT = "## Player's intent"
const SPEC = '## Genio spec'
/** What renderBrief writes when Genio gave no spec: boilerplate, not a summary. */
const NO_SPEC = /^No extra build instructions\./
/** Genio's own headers in a brief: the mission section ends at the first one. */
const BOILERPLATE = /^(?:# (?:Genio unit brief|Mission|Setup|Rules|Authoring choices|Genio ping inbox|Project memory|Engine notes|Tools|Modeller|Generator|Definition of done|Base brief additions)\b|## (?:Player's intent|Genio spec|Plan context|Recon report carried into this build)\s*$)/

export interface BriefSummary {
  /** the player's own words, as written */
  ask: string
  /** what the unit will do, in plain words */
  summary: string
}

/** Cut text at a sentence end within max characters (a word end, with an ellipsis, when no sentence fits). */
export function clipSummary(text: string, max = SUMMARY_CHARS): string {
  const s = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*\n\s*/g, '\n\n').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max + 1)
  let end = -1
  // a sentence ends at . ! ? followed by space and a capital, a quote or a bracket (not "e.g. the", not "prompts.ts")
  for (const m of head.matchAll(/[.!?](?=["')\]]?(?:\s+["'(`A-Z0-9]|\s*$))/g)) end = m.index! + 1
  if (end >= max / 4) return s.slice(0, end).trim()
  const cut = head.lastIndexOf(' ', max - 1)
  return `${s.slice(0, cut > max / 2 ? cut : max - 1).replace(/[\s,;:(\-–—]+$/, '')}…`
}

/** The lines of one section of a brief, from its header to the next Genio header. */
function section(brief: string, header: string): string {
  const lines = brief.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === header)
  if (start < 0) return ''
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (BOILERPLATE.test(l.trim())) break
    out.push(l)
  }
  return out.join('\n').trim()
}

/** The player's words recorded in a brief. */
export function briefIntent(brief: string): string {
  const s = section(brief, INTENT)
  return s === '(no intent given)' ? '' : s
}

/** The first plain paragraph of a mission spec: no headers, no fences, no Genio filler. */
export function specParagraph(spec: string): string {
  const paras = spec.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  for (const p of paras) {
    const body = p.split('\n').filter((l) => !/^\s*(#{1,6}\s|```|---+\s*$)/.test(l)).join('\n').trim()
    if (!body || NO_SPEC.test(body)) continue
    return body
  }
  return ''
}

/** What the unit will do, derived when Genio wrote no summary: the spec's first paragraph, else the ask. */
export function deriveSummary(intent: string, spec: string): string {
  return clipSummary(specParagraph(spec) || intent)
}

/** The Brief tab's content for a unit: its stored summary, else one derived from the brief file. */
export function briefSummary(stored: string | undefined, brief: string): BriefSummary {
  const ask = briefIntent(brief)
  return { ask, summary: stored?.trim() || deriveSummary(ask, section(brief, SPEC)) }
}
