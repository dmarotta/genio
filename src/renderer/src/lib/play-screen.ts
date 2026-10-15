import { copyMinutes, type PlayerCopyRecord, type PlayerInstanceStatus, type PlayerSourceOption, type PlayerState } from '@shared/play'

/** One plain label per instance state, as the Play screen and its screen context show it. */
export const STATE_LABEL: Record<PlayerState, string> = {
  idle: 'No instance',
  copying: 'Copying',
  starting: 'Starting Unity',
  syncing: 'Syncing',
  ready: 'Stopped · Unity warm',
  'entering-play': 'Entering Play',
  playing: 'Playing',
  paused: 'Paused',
  'exiting-play': 'Exiting Play',
  'shutting-down': 'Quitting Unity',
  crashed: 'Unity crashed',
  'stuck-dialog': 'Stuck on a dialog',
  'close-stuck': 'Unity would not close',
  'compile-errors': 'Compile errors',
  'low-memory': 'Not enough memory',
  'missing-editor': 'Unity version missing',
  'limit-reached': 'Editor limit reached',
  error: 'Play failed'
}

/** States where Genio is working toward Play or toward quitting; Play/Restart wait, Stop cancels. */
export const WORKING: ReadonlySet<PlayerState> = new Set(['copying', 'starting', 'syncing', 'entering-play', 'exiting-play', 'shutting-down'])
/** States that need the player's attention; each has one clear action on the screen. */
export const PROBLEMS: ReadonlySet<PlayerState> = new Set(['crashed', 'stuck-dialog', 'close-stuck', 'compile-errors', 'low-memory', 'missing-editor', 'limit-reached', 'error'])

/** The instance's lifecycle in order. A cold Play copies then starts Unity; a warm one syncs and enters Play directly. */
export const STEPS: { label: string; states: PlayerState[] }[] = [
  { label: 'Copy · sync', states: ['copying', 'syncing'] },
  { label: 'Start Unity', states: ['starting'] },
  { label: 'Enter Play', states: ['entering-play'] },
  { label: 'Playing', states: ['playing', 'paused'] },
  { label: 'Stopped, warm', states: ['exiting-play', 'ready'] },
  { label: 'Quit · delete copy', states: ['shutting-down'] }
]
export function stepIndex(state: PlayerState | undefined): number {
  return state ? STEPS.findIndex((s) => s.states.includes(state)) : -1
}

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

/** A running copy or sync: phase, sizes and a time estimate from the speed so far. */
export function progressText(progress: PlayerCopyRecord['progress'], now: number): string | undefined {
  if (!progress) return undefined
  const files = progress.files ? ` · ${progress.files.done.toLocaleString()} / ${progress.files.total.toLocaleString()} files` : ''
  if (progress.phase === 'scanning') return `Comparing files with the source${files}`
  if (progress.phase === 'deleting') return `Removing files the source no longer has${files}`
  const done = progress.bytes?.done ?? 0, total = progress.bytes?.total ?? 0
  const what = progress.phase === 'library' ? 'Seeding the Library' : 'Copying'
  if (!total) return `${what}${files}`
  const elapsed = (now - progress.startedAt) / 1000, rate = elapsed > 3 ? done / elapsed : 0
  const left = rate > 0 && total > done ? Math.ceil((total - done) / rate / 60) : undefined
  return `${what} ${bytes(done)} / ${bytes(total)}${files}${left !== undefined ? ` · about ${left} min left` : ''}`
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
  return `Deleting the copy in the background${left}${d?.blocked ? ` · waiting: ${d.blocked}` : ''}. Play brings it back if it is not gone yet.`
}

/** The warning before a first Play copies the project. */
export function firstCopyWarning(totalBytes: number, idleMinutes: number): string {
  const { min, max } = copyMinutes(totalBytes)
  const time = min === max ? `about ${min} min` : `about ${min}–${max} min`
  return `The first Play of this project copies about ${bytes(totalBytes)} and takes ${time}. Unity then opens and imports it. Playing again within ${idleMinutes} min of Stop skips this; after that the copy is deleted.`
}

const short = (head?: string): string => (head ? head.slice(0, 7) : '')
const dirty = (n?: number): string => (n === undefined ? '' : n ? ` · ${n} uncommitted` : ' · clean')

/** One picker row: "Main checkout · main · clean", "Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted", "develop @ 6ff3823". */
export function sourceText(o: PlayerSourceOption): string {
  if (o.group === 'branch') return `${o.label} @ ${short(o.head)}`
  return `${o.label}${o.branch ? ` · ${o.branch}` : o.head ? ` · detached ${short(o.head)}` : ''}${dirty(o.dirty)}`
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
