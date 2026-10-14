import type { WindowList } from '@shared/api'
import { byRecent } from './recent'

export type FileAction =
  | { type: 'open-project'; path: string }
  | { type: 'hub' }
  | { type: 'exit' }

export interface FileItem { kind: 'item'; id: string; label: string; key?: string; hint?: string; title?: string; action: FileAction }
export interface FileSubmenu { kind: 'submenu'; id: string; label: string; empty: string; items: FileItem[] }
export type FileEntry = FileItem | FileSubmenu

export const RECENT_LIMIT = 8

/** The same three entries in project windows and the Hub; Exit closes only its caller. */
export function fileMenu(list: WindowList, recent: string[]): FileEntry[] {
  const open = new Set(list.windows.map(w => w.project))
  const recentProjects: FileSubmenu = {
    kind: 'submenu', id: 'recent', label: 'Open Recent', empty: 'No recent projects yet.',
    items: byRecent(list.projects, recent).slice(0, RECENT_LIMIT).map(p => ({
      kind: 'item', id: `recent-${p.name}`, label: p.name, title: p.path, hint: open.has(p.name) ? 'Open' : undefined, action: { type: 'open-project', path: p.path }
    }))
  }
  return [
    { kind: 'item', id: 'hub', label: 'Hub', key: 'N', action: { type: 'hub' } },
    recentProjects,
    { kind: 'item', id: 'exit', label: 'Exit', action: { type: 'exit' } }
  ]
}

/** The File action a key press triggers in this window, if any. */
export function fileKeyAction(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): FileAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return null
  return e.key.toUpperCase() === 'N' ? { type: 'hub' } : null
}
