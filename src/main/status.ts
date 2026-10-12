/**
 * Status protocol (companion bin/fm-classify-lib.sh). Units append one line per
 * actionable event:  `<verb> [key=<slug>] [at=<epoch>] [corr=<16hex>]: <note>`
 */
import type { StatusEvent, StatusKind } from '@shared/types'

const VERBS: StatusKind[] = ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed', 'note', 'resolved', 'player-held']
const NEVER_RELEVANT: StatusKind[] = ['working', 'paused', 'resolved', 'player-held', 'note']
const RELEVANT_VERBS: StatusKind[] = ['done', 'needs-decision', 'blocked', 'failed']
const LEGACY_RELEVANT = /PR ready|checks green|ready in branch|merged/i

export const DEFAULT_KEY = 'default'

function parseTags(head: string, fields: Record<string, string>): { key?: string; at?: number; dupAt: boolean } {
  let key: string | undefined
  let at: number | undefined
  let atCount = 0
  const re = /\[(\w+)=([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(head))) {
    const [, k, v] = m
    if (k === 'key') key = v.trim() || undefined
    else if (k === 'at') {
      atCount++
      at = /^\d{1,12}$/.test(v.trim()) ? parseInt(v.trim(), 10) : undefined
    } else fields[k] = v.trim()
  }
  const bareCorr = head.match(/(?:^|\s)corr=([0-9a-f]{16})(?:\s|$)/i)
  if (bareCorr && !fields.corr) fields.corr = bareCorr[1]
  return { key, at: atCount === 1 ? at : undefined, dupAt: atCount > 1 }
}

export function parseStatusLine(raw: string, taskId: string, ts = new Date().toISOString()): StatusEvent {
  const line = raw.replace(/^﻿/, '').trim()
  const fields: Record<string, string> = {}
  const colon = line.indexOf(':')
  const head = colon >= 0 ? line.slice(0, colon) : line
  let text = colon >= 0 ? line.slice(colon + 1).trim() : ''
  const verbMatch = head.trim().match(/^([a-z-]+)/i)
  const verb = (verbMatch?.[1] ?? '').toLowerCase() as StatusKind
  const kind: StatusKind = VERBS.includes(verb) ? verb : 'unknown'
  if (kind === 'unknown') text = line
  const tags = parseTags(head, fields)
  let key = tags.key
  // a key may also lead the note: `needs-decision: [key=x] ...`
  const lead = text.match(/^\[key=([^\]]+)\]\s*/)
  if (lead) {
    key = key ?? lead[1].trim()
    text = text.slice(lead[0].length)
  }
  if (kind === 'needs-decision' || kind === 'blocked' || kind === 'resolved' || kind === 'player-held') {
    key = key ?? DEFAULT_KEY
  }
  const pr = line.match(/https?:\/\/[^\s)>\]]+\/(?:pull|merge_requests|pulls)\/\d+/i)
  if (pr) fields.pr = pr[0]
  if (kind === 'paused') {
    const until = text.match(/until\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z)/i)
    if (until) fields.until = until[1]
  }
  const branch = text.match(/ready in branch\s+(\S+)/i)
  if (branch) fields.branch = branch[1].replace(/[.,;]+$/, '')
  let playerRelevant: boolean
  if (NEVER_RELEVANT.includes(kind)) playerRelevant = false
  else if (RELEVANT_VERBS.includes(kind)) playerRelevant = true
  else playerRelevant = LEGACY_RELEVANT.test(line) // bare legacy lines only
  return { taskId, ts, raw: line, kind, key, at: tags.at, text, fields, playerRelevant }
}

/** Parse a whole status log. Empty lines are skipped. */
export function parseStatusLog(content: string, taskId: string): StatusEvent[] {
  return content
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => parseStatusLine(l, taskId))
}

/**
 * Open/resolved fold: needs-decision|blocked open a key; resolved|player-held
 * with the same key close it; a terminal done/failed supersedes stale opens.
 * Later working/paused/done lines never close a specific key otherwise.
 */
export function foldOpenDecisions(events: StatusEvent[]): Map<string, StatusEvent> {
  const open = new Map<string, StatusEvent>()
  for (const e of events) {
    const key = e.key ?? DEFAULT_KEY
    if (e.kind === 'needs-decision' || e.kind === 'blocked') open.set(key, e)
    else if (e.kind === 'resolved' || e.kind === 'player-held') open.delete(key)
    else if (e.kind === 'done' || e.kind === 'failed') open.clear()
  }
  return open
}

/** Format a status line exactly as units do (forward-compatible with the parser). */
export function formatStatusLine(verb: StatusKind, note: string, opts: { key?: string; at?: number } = {}): string {
  const tags = [opts.key ? `[key=${opts.key}]` : '', `[at=${opts.at ?? Math.floor(Date.now() / 1000)}]`].filter(Boolean).join(' ')
  return `${verb} ${tags}: ${note.replace(/\r?\n/g, ' ').trim()}`
}
