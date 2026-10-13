import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readWorldMetadata } from '../src/main/world-metadata'
import { git } from '../src/main/git'
import type { Project } from '../src/shared/types'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
it('reads nested Unity versions and the latest commit, tolerating an uncommitted world', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'genio-world-metadata-')); dirs.push(dir)
  await fs.mkdir(path.join(dir, 'game/ProjectSettings'), { recursive: true })
  await fs.writeFile(path.join(dir, 'game/ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.5.0f1\n')
  const project = { path: dir, engine: 'unity', engineRoot: 'game' } as unknown as Project
  expect(await readWorldMetadata(project)).toEqual({ engineVersion: '6000.5.0f1' })
  await git(dir, ['init'])
  await git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial'])
  const metadata = await readWorldMetadata(project)
  expect(metadata.engineVersion).toBe('6000.5.0f1')
  expect(Number.isFinite(Date.parse(metadata.lastCommitAt!))).toBe(true)
  expect(await readWorldMetadata()).toEqual({})
})
