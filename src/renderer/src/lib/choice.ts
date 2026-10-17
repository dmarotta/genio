/** Pure behaviour of the Your Move choice card, kept apart from React so it can be tested in node. */

export type AnswerKeyAction = 'submit' | 'newline' | 'blur' | 'none'

/** What a key press does in the answer box: Enter locks in, Shift+Enter breaks the line, Esc leaves the box. */
export function answerKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean }): AnswerKeyAction {
  if (e.isComposing) return 'none'
  if (e.key === 'Escape') return 'blur'
  if (e.key !== 'Enter') return 'none'
  return e.shiftKey ? 'newline' : 'submit'
}

/** Legacy explanations may follow an option after a clear punctuation boundary. */
export function isRecommended(option: string, recommendation?: string): boolean {
  if (!recommendation) return false
  if (recommendation === option) return true
  return recommendation.toLowerCase().startsWith(option.toLowerCase()) && /^\s+(?:[—–:;]|-\s)/.test(recommendation.slice(option.length))
}

const REC_MARK = /[([]\s*recommended\s*[)\]]/i
const SPLIT = /[:?;\n]|\s+(?:or|vs\.?|versus)\s+/gi

/**
 * The option a question marks with "(recommended)", e.g. "A (recommended), or B?" → "A" and
 * "A, or B (recommended)?" → "B". Undefined when the question names no recommended option.
 */
export function recommendedFromQuestion(question: string): string | undefined {
  const m = REC_MARK.exec(question)
  if (!m) return undefined
  const before = question.slice(0, m.index)
  let start = 0
  for (const s of before.matchAll(SPLIT)) start = s.index! + s[0].length
  const text = before
    .slice(start)
    .replace(/^[\s,.;:—–-]*(?:either\s+)?/i, '')
    .replace(/[\s,.;:—–-]+$/, '')
  return text || undefined
}

/**
 * The recommendation that needs its own row: the decision's own recommendation when it is not one of
 * its options (those are marked in place), else a "(recommended)" option named in the question.
 */
export function quickRecommendation(d: { question: string; options: string[]; recommendation?: string }): string | undefined {
  if (d.recommendation) return d.options.filter((o) => isRecommended(o, d.recommendation)).length === 1 ? undefined : d.recommendation
  if (d.options.length) return undefined
  return recommendedFromQuestion(d.question)
}

export type ChoiceRow = { text: string; rec: boolean }

/** One row per answer the panel offers: the options, the recommended one marked, and a recommendation that is not an option last. */
export function choiceRows(d: { question: string; options: string[]; recommendation?: string }): ChoiceRow[] {
  const quick = quickRecommendation(d)
  const rows = d.options.map((text) => ({ text, rec: !quick && isRecommended(text, d.recommendation) }))
  return quick && !d.options.includes(quick) ? [...rows, { text: quick, rec: true }] : rows.map((r) => ({ ...r, rec: r.rec || r.text === quick }))
}

/** What Ask Genio sends as the player's own chat message: the question, its details, the numbered options and who asked, no ids. */
export function askGenioMessage(d: { question: string; context?: string; options: string[]; recommendation?: string }, asker?: string): string {
  const rows = choiceRows(d)
  return [
    'Help me decide this open choice.',
    ...(asker ? [`Asked by: ${asker}`] : []),
    `Question: ${d.question}`,
    ...(d.context?.trim() ? [`Details: ${d.context.trim()}`] : []),
    ...(rows.length ? ['Options:', ...rows.map((r, i) => `${i + 1}. ${r.text}${r.rec ? ' (recommended)' : ''}`)] : [])
  ].join('\n')
}
