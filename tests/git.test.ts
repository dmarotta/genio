import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import * as git from '../src/main/git'
import { detectProject } from '../src/main/engine-detect'

it('worktree + landed verdict + local ff merge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-smoke-'))
  const repo = path.join(root, 'repo')
  await git.initRepo(repo, 'main')
  await git.git(repo, ['config', 'user.email', 't@t'])
  await git.git(repo, ['config', 'user.name', 't'])
  fs.writeFileSync(path.join(repo, 'project.godot'), 'config_version=5\n')
  expect((await git.commitAll(repo, 'init')).code).toBe(0)
  expect((await detectProject(repo)).engine).toBe('godot')
  const wt = path.join(root, 'wt', 't1')
  const add = await git.addWorktree(repo, wt, 'genio/t1', 'main')
  expect(add.code, add.stderr).toBe(0)
  expect((await git.assertIsolated(repo, wt)).ok).toBe(true)
  expect((await git.assertIsolated(repo, repo)).ok).toBe(false)
  fs.writeFileSync(path.join(wt, 'a.txt'), 'x')
  let v = await git.landedVerdict(repo, wt, 'genio/t1', 'main', false)
  expect(v.landed).toBe(false)
  await git.git(wt, ['config', 'user.email', 't@t'])
  await git.git(wt, ['config', 'user.name', 't'])
  await git.commitAll(wt, 'feat')
  v = await git.landedVerdict(repo, wt, 'genio/t1', 'main', false)
  expect(v.landed).toBe(false)
  expect(v.reasons[0]).toMatch(/not pushed/)
  const m = await git.mergeLocalFastForward(repo, 'genio/t1', 'main')
  expect(m.code, m.stderr).toBe(0)
  v = await git.landedVerdict(repo, wt, 'genio/t1', 'main', false)
  expect(v.landed).toBe(true)
  expect((await git.removeWorktree(repo, wt)).code).toBe(0)
}, 60_000)
