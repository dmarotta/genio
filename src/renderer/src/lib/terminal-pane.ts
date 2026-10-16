import type { TerminalInfo } from '@shared/types'
import { pushShellHistory } from '@shared/terminal-pane'
import { PROJECT_WINDOW, setState, type State } from '../store'

/** The terminal pane under a project window's screens: height, remembered state and shell mode's availability. */
export const PANE_MIN = 96
export const PANE_DEFAULT = 260
/** Room the screen above always keeps (the floating chat and answer cards stay usable over it). */
export const PANE_KEEP_ABOVE = 140
export const PANE_ANIMATION_MS = 200
export const PANE_SHORTCUT = 'Ctrl+`'

export interface PanePrefs { height: number; open: boolean }

/** The pane's height for the space it shares with the screen above: never under PANE_MIN, never crowding the screen out. */
export function clampPaneHeight(height: number, available: number): number {
  const max = Math.max(PANE_MIN, available - PANE_KEEP_ABOVE)
  const h = Number.isFinite(height) ? height : PANE_DEFAULT
  return Math.round(Math.min(max, Math.max(PANE_MIN, h)))
}

const prefsKey = (project: string): string => `genio.terminal.${project}`
const historyKey = (project: string): string => `genio.shell-history.${project}`

/** Remembered per project: the dragged height and whether the pane was showing. */
export function readPanePrefs(project: string): PanePrefs {
  try {
    const v = JSON.parse(localStorage.getItem(prefsKey(project)) || 'null')
    if (v && Number.isFinite(v.height)) return { height: v.height, open: !!v.open }
  } catch { /* storage unavailable or obsolete */ }
  return { height: PANE_DEFAULT, open: false }
}
export function writePanePrefs(project: string, prefs: PanePrefs): void {
  try { localStorage.setItem(prefsKey(project), JSON.stringify(prefs)) } catch { /* storage unavailable */ }
}

export function readShellHistory(project: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(historyKey(project)) || '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function rememberShellCommand(project: string, command: string): string[] {
  const next = pushShellHistory(readShellHistory(project), command)
  try { localStorage.setItem(historyKey(project), JSON.stringify(next)) } catch { /* storage unavailable */ }
  return next
}

export const isPaneShortcut = (e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code' | 'key'>): boolean =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'Backquote' || e.key === '`')

export function togglePane(): void {
  setState((s) => ({ paneOpen: !s.paneOpen }))
}
/** Show the pane, optionally with a '!' run's tab in front. */
export function showPane(tab?: string): void {
  setState({ paneOpen: true, paneTab: tab })
}

/** This window's pane terminals: the interactive shell and the '!' runs, oldest first. */
export function paneTerminals(terminals: State['terminals'], project = PROJECT_WINDOW): TerminalInfo[] {
  return Object.values(terminals).filter((t) => t.kind === 'pane' && t.project === project)
}

/** Why '!' shell mode is off right now; undefined when it can run commands. */
export function shellUnavailable(s: Pick<State, 'terminals' | 'paneError'>): string | undefined {
  if (!PROJECT_WINDOW) return 'Shell commands run in a project window.'
  if (s.paneError) return s.paneError
  const shell = paneTerminals(s.terminals).find((t) => t.run === undefined)
  if (shell?.startError) return `The terminal shell could not start: ${shell.startError}`
  return undefined
}
