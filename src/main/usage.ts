/**
 * Usage for Settings → Accounts & keys, best source first:
 *   - plan / rate-limit status the tool itself reports:
 *       Codex: a no-prompt app-server account/rateLimits/read (codex-usage-probe.ts,
 *       kept in data/usage/codex-limits.json) plus the rate_limits snapshot in
 *       token_count events of its session logs (sessions/**.jsonl and
 *       archived_sessions/*.jsonl, where despawned units' threads go, in Genio's
 *       own Codex home and in the player's $CODEX_HOME);
 *       Claude Code: a zero-prompt structured /usage account refresh plus SDK
 *       rate_limit_event messages, kept in data/usage/claude-limits.json;
 *   - tokens Genio measures from the session logs of its own units and chats (sessions whose
 *     cwd is inside Genio's base or a unit worktree on a Dev Drive): Claude Code transcripts and Codex session logs;
 *   - FAL.ai spend recorded in the FAL screen's run history.
 * Genio reads only usage/session records. The SDK handles its own authenticated
 * account probe; Genio never reads credentials or calls a private endpoint directly.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FalRun, FalSpend, MeasuredUsage, TokenTally, ToolUsage, UsageLimits, UsageReport, UsageWindow } from '@shared/api'
import { FalHistory } from './fal-history'
import { expireWindow, type QuotaWindow } from './quota-policy'
import type { AppCtx } from './services'
import { appendJsonl, isSubPath, nowIso, readJson, writeJsonAtomic } from './util'
import { claudeProbeError, refreshClaudePlanUsage } from './claude-usage-probe'
import { claudeProjectRoots } from './claude-home'
import { codexProbeError, codexSnapshot, readCodexProbeLimits, refreshCodexPlanUsage } from './codex-usage-probe'
import { CODEX_SESSION_DIRS } from './codex-session'
import { codexHomes, codexSignedOut } from './codex-home'
import { volumeChild } from '../../resources/unit-skills/genio/skills/play/scripts/clone.mjs'

const DAY = 86_400_000

export interface TokenRecord {
  ts: number
  session: string
  input: number
  cached: number
  output: number
}

export const emptyTally = (): TokenTally => ({ input: 0, cached: 0, output: 0, total: 0, sessions: 0 })

export function tally(records: Iterable<TokenRecord>, since: number, until = Infinity): TokenTally {
  const t = emptyTally()
  const sessions = new Set<string>()
  for (const r of records) {
    if (r.ts < since || r.ts >= until) continue
    t.input += r.input
    t.cached += r.cached
    t.output += r.output
    sessions.add(r.session)
  }
  t.total = t.input + t.cached + t.output
  t.sessions = sessions.size
  return t
}

/** Local midnight today and six days before it: the "today" and "7 days" windows. */
export function usageWindows(now = Date.now()): { todayStart: number; weekStart: number } {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const todayStart = d.getTime()
  d.setDate(d.getDate() - 6)
  return { todayStart, weekStart: d.getTime() }
}

export function windowLabel(minutes?: number): string {
  if (!minutes) return 'limit'
  if (minutes === 10_080) return 'weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-min`
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return obj(JSON.parse(line))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- Codex

export interface CodexWindow {
  minutes?: number
  usedPercent: number
  resetsAt?: string
}

export interface CodexSnapshot {
  ts: string
  limitId: string
  name?: string
  plan?: string
  windows: CodexWindow[]
  /** where the snapshot came from; session logs and chat events are "reported by Codex" */
  source?: string
}

export interface CodexSession {
  id: string
  cwd?: string
  records: TokenRecord[]
  snapshots: CodexSnapshot[]
}

/** ChatGPT subscription telemetry; these tokens are never added to cash cost. */
export function recordCodexChatUsage(data: string, cwd: string, thread: string, usage: Record<string, any>): void {
  if (!/^[\w-]+$/.test(thread)) return
  const file = path.join(data, 'usage', 'codex-chat', `${thread}.jsonl`)
  const total = usage.total
  if (!total) return
  appendJsonl(file, { type: 'session_meta', payload: { cwd, id: thread } })
  appendJsonl(file, { timestamp: nowIso(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
    input_tokens: num(total.inputTokens), cached_input_tokens: num(total.cachedInputTokens), output_tokens: num(total.outputTokens)
  } } } })
}
export function recordCodexChatLimits(data: string, event: Record<string, any>): void {
  const limits = event.rateLimits
  if (!limits) return
  let parsed: CodexSnapshot | undefined
  try { parsed = codexSnapshot(limits, nowIso()) } catch { return }
  const snapshot = parsed
  if (!snapshot) return
  const file = path.join(data, 'usage', 'codex-chat-limits.json')
  const prior = readJson<CodexSnapshot[]>(file, [])
  const i = prior.findIndex(p => p.limitId === snapshot.limitId)
  if (i >= 0) prior[i] = snapshot; else prior.push(snapshot)
  writeJsonAtomic(file, prior)
}

/** Only these lines matter; everything else (prompts, tool output) is skipped unparsed. */
export const isCodexUsageLine = (line: string): boolean => line.includes('"token_count"') || line.includes('"session_meta"')

function codexWindow(v: unknown, eventMs: number): CodexWindow | undefined {
  const w = obj(v)
  if (!w || typeof w.used_percent !== 'number') return undefined
  const resetsAt =
    typeof w.resets_at === 'number'
      ? new Date(w.resets_at * 1000).toISOString()
      : typeof w.resets_in_seconds === 'number' && Number.isFinite(eventMs)
        ? new Date(eventMs + w.resets_in_seconds * 1000).toISOString()
        : undefined
  return { minutes: typeof w.window_minutes === 'number' ? w.window_minutes : undefined, usedPercent: num(w.used_percent), resetsAt }
}

/**
 * One Codex session log: its cwd, token deltas per API call (from the cumulative
 * total_token_usage, so repeated events don't double count) and its rate-limit snapshots.
 * The parser keeps its cumulative counters, so an append-only log can be fed its new tail later.
 */
export class CodexSessionParser {
  readonly session: CodexSession
  private prev = { input: 0, cached: 0, output: 0 }
  constructor(id: string) { this.session = { id, records: [], snapshots: [] } }

  feed(line: string): void {
    const s = this.session
    if (!isCodexUsageLine(line)) return
    const j = parseLine(line)
    const p = obj(j?.payload)
    if (!j || !p) return
    if (j.type === 'session_meta') {
      s.id = str(p.id) ?? s.id
      s.cwd = str(p.cwd) ?? s.cwd
      return
    }
    if (p.type !== 'token_count') return
    const ts = str(j.timestamp) ?? ''
    const ms = Date.parse(ts)
    const total = obj(obj(p.info)?.total_token_usage)
    if (total && Number.isFinite(ms)) {
      const inputAll = num(total.input_tokens)
      const cur = { cached: num(total.cached_input_tokens), input: Math.max(0, inputAll - num(total.cached_input_tokens)), output: num(total.output_tokens) }
      const d = { input: cur.input - this.prev.input, cached: cur.cached - this.prev.cached, output: cur.output - this.prev.output }
      // a smaller total means the counter restarted (new conversation in the same file)
      const reset = d.input < 0 || d.cached < 0 || d.output < 0
      const delta = reset ? cur : d
      if (delta.input || delta.cached || delta.output) s.records.push({ ts: ms, session: s.id, ...delta })
      this.prev = cur
    }
    const rl = obj(p.rate_limits)
    if (rl && ts) {
      const windows = [codexWindow(rl.primary, ms), codexWindow(rl.secondary, ms)].filter((w): w is CodexWindow => Boolean(w))
      if (windows.length) s.snapshots.push({ ts, limitId: str(rl.limit_id) ?? 'codex', name: str(rl.limit_name), plan: str(rl.plan_type), windows })
    }
  }
}

export function parseCodexSession(lines: Iterable<string>, id: string): CodexSession {
  const parser = new CodexSessionParser(id)
  for (const line of lines) parser.feed(line)
  return parser.session
}

/** The latest snapshot per limit bucket, main bucket first. */
export function codexLimits(snapshots: Iterable<CodexSnapshot>, now = Date.now()): UsageLimits[] {
  const latest = new Map<string, CodexSnapshot>()
  const windows = new Map<string, Map<string, UsageWindow>>()
  let plan: string | undefined
  let planTs = ''
  for (const s of [...snapshots].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const bucket = windows.get(s.limitId) ?? new Map<string, UsageWindow>()
    for (const w of s.windows) {
      const label = windowLabel(w.minutes)
      const prev = bucket.get(label)
      bucket.set(label, { label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, observedAt: s.ts,
        changedAt: prev && prev.usedPercent === w.usedPercent && prev.resetsAt === w.resetsAt ? prev.changedAt : s.ts })
    }
    windows.set(s.limitId, bucket)
    const cur = latest.get(s.limitId)
    if (!cur || s.ts > cur.ts) latest.set(s.limitId, s)
    if (s.plan && s.ts > planTs) {
      plan = s.plan
      planTs = s.ts
    }
  }
  return [...latest.values()]
    .sort((a, b) => (a.limitId === 'codex' ? -1 : b.limitId === 'codex' ? 1 : a.limitId.localeCompare(b.limitId)))
    .map((s) => ({
      source: s.source ?? 'reported by Codex',
      updatedAt: s.ts,
      name: s.limitId === 'codex' ? undefined : (s.name ?? s.limitId),
      plan: s.limitId === 'codex' ? (s.plan ?? plan) : s.plan,
      windows: [...windows.get(s.limitId)!.values()].map((w) => expireWindow(w, now))
    }))
}

// ---------------------------------------------------------- Claude Code

export interface ClaudeUsageLine {
  /** message id + request id: the transcript repeats a message once per content block */
  key: string
  cwd?: string
  record: TokenRecord
}

/** Per-message usage from a Claude Code transcript line (assistant messages only). */
export function parseClaudeUsageLine(line: string): ClaudeUsageLine | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined
  const j = parseLine(line)
  if (!j || j.type !== 'assistant') return undefined
  const msg = obj(j.message)
  const u = obj(msg?.usage)
  const ts = Date.parse(str(j.timestamp) ?? '')
  if (!msg || !u || !Number.isFinite(ts)) return undefined
  const record: TokenRecord = {
    ts,
    session: str(j.sessionId) ?? str(j.session_id) ?? '',
    input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
    cached: num(u.cache_read_input_tokens),
    output: num(u.output_tokens)
  }
  if (!record.input && !record.cached && !record.output) return undefined
  const key = `${str(msg.id) ?? str(j.uuid) ?? ''}:${str(j.requestId) ?? ''}`
  return { key, cwd: str(j.cwd), record }
}

/** Claude Code's project folder name for a cwd: every non-alphanumeric character becomes '-'. */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** What the Agent SDK's rate_limit_event carries (the fields Genio keeps). */
export interface ClaudeRateLimitInfo {
  status?: string
  rateLimitType?: string
  utilization?: number
  resetsAt?: number
}

interface StoredWindow {
  source?: string
  label?: string
  utilizationObservedAt?: string
  status?: string
  utilization?: number
  resetsAt?: number
  updatedAt: string
  observedAt?: string
  changedAt?: string
}

export interface ClaudeLimitsFile {
  windows: Record<string, StoredWindow>
  plan?: string
  /** Last successful full account /usage snapshot, separate from status-only events. */
  planObservedAt?: string
  planAvailable?: boolean
}

/** Merge one rate_limit_event; unchanged events refresh observation time, not change time. */
export function mergeClaudeRateLimit(file: ClaudeLimitsFile, info: ClaudeRateLimitInfo, at = nowIso()): ClaudeLimitsFile | undefined {
  const type = info.rateLimitType || 'unspecified'
  const prev = file.windows[type]
  // SDK rate-limit headers are USED fractions, unlike structured /usage's percentages.
  const utilization = typeof info.utilization === 'number' && Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization : undefined
  const changedReset = info.resetsAt !== undefined && info.resetsAt !== prev?.resetsAt
  const recovered = info.status === 'allowed' && prev?.status === 'rejected'
  const keepUtilization = !changedReset && !recovered && info.utilization === undefined
  const next: StoredWindow = {
    source: utilization !== undefined ? 'Claude Code rate-limit event (used fraction)' : prev?.source,
    utilizationObservedAt: utilization !== undefined ? at : keepUtilization ? prev?.utilizationObservedAt ?? prev?.observedAt ?? prev?.updatedAt : undefined,
    status: info.status ?? prev?.status,
    utilization: utilization ?? (keepUtilization ? prev?.utilization : undefined),
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : prev?.resetsAt,
    updatedAt: at,
    observedAt: at,
    changedAt: at
  }
  if (prev && prev.status === next.status && prev.utilization === next.utilization && prev.resetsAt === next.resetsAt) next.changedAt = prev.changedAt ?? prev.updatedAt
  return { ...file, windows: { ...file.windows, [type]: next } }
}

const CLAUDE_WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_oauth_apps: 'weekly (OAuth apps)',
  seven_day_opus: 'weekly (Opus)',
  seven_day_sonnet: 'weekly (Sonnet)',
  seven_day_overage_included: 'weekly (with extra usage)',
  overage: 'extra usage',
  unspecified: 'plan limit'
}
const CLAUDE_ORDER = Object.keys(CLAUDE_WINDOW_LABEL)

/**
 * SDK events report a used fraction (0-1). Structured /usage is normalized at its
 * boundary instead; guessing by magnitude would turn 1% used into 100% used.
 */
export const claudePercent = (u: number): number | undefined => Number.isFinite(u) && u >= 0 && u <= 1 ? Math.round(u * 1000) / 10 : undefined

export function claudeLimits(file: ClaudeLimitsFile | undefined, now = Date.now()): UsageLimits | undefined {
  const entries = Object.entries(file?.windows ?? {}).sort(([a], [b]) => CLAUDE_ORDER.indexOf(a) - CLAUDE_ORDER.indexOf(b))
  if (!entries.length) return undefined
  const windows = entries.map(
    ([type, w]): UsageWindow => expireWindow({
      observedAt: w.status === 'rejected' ? w.observedAt ?? w.updatedAt : w.utilizationObservedAt ?? w.observedAt ?? w.updatedAt,
      changedAt: w.changedAt ?? w.updatedAt,
      label: w.label ?? CLAUDE_WINDOW_LABEL[type] ?? type.replace(/_/g, ' '),
      usedPercent: typeof w.utilization === 'number' ? claudePercent(w.utilization) : undefined,
      status: w.status === 'rejected' && w.resetsAt !== undefined && w.resetsAt * 1000 <= now ? undefined : w.status,
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
    }, now)
  )
  const updatedAt = entries.map(([, w]) => w.updatedAt).sort().pop() as string
  const sources = [...new Set(entries.map(([, w]) => w.source ?? "reported by Claude Code to Genio's chat"))]
  return { source: sources.join('; '), plan: file?.plan, updatedAt, windows }
}

export function recordClaudeRateLimit(file: string, info: ClaudeRateLimitInfo): void {
  const cur = readJson<ClaudeLimitsFile>(file, { windows: {} })
  const next = mergeClaudeRateLimit({ windows: obj(cur.windows) ? cur.windows : {} }, info)
  if (next) writeJsonAtomic(file, next)
}

export const claudeLimitsFile = (dataDir: string): string => path.join(dataDir, 'usage', 'claude-limits.json')

/** A missing report is unknown; corrupt/unreadable evidence is a visible read failure. */
export function readClaudeLimits(dataDir: string): ClaudeLimitsFile | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(claudeLimitsFile(dataDir), 'utf8')) as ClaudeLimitsFile
    if (!value?.windows || typeof value.windows !== 'object' || Array.isArray(value.windows)) throw new Error('Invalid Claude usage report')
    for (const w of Object.values(value.windows)) {
      if (!w || typeof w !== 'object' || typeof w.updatedAt !== 'string' ||
        (w.utilization !== undefined && (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization))) ||
        (w.resetsAt !== undefined && (typeof w.resetsAt !== 'number' || !Number.isFinite(w.resetsAt)))) throw new Error('Invalid Claude usage window')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// ---------------------------------------------------------------- FAL

export function falSpend(runs: FalRun[], now = Date.now()): FalSpend {
  const { todayStart, weekStart } = usageWindows(now)
  const s: FalSpend = { source: 'recorded in the FAL run history', updatedAt: new Date(now).toISOString(), todayUsd: 0, weekUsd: 0, runs: 0, costed: 0 }
  for (const r of runs) {
    const t = Date.parse(r.createdAt)
    if (!Number.isFinite(t) || t < weekStart) continue
    s.runs++
    if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd)) continue
    s.costed++
    s.weekUsd += r.costUsd
    if (t >= todayStart) s.todayUsd += r.costUsd
  }
  return s
}

// ---------------------------------------------------------------- dispatch quota

/** Live 5-hour and weekly windows per tool, for the loadout picker (a rejected window counts as 100%). */
export function quotaFromUsage(r: UsageReport): Record<string, QuotaWindow[]> {
  const out: Record<string, QuotaWindow[]> = {}
  for (const t of r.tools) {
    const windows = t.limits.flatMap((l) => l.windows.map((w) => expireWindow({ ...w, label: l.name ? `${l.name}: ${w.label}` : w.label, observedAt: w.observedAt ?? l.updatedAt })))
    if (windows.length) out[t.tool] = windows
  }
  return out
}

// ---------------------------------------------------------------- scanning

/** *.jsonl files under dir modified at or after `since` (no symlinks followed). */
function recentJsonl(dir: string, since: number, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) recentJsonl(p, since, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        if (fs.statSync(p).mtimeMs >= since) out.push(p)
      } catch {
        /* vanished */
      }
    }
  }
  return out
}

/** What the scan actually read from disk (tests and the perf harness). */
export const scanDiagnostics = { bytesRead: 0, filesRead: 0 }

/**
 * Stream a log from `offset`, line by line (logs can be tens of MB). Returns the
 * byte offset after the last complete line; a trailing partial line (a writer
 * mid-record) is still offered to `onLine` but is read again on the next scan.
 */
export async function readLines(file: string, offset: number, onLine: (line: string) => void): Promise<number> {
  let total = offset
  let carry: Buffer = Buffer.alloc(0)
  scanDiagnostics.filesRead++
  for await (const chunk of fs.createReadStream(file, { start: offset }) as AsyncIterable<Buffer>) {
    scanDiagnostics.bytesRead += chunk.length
    total += chunk.length
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    let from = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, from)
      if (nl < 0) break
      onLine(buf.toString('utf8', from, nl > from && buf[nl - 1] === 0x0d ? nl - 1 : nl))
      from = nl + 1
    }
    carry = buf.subarray(from)
  }
  if (carry.length) onLine(carry.toString('utf8'))
  return total - carry.length
}

interface Parsed<T, S> { data: T; state?: S; offset: number }
interface Tail<T, S> { offset: number; data?: T; state?: S }

/**
 * Parsed files, reused while their size and mtime are unchanged. A file that
 * only grew (an append-only session log) is parsed from where the last scan
 * stopped, continuing the previous data and parser state.
 */
class FileCache<T, S = undefined> {
  private map = new Map<string, { mtimeMs: number; size: number } & Parsed<T, S>>()

  async get(file: string, parse: (file: string, from: Tail<T, S>) => Promise<Parsed<T, S>>): Promise<T | undefined> {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.map.delete(file)
      return undefined
    }
    const hit = this.map.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
    const from: Tail<T, S> = hit && st.size > hit.size ? { offset: hit.offset, data: hit.data, state: hit.state } : { offset: 0 }
    try {
      const parsed = await parse(file, from)
      this.map.set(file, { mtimeMs: st.mtimeMs, size: st.size, ...parsed })
      return parsed.data
    } catch {
      // locked or vanished mid-read: skip it this time
      return hit?.data
    }
  }

  prune(keep: Set<string>): void {
    for (const k of this.map.keys()) if (!keep.has(k)) this.map.delete(k)
  }
}

const claudeCache = new FileCache<ClaudeUsageLine[]>()
const codexCache = new FileCache<CodexSession, CodexSessionParser>()

async function parseClaudeTail(file: string, from: Tail<ClaudeUsageLine[], undefined>): Promise<Parsed<ClaudeUsageLine[], undefined>> {
  const data = from.data ? [...from.data] : []
  const offset = await readLines(file, from.offset, (line) => {
    const v = parseClaudeUsageLine(line)
    if (v) data.push(v)
  })
  return { data, offset }
}

async function parseCodexTail(file: string, from: Tail<CodexSession, CodexSessionParser>): Promise<Parsed<CodexSession, CodexSessionParser>> {
  const parser = from.state ?? new CodexSessionParser(path.basename(file, '.jsonl'))
  const offset = await readLines(file, from.offset, (line) => parser.feed(line))
  return { data: parser.session, state: parser, offset }
}

/** Memoised per scan: a cwd's ownership never changes within one scan, and path checks are not free. */
function cwdMemo<T>(fn: (cwd: string) => T): (cwd: string | undefined) => T | undefined {
  const memo = new Map<string, T>()
  return (cwd) => {
    if (!cwd) return undefined
    let v = memo.get(cwd)
    if (v === undefined) {
      v = fn(cwd)
      memo.set(cwd, v)
    }
    return v
  }
}

/**
 * The world a unit session belongs to: the first folder under Genio's worktrees/ (units run in worktrees/<world>/<task>),
 * or under the base's worktrees on a Dev Drive project's volume (placeWorktree).
 */
export function worldOf(cwd: string | undefined, root: string): string | undefined {
  if (!cwd) return undefined
  const rel = path.relative(path.join(root, 'worktrees'), cwd)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return volumeChild(cwd, root, 'worktrees')
  return rel.split(/[\\/]/)[0] || undefined
}

function measured(source: string, scope: string, records: TokenRecord[], now: number, worlds?: Map<TokenRecord, string>): MeasuredUsage {
  const { todayStart, weekStart } = usageWindows(now)
  const byWorld: NonNullable<MeasuredUsage['byWorld']> = {}
  const groups = new Map<string, TokenRecord[]>()
  for (const [r, w] of worlds ?? []) {
    const list = groups.get(w)
    if (list) list.push(r)
    else groups.set(w, [r])
  }
  for (const [w, list] of groups) byWorld[w] = { today: tally(list, todayStart), week: tally(list, weekStart) }
  return { source, scope, updatedAt: new Date(now).toISOString(), today: tally(records, todayStart), week: tally(records, weekStart), byWorld }
}

export function belongsToGenio(line: ClaudeUsageLine, sessions: Set<string>, root: string): boolean {
  return sessions.has(line.record.session) || Boolean(line.cwd && isSubPath(line.cwd, root))
}

/** Session ownership survives cwd changes; legacy main chat remains unattributed. */
export function usageAttribution(ctx: AppCtx): { sessions: Map<string, string | undefined>; world(cwd?: string): string | undefined } {
  const sessions = new Map<string, string | undefined>()
  const owners = new Map((ctx.allies?.list() ?? []).filter(a => a.projects.length === 1).map(a => [a.name, a.projects[0]]))
  const homes = [...ctx.homes.values()].map(h => ({ home: h.home, world: owners.get(h.home.name) }))
    .sort((a, b) => b.home.root.length - a.home.root.length)
  for (const { home, world } of homes) {
    const state = readJson<{ sessionId?: string; botSessionId?: string }>(home.workspaceFileToRead, {})
    if (state.sessionId) sessions.set(state.sessionId, world)
    if (state.botSessionId) sessions.set(state.botSessionId, world)
    const costs = readJson<{ sessions: Record<string, unknown> }>(path.join(home.data, 'usage', 'session-costs.json'), { sessions: {} })
    for (const id of Object.keys(costs.sessions)) sessions.set(id, world)
  }
  return { sessions, world(cwd) {
    if (!cwd) return undefined
    // Check the most specific base first: main also contains project bases.
    for (const { home, world } of homes) {
      if (world && path.relative(home.root, cwd) === '') return world
      const unitWorld = worldOf(cwd, home.root)
      if (unitWorld) return unitWorld
    }
    return undefined
  } }
}

async function claudeUsage(ctx: AppCtx, root: string, now: number): Promise<ToolUsage> {
  const { weekStart } = usageWindows(now)
  // Genio's own Claude home, plus the player's for Genio sessions from before it.
  const roots = claudeProjectRoots()
  // Persisted session identity wins over cwd (which can change mid-conversation).
  const attribution = usageAttribution(ctx)
  const sessions = new Set(attribution.sessions.keys())
  const files = roots.flatMap(projects => recentJsonl(projects, weekStart))
  const seen = new Map<string, TokenRecord>()
  const worldByKey = new Map<string, string>()
  const inBase = cwdMemo((cwd) => isSubPath(cwd, root) || Boolean(attribution.world(cwd)))
  const worldOfCwd = cwdMemo((cwd) => attribution.world(cwd) ?? '')
  for (const f of files) {
    const lines = await claudeCache.get(f, parseClaudeTail)
    for (const l of lines ?? []) {
      if (!(sessions.has(l.record.session) || inBase(l.cwd))) continue
      const key = `${l.record.session}:${l.key}`
      const world = attribution.sessions.has(l.record.session) ? attribution.sessions.get(l.record.session) : worldOfCwd(l.cwd) || undefined
      if (world) worldByKey.set(key, world)
      const prev = seen.get(key)
      // Streaming content blocks may repeat the request with larger output counters.
      seen.set(key, prev ? { ...prev, input: Math.max(prev.input, l.record.input),
        cached: Math.max(prev.cached, l.record.cached), output: Math.max(prev.output, l.record.output) } : l.record)
    }
  }
  const records = [...seen.values()]
  const worlds = new Map<TokenRecord, string>()
  for (const [key, r] of seen) if (worldByKey.has(key)) worlds.set(r, worldByKey.get(key)!)
  claudeCache.prune(new Set(files))
  const limits = claudeLimits(readClaudeLimits(ctx.main.home.data), now)
  return {
    tool: 'claude',
    limits: limits ? [limits] : [],
    error: claudeProbeError(ctx.main.home.data),
    measured: measured('measured by Genio', "Genio's units and chats (Claude Code transcripts)", records, now, worlds),
    note: limits?.windows.some(w => w.usedPercent !== undefined) ? undefined : 'Current Claude usage unknown; ordinary dispatch is allowed. Plan protection requires a report under 10 minutes old.'
  }
}

async function codexUsage(ctx: AppCtx, root: string, now: number, data: string): Promise<ToolUsage> {
  // Genio's Codex is not signed in: old plan readings do not describe a login Genio can use, so there is nothing to report.
  if (codexSignedOut()) return { tool: 'codex', limits: [], measured: measured('measured by Genio', "Genio's units and chats (Codex plan tokens, not cash cost)", [], now) }
  const attribution = usageAttribution(ctx)
  const { weekStart } = usageWindows(now)
  const chats = recentJsonl(path.join(data, 'usage', 'codex-chat'), weekStart)
  const chatIds = chats.map(f => path.basename(f, '.jsonl'))
  // Despawned units' threads are archived (moved, mtime kept), so their week still counts.
  // Genio's own Codex home, plus the player's for Genio threads from before it (or from a fallback).
  const native = codexHomes().flatMap(home => CODEX_SESSION_DIRS.flatMap(dir => recentJsonl(path.join(home, dir), weekStart)))
  const files = [...native.filter(f => !chatIds.some(id => f.endsWith(`${id}.jsonl`))), ...chats]
  const records: TokenRecord[] = []
  const worlds = new Map<TokenRecord, string>()
  // The account probe, chat events and session logs all feed one latest-per-bucket view.
  const snapshots: CodexSnapshot[] = [...readJson<CodexSnapshot[]>(path.join(data, 'usage', 'codex-chat-limits.json'), []), ...readCodexProbeLimits(data)]
  for (const f of files) {
    const s = await codexCache.get(f, parseCodexTail)
    if (!s) continue
    // plan limits are account-wide: every session's snapshot counts
    snapshots.push(...s.snapshots)
    const owned = s.records.some(r => attribution.sessions.has(r.session))
    if (chats.includes(f) || owned || s.cwd && (isSubPath(s.cwd, root) || attribution.world(s.cwd))) {
      records.push(...s.records)
      for (const r of s.records) {
        const world = attribution.sessions.has(r.session) ? attribution.sessions.get(r.session) : attribution.world(s.cwd)
        if (world) worlds.set(r, world)
      }
    }
  }
  codexCache.prune(new Set(files))
  const limits = codexLimits(snapshots, now)
  return {
    tool: 'codex',
    limits,
    error: codexProbeError(data),
    measured: measured('measured by Genio', "Genio's units and chats (Codex plan tokens, not cash cost)", records, now, worlds),
    note: limits.length ? undefined : 'Codex reported no plan windows (account probe and the last 7 days of session logs).'
  }
}

async function safely(tool: string, fn: () => Promise<ToolUsage>): Promise<ToolUsage> {
  try {
    return await fn()
  } catch (e) {
    return { tool, limits: [], error: (e as Error).message }
  }
}

let inFlight: Promise<UsageReport> | undefined

/** Build the usage report (one scan at a time; parsed files are cached between calls). */
export async function usageReport(ctx: AppCtx, options: { forceClaude?: boolean; forceCodex?: boolean } = {}): Promise<UsageReport> {
  // Both probes are bounded and never throw: a failed read leaves usage unknown, not blocked.
  await Promise.all([
    refreshClaudePlanUsage(ctx.main.home.data, ctx.main.home.root, ctx.settings.get().claudePath?.trim() || undefined, options.forceClaude),
    refreshCodexPlanUsage(ctx.main.home.data, options.forceCodex)
  ])
  inFlight ??= (async (): Promise<UsageReport> => {
    const root = ctx.main.home.root
    const now = Date.now()
    const tools = [await safely('claude', () => claudeUsage(ctx, root, now)), await safely('codex', () => codexUsage(ctx, root, now, ctx.main.home.data))]
    let fal: FalSpend
    try {
      fal = falSpend(new FalHistory(path.join(ctx.main.home.data, 'fal')).list(), now)
    } catch {
      fal = falSpend([], now)
    }
    return { generatedAt: new Date(now).toISOString(), tools, fal }
  })().finally(() => {
    inFlight = undefined
  })
  return inFlight
}
