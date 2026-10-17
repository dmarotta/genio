/**
 * The player's words, verified. Tools that need the player's say-so (merge,
 * force despawn, relaunching a held unit, spend, overwrites, settings…) take
 * player_words from the model; the model can type anything, so the words only
 * count when they are a verbatim quote of a real player message in this chat
 * (never Genio's text, a unit's, a tool result or a system line) and that
 * message actually says the purpose's action. Merge and discard add recency
 * (newer than the unit's ready signal, or than the unit) and scope (it names
 * that work, or answers Genio's message about it).
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

/** Any plain words for getting rid of a unit: "kill it", "remove the boat unit", "get rid of it", "stop and remove it", "forget it". */
const DISCARD_VERB = /\b(?:discard(?:s|ed|ing)?|delet(?:e|es|ed|ing)|kill(?:s|ed|ing)?|remov(?:e|es|ed|ing)|get(?:ting)?\s+rid\s+of|drop(?:s|ped|ping)?|scrap(?:s|ped|ping)?|clear(?:s|ed|ing)?|trash(?:es|ed|ing)?|nuke[sd]?|nuking|wipe[sd]?|wiping|ditch(?:es|ed|ing)?|dump(?:s|ed|ing)?|toss(?:es|ed|ing)?|eras(?:e|es|ed|ing)|destroy(?:s|ed|ing)?|purg(?:e|es|ed|ing)|abandon(?:s|ed|ing)?|(?:force[- ])?despawn(?:s|ed|ing)?|throw\w*\s+(?:\w+\s+){0,3}(?:away|out)|bin\s+(?:it|that|this|them)|forget\s+(?:about\s+)?(?:it|that|this|them))\b/

/** One line per purpose. Merge and discard are checked by verifyMergeWords and verifyDiscardWords on top of these. */
export const PURPOSES = {
  merge: { needs: 'approve merging this work', noQuestions: true },
  discard: { needs: 'ask to remove this unit', intent: DISCARD_VERB, noQuestions: true },
  relaunch: { needs: 'say to resume or respawn this unit', intent: /\b(?:resum\w*|respawn\w*|relaunch\w*|restart\w*|retry|try\s+(?:it\s+)?again|start\s+(?:it\s+)?again|continue|keep\s+going|carry\s+on|unpause)\b/ },
  'engine-root': { needs: 'say which folder holds the game' },
  settings: { needs: 'ask for this preference change' },
  spend: { needs: 'approve this paid run', intent: /\b(?:yes|yep|yeah|ok|okay|sure|approve\w*|go|go ahead|do it|run it|fine|spend|pay|confirm\w*|proceed|accept\w*)\b/ },
  asset: { needs: 'ask for this asset' },
  'art-bible': { needs: 'ask to create or change the Art Bible' },
  'design-note': { needs: 'ask to save this design note' },
  overwrite: { needs: 'say to replace the existing file', intent: /\b(?:overwrit\w*|replac\w*|overrid\w*|swap\w*)\b/ },
  play: { needs: 'ask for this Play action' },
  remote: { needs: 'agree to create the remote repository', intent: /\b(?:github|remote|repo|repository|publish\w*|push\w*)\b/ },
  'auto-loot': { needs: 'turn on Auto-loot', intent: /\bauto[- ]?loot\b|\bmerge\s+(?:finished\s+work\s+)?automatically\b|\bauto[- ]?merg\w*/ },
  'delete-clone': { needs: 'say to delete the clone', intent: /\b(?:delet\w*|remov\w*|wipe\w*|trash\w*)\b/ },
  choice: { needs: 'answer this choice' },
  'early-start': { needs: 'say to start this work before what it waits on lands', intent: /\b(?:now|anyway|already|early|before|without\s+waiting|don'?t\s+wait|do\s+not\s+wait|ignore|skip|in\s+parallel|at\s+the\s+same\s+time|start|deploy|dispatch|launch|go)\b/ }
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

const STOP = new Set(['the', 'this', 'that', 'with', 'from', 'into', 'onto', 'when', 'what', 'make', 'made', 'real', 'unit', 'build', 'work', 'merge', 'merging', 'land', 'ship', 'genio', 'your', 'their', 'have', 'more', 'less', 'only', 'also', 'just', 'some', 'every', 'each', 'them', 'they', 'then', 'than', 'there', 'here', 'should', 'would', 'could', 'about', 'after', 'before', 'over', 'under', 'fix', 'fixes', 'add', 'adds'])
const words = (s: string): string[] => normalizeWords(s).split(/[^a-z0-9']+/).filter(w => w.length >= 4 && !STOP.has(w))
const hasWord = (text: string, w: string): boolean => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`).test(text)

/** Named outright: id, branch, title or PR number. */
function names(text: string, t: MergeTarget): boolean {
  const n = normalizeWords(text)
  if (n.includes(t.id.toLowerCase())) return true
  if (t.branch && n.includes(t.branch.toLowerCase())) return true
  const title = normalizeWords(t.title)
  if (title.length >= 6 && n.includes(title)) return true
  return !!t.pr?.number && new RegExp(`(?:#|\\bpr\\s*#?)${t.pr.number}\\b`).test(n)
}

/** A title word only this work has ("merge the settings one"). */
function distinctive(text: string, t: MergeTarget, others: MergeTarget[]): boolean {
  const n = normalizeWords(text)
  const theirs = new Set(others.flatMap(o => words(o.title)))
  return words(t.title).some(w => !theirs.has(w) && hasWord(n, w))
}

const ALL = /\b(?:everything|all\s+of\s+(?:them|it)|all\s+(?:the\s+)?(?:builds?|units?|prs|branches|work|ready ones)|all)\s*$|\b(?:everything|all\s+of\s+them)\b/
const PLURAL = /\b(?:them|both|those|these|the\s+(?:two|three|four)|all\s+(?:two|three|four))\b/

/** Genio's messages the player was answering: everything Genio said since the player's previous message. */
function answeredGenio(history: ChatMessage[], m: ChatMessage): string {
  const i = history.findIndex(x => x.id === m.id)
  const said: string[] = []
  for (let j = i - 1; j >= 0; j--) {
    const x = history[j]
    if (x.role === 'player' && !x.queue) break
    if (x.role === 'genio' && !x.partial) said.unshift(x.text)
  }
  return said.join('\n')
}

/**
 * Merge words: a real player message that says to merge (not a question, not
 * tentative, not "later"), newer than the unit's ready signal, and pointing at
 * this work: by name, "everything", or "it/that/them" answering Genio's message
 * about it. A standing approval ("keep merging everything") is reported as such
 * so the caller can look up the recorded standing approval instead.
 */
export function verifyMergeWords(history: ChatMessage[], quote: string | undefined, target: MergeTarget, others: MergeTarget[] = []): WordsCheck {
  const { found, reason } = matching(history, quote ?? '')
  if (!found.length) return { ok: false, reason: reason! }
  const ready = target.readyAt ?? target.createdAt
  let first: WordsCheck | undefined
  for (const m of found) {
    const why = mergeRefusal(history, m, target, others, ready)
    if (!why) return { ok: true, messageId: m.id, at: m.ts, text: m.text }
    first ??= why
  }
  return first!
}

function mergeRefusal(history: ChatMessage[], m: ChatMessage, target: MergeTarget, others: MergeTarget[], ready: string): WordsCheck | undefined {
  const intent = mergeIntent(m.text)
  if (!intent.ok) {
    const why = {
      none: 'does not say to merge (a design pick like "go with 3" or "use X" approves the design, not the merge)',
      question: 'is a question, not an instruction', hedge: 'is tentative, not an instruction', defer: 'defers the merge'
    }[intent.reason]
    return { ok: false, reason: `the player's message ${quoted(m)} ${why}` }
  }
  if (STANDING.some(r => r.test(intent.sentence))) return { ok: false, standing: true, reason: `the player's message ${quoted(m)} is a standing approval: it counts only while it is recorded and active for this project` }
  if (!(m.ts > ready)) return { ok: false, reason: `the player's message ${quoted(m)} (${clock(m.ts)}) came before this unit reported ready (${clock(ready)}), so it cannot approve this work` }
  if (names(m.text, target)) return undefined
  const named = others.filter(o => names(m.text, o))
  if (named.length) return { ok: false, reason: `the player's message ${quoted(m)} names other work (${named.map(o => o.id).join(', ')}), not ${target.id}` }
  if (ALL.test(intent.clause)) return undefined
  if (distinctive(intent.sentence, target, others)) return undefined
  const genio = answeredGenio(history, m)
  const about = (t: MergeTarget): boolean => names(genio, t)
  if (genio && about(target) && (PLURAL.test(intent.clause) || !others.some(about))) return undefined
  return { ok: false, reason: `the player's message ${quoted(m)} does not say which work to merge: it must name ${target.id} ("${truncate(target.title, 60)}"), say "everything", or reply directly to Genio's message about this unit` }
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

/** The player's approving answer to this unit's merge choice, given after it reported ready. */
export function mergeChoiceApproval(decisions: Decision[], target: MergeTarget): Decision | undefined {
  const ready = target.readyAt ?? target.createdAt
  return decisions
    .filter(d => d.action?.kind === 'merge-approval' && d.action.task === target.id && d.resolvedAt && d.resolvedAt > ready && d.answer
      && (d.answeredVia === 'ui' || (d.answeredVia === 'chat' && !!d.answerMessage)) && approvesMerge(d.answer, d.options))
    .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!))[0]
}

// ------------------------------------------------------------------ discard

/** A unit a discard may point at; the player may call it by its kind ("kill the modelling unit"). */
export interface DiscardTarget extends MergeTarget {
  kind?: 'build' | 'recon' | 'modeller' | 'generator'
}

const KIND_WORDS: Record<NonNullable<DiscardTarget['kind']>, string[]> = {
  build: [], recon: ['recon', 'scout'], modeller: ['modeller', 'modelling', 'modeling', 'model'], generator: ['generator', 'generation']
}
/** A negation in the verb's own clause ("don't kill it"). Unlike NEGATED, "stop" is not one: "stop and remove it". */
const DISCARD_NEGATED = /\b(?:don'?t|dont|do not|never|not|no|without|hold off(?: on)?|can'?t|cannot|won'?t|shouldn'?t|wouldn'?t|nor)\b[^,;.!?]{0,24}$/
/** The verb is about the merge, or nothing: "drop the merge", "remove nothing". */
const NOT_A_UNIT = /^\s+(?:the\s+|that\s+|this\s+|its\s+)?(?:merge|merging|landing|pr|nothing|none)\b/
/** "can you remove it", "genio, could you kill the boat unit?": a request, not a question. */
const REQUEST = /^(?:(?:ok|okay|so|then|and|please|pls|genio|hey),?\s+)*(?:can|could|would|will)\s+(?:you|u)\b/
const discardVerbs = (): RegExp => new RegExp(DISCARD_VERB.source, 'g')

/** The clause that says to get rid of something, or why the message does not say it. */
function discardIntent(text: string): { ok: true; clause: string } | { ok: false; reason: 'none' | 'question' | 'hedge' | 'defer' } {
  let worst: 'none' | 'question' | 'hedge' | 'defer' = 'none'
  for (const sentence of sentences(text)) {
    for (const v of sentence.matchAll(discardVerbs())) {
      if (DISCARD_NEGATED.test(sentence.slice(0, v.index)) || NOT_A_UNIT.test(sentence.slice(v.index + v[0].length))) continue
      if (isQuestion(sentence) && !REQUEST.test(strip(sentence))) { worst = 'question'; continue }
      if (HEDGE.test(sentence)) { worst = 'hedge'; continue }
      if (DEFER.test(sentence)) { worst = 'defer'; continue }
      return { ok: true, clause: clauses(sentence).find(c => c.includes(v[0])) ?? sentence }
    }
  }
  return { ok: false, reason: worst }
}

const stem = (w: string): string => (w.length > 5 ? w.replace(/(?:ling|ing|ers|er|ed|es|s)$/, '') : w.replace(/s$/, ''))
/** One typo apart: a letter added, dropped, changed, or two swapped ("modl", "boart"). */
function oneTypo(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    const diff = [...a].flatMap((c, i) => (c === b[i] ? [] : [i]))
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]])
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  return [...long].some((_, i) => long.slice(0, i) + long.slice(i + 1) === short)
}

/** How plainly the text points at this unit by a word only it has (title or kind): 2 as written, 1 with a typo, 0 not at all. */
function mentions(text: string, t: DiscardTarget, others: DiscardTarget[]): number {
  const own = (x: DiscardTarget): string[] => [...words(x.title), ...KIND_WORDS[x.kind ?? 'build']].map(stem)
  const theirs = new Set(others.flatMap(own))
  const mine = own(t).filter(w => !theirs.has(w))
  const said = words(normalizeWords(text).replace(discardVerbs(), ' ')).map(stem)
  if (said.some(w => mine.includes(w))) return 2
  return said.some(w => mine.some(x => oneTypo(w, x))) ? 1 : 0
}

function discardRefusal(history: ChatMessage[], m: ChatMessage, target: DiscardTarget, others: DiscardTarget[]): string | undefined {
  const intent = discardIntent(m.text)
  if (!intent.ok) {
    return `the player's message ${quoted(m)} ${{ none: 'does not ask to remove a unit', question: 'is a question, not an instruction', hedge: 'is tentative, not an instruction', defer: 'says to do it later' }[intent.reason]}`
  }
  if (!(m.ts > target.createdAt)) return `the player's message ${quoted(m)} (${clock(m.ts)}) was sent before ${target.id} existed`
  if (names(m.text, target)) return undefined
  const named = others.filter(o => names(m.text, o))
  if (named.length) return `the player's message ${quoted(m)} is about ${named.map(o => o.id).join(', ')}, not ${target.id}`
  if (ALL.test(intent.clause)) return undefined
  const mine = mentions(m.text, target, others)
  const score = others.map(o => mentions(m.text, o, [target, ...others.filter(x => x !== o)]))
  const best = Math.max(0, ...score)
  // a word only this unit has wins; a typo counts when no other unit is as close
  if (mine === 2 || mine > best) return undefined
  if (best > mine) return `the player's message ${quoted(m)} is about ${others.filter((_, i) => score[i] === best).map(o => o.id).join(', ')}, not ${target.id}`
  const genio = answeredGenio(history, m)
  const about = (t: MergeTarget): boolean => names(genio, t)
  if (genio && about(target) && (PLURAL.test(intent.clause) || !others.some(about))) return undefined
  return `the player's message ${quoted(m)} does not name ${target.id} ("${truncate(target.title, 60)}") or reply to Genio's message about it`
}

/**
 * Words that discard a unit's unlanded work (force despawn): a real player
 * message, sent after the unit existed, that says to get rid of something in
 * any plain words (not a question, a maybe or a "later") and points at this
 * unit as a merge approval does: by id, branch, title or a word only it has
 * (its kind too, typos allowed), "everything", or a reply to Genio's message
 * about it.
 */
export function verifyDiscardWords(history: ChatMessage[], quote: string | undefined, target: DiscardTarget, others: DiscardTarget[] = []): WordsCheck {
  const { found, reason } = matching(history, quote ?? '')
  if (!found.length) return { ok: false, reason: reason! }
  let first: string | undefined
  for (const m of found) {
    const why = discardRefusal(history, m, target, others)
    if (!why) return { ok: true, messageId: m.id, at: m.ts, text: m.text }
    first ??= why
  }
  return { ok: false, reason: first! }
}

/** What a refused tool says: the reason, and what would make it work. */
export function refusal(action: string, reason: string, remedy: string): string {
  return `${action} refused: ${reason}. ${remedy}`
}
