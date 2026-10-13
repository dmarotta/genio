/**
 * Desktop notification copy: the single place that turns an outcome into a
 * short, scannable title + one-line body. Full details stay in the app, so
 * ids, paths, URLs and boilerplate prefixes are stripped here.
 */

export type NotifyKind = 'ready' | 'decision' | 'failure' | 'info' | 'alarm' | 'digest'

export interface NotifyInput {
  kind: NotifyKind
  /** free text from a unit, the Bot or a decision; cleaned and capped */
  text?: string
  /** world or ally the outcome belongs to, shown as "Title · where" */
  where?: string
  /** digest / alarm: how many items are waiting */
  count?: number
}

export interface NotifyCopy {
  title: string
  body: string
}

export const TITLE_MAX = 40
export const BODY_MAX = 80
const FALLBACK_BODY = 'Open Genio for details.'

const URL_RE = /\bhttps?:\/\/\S+/gi
const WIN_PATH_RE = /(?:\b[A-Za-z]:|\\\\)[\\/][^\s,;:'"`)\]]*/g
const ABS_PATH_RE = /(?<![\w.])(?:~|\.{1,2})?\/(?:[\w.@-]+\/)*[\w.@-]+\/?/g
const REL_PATH_RE = /\b[\w.@-]+(?:[\\/][\w.@-]+)+\.[A-Za-z]\w{0,4}\b/g
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HASH_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/gi
// unit ids: a slug with a short hex suffix, e.g. fix-login-sho-ff92
const UNIT_ID_RE = /\b[a-z0-9]+(?:-[a-z0-9]+)*-(?=[0-9a-f]{4}\b)[0-9a-f]*\d[0-9a-f]*\b/g
const KEY_TAG_RE = /\[(?:key|at|id)=[^\]]*\]/gi
const PREFIX_RE = /^\s*(?:\[[^\]]{1,20}\]\s*|genio\s*\/\/\s*|(?:bot|your move|choice needed|pr ready|ready for review|problem|the bot hit a problem|genio alarm)\s*[:\-–—]\s*)/i

/** Strips ids, paths, URLs and boilerplate, keeps the first line, caps the length. */
export function cleanNotifyText(text: string | undefined, max = BODY_MAX): string {
  let s = (text ?? '').replace(/\r/g, '')
  s = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  s = s.replace(/\*\*|__|`/g, '')
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
  s = s.replace(URL_RE, ' ').replace(WIN_PATH_RE, ' ').replace(REL_PATH_RE, ' ').replace(ABS_PATH_RE, ' ')
  s = s.replace(KEY_TAG_RE, ' ').replace(UUID_RE, ' ').replace(HASH_RE, ' ').replace(UNIT_ID_RE, ' ')
  s = s.replace(/\(\s*[,;:]?\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1')
  for (let i = 0; i < 4; i++) {
    const next = s.replace(PREFIX_RE, '')
    if (next === s) break
    s = next
  }
  s = s
    .replace(/([:,;])(?:\s*[:,;])+/g, '$1')
    .replace(/([—–])(?:\s*[—–])+/g, '$1')
    .replace(/([:,;])\s*[—–-]\s+/g, '$1 ')
    .replace(/^[\s:,;.\-–—]+/, '')
    .replace(/[\s:,;\-–—]+$/, '')
    .trim()
  if (!s) return ''
  s = s[0].toUpperCase() + s.slice(1)
  return capWords(s, max)
}

/** Caps to `max` characters, cutting at a word boundary and ending with an ellipsis. */
export function capWords(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const sp = cut.lastIndexOf(' ')
  const head = sp > max * 0.6 ? cut.slice(0, sp) : cut
  return head.replace(/[\s.,;:\-–—]+$/, '') + '…'
}

function baseTitle(input: NotifyInput): string {
  const text = input.text ?? ''
  const n = Math.max(1, input.count ?? 1)
  switch (input.kind) {
    case 'ready':
      return /\/pull\/\d+|\bPR\b|pull request/i.test(text) ? 'PR ready' : 'Ready for review'
    case 'decision':
      return 'Choice needed'
    case 'failure':
      return /\b(blocked|stuck|wedged|stalled)\b/i.test(text) ? 'Unit stuck' : 'Something failed'
    case 'alarm':
      return n === 1 ? 'Still waiting on you' : `${n} waiting on you`
    case 'digest':
      return n === 1 ? 'Update while away' : `${n} updates while away`
    default:
      return 'Update'
  }
}

/** The world name from a GitHub PR URL, when the text carries one. */
function repoFromText(text: string | undefined): string | undefined {
  const m = /github\.com\/[^/\s]+\/([^/\s]+)\/pull\/\d+/i.exec(text ?? '')
  return m?.[1]
}

/** Title + body for a desktop notification. Every OS notification goes through here. */
export function formatNotification(input: NotifyInput): NotifyCopy {
  const where = cleanWhere(input.where ?? (input.kind === 'ready' ? repoFromText(input.text) : undefined))
  const base = baseTitle(input)
  const title = capWords(where ? `${base} · ${where}` : base, TITLE_MAX)
  const body = cleanNotifyText(input.text) || FALLBACK_BODY
  return { title, body }
}

function cleanWhere(where: string | undefined): string {
  const w = (where ?? '').trim()
  if (!w || w === 'main') return ''
  return w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}
