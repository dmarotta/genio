import type { Project } from '@shared/types'
import type { WorldMetadata } from '@shared/api'
import { ENGINE_LABEL } from './vocab'
export function worldPath(p: Project): string {
  const root = p.engineRoot
  if (!root || root === '.') return p.path
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(root) ? root : `${p.path.replace(/[\\/]$/, '')}/${root}`
}
/** The projects a Hub search matches, by name, path, engine or engine version, in name order. */
export function worldList(projects: Project[], query: string, metadata: Record<string, WorldMetadata> = {}): Project[] {
  const q = query.trim().toLocaleLowerCase()
  return projects.filter((p) => `${p.name} ${p.path} ${worldPath(p)} ${ENGINE_LABEL[p.engine]} ${metadata[p.name]?.engineVersion ?? ''}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
}
export function modifiedLabel(date?: string, now = Date.now()): string {
  const timestamp = Date.parse(date ?? '')
  if (!Number.isFinite(timestamp)) return 'No commit yet'
  const seconds = Math.max(0, (now - timestamp) / 1000)
  if (seconds < 60) return 'Just now'
  for (const [size, label] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']] as const) {
    if (seconds >= size) { const n = Math.floor(seconds / size); return `${n} ${label}${n === 1 ? '' : 's'} ago` }
  }
  return 'Just now'
}
