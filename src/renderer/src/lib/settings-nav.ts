import { isSettingsPageId, resolveSettingsPage, type SettingsPageId } from '@shared/settings-pages'
import { go } from '../store'

export interface SettingsRequest { page: SettingsPageId; anchor?: string }

let pending: SettingsRequest | null = null
const listeners = new Set<(request: SettingsRequest) => void>()

/**
 * Open a Settings page; with an anchor, also scroll that element into view and focus it.
 * Takes current and retired ids alike ('patch' opens System › Updates), so old links keep working.
 */
export function requestSystemsSection(section: string, anchor?: string): void {
  const request = resolveSettingsPage(section, anchor)
  pending = listeners.size ? null : request
  for (const listener of listeners) listener(request)
}

/**
 * The one way into Settings from anywhere else: switches this window to Settings on that page
 * (and anchor). Without an id it reopens the last page viewed (Ctrl+,).
 */
export function openSettings(id?: string, anchor?: string): void {
  if (id) requestSystemsSection(id, anchor)
  go('systems')
}

/** A request made before Settings mounted, handed over once. */
export function takePendingSection(): SettingsRequest | null {
  const p = pending
  pending = null
  return p
}

export function onSectionRequest(listener: (request: SettingsRequest) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Per viewer: the page Settings reopens on. */
const LAST_PAGE_KEY = 'genio.settings.last'
export function readLastPage(): SettingsPageId | undefined {
  try {
    const id = localStorage.getItem(LAST_PAGE_KEY) ?? ''
    return isSettingsPageId(id) ? id : undefined
  } catch {
    return undefined
  }
}
export function rememberPage(id: SettingsPageId): void {
  try {
    localStorage.setItem(LAST_PAGE_KEY, id)
  } catch {
    /* per-viewer convenience only */
  }
}

/** Arrow keys in the page list and the search results: the index to move to, or null for other keys. */
export function listKey(key: string, index: number, count: number): number | null {
  if (!count) return null
  switch (key) {
    case 'ArrowDown': return Math.min(count - 1, index + 1)
    case 'ArrowUp': return Math.max(0, index - 1)
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

/** Ctrl+, (Cmd+, on a Mac): Settings, on the last page viewed. Works in the Hub and in project windows. */
export function isSettingsShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ','
}
