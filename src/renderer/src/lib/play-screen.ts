import { copyMinutes, type PlayerCopyRecord, type PlayerInstanceStatus, type PlayerSourceOption, type PlayerState } from '@shared/play'

/** One plain label per instance state, as the screen context shows it. */
export const STATE_LABEL: Record<PlayerState, string> = {
  idle: 'Unity is off',
  copying: 'Copying',
  starting: 'Starting Unity',
  syncing: 'Syncing',
  ready: 'Unity ready',
  'entering-play': 'Entering Play',
  playing: 'Playing',
  paused: 'Paused',
  'exiting-play': 'Exiting Play',
  'shutting-down': 'Stopping Unity',
  crashed: 'Unity crashed',
  'stuck-dialog': 'Stuck on a dialog',
  'close-stuck': 'Unity would not close',
  'compile-errors': 'Compile errors',
  'low-memory': 'Not enough memory',
  'missing-editor': 'Unity version missing',
  'limit-reached': 'Editor limit reached',
  error: 'Play failed'
}

/** States where Genio is working toward Play or toward quitting; the status polls faster. */
export const WORKING: ReadonlySet<PlayerState> = new Set(['copying', 'starting', 'syncing', 'entering-play', 'exiting-play', 'shutting-down'])
/** States that need the player's attention: the status line turns red or amber. */
export const PROBLEMS: ReadonlySet<PlayerState> = new Set(['crashed', 'stuck-dialog', 'close-stuck', 'compile-errors', 'low-memory', 'missing-editor', 'limit-reached', 'error'])

export function bytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(0, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** "7:42", or "1:02:05" past an hour; never negative. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** "120 of 253 MB", or "512 MB of 1.2 GB" when the units differ. */
function amount(done: number, total: number): string {
  const d = bytes(done), t = bytes(total), unit = t.split(' ')[1]
  return d.endsWith(` ${unit}`) ? `${d.split(' ')[0]} of ${t}` : `${d} of ${t}`
}

/** A running copy or sync as one line: "Copying · 120 of 253 MB · about 1 min left". */
export function progressText(progress: PlayerCopyRecord['progress'], now: number): string | undefined {
  if (!progress) return undefined
  const files = progress.files ? ` · ${progress.files.done.toLocaleString()} of ${progress.files.total.toLocaleString()} files` : ''
  if (progress.phase === 'scanning') return `Comparing files${files}`
  if (progress.phase === 'deleting') return `Removing old files${files}`
  const done = progress.bytes?.done ?? 0, total = progress.bytes?.total ?? 0
  const what = progress.phase === 'library' ? 'Seeding the Library' : 'Copying'
  if (!total) return `${what}${files}`
  const elapsed = (now - progress.startedAt) / 1000, rate = elapsed > 3 ? done / elapsed : 0
  const left = rate > 0 && total > done ? Math.ceil((total - done) / rate / 60) : undefined
  return `${what} · ${amount(done, total)}${left !== undefined ? ` · about ${left} min left` : ''}`
}

/** The last sync, as one short line ("synced 31 files (12 MB) in 1.2 s"). */
export function syncSummary(copy: PlayerCopyRecord | undefined): string | undefined {
  const s = copy?.lastSync
  if (!s || !s.complete || !s.files) return undefined
  const changed = s.files.added + s.files.updated + s.files.restored + s.files.deleted
  const seconds = s.elapsedMs < 10_000 ? (s.elapsedMs / 1000).toFixed(1) : String(Math.round(s.elapsedMs / 1000))
  return changed ? `synced ${changed.toLocaleString()} files (${bytes(s.bytes?.copied ?? 0)}) in ${seconds} s` : `already in sync (${seconds} s)`
}

/** The background deletion of a copy after Unity quit, if one is pending or running. */
export function deletionText(copy: PlayerCopyRecord | undefined): string | undefined {
  if (!copy || (copy.state !== 'pending-delete' && copy.state !== 'deleting')) return undefined
  const d = copy.deletion
  const left = d?.bytesLeft ? ` · ${bytes(d.bytesLeft)} left` : ''
  return `Deleting the copy in the background${left}${d?.blocked ? ` · waiting: ${d.blocked}` : ''}. Starting Unity brings it back if it is not gone yet.`
}

/** What the first start copies, for the screen context: "about 51.2 GB, about 13–20 min". */
export function firstCopyText(totalBytes: number): string {
  const { min, max } = copyMinutes(totalBytes)
  return `about ${bytes(totalBytes)}, ${min === max ? `about ${min} min` : `about ${min}–${max} min`}`
}

const short = (head?: string): string => (head ? head.slice(0, 7) : '')
const dirty = (n?: number): string => (n === undefined ? '' : n ? ` · ${n} uncommitted` : ' · clean')

/** One picker row: "Main checkout · main · clean", "Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted", "develop @ 6ff3823". */
export function sourceText(o: PlayerSourceOption): string {
  if (o.group === 'branch') return `${o.label} @ ${short(o.head)}`
  return `${o.label}${o.branch ? ` · ${o.branch}` : o.head ? ` · detached ${short(o.head)}` : ''}${dirty(o.dirty)}`
}

/** The header chip: "main" for the main checkout, else the worktree, unit or branch name. */
export function chipText(o: PlayerSourceOption): string {
  return o.group === 'main' ? 'main' : o.label
}

export const SOURCE_GROUPS: { group: PlayerSourceOption['group']; label: string }[] = [
  { group: 'main', label: 'Main checkout' },
  { group: 'worktree', label: 'Your worktrees' },
  { group: 'unit', label: 'Units' },
  { group: 'branch', label: 'Branches (played from commits)' }
]

/** What is playing or last played, from the copy's record: "feat/formation-controls @ 6ff3823". */
export function playedText(status: PlayerInstanceStatus | undefined): string | undefined {
  const s = status?.copy?.lastSync?.source ?? status?.copy?.source
  if (!s) return undefined
  return s.kind === 'checkout' ? `${s.branch ?? 'detached'}${s.head ? ` @ ${short(s.head)}` : ''}` : `${s.ref} @ ${short(s.commit)}`
}

/** The streamed resolutions; `short` labels the narrow layout. The stream accepts 16–1920 per side. */
export const RESOLUTIONS: { id: string; width: number; height: number; label: string; short: string }[] = [
  { id: '1280x720', width: 1280, height: 720, label: '1280 × 720', short: '720p' },
  { id: '1920x1080', width: 1920, height: 1080, label: '1920 × 1080', short: '1080p' },
  { id: '960x540', width: 960, height: 540, label: '960 × 540', short: '540p' },
  { id: '640x360', width: 640, height: 360, label: '640 × 360', short: '360p' },
  { id: '720x1280', width: 720, height: 1280, label: '720 × 1280 portrait', short: 'Portrait' }
]
export const DEFAULT_RESOLUTION = RESOLUTIONS[0]

/** The one status line for a state (the copy progress replaces it while copying). */
export function statusText(status: PlayerInstanceStatus | undefined, scene?: string): string {
  if (!status) return 'Loading'
  const where = [playedText(status), scene].filter(Boolean).join(' · ')
  switch (status.state) {
    case 'idle': return 'Unity is off'
    case 'copying': return 'Copying the project…'
    case 'starting': return 'Starting Unity…'
    case 'syncing': return 'Syncing the source…'
    case 'ready': return 'Unity ready'
    case 'entering-play': return 'Entering Play…'
    case 'playing': return where ? `Playing · ${where}` : 'Playing'
    case 'paused': return where ? `Paused · ${where}` : 'Paused'
    case 'exiting-play': return 'Exiting Play…'
    case 'shutting-down': return 'Stopping Unity…'
    case 'crashed': return `Unity closed unexpectedly${status.exitCode !== undefined ? ` (exit ${status.exitCode})` : ''}`
    case 'stuck-dialog': return `A Unity dialog is blocking the editor${status.dialog?.title ? `: ${status.dialog.title}` : ''}`
    case 'close-stuck': return 'Unity would not close'
    case 'compile-errors': return 'Compile errors'
    default: return status.message ?? STATE_LABEL[status.state]
  }
}
