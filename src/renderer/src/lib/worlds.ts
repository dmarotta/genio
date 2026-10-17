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
