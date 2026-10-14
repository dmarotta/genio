import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { refreshEngine, createProjectsService } from '../src/main/projects'
import { detectProject } from '../src/main/engine-detect'
import { Home } from '../src/main/home'
import type { AppCtx } from '../src/main/services'
import type { Project } from '@shared/types'
import { suggestFolder } from '@shared/fal'
import { suggestAnimationFolder } from '@shared/uthana'
import { readWorldConfig, writeWorldConfig } from '../src/main/fal-world'
import * as git from '../src/main/git'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-engine-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
const put = (rel: string, value = '') => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
const project = (patch: Partial<Project> = {}): Project => ({
  name: 'game', path: root, defaultBranch: 'main', engine: 'other', commands: {},
  mode: 'local-only', yolo: false, forge: 'none', branchPrefix: 'genio/', managed: false, addedAt: '', ...patch
})

it.each(['', 'FoundersOfAvalonUnity', 'games/My Game'])('finds Unity at %s with checkout-relative commands', async (engineRoot) => {
  put(`${engineRoot ? engineRoot + '/' : ''}ProjectSettings/ProjectVersion.txt`)
  const detected = await detectProject(root)
  expect(detected).toMatchObject({ engine: 'unity', engineRoot })
  // No version or installed editor: never propose the colliding Unity CLI alias.
  expect(detected.commands.test).toBeUndefined()
})

it('finds nested Godot with GUT and Unreal', async () => {
  put('games/godot/project.godot')
  put('games/godot/addons/gut/gut_cmdln.gd')
  expect(await detectProject(root)).toMatchObject({ engine: 'godot', engineRoot: 'games/godot', commands: {
    run: 'godot --path "games/godot"', test: 'godot --headless --path "games/godot" -s addons/gut/gut_cmdln.gd -gexit'
  } })
  put('unreal/Game.uproject')
  expect(await detectProject(root)).toMatchObject({ engine: 'unreal', engineRoot: 'unreal' })
  put('project.godot')
  expect(await detectProject(root)).toMatchObject({ engine: 'godot', engineRoot: '' })
})

it('ignores caches, build output, hidden directories and projects deeper than three levels', async () => {
  for (const dir of ['Library/game', 'node_modules/game', '.git/game', 'bin/game', 'OBJ/game', 'Build/game', 'out/game', 'a/b/c/d']) put(`${dir}/project.godot`)
  expect(await detectProject(root)).toMatchObject({ engine: 'other', engineRoot: '', commands: {}, detected: { candidates: [], ambiguous: false, declared: false } })
  put('package.json', JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { phaser: '*' } }))
  expect(await detectProject(root)).toMatchObject({ engine: 'web', engineRoot: '', commands: { build: 'npm run build' } })
})

it('reads a package.json saved with a UTF-8 BOM', async () => {
  put('package.json', '\uFEFF' + JSON.stringify({ scripts: { dev: 'vite' }, dependencies: { phaser: '*' } }))
  expect(await detectProject(root)).toMatchObject({ engine: 'web', engineRoot: '', commands: { run: 'npm run dev' } })
})

it('refreshes ordinary folders on startup refresh and Sync, not only on window open', async () => {
  const home = new Home(path.join(root, 'home'))
  const ctx = { main: { home }, ledger: { record() {} } } as unknown as AppCtx
  fs.mkdirSync(path.join(root, 'folder'))
  const { project: opened } = await createProjectsService(() => ctx).openFolder(path.join(root, 'folder'))
  expect(opened).toMatchObject({ gitRepo: false, engine: 'other', engineRoot: '' })
  put('folder/FoundersOfAvalonUnity/ProjectSettings/ProjectVersion.txt')
  const restarted = createProjectsService(() => ctx)
  await restarted.refreshRemotes()
  expect(restarted.get(opened.name)).toMatchObject({ gitRepo: false, mode: 'local-only', engine: 'unity', engineRoot: 'FoundersOfAvalonUnity' })
  fs.rmSync(path.join(root, 'folder', 'FoundersOfAvalonUnity'), { recursive: true })
  await restarted.sync(opened.name)
  expect(restarted.get(opened.name)).toMatchObject({ engine: 'other', engineRoot: '' })
})

it('upgrades legacy fallback engines, preserves manual and specific legacy choices and custom commands', async () => {
  put('FoundersOfAvalonUnity/ProjectSettings/ProjectVersion.txt')
  expect(await refreshEngine(project())).toMatchObject({ engine: 'unity', engineRoot: 'FoundersOfAvalonUnity', engineSource: 'auto' })
  for (const engine of ['other', 'godot'] as const) {
    expect(await refreshEngine(project({ engine, engineSource: 'manual', commands: { test: 'custom' } })))
      .toMatchObject({ engine, engineSource: 'manual', commands: { test: 'custom' } })
  }
  expect((await refreshEngine(project({ engine: 'godot' }))).engine).toBe('godot')
  expect((await refreshEngine(project({ engine: 'unity' }))).engineRoot).toBe('FoundersOfAvalonUnity')
})

it('refreshes persisted engines on startup refresh and sync, and pins explicit updates', async () => {
  const home = new Home(path.join(root, 'home'))
  const dir = path.join(root, 'repo')
  await git.initRepo(dir, 'main')
  const ctx = { main: { home } } as unknown as AppCtx
  const svc = createProjectsService(() => ctx)
  await svc.add({ source: dir, name: 'game' })
  put('repo/FoundersOfAvalonUnity/ProjectSettings/ProjectVersion.txt')
  const restarted = createProjectsService(() => ctx)
  await restarted.refreshRemotes()
  expect(restarted.get('game')).toMatchObject({ engine: 'unity', engineRoot: 'FoundersOfAvalonUnity' })
  restarted.update('game', { engine: 'other' })
  await restarted.sync('game')
  expect(restarted.get('game')).toMatchObject({ engine: 'other', engineSource: 'manual', engineRoot: '' })
  restarted.update('game', { engine: 'unity', engineRoot: 'Manual/Game' })
  const pinned = createProjectsService(() => ctx)
  await pinned.refreshRemotes()
  expect(pinned.get('game')).toMatchObject({ engineRoot: 'Manual/Game', engineRootSource: 'manual' })
  expect(() => pinned.update('game', { engineRoot: '../outside' })).toThrow('inside the project')
  pinned.update('game', { engineRoot: '' })
  await pinned.refreshRemotes()
  expect(pinned.get('game')?.engineRoot).toBe('')
  pinned.update('game', { engineRoot: undefined })
  await pinned.refreshRemotes()
  expect(pinned.get('game')?.engineRoot).toBe('FoundersOfAvalonUnity')
})

it('roots asset suggestions and persisted defaults while keeping explicit folders repo-relative', () => {
  expect(suggestFolder('unity', 'image', 'Game')).toBe('Game/Assets/Art/Generated')
  expect(suggestFolder('godot', 'audio', 'games/godot')).toBe('games/godot/assets/generated/audio')
  expect(suggestFolder('unreal', 'model', 'Game')).toBe('Game/SourceArt/Generated/Models')
  expect(suggestAnimationFolder('unity', 'Game')).toBe('Game/Assets/Animations/Generated')
  expect(suggestAnimationFolder('unreal', 'Game')).toBe('Game/SourceArt/Generated/Animations')
  expect(suggestFolder('unity', 'image')).toBe('Assets/Art/Generated')
  writeWorldConfig(root, { folders: { audio: 'Shared/Audio' } }, 'unity', 'Game')
  expect(readWorldConfig(root).folders).toMatchObject({ audio: 'Shared/Audio', image: 'Game/Assets/Art/Generated' })
})
