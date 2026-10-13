/** Pure behaviour of the Your Move choice card, kept apart from React so it can be tested in node. */

export type AnswerKeyAction = 'submit' | 'newline' | 'blur' | 'none'

/** What a key press does in the answer box: Enter locks in, Shift+Enter breaks the line, Esc leaves the box. */
export function answerKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean }): AnswerKeyAction {
  if (e.isComposing) return 'none'
  if (e.key === 'Escape') return 'blur'
  if (e.key !== 'Enter') return 'none'
  return e.shiftKey ? 'newline' : 'submit'
}

/** Whether a choice option is the recommended one (exact, or the recommendation starts with it). */
export function isRecommended(option: string, recommendation?: string): boolean {
  if (!recommendation) return false
  return recommendation === option || recommendation.toLowerCase().startsWith(option.toLowerCase())
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
 * The text "Go with recommendation" submits: the decision's own recommendation when it is not one of
 * its options (those get their own buttons), else a "(recommended)" option named in the question.
 */
export function quickRecommendation(d: { question: string; options: string[]; recommendation?: string }): string | undefined {
  if (d.recommendation) return d.options.some((o) => isRecommended(o, d.recommendation)) ? undefined : d.recommendation
  if (d.options.length) return undefined
  return recommendedFromQuestion(d.question)
}
