import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { modeSourceOf } from '@shared/vocab'
import * as git from '../src/main/git'
import { Home } from '../src/main/home'
import { applyRemoteChange, autoModeFor, createProjectsService } from '../src/main/projects'
import type { AppCtx } from '../src/main/services'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mode-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

async function repo(dir: string): Promise<string> {
  await git.initRepo(dir, 'main')
  await git.git(dir, ['config', 'user.email', 't@t'])
  await git.git(dir, ['config', 'user.name', 't'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  expect((await git.commitAll(dir, 'init')).code).toBe(0)
  return dir
}

async function commit(dir: string, file: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), file)
  expect((await git.commitAll(dir, file)).code).toBe(0)
}

const projects = () => {
  const home = new Home(path.join(root, 'home'))
  const ctx = { main: { home }, ledger: { record: () => undefined }, forge: { available: () => true } } as unknown as AppCtx
  return createProjectsService(() => ctx)
}

const base = (over: Partial<Project> = {}): Project => ({
  name: 'w', path: '/w', defaultBranch: 'main', mode: 'local-only', yolo: false, branchPrefix: 'genio/',
  forge: 'none', engine: 'other', commands: {}, managed: false, addedAt: '', ...over
})

describe('mode follows the remote', () => {
  it('detects the default mode per remote type', () => {
    expect(autoModeFor(undefined)).toBe('local-only')
    expect(autoModeFor('https://github.com/me/game.git')).toBe('direct-PR')
    expect(autoModeFor('git@github.com:me/game.git')).toBe('direct-PR')
    expect(autoModeFor('https://gitea.example.com/me/game.git')).toBe('local-only')
    expect(autoModeFor('https://gitlab.com/me/game.git')).toBe('local-only')
    expect(autoModeFor('ssh://git@nas.local/srv/game.git')).toBe('local-only')
  })

  it('treats legacy entries as auto only for the old no-remote default', () => {
    expect(modeSourceOf(base())).toBe('auto')
    expect(modeSourceOf(base({ remote: 'https://github.com/me/g.git', mode: 'no-mistakes' }))).toBe('manual')
    expect(modeSourceOf(base({ mode: 'direct-PR', modeSource: 'auto' }))).toBe('auto')
  })

  it('switches an auto world to Standard when a GitHub remote appears, with a notice', () => {
    const r = applyRemoteChange(base({ modeSource: 'auto' }), 'https://github.com/me/g.git')!
    expect(r.next.mode).toBe('direct-PR')
    expect(r.next.forge).toBe('github')
    expect(r.next.modeSource).toBe('auto')
    expect(r.notice).toMatch(/Offline → Standard/)
    expect(applyRemoteChange(r.next, 'https://github.com/me/g.git')).toBeUndefined()
    const gitea = applyRemoteChange(r.next, 'https://gitea.example.com/me/g.git')!
    expect(gitea.next.mode).toBe('local-only')
    expect(gitea.next.forge).toBe('none')
  })

  it('never overrides a manual mode', () => {
    const r = applyRemoteChange(base({ modeSource: 'manual' }), 'https://github.com/me/g.git')!
    expect(r.next.mode).toBe('local-only')
    expect(r.next.remote).toBe('https://github.com/me/g.git')
    expect(r.notice).toMatch(/set by hand/)
  })

  it('registers worlds in auto mode, pins on manual choice, and re-detects on sync', async () => {
    const svc = projects()
    const dir = await repo(path.join(root, 'game'))
    const p = await svc.add({ source: dir, name: 'game' })
    expect(p.mode).toBe('local-only')
    expect(p.modeSource).toBe('auto')

    await git.git(dir, ['remote', 'add', 'origin', 'https://github.com/me/game.git'])
    const s = await svc.sync('game')
    expect(s.message).toMatch(/gained remote .* Offline → Standard/)
    expect(svc.get('game')!.mode).toBe('direct-PR')
    expect(svc.get('game')!.forge).toBe('github')

    // the player pins Offline: a later remote change keeps it
    expect(svc.update('game', { mode: 'local-only' }).modeSource).toBe('manual')
    await git.git(dir, ['remote', 'set-url', 'origin', 'https://github.com/me/other.git'])
    expect(await svc.refreshRemotes('game')).toEqual([expect.stringMatching(/set by hand/)])
    expect(svc.get('game')!.mode).toBe('local-only')

    // and can hand it back to the remote
    const back = svc.update('game', { modeSource: 'auto' })
    expect(back.mode).toBe('direct-PR')
    expect(back.forge).toBe('github')

    const pinned = await svc.add({ source: await repo(path.join(root, 'hard')), name: 'hard', mode: 'no-mistakes' })
    expect(pinned.modeSource).toBe('manual')
  }, 60_000)
})

describe('unit base branch per mode', () => {
  it('branches Offline units from the local default, others from origin', async () => {
    const remote = path.join(root, 'remote.git')
    await git.git(root, ['init', '--bare', '-b', 'main', remote])
    const dir = await repo(path.join(root, 'game'))
    await git.git(dir, ['remote', 'add', 'origin', remote])
    expect((await git.git(dir, ['push', 'origin', 'main'])).code).toBe(0)
    await git.fetch(dir)
    await commit(dir, 'local.txt') // landed locally, not pushed

    expect(await git.baseRef(dir, 'main')).toBe('origin/main')
    expect(await git.baseRef(dir, 'main', true)).toBe('main')

    const off = path.join(root, 'wt', 'off')
    expect((await git.addWorktree(dir, off, 'genio/off', 'main', true)).code).toBe(0)
    expect(fs.existsSync(path.join(off, 'local.txt'))).toBe(true)

    const std = path.join(root, 'wt', 'std')
    expect((await git.addWorktree(dir, std, 'genio/std', 'main', false)).code).toBe(0)
    expect(fs.existsSync(path.join(std, 'local.txt'))).toBe(false)
  }, 60_000)
})

describe('push on demand', () => {
  it('reports unpushed commits, pushes fast-forward only, and refuses on divergence', async () => {
    const remote = path.join(root, 'remote.git')
    await git.git(root, ['init', '--bare', '-b', 'main', remote])
    const dir = await repo(path.join(root, 'game'))
    await git.git(dir, ['remote', 'add', 'origin', remote])
    expect((await git.git(dir, ['push', 'origin', 'main'])).code).toBe(0)
    await git.fetch(dir)

    const svc = projects()
    await svc.add({ source: dir, name: 'game' })
    expect(svc.get('game')!.mode).toBe('local-only') // a non-GitHub remote stays Offline

    await commit(dir, 'b.txt')
    await commit(dir, 'c.txt')
    expect(await svc.pushStatus('game')).toEqual({ branch: 'main', ahead: 2, behind: 0, remoteMissing: false })

    const ok = await svc.push('game')
    expect(ok.ok, ok.message).toBe(true)
    expect(ok.message).toMatch(/pushed 2 commit/)
    expect(await git.headSha(remote, 'main')).toBe(await git.headSha(dir, 'main'))
    expect((await svc.push('game')).message).toMatch(/up to date/)

    // someone else pushes; we land a different commit locally: diverged
    const other = path.join(root, 'other')
    await git.clone(remote, other)
    await git.git(other, ['config', 'user.email', 'o@o'])
    await git.git(other, ['config', 'user.name', 'o'])
    await commit(other, 'theirs.txt')
    expect((await git.git(other, ['push', 'origin', 'main'])).code).toBe(0)
    await commit(dir, 'ours.txt')
    const theirs = await git.headSha(remote, 'main')

    const refused = await svc.push('game')
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/diverged.*never force-pushes/)
    expect(await git.headSha(remote, 'main')).toBe(theirs) // remote untouched, nothing forced

    // Standard worlds land through PRs, not world_push
    svc.update('game', { mode: 'direct-PR' })
    expect((await svc.push('game')).message).toMatch(/through PRs/)
  }, 90_000)

  it('refuses without a remote', async () => {
    const svc = projects()
    await svc.add({ source: await repo(path.join(root, 'solo')), name: 'solo' })
    const r = await svc.push('solo')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no remote/)
    expect(await svc.pushStatus('solo')).toBeUndefined()
  }, 30_000)
})
