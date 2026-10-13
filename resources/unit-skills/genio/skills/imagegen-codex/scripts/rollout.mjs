/**
 * Reading a Codex session rollout (~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread-id>.jsonl).
 * `codex exec --json` does not emit image items, but the rollout records each
 * built-in image_gen call as an `item_completed` event of kind
 * `image_gen.generation` with its savedPath, and every `token_count` event
 * carries the plan's rate limits. Only session files are read here, never
 * Codex's auth or config files.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The thread id from `codex exec --json` stdout (the `thread.started` event), or null. */
export function threadIdFromEvents(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const e = JSON.parse(line)
      if (e?.type === 'thread.started' && typeof e.thread_id === 'string') return e.thread_id
    } catch {
      /* not an event line */
    }
  }
  return null
}

/**
 * Image generations, rate limits (first and last seen) and the completion of a
 * rollout. Inline image data (`result`) is not kept; use imageBytes() for that.
 */
export function parseRollout(text) {
  const out = { threadId: null, images: [], rateLimitsFirst: null, rateLimits: null, completed: null }
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue // a torn last line while Codex is still writing
    }
    const p = o?.payload
    if (!p || typeof p !== 'object') continue
    if (o.type === 'session_meta') out.threadId ??= p.id ?? p.session_id ?? null
    else if (p.type === 'item_completed' && p.item?.kind === 'image_gen.generation') {
      const it = p.item
      out.images.push({
        id: it.id ?? null,
        status: it.status ?? null,
        savedPath: typeof it.savedPath === 'string' ? it.savedPath : null,
        revisedPrompt: it.revisedPrompt ?? null,
        transparentBackground: it.transparentBackground ?? null,
        failure: it.failure ?? null,
        hasInlineResult: typeof it.result === 'string' && it.result.length > 0,
        completedAt: typeof p.completed_at_ms === 'number' ? new Date(p.completed_at_ms).toISOString() : (o.timestamp ?? null)
      })
    } else if (p.type === 'token_count' && p.rate_limits) {
      out.rateLimitsFirst ??= p.rate_limits
      out.rateLimits = p.rate_limits
    } else if (p.type === 'task_complete') {
      out.completed = { durationMs: p.duration_ms ?? null }
    }
  }
  return out
}

/** The inline PNG bytes of one generation, when the rollout carries them (fallback if savedPath is gone). */
export function imageBytes(text, id) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes('image_gen.generation') || (id && !line.includes(id))) continue
    try {
      const it = JSON.parse(line)?.payload?.item
      if (it?.kind === 'image_gen.generation' && it.id === id && typeof it.result === 'string') return Buffer.from(it.result, 'base64')
    } catch {
      /* skip */
    }
  }
  return null
}

const pct = (w) => (typeof w?.used_percent === 'number' ? w.used_percent : null)

/** The plan meter for the output: used % of each window, and a warning at or above `warnAt` %. */
export function planMeter(rateLimits, warnAt = 80, before = null) {
  if (!rateLimits) return { known: false, warning: null }
  const win = (w) => (w ? { used_percent: pct(w), window_minutes: w.window_minutes ?? null, resets_at: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null } : null)
  const primary = win(rateLimits.primary)
  const secondary = win(rateLimits.secondary)
  const most = (a, b) => Math.max(...[a, b].filter((x) => typeof x === 'number'), -1)
  const used = most(primary?.used_percent, secondary?.used_percent)
  const usedBefore = before ? most(pct(before.primary), pct(before.secondary)) : -1
  let warning = null
  if (rateLimits.rate_limit_reached_type) warning = `Your ChatGPT plan reports a reached rate limit (${rateLimits.rate_limit_reached_type}).`
  else if (used >= warnAt) warning = `Your ChatGPT plan meter is at ${used}% (warning threshold ${warnAt}%). Image generation competes with your coding units for the same allowance.`
  return {
    known: true,
    plan_type: rateLimits.plan_type ?? null,
    used_percent: used < 0 ? null : used,
    used_percent_before: usedBefore < 0 ? null : usedBefore,
    primary,
    secondary,
    warning
  }
}

const pad = (n) => String(n).padStart(2, '0')
const dayDirs = (sessions, d) => [
  path.join(sessions, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())),
  path.join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
]

/** The rollout file for a thread: the day folders around the run first, then a full scan. */
export function findRollout(sessionsDir, threadId, around = [new Date()]) {
  const match = (name) => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)
  const seen = new Set()
  for (const d of around) {
    for (const dir of dayDirs(sessionsDir, d)) {
      if (seen.has(dir)) continue
      seen.add(dir)
      try {
        const hit = fs.readdirSync(dir).find(match)
        if (hit) return path.join(dir, hit)
      } catch {
        /* no such day */
      }
    }
  }
  try {
    const hit = fs.readdirSync(sessionsDir, { recursive: true }).map(String).find((rel) => match(path.basename(rel)))
    return hit ? path.join(sessionsDir, hit) : null
  } catch {
    return null
  }
}
