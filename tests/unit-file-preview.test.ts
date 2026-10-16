import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unitFilePreview } from '../src/main/unit-file-preview'
import type { ModellerLive } from '../src/shared/modeller'

let repo: string, project: string
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const put = (root: string, rel: string, bytes: Buffer | string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), bytes)
}
const live = (): ModellerLive => ({
  model: 'tower', branch: 'main', branches: ['main'], checks: [], running: null, failure: null, stamp: '1',
  steps: [{ id: 's005', n: 5, caption: 'Roof', triangles: 2802, parts: 9, warnings: 0, ms: 1500, glb: 'genio-media://model/t/modeller/tower/steps/s005/model.glb', view: 'genio-media://model/t/modeller/tower/steps/s005/view.png' }]
})

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-preview-'))
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-preview-project-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  put(repo, 'Art/logo.png', Buffer.from([1, 2, 3]))
  put(repo, 'Assets/Models/tower.fbx', Buffer.from([0, 9, 9]))
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'unit')
  put(repo, 'Art/logo.png', Buffer.from([4, 5, 6, 7]))
  put(repo, 'Art/new.webp', Buffer.from([8]))
  put(repo, 'Assets/Models/tower.fbx', Buffer.from([0, 9, 9, 9, 9]))
  put(repo, 'Assets/Models/crate.glb', Buffer.from([1]))
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'unit')
  put(project, 'Assets/Models/tower.fbx', Buffer.from([0, 9, 9]))
})
afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }) })

describe('Changes tab: before and after of binary files', () => {
  it('shows an image as its base blob and its worktree file, with both sizes', async () => {
    const p = await unitFilePreview({ worktree: repo, ref: 'main', file: 'Art/logo.png' })
    expect(p).toEqual({ kind: 'image', beforeBytes: 3, afterBytes: 4, before: 'data:image/png;base64,AQID', after: 'data:image/png;base64,BAUGBw==' })
    const added = await unitFilePreview({ worktree: repo, ref: 'main', file: 'Art/new.webp' })
    expect(added).toEqual({ kind: 'image', afterBytes: 1, after: 'data:image/webp;base64,CA==' })
  })

  it("shows a model before as Inventory's thumbnail of the player's copy, after as the Modeller's latest render", async () => {
    const p = await unitFilePreview({ worktree: repo, ref: 'main', file: 'Assets/Models/tower.fbx', projectRoot: project, world: 'game', modeller: live })
    expect(p).toEqual({
      kind: 'model', beforeBytes: 3, afterBytes: 5, before: 'genio-media://thumb/game/Assets/Models/tower.fbx',
      after: 'genio-media://model/t/modeller/tower/steps/s005/view.png', triangles: 2802, parts: 9
    })
    // A new model has no before; a unit without a model has no after picture.
    expect(await unitFilePreview({ worktree: repo, ref: 'main', file: 'Assets/Models/crate.glb', projectRoot: project, world: 'game' })).toEqual({ kind: 'model', afterBytes: 1 })
  })

  it('ignores other files and refuses paths outside the worktree', async () => {
    expect(await unitFilePreview({ worktree: repo, ref: 'main', file: 'Sounds/hit.wav' })).toEqual({ kind: 'other' })
    for (const bad of ['../secret.png', 'C:/x.png', '/etc/x.png', 'a\\b.png', '-x.png', 'a//b.png']) {
      await expect(unitFilePreview({ worktree: repo, ref: 'main', file: bad })).rejects.toThrow('Not a file of this unit.')
    }
  })
})
