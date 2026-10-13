/**
 * Usage for Systems → Accounts, best source first:
 *   - plan / rate-limit status the tool itself reports:
 *       Codex: the rate_limits snapshot in token_count events of its session logs
 *       ($CODEX_HOME/sessions/**.jsonl);
 *       Claude Code: rate_limit_event messages Genio's own chat sessions receive from the
 *       Agent SDK, kept in data/usage/claude-limits.json (the CLI writes no limits to disk);
 *   - tokens Genio measures from the session logs of its own units and chats (sessions whose
 *     cwd is inside Genio's base): Claude Code transcripts and Codex session logs;
 *   - FAL.ai spend recorded in the FAL screen's run history.
 * Only session/usage logs are read: never auth or credential files, never a private endpoint.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { FalRun, FalSpend, MeasuredUsage, TokenTally, ToolUsage, UsageLimits, UsageReport, UsageWindow } from '@shared/api'
import { FalHistory } from './fal-history'
import type { AppCtx } from './services'
import { isSubPath, nowIso, readJson, writeJson } from './util'

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
}

export interface CodexSession {
  id: string
  cwd?: string
  records: TokenRecord[]
  snapshots: CodexSnapshot[]
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
 */
export function parseCodexSession(lines: Iterable<string>, id: string): CodexSession {
  const s: CodexSession = { id, records: [], snapshots: [] }
  let prev = { input: 0, cached: 0, output: 0 }
  for (const line of lines) {
    if (!isCodexUsageLine(line)) continue
    const j = parseLine(line)
    const p = obj(j?.payload)
    if (!j || !p) continue
    if (j.type === 'session_meta') {
      s.cwd = str(p.cwd) ?? s.cwd
      continue
    }
    if (p.type !== 'token_count') continue
    const ts = str(j.timestamp) ?? ''
    const ms = Date.parse(ts)
    const total = obj(obj(p.info)?.total_token_usage)
    if (total && Number.isFinite(ms)) {
      const inputAll = num(total.input_tokens)
      const cur = { cached: num(total.cached_input_tokens), input: Math.max(0, inputAll - num(total.cached_input_tokens)), output: num(total.output_tokens) }
      const d = { input: cur.input - prev.input, cached: cur.cached - prev.cached, output: cur.output - prev.output }
      // a smaller total means the counter restarted (new conversation in the same file)
      const reset = d.input < 0 || d.cached < 0 || d.output < 0
      const delta = reset ? cur : d
      if (delta.input || delta.cached || delta.output) s.records.push({ ts: ms, session: id, ...delta })
      prev = cur
    }
    const rl = obj(p.rate_limits)
    if (rl && ts) {
      const windows = [codexWindow(rl.primary, ms), codexWindow(rl.secondary, ms)].filter((w): w is CodexWindow => Boolean(w))
      if (windows.length) s.snapshots.push({ ts, limitId: str(rl.limit_id) ?? 'codex', name: str(rl.limit_name), plan: str(rl.plan_type), windows })
    }
  }
  return s
}

/** The latest snapshot per limit bucket, main bucket first. */
export function codexLimits(snapshots: Iterable<CodexSnapshot>, now = Date.now()): UsageLimits[] {
  const latest = new Map<string, CodexSnapshot>()
  let plan: string | undefined
  let planTs = ''
  for (const s of snapshots) {
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
      source: 'reported by Codex',
      updatedAt: s.ts,
      name: s.limitId === 'codex' ? undefined : (s.name ?? s.limitId),
      plan: s.limitId === 'codex' ? (s.plan ?? plan) : s.plan,
      windows: s.windows.map(
        (w): UsageWindow => ({
          label: windowLabel(w.minutes),
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt,
          stale: w.resetsAt ? Date.parse(w.resetsAt) <= now : undefined
        })
      )
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
  status?: string
  utilization?: number
  resetsAt?: number
  updatedAt: string
}

export interface ClaudeLimitsFile {
  windows: Record<string, StoredWindow>
}

/** Merge one rate_limit_event into the stored state; returns undefined when nothing changed. */
export function mergeClaudeRateLimit(file: ClaudeLimitsFile, info: ClaudeRateLimitInfo, at = nowIso()): ClaudeLimitsFile | undefined {
  const type = info.rateLimitType || 'unspecified'
  const prev = file.windows[type]
  const next: StoredWindow = {
    status: info.status,
    utilization: typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? info.utilization : prev?.utilization,
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : prev?.resetsAt,
    updatedAt: at
  }
  if (prev && prev.status === next.status && prev.utilization === next.utilization && prev.resetsAt === next.resetsAt) return undefined
  return { windows: { ...file.windows, [type]: next } }
}

const CLAUDE_WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly (Opus)',
  seven_day_sonnet: 'weekly (Sonnet)',
  seven_day_overage_included: 'weekly (with extra usage)',
  overage: 'extra usage',
  unspecified: 'plan limit'
}
const CLAUDE_ORDER = Object.keys(CLAUDE_WINDOW_LABEL)

/**
 * The SDK reports utilization as a fraction (0-1); a value above 1 is taken as already
 * being a percentage.
 */
export const claudePercent = (u: number): number => Math.round((u <= 1 ? u * 100 : u) * 10) / 10

export function claudeLimits(file: ClaudeLimitsFile | undefined, now = Date.now()): UsageLimits | undefined {
  const entries = Object.entries(file?.windows ?? {}).sort(([a], [b]) => CLAUDE_ORDER.indexOf(a) - CLAUDE_ORDER.indexOf(b))
  if (!entries.length) return undefined
  const windows = entries.map(
    ([type, w]): UsageWindow => ({
      label: CLAUDE_WINDOW_LABEL[type] ?? type.replace(/_/g, ' '),
      usedPercent: typeof w.utilization === 'number' ? claudePercent(w.utilization) : undefined,
      status: w.status,
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : undefined,
      stale: w.resetsAt ? w.resetsAt * 1000 <= now : undefined
    })
  )
  const updatedAt = entries.map(([, w]) => w.updatedAt).sort().pop() as string
  return { source: "reported by Claude Code to Genio's chat", updatedAt, windows }
}

export function recordClaudeRateLimit(file: string, info: ClaudeRateLimitInfo): void {
  const cur = readJson<ClaudeLimitsFile>(file, { windows: {} })
  const next = mergeClaudeRateLimit({ windows: obj(cur.windows) ? cur.windows : {} }, info)
  if (next) writeJson(file, next)
}

export const claudeLimitsFile = (dataDir: string): string => path.join(dataDir, 'usage', 'claude-limits.json')

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

// ---------------------------------------------------------------- scanning

const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
const codexHome = (): string => process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')

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

/** Stream a log and keep what `pick` returns for each line (logs can be tens of MB). */
async function pickLines<T>(file: string, pick: (line: string) => T | undefined): Promise<T[]> {
  const out: T[] = []
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    const v = pick(line)
    if (v !== undefined) out.push(v)
  }
  return out
}

/** Parsed files, reused while their size and mtime are unchanged. */
class FileCache<T> {
  private map = new Map<string, { mtimeMs: number; size: number; data: T }>()

  async get(file: string, parse: (file: string) => Promise<T>): Promise<T | undefined> {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      this.map.delete(file)
      return undefined
    }
    const hit = this.map.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
    try {
      const data = await parse(file)
      this.map.set(file, { mtimeMs: st.mtimeMs, size: st.size, data })
      return data
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
const codexCache = new FileCache<CodexSession>()

function measured(source: string, scope: string, records: TokenRecord[], now: number): MeasuredUsage {
  const { todayStart, weekStart } = usageWindows(now)
  return { source, scope, updatedAt: new Date(now).toISOString(), today: tally(records, todayStart), week: tally(records, weekStart) }
}

async function claudeUsage(ctx: AppCtx, root: string, now: number): Promise<ToolUsage> {
  const { weekStart } = usageWindows(now)
  const projects = path.join(claudeHome(), 'projects')
  const prefix = claudeProjectDir(root).toLowerCase()
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(projects).filter((d) => d.toLowerCase().startsWith(prefix))
  } catch {
    /* no transcripts yet */
  }
  const files = dirs.flatMap((d) => recentJsonl(path.join(projects, d), weekStart))
  const seen = new Set<string>()
  const records: TokenRecord[] = []
  for (const f of files) {
    const lines = await claudeCache.get(f, (p) => pickLines(p, parseClaudeUsageLine))
    for (const l of lines ?? []) {
      // the folder prefix can match a sibling path; the cwd on each line decides
      if (!l.cwd || !isSubPath(l.cwd, root) || seen.has(l.key)) continue
      seen.add(l.key)
      records.push(l.record)
    }
  }
  claudeCache.prune(new Set(files))
  const limits = claudeLimits(readJson<ClaudeLimitsFile | undefined>(claudeLimitsFile(ctx.main.home.data), undefined), now)
  return {
    tool: 'claude',
    limits: limits ? [limits] : [],
    measured: measured('measured by Genio', "Genio's units and chats (Claude Code transcripts)", records, now),
    note: limits ? undefined : "No plan limits seen yet: Claude Code reports them only to Genio's chat, when they change."
  }
}

async function codexUsage(root: string, now: number): Promise<ToolUsage> {
  const { weekStart } = usageWindows(now)
  const files = recentJsonl(path.join(codexHome(), 'sessions'), weekStart)
  const records: TokenRecord[] = []
  const snapshots: CodexSnapshot[] = []
  for (const f of files) {
    const s = await codexCache.get(f, async (p) => parseCodexSession(await pickLines(p, (l) => (isCodexUsageLine(l) ? l : undefined)), path.basename(p, '.jsonl')))
    if (!s) continue
    // plan limits are account-wide: every session's snapshot counts
    snapshots.push(...s.snapshots)
    if (s.cwd && isSubPath(s.cwd, root)) records.push(...s.records)
  }
  codexCache.prune(new Set(files))
  const limits = codexLimits(snapshots, now)
  return {
    tool: 'codex',
    limits,
    measured: measured('measured by Genio', "Genio's units (Codex session logs)", records, now),
    note: limits.length ? undefined : 'No rate-limit snapshot in the last 7 days of Codex session logs.'
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
export function usageReport(ctx: AppCtx): Promise<UsageReport> {
  inFlight ??= (async (): Promise<UsageReport> => {
    const now = Date.now()
    const root = ctx.main.home.root
    const tools = [await safely('claude', () => claudeUsage(ctx, root, now)), await safely('codex', () => codexUsage(root, now))]
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
