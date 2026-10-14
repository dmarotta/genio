import type { Project } from '@shared/types'

/** Recently opened project paths, newest first; every window shares them through localStorage. */
const RECENT_KEY = 'genio.hub.recent-projects'

export function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string') : []
  } catch { return [] }
}

/** Move a successfully opened project to the front; returns the new list. */
export function rememberRecent(path: string): string[] {
  const next = [path, ...readRecent().filter(p => p !== path)].slice(0, 100)
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* Storage is optional. */ }
  return next
}

/** The Hub's order: most recently opened first, then newest registered, then by name. */
export function byRecent<T extends Pick<Project, 'name' | 'path' | 'addedAt'>>(projects: T[], recent: string[]): T[] {
  const rank = (path: string): number => { const i = recent.indexOf(path); return i < 0 ? recent.length : i }
  return [...projects].sort((a, b) => rank(a.path) - rank(b.path) || b.addedAt.localeCompare(a.addedAt) || a.name.localeCompare(b.name))
}
