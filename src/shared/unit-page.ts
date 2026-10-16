import type { DeliveryMode, PrInfo, Task, TerminalInfo } from './types'
import { squadBadge, squadState, type SquadTone } from './squad-display'

/**
 * The one thing the unit page offers beside More, by state (Recon table in
 * docs/squad-display.md): merge a ready Build, respawn a stopped unit, build
 * from a finished Recon, answer an open question, or steer a working unit
 * through the ping box. Landed and despawned units offer nothing. A Modeller
 * offers exactly what any Build offers.
 */
export type PrimaryAction = 'merge-local' | 'merge-pr' | 'respawn' | 'recon-done' | 'question' | 'steer' | 'none'

const STOPPED: Task['state'][] = ['failed', 'exited', 'detached']
const RUNNING: Task['state'][] = ['spawning', 'working', 'validating', 'stale', 'paused']

export function primaryAction(t: Task, term?: TerminalInfo, openQuestion = false): PrimaryAction {
  if (t.state === 'cleaned' || t.state === 'merged') return 'none'
  if (t.kind === 'scout' && t.state === 'done') return 'recon-done'
  if (STOPPED.includes(t.state)) return 'respawn'
  if (t.state === 'needs-decision' || t.state === 'blocked' || openQuestion) return 'question'
  if (t.kind === 'ship' && t.state === 'ready' && squadState(t, term) === 'READY TO MERGE') {
    if (t.pr?.url && t.pr.state !== 'MERGED' && t.pr.state !== 'CLOSED') return 'merge-pr'
    if (!t.pr?.url && t.mode === 'local-only') return 'merge-local'
    return 'none'
  }
  if (RUNNING.includes(t.state) || t.state === 'ready') return 'steer'
  return 'none'
}

/**
 * "Play this unit", beside the primary action: opens the Play screen with the unit's worktree preselected. Builds
 * in projects whose engine has Play (supportsUnitySlots) only. Enabled while the worktree exists, in every state
 * (a working unit plays a copy of its files as they are on disk at that moment); disabled once the worktree is gone.
 * The hint is the button's plain tooltip; Play's status shows on the Play screen only. undefined: no button.
 */
export function unitPlay(t: Task, playable: boolean, worktreeRemoved = false): { enabled: boolean; hint: string } | undefined {
  if (!playable || t.kind !== 'ship') return undefined
  if (t.state === 'cleaned' || worktreeRemoved || !t.worktree) return { enabled: false, hint: 'Its worktree is gone.' }
  return { enabled: true, hint: 'Play this unit\'s worktree' }
}

/** Genio's forge merge refuses red or pending checks; a PR with no checks at all is green. */
export function prGreen(pr: Pick<PrInfo, 'checks'>): boolean {
  return pr.checks === 'passing' || pr.checks === 'none'
}

/** Why Merge PR is off, in words; '' when it can merge. */
export function prMergeBlock(pr: Pick<PrInfo, 'checks'>): string {
  if (prGreen(pr)) return ''
  if (pr.checks === 'failing') return 'Checks are failing: Genio merges only green PRs.'
  if (pr.checks === 'pending') return 'Checks are still running: merge once they report green.'
  return 'Genio has not read this PR\'s checks yet.'
}

/** Rating belongs to finished units; a ready one is rated in the Merge confirm. */
export const canRate = (t: Task, term?: TerminalInfo): boolean => squadState(t, term) === 'DONE'

/**
 * The page's state chip: the Squad badge, except where it would read as done
 * or working when the agent simply is not running.
 */
export function unitBadge(t: Task, term?: TerminalInfo): { label: string; tone: SquadTone } {
  const badge = squadBadge(t, term)
  if (t.state === 'detached') return { label: 'NOT RUNNING', tone: 'amber' }
  if (t.state === 'paused') return { label: 'WAITING', tone: badge.tone }
  // Recall exits the agent on purpose (crew control 'exit'); that is not an abnormal exit.
  if (t.state === 'exited' && t.stateReason === 'recalled') return { label: 'RECALLED', tone: 'amber' }
  if (t.state === 'exited' && badge.tone !== 'alert') return { label: 'STOPPED', tone: 'amber' }
  return badge
}

/** Delivery mode in words: what landing this unit means. */
export function deliveryLabel(mode: DeliveryMode | undefined, base: string): string {
  switch (mode) {
    case 'local-only': return `Merge into ${base}`
    case 'direct-PR': return `Pull request into ${base}`
    case 'no-mistakes': return `Gauntlet, then a pull request into ${base}`
    default: return 'Recon: a report, nothing to merge'
  }
}

/**
 * "needs input": the agent is alive but has printed nothing for the lagging
 * window (Settings: Call a unit lagging after), or the supervisor already
 * marked it lagging. It may be sitting at a prompt.
 */
export function needsInput(t: Task, term: TerminalInfo | undefined, now: number, staleSeconds = 240): boolean {
  if (t.state === 'stale') return true
  if (!term?.alive || !['working', 'spawning'].includes(t.state)) return false
  const last = Math.max(Date.parse(t.lastOutputAt ?? '') || 0, Date.parse(term.lastOutputAt ?? '') || 0)
  return !!last && now - last > Math.max(30, staleSeconds || 240) * 1000
}

// ------------------------------------------------------------------ Changes tab

export interface DiffStatFile { path: string; changes: number; binary: boolean }
export interface UnitChanges {
  files: DiffStatFile[]
  insertions: number
  deletions: number
  /** `git log --oneline` of the branch's own commits */
  commits: string[]
  /** `git status --porcelain` lines not committed yet */
  uncommitted: string[]
  /** the copy is gone (despawned) */
  removed: boolean
}

const EMPTY: UnitChanges = { files: [], insertions: 0, deletions: 0, commits: [], uncommitted: [], removed: false }

/** `git diff --stat` output: one " path | 12 +++--" row per file, then the summary line. */
export function parseDiffStat(stat: string): Pick<UnitChanges, 'files' | 'insertions' | 'deletions'> {
  const files: DiffStatFile[] = []
  let insertions = 0, deletions = 0
  for (const line of stat.split(/\r?\n/)) {
    const row = line.match(/^\s*(.+?)\s+\|\s+(?:(\d+)|Bin\b)/)
    if (row) {
      files.push({ path: row[1].trim(), changes: row[2] ? parseInt(row[2], 10) : 0, binary: !row[2] })
      continue
    }
    const sum = line.match(/\d+ files? changed/)
    if (sum) {
      insertions = parseInt(line.match(/(\d+) insertions?\(\+\)/)?.[1] ?? '0', 10)
      deletions = parseInt(line.match(/(\d+) deletions?\(-\)/)?.[1] ?? '0', 10)
    }
  }
  return { files, insertions, deletions }
}

/** The `diffstat` task file: JSON {stat, commits, uncommitted} from main, or a short note. */
export function parseUnitChanges(raw: string): UnitChanges {
  const text = raw.trim()
  if (!text.startsWith('{')) return { ...EMPTY, removed: /worktree removed/.test(text) }
  try {
    const j = JSON.parse(text) as { stat?: string; commits?: string[]; uncommitted?: string[] }
    return { ...EMPTY, ...parseDiffStat(j.stat ?? ''), commits: j.commits ?? [], uncommitted: j.uncommitted ?? [] }
  } catch {
    return EMPTY
  }
}

/** The unit's own last word on tests, from its status lines (Genio does not run tests on Offline units). */
export function reportedTests(lines: { text: string }[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (/\b(tests?|typecheck|vitest|specs?)\b/i.test(lines[i].text)) return lines[i].text
  return undefined
}

// ------------------------------------------------------------------ Timeline

export interface TimelineRow {
  /** status verb, or 'ping' for a message sent to the unit */
  verb: string
  tags: string
  text: string
  /** epoch ms, when known */
  at?: number
  /** pings only: still waiting in the inbox */
  unread?: boolean
}

/** Status file lines: `<verb> [key=k] [at=epoch]: text || {json}`. */
export function parseStatusLines(raw: string): TimelineRow[] {
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const m = l.match(/^\s*([a-z-]+)((?:\s*\[[^\]]*\])*)\s*:\s*(.*)$/i)
    if (!m) return { verb: 'note', tags: '', text: l }
    const at = m[2].match(/\[at=(\d{1,12})\]/)
    return { verb: m[1].toLowerCase(), tags: m[2].replace(/\[at=\d+\]/, '').trim(), text: m[3].replace(/\s+\|\|\s+\{.*\}\s*$/, ''), at: at ? parseInt(at[1], 10) * 1000 : undefined }
  })
}

/** The `inbox` task file: `--- PENDING 001.msg at=<iso> ---` headers, each followed by the message. */
export function parsePings(raw: string): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const part of raw.split(/^(?=--- (?:PENDING|READ) )/m)) {
    const m = part.match(/^--- (PENDING|READ) (\S+)(?: at=(\S+))? ---\r?\n?([\s\S]*)$/)
    if (!m) continue
    const at = m[3] ? Date.parse(m[3]) : NaN
    rows.push({ verb: 'ping', tags: '', text: m[4].trim(), at: Number.isFinite(at) ? at : undefined, unread: m[1] === 'PENDING' })
  }
  return rows
}

/** Status lines and pings in one list, newest first. A line without a time stays after the one before it. */
export function mergeTimeline(status: TimelineRow[], pings: TimelineRow[]): TimelineRow[] {
  let last = 0
  const keyed = [...status, ...pings].map((r, i) => {
    if (i < status.length) last = r.at ?? last
    return { r, t: r.at ?? (i < status.length ? last : Number.MAX_SAFE_INTEGER), i }
  })
  return keyed.sort((a, b) => a.t - b.t || a.i - b.i).map((k) => k.r).reverse()
}
