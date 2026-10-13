import fs from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '@shared/types'
import type { WorldMetadata } from '@shared/api'
import { git } from './git'

/** Read-only display metadata; never persist derived timestamps into the registry. */
export async function readWorldMetadata(project?: Project): Promise<WorldMetadata> {
  if (!project) return {}
  const result: WorldMetadata = {}
  const root = project.engineRoot
  const enginePath = root ? path.resolve(project.path, root) : project.path
  if (project.engine === 'unity') {
    const version = await fs.readFile(path.join(enginePath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8').catch(() => '')
    result.engineVersion = /^m_EditorVersion:\s*(\S+)/m.exec(version)?.[1]
  }
  const commit = await git(project.path, ['log', '-1', '--format=%cI'], 5000).catch(() => undefined)
  if (commit?.code === 0 && Number.isFinite(Date.parse(commit.stdout.trim()))) result.lastCommitAt = commit.stdout.trim()
  return result
}
