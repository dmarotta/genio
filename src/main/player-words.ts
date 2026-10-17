/**
 * The player's words, verified, for spend and generation only. A paid run's
 * approval, a unit's budget at deploy, a generation request and an overwrite
 * take player_words from the model; the model can type anything, so the words
 * only count when they are a verbatim quote of a real player message in this
 * chat (never Genio's text, a unit's, a tool result or a system line) and that
 * message actually says the purpose's action. Everything else the chat does
 * (merge, discard, relaunch, settings…) is cleared by its approval mode and the
 * permission prompt instead (clearAction in chat-tool-policy.ts), never by text.
 * Standing approvals ("keep merging everything") are read from real player
 * messages here too.
 */
import type { ChatMessage, Decision } from '@shared/types'
import { truncate } from './util'

/** Shortest quote that can identify a message; a shorter one must be the whole message ("yes", "ok"). */
export const MIN_QUOTE = 8
/** How far back a quote is looked for. */
export const HISTORY_DEPTH = 300

interface PurposeRule {
  /** what the player's message must do, as the refusal says it: "does not …" */
  needs: string
  /** the message must say this (absent: the quoted request itself is enough) */
  intent?: RegExp
  /** a question is not an instruction for this purpose */
  noQuestions?: boolean
}

/** One line per purpose: spend and generation, the only actions that still take the player's quoted words. */
export const PURPOSES = {
  spend: { needs: 'approve this paid run', intent: /\b(?:yes|yep|yeah|ok|okay|sure|approve\w*|go|go ahead|do it|run it|fine|spend|pay|confirm\w*|proceed|accept\w*)\b/ },
  asset: { needs: 'ask for this asset' },
  'design-note': { needs: 'ask to save this design note' },
  overwrite: { needs: 'say to replace the existing file', intent: /\b(?:overwrit\w*|replac\w*|overrid\w*|swap\w*)\b/ }
} satisfies Record<string, PurposeRule>

export type WordsPurpose = keyof typeof PURPOSES

export type WordsCheck =
  | { ok: true; messageId: string; at: string; text: string }
  | { ok: false; reason: string; standing?: boolean }

export function normalizeWords(s: string): string {
  return s.normalize('NFKC').replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').toLowerCase().replace(/\s+/g, ' ').trim()
}
const strip = (s: string): string => s.replace(/^["'\s]+|["'\s.!,;:…]+$/g, '')
const quoted = (m: ChatMessage): string => `"${truncate(m.text.replace(/\s+/g, ' ').trim(), 120)}"`
const clock = (iso: string): string => new Date(iso).toISOString().slice(11, 16) + ' UTC'

/** Real player messages only: typed by the player and read by the session. Commands and synthesized wrappers are not words. */
export function playerMessages(history: ChatMessage[]): ChatMessage[] {
  return history.filter(m => m.role === 'player' && !m.queue && !m.from && !!m.text?.trim() && !m.text.trim().startsWith('/')
    && !/^Clarification requested for choice /.test(m.text))
}

/** Player messages that contain the quote verbatim (whitespace, case and quote marks normalized), newest first. */
function matching(history: ChatMessage[], quote: string): { found: ChatMessage[]; reason?: string } {
  const q = strip(normalizeWords(quote))
  if (!q) return { found: [], reason: 'no player words were given' }
  const all = playerMessages(history).reverse()
  const found = all.filter(m => {
    const text = normalizeWords(m.text)
    return strip(text) === q || (q.length >= MIN_QUOTE && text.includes(q))
  })
  if (found.length) return { found }
  if (q.length < MIN_QUOTE && all.some(m => normalizeWords(m.text).includes(q))) {
    return { found: [], reason: `"${quote.trim()}" is too short to identify the player's message: quote at least ${MIN_QUOTE} characters of it, or all of it` }
  }
  return { found: [], reason: `"${truncate(quote.trim(), 120)}" is not in any of the player's own messages in this chat (Genio's, a unit's, tool and system text never count)` }
}

/** Sentences with their end mark, so a question stays recognizable. */
const sentences = (text: string): string[] => normalizeWords(text.replace(/\r?\n+/g, '. ')).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
/** "can you merge it", "is it green": an auxiliary before its subject. "do it" is not a question. */
const AUX_QUESTION = /^(?:should|shall|can|could|would|will|do|does|did|may|might|is|are|was|were|have|has|isn'?t|aren'?t|won'?t|wouldn'?t|shouldn'?t|don'?t)\s+(?:i|we|you|it|they|he|she|that|this|these|those|there|the|my|our|your|its)\b/
/** "what about…", "how does…"; with a comma it is usually a condition ("when it's green, merge it"). */
const WH_QUESTION = /^(?:what|why|how|when|where|which|who)\b/
const isQuestion = (sentence: string): boolean => {
  const s = strip(sentence)
  return /\?\s*$/.test(sentence) || AUX_QUESTION.test(s) || (WH_QUESTION.test(s) && !s.includes(','))
}
const HEDGE = /\b(?:maybe|perhaps|might|i wonder|not sure|probably|should we|do you think|thinking (?:of|about)|considering|if you want)\b/
const DEFER = /\b(?:later|tomorrow|tonight|not yet|not now|until|after (?:i|we)|once (?:i|we)|when (?:i|we))\b/
/** The intent must not sit right after a negation in its own clause ("don't merge", "never delete"). */
const NEGATED = /\b(?:don'?t|do not|never|not|no|stop|without|hold off|cancel|nor|can'?t|cannot|won'?t)\b[^,;.!?]{0,24}$/

/** The generic purpose check: the intent appears, not negated, and (when the rule says so) not in a question. */
function sayIt(m: ChatMessage, rule: PurposeRule): string | undefined {
  if (!rule.intent) return undefined
  for (const sentence of sentences(m.text)) {
    const at = sentence.search(rule.intent)
    if (at < 0) continue
    if (NEGATED.test(sentence.slice(0, at))) continue
    if (rule.noQuestions && isQuestion(sentence)) return `the player's message ${quoted(m)} is a question, not an instruction`
    return undefined
  }
  return `the player's message ${quoted(m)} does not ${rule.needs}`
}

/**
 * Verify words for any purpose. after = the message must be newer than this
 * moment (e.g. the unit's creation for a discard).
 */
export function verifyPlayerWords(history: ChatMessage[], words: string | undefined, purpose: WordsPurpose, opts: { after?: string; what?: string } = {}): WordsCheck {
  const { found, reason } = matching(history, words ?? '')
  if (!found.length) return { ok: false, reason: reason! }
  const rule: PurposeRule = PURPOSES[purpose]
  let first: string | undefined
  for (const m of found) {
    const why = opts.after && !(m.ts > opts.after) ? `the player's message ${quoted(m)} (${clock(m.ts)}) predates ${opts.what ?? 'this action'} (${clock(opts.after)})` : sayIt(m, rule)
    if (!why) return { ok: true, messageId: m.id, at: m.ts, text: m.text }
    first ??= why
  }
  return { ok: false, reason: first! }
}

// ------------------------------------------------------------------ spend budget

/** Dollar amounts a message names: "$0.50", "0.5 USD", "USD 2", "2 dollars", "50 cents", "2 bucks". */
export function moneyAmounts(text: string): number[] {
  const n = normalizeWords(text)
  const out: number[] = []
  const num = '(\\d+(?:[.,]\\d+)?)'
  const add = (v: string, cents = false): void => {
    const x = Number(v.replace(',', '.'))
    if (Number.isFinite(x)) out.push(cents ? Math.round(x) / 100 : x)
  }
  for (const m of n.matchAll(new RegExp(`(?:\\$|usd\\s*)${num}`, 'g'))) add(m[1])
  for (const m of n.matchAll(new RegExp(`${num}\\s*(?:\\$|usd\\b|dollars?\\b|bucks?\\b)`, 'g'))) add(m[1])
  for (const m of n.matchAll(new RegExp(`${num}\\s*(?:cents?\\b|c\\b|¢)`, 'g'))) add(m[1], true)
  // a bare decimal ("up to 0.50") is a price; a bare whole number ("3 sounds") is not
  for (const m of n.matchAll(/(?<![\d.,])(\d+[.,]\d{1,2})(?![\d.,])/g)) add(m[1])
  return out
}

const SPEND_INTENT = /\b(?:yes|yep|yeah|ok|okay|sure|approv\w*|go ahead|fine|spend|pay|budget|allow\w*|can use|up to|cap|limit|authori[sz]\w*|give (?:it|them|him|her)|let (?:it|them) (?:spend|use))\b/

/**
 * Words that approve a unit's up-front budget: a verbatim quote of a real
 * player message (like merge words) that says to spend or approves, is not a
 * question, a maybe or a "later", and names this exact USD amount.
 */
export function verifySpendWords(history: ChatMessage[], quote: string | undefined, usd: number): WordsCheck {
  const { found, reason } = matching(history, quote ?? '')
  if (!found.length) return { ok: false, reason: reason! }
  let first: string | undefined
  for (const m of found) {
    let why: string | undefined = `the player's message ${quoted(m)} does not approve spending`
    for (const sentence of sentences(m.text)) {
      const at = sentence.search(SPEND_INTENT)
      if (at < 0 || NEGATED.test(sentence.slice(0, at))) continue
      if (isQuestion(sentence)) { why = `the player's message ${quoted(m)} is a question, not an approval`; continue }
      if (HEDGE.test(sentence) || DEFER.test(sentence)) { why = `the player's message ${quoted(m)} is tentative or deferred, not an approval`; continue }
      why = moneyAmounts(m.text).some((a) => Math.abs(a - usd) < 1e-9) ? undefined : `the player's message ${quoted(m)} does not name the amount USD ${usd}`
      if (!why) break
    }
    if (!why) return { ok: true, messageId: m.id, at: m.ts, text: m.text }
    first ??= why
  }
  return { ok: false, reason: first! }
}

// ------------------------------------------------------------------ merge

/**
 * Lead-ins before the merge verb: "yes, go ahead and merge it", "ok so land them". Question lead-ins
 * ("can you merge…") are let through so the sentence is then refused as a question, with that reason.
 */
const LEAD = /^(?:(?:yes|yeah|yep|yup|ok|okay|k|sure|alright|all right|right|great|good|perfect|cool|nice|fine|awesome|lgtm|looks good|sounds good|please|pls|now|then|so|and|also|just|go ahead and|go on and|ahead and|you can|you may|feel free to|let'?s|genio|(?:can|could|would|will|should|shall) (?:you|we|i))\s+)*/
const MERGE_VERB = /^(?:i\s+)?(?:merge\b(?!\s+(?:is|was|has|had|failed|broke\w*|conflicts?|button|tool|code|guard|logic|rules?|works?)\b)|land\s+(?:it|that|this|them|those|these|both|everything|all|em)\b|land\s+the\s+(?:[\w'-]+\s+){0,3}(?:pr|branch|build|change|changes|fix|work|unit|one|ones)\b|land$|ship\s+(?:it|them|that|this|those|these|both|everything|all)\b|approved?\s+(?:the\s+)?(?:merge|merging|landing|pr\b|it\b|that\b|this\b|them\b|both\b|those\b|these\b)|(?:keep|continue|go on)\s+(?:merging|landing|shipping)\b|do\s+the\s+merge\b)/
const clauses = (sentence: string): string[] => strip(sentence).split(/[,;:]|\s+(?:and|then|so|but)\s+|\s+-+\s+/).map(c => strip(c.trim())).filter(Boolean)

/** The clause that says to merge, or why the message does not say it. */
export function mergeIntent(text: string): { ok: true; sentence: string; clause: string } | { ok: false; reason: 'none' | 'question' | 'hedge' | 'defer' } {
  let worst: 'none' | 'question' | 'hedge' | 'defer' = 'none'
  for (const sentence of sentences(text)) {
    for (const clause of clauses(sentence)) {
      const verb = clause.replace(LEAD, '')
      if (!MERGE_VERB.test(verb)) continue
      if (isQuestion(sentence)) { worst = 'question'; continue }
      if (HEDGE.test(sentence)) { worst = 'hedge'; continue }
      if (DEFER.test(clause)) { worst = 'defer'; continue }
      return { ok: true, sentence, clause: verb }
    }
  }
  return { ok: false, reason: worst }
}

/** "Keep merging everything", "merge everything that finishes", "land everything as they come", "merge all you can". */
const STANDING = [
  /\b(?:keep|continue|go on)\s+(?:merging|landing|shipping)\b/,
  /\b(?:merge|land|ship)\s+(?:everything|all(?:\s+of\s+them)?|every\s+(?:build|unit|one|pr))\b[^.!?]*\b(?:finish\w*|done|ready|come|comes|green|pass\w*|from now on|going forward|tonight|today|you can|as they)\b/,
  /\b(?:merge|land)\s+(?:whatever|anything)\b/,
  /\bfrom now on\b[^.!?]*\b(?:merge|land)\b|\b(?:merge|land)\b[^.!?]*\bfrom now on\b/
]
/** "stop", "stop merging", "don't merge", "revoke". */
const REVOKE = /^(?:stop|halt|pause)\s*[.!]*$|\b(?:stop|quit|cease|no more|don'?t|do not|pause|hold off(?: on)?)\s+(?:the\s+)?(?:auto[- ]?)?(?:merging|landing|merges|shipping|merge|land)\b|\brevoke\b/

export function isStandingApproval(text: string): boolean {
  const intent = mergeIntent(text)
  if (!intent.ok) return false
  return STANDING.some(r => r.test(intent.sentence))
}

export function isStandingRevoke(text: string): boolean {
  return REVOKE.test(strip(normalizeWords(text)))
}

/** The work a merge approval must point at. */
export interface MergeTarget {
  id: string
  title: string
  branch?: string
  readyAt?: string
  createdAt: string
  pr?: { url: string; number?: number }
}

/** Default options of a "Merge now?" choice. */
export const MERGE_CHOICE_OPTIONS = ['Merge now', 'Not yet']

/** An answer that approves the merge: the first option, or a plain yes. */
export function approvesMerge(answer: string, options: string[] = MERGE_CHOICE_OPTIONS): boolean {
  const a = strip(normalizeWords(answer))
  if (/^(?:no|nope|not|don'?t|do not|wait|later|hold|stop|cancel|never)\b/.test(a)) return false
  if (options[0] && a === strip(normalizeWords(options[0]))) return true
  return /^(?:yes|yeah|yep|y|ok|okay|sure|merge(?: it| now)?|land it|ship it|go(?: ahead)?|do it|approved?)\b/.test(a)
}

/**
 * The player's approving click on this unit's merge choice, given after it reported ready. An answer the chat
 * closed it with (choice_resolve) is not one: chat text never clears a merge; the merge tool asks instead.
 */
export function mergeChoiceApproval(decisions: Decision[], target: MergeTarget): Decision | undefined {
  const ready = target.readyAt ?? target.createdAt
  return decisions
    .filter(d => d.action?.kind === 'merge-approval' && d.action.task === target.id && d.resolvedAt && d.resolvedAt > ready && d.answer
      && d.answeredVia === 'ui' && approvesMerge(d.answer, d.options))
    .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!))[0]
}

/** What a refused tool says: the reason, and what would make it work. */
export function refusal(action: string, reason: string, remedy: string): string {
  return `${action} refused: ${reason}. ${remedy}`
}
