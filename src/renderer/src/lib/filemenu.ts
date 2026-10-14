import type { WindowList } from '@shared/api'
import { byRecent } from './recent'

export type FileAction =
  | { type: 'open-folder' }
  | { type: 'open-project'; path: string }
  | { type: 'hub' }
  | { type: 'close' }
  | { type: 'quit' }

export interface FileItem { kind: 'item'; id: string; label: string; key?: string; hint?: string; title?: string; on?: boolean; action: FileAction }
export interface FileSubmenu { kind: 'submenu'; id: string; label: string; count?: number; empty: string; items: FileItem[] }
export type FileEntry = FileItem | FileSubmenu | { kind: 'separator'; id: string }

/** Ctrl accelerators: shown in the menu and handled by the window, so both stay in step. */
const KEYS = { 'open-folder': 'O', hub: 'N', close: 'W', quit: 'Q' } as const
export const RECENT_LIMIT = 8

const item = (type: keyof typeof KEYS, label: string): FileItem => ({ kind: 'item', id: type, label, key: KEYS[type], action: { type } as FileAction })

/** The File menu of a project window (project set) or of the Hub, which has no Hub or recent entries of its own. */
export function fileMenu(project: string | undefined, list: WindowList, recent: string[]): FileEntry[] {
  const open = new Set(list.windows.map(w => w.project))
  const path = (name: string): string | undefined => list.projects.find(p => p.name === name)?.path
  const windows: FileSubmenu = {
    kind: 'submenu', id: 'windows', label: 'Open windows', count: list.windows.length, empty: 'Only this window is open.',
    items: list.windows.flatMap((w): FileItem[] => {
      const target = w.project === null ? undefined : path(w.project)
      if (w.project !== null && !target) return []
      return [{ kind: 'item', id: `window-${w.project ?? 'hub'}`, label: w.project ?? 'Hub', hint: w.current ? 'This window' : undefined, on: w.current,
        action: target ? { type: 'open-project', path: target } : { type: 'hub' } }]
    })
  }
  const tail: FileEntry[] = [windows, { kind: 'separator', id: 'sep' }, item('close', 'Close window'), item('quit', 'Exit Genio')]
  if (!project) return [item('open-folder', 'Open project…'), ...tail]
  const recentProjects: FileSubmenu = {
    kind: 'submenu', id: 'recent', label: 'Open recent', empty: 'No other projects yet.',
    items: byRecent(list.projects.filter(p => p.name !== project), recent).slice(0, RECENT_LIMIT).map(p => ({
      kind: 'item', id: `recent-${p.name}`, label: p.name, title: p.path, hint: open.has(p.name) ? 'Open' : undefined, action: { type: 'open-project', path: p.path }
    }))
  }
  return [item('open-folder', 'Open project…'), recentProjects, item('hub', 'New window / Hub'), ...tail]
}

/** The File action a key press triggers in this window, if any. */
export function fileKeyAction(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, projectWindow: boolean): FileAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null
  const type = (Object.keys(KEYS) as (keyof typeof KEYS)[]).find(t => KEYS[t] === e.key.toUpperCase())
  if (!type || (type === 'hub' && !projectWindow)) return null
  return { type } as FileAction
}
