import type { PlayerInstanceStatus, PlayerSourceOption, PlayerState } from '@shared/play'

/** The one action a problem may offer on the status line. */
export type PlayLineAction = 'retry' | 'console' | 'visible' | 'settings' | 'reconnect' | 'main'
export const ACTION_LABEL: Record<PlayLineAction, string> = {
  retry: 'Try again', console: 'Show console', visible: 'Open Unity', settings: 'Settings', reconnect: 'Reconnect', main: 'Play main'
}

/**
 * Everything the Play screen says about the instance: one plain line, an alert tone for a problem, the progress bar
 * (a 0–100 percentage, or indeterminate) only while Genio prepares the copy or starts Unity or Play, and at most one
 * action. kind colours the dot.
 */
export interface PlayLine {
  text: string
  kind: 'off' | 'work' | 'ready' | 'live' | 'problem'
  bar?: number | 'indeterminate'
  action?: PlayLineAction
}

/** States where Genio is working toward Play or toward quitting; the status polls faster. */
export const WORKING: ReadonlySet<PlayerState> = new Set(['copying', 'starting', 'syncing', 'entering-play', 'exiting-play', 'shutting-down'])

/** One short sentence per problem state, and its action when one is needed. */
const PROBLEM: Partial<Record<PlayerState, { text: string; action?: PlayLineAction }>> = {
  crashed: { text: 'Unity closed unexpectedly.' },
  'stuck-dialog': { text: 'A Unity dialog is blocking the editor.', action: 'visible' },
  'close-stuck': { text: 'Unity would not close.' },
  'compile-errors': { text: 'The game has compile errors.', action: 'console' },
  'low-memory': { text: 'Not enough free memory for Unity.' },
  'missing-editor': { text: 'This project\'s Unity version is not installed.' },
  'limit-reached': { text: 'Too many Play editors are open.', action: 'settings' },
  error: { text: 'Play failed.', action: 'retry' }
}
const STARTS = new Set(['start', 'start-anyway', 'restart', 'visible'])
const ENTERS = new Set(['enter', 'enter-anyway'])
const STOPS = new Set(['cancel', 'stop', 'close-again', 'exit'])

export interface PlayLineInput {
  status?: PlayerInstanceStatus
  /** The call in flight, by its button's action. */
  busy?: string
  /** A call that failed; its text stays in the tooltip and the screen facts. */
  error?: string
  /** The chosen or requested source vanished from the list. */
  missing?: boolean
  /** The live view closed while Unity still plays. */
  streamEnded?: boolean
}

/** The copy's overall percentage, when it reports bytes. */
function percent(status: PlayerInstanceStatus): number | 'indeterminate' {
  const bytes = status.copy?.progress?.bytes
  return bytes?.total ? Math.min(100, Math.round((bytes.done / bytes.total) * 100)) : 'indeterminate'
}

/** The status line and bar for the whole screen: a call in flight, then the instance, then local problems. */
export function playLine({ status, busy, error, missing, streamEnded }: PlayLineInput): PlayLine {
  const state = status?.state
  if (!status) return { text: 'Loading', kind: 'off' }
  if (state === 'copying' || state === 'syncing') return { text: 'Preparing', kind: 'work', bar: percent(status) }
  if (state === 'starting') return { text: 'Starting Unity', kind: 'work', bar: 'indeterminate' }
  if (state === 'entering-play') return { text: 'Starting Play', kind: 'work', bar: 'indeterminate' }
  if (state === 'exiting-play' || state === 'shutting-down' || (busy && STOPS.has(busy))) return { text: 'Stopping', kind: 'work' }
  if (busy && (STARTS.has(busy) || (ENTERS.has(busy) && state !== 'playing' && state !== 'paused'))) {
    return state === 'ready' && ENTERS.has(busy) ? { text: 'Starting Play', kind: 'work', bar: 'indeterminate' } : { text: 'Preparing', kind: 'work', bar: 'indeterminate' }
  }
  const problem = state && PROBLEM[state]
  if (problem) return { text: problem.text, kind: 'problem', action: problem.action }
  if (error) return { text: 'Something went wrong.', kind: 'problem' }
  if (missing) return { text: 'That source is gone. Pick another one.', kind: 'problem' }
  if (streamEnded && (state === 'playing' || state === 'paused')) return { text: 'The live view stopped.', kind: 'problem', action: 'reconnect' }
  if (status.sourceGone?.when === 'loading') return { text: `${status.sourceGone.unit ? 'This unit' : 'This source'} was removed.`, kind: 'problem', action: 'main' }
  switch (state) {
    case 'ready': return { text: 'Ready', kind: 'ready' }
    case 'playing': return { text: 'Playing', kind: 'live' }
    case 'paused': return { text: 'Paused', kind: 'live' }
    default: return { text: 'Stopped', kind: 'off' }
  }
}

const short = (head?: string): string => (head ? head.slice(0, 7) : '')
const dirty = (n?: number): string => (n === undefined ? '' : n ? ` · ${n} uncommitted` : ' · clean')

/** One picker row: "Main checkout · main · clean", "Ranger (lairs AI) · genio/lairs-ai · 3 uncommitted", "develop @ 6ff3823". */
export function sourceText(o: PlayerSourceOption): string {
  if (o.group === 'branch') return `${o.label} @ ${short(o.head)}`
  return `${o.label}${o.branch ? ` · ${o.branch}` : o.head ? ` · detached ${short(o.head)}` : ''}${dirty(o.dirty)}`
}

/** The source picker's face: "main" for the main checkout, else the worktree, unit or branch name. */
export function chipText(o: PlayerSourceOption): string {
  return o.group === 'main' ? 'main' : o.label
}

export const SOURCE_GROUPS: { group: PlayerSourceOption['group']; label: string }[] = [
  { group: 'main', label: 'Main checkout' },
  { group: 'worktree', label: 'Your worktrees' },
  { group: 'unit', label: 'Units' },
  { group: 'branch', label: 'Branches (played from commits)' }
]

/** The streamed resolutions; `short` labels the narrow layout. The stream accepts 16–1920 per side. */
export const RESOLUTIONS: { id: string; width: number; height: number; label: string; short: string }[] = [
  { id: '1280x720', width: 1280, height: 720, label: '1280 × 720', short: '720p' },
  { id: '1920x1080', width: 1920, height: 1080, label: '1920 × 1080', short: '1080p' },
  { id: '960x540', width: 960, height: 540, label: '960 × 540', short: '540p' },
  { id: '640x360', width: 640, height: 360, label: '640 × 360', short: '360p' },
  { id: '720x1280', width: 720, height: 1280, label: '720 × 1280 portrait', short: 'Portrait' }
]
export const DEFAULT_RESOLUTION = RESOLUTIONS[0]
