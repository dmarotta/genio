import type { Project } from '@shared/types'
import type { WorldMetadata } from '@shared/api'
import { ENGINE_LABEL } from './vocab'
export type WorldSort = 'name' | 'modified' | 'engine'
export function worldPath(p: Project): string {
  const root = p.engineRoot
  if (!root || root === '.') return p.path
  return /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(root) ? root : `${p.path.replace(/[\\/]$/, '')}/${root}`
}
export function worldList(projects: Project[], query: string, sort: WorldSort, metadata: Record<string, WorldMetadata> = {}): Project[] {
  const q = query.trim().toLocaleLowerCase()
  const time = (p: Project): number => Date.parse(metadata[p.name]?.lastCommitAt ?? '') || 0
  return projects.filter((p) => `${p.name} ${p.path} ${worldPath(p)} ${ENGINE_LABEL[p.engine]} ${metadata[p.name]?.engineVersion ?? ''}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => (sort === 'modified' ? time(b) - time(a) : sort === 'engine' ? ENGINE_LABEL[a.engine].localeCompare(ENGINE_LABEL[b.engine]) : 0) || a.name.localeCompare(b.name))
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
