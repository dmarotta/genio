import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../src/shared/types'
import type { AppCtx } from '../src/main/services'
import { effectiveEngine } from '../src/shared/engine'
import { PlayService } from '../src/main/play'
import type { UnityAdapter } from '../src/main/play-unity'
import { unitPlayEnv } from '../src/main/crew'
import { unityTestRoot } from '../src/main/gauntlet'
import { placementTarget } from '../src/main/asset-placement'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { ENGINE_CASES, engineProject } from './engine-cases'

let tmp: string, world: string, data: string, worktree: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-engine-contract-'))
  world = path.join(tmp, 'founders-of-avalon'); data = path.join(tmp, 'data'); worktree = path.join(tmp, 'worktree')
  // Detection would find Unity here; consumers must still read only the stored fields.
  fs.mkdirSync(path.join(world, 'FoundersOfAvalonUnity', 'ProjectSettings'), { recursive: true })
  fs.writeFileSync(path.join(world, 'FoundersOfAvalonUnity', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n')
  fs.mkdirSync(data); fs.mkdirSync(worktree)
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }))

const play = (p: Project) => new PlayService({ projects: { get: (name: string) => name === p.name ? p : undefined }, main: { home: { data } }, stats: { unlock() {} } } as unknown as AppCtx)

describe('effectiveEngine', () => {
  it('reads the stored engine and root, never the disk', () => {
    expect(effectiveEngine(engineProject({ engine: 'godot', engineRoot: 'games/godot' }, world))).toEqual({ engine: 'godot', root: 'games/godot' })
    expect(effectiveEngine(engineProject({ engine: 'other', engineRoot: '' }, world))).toEqual({ engine: 'other', root: '' })
    expect(effectiveEngine({ engine: undefined as unknown as Project['engine'] })).toEqual({ engine: 'other', root: '' })
  })
  it('normalizes separators and refuses roots that escape the project', () => {
    for (const engineRoot of ['Game', 'Game/', 'Game\\', './Game', '.\\Game\\']) expect(effectiveEngine({ engine: 'unity', engineRoot }).root).toBe('Game')
    for (const engineRoot of [undefined, '', '.', './', '../outside', 'Game/../..', '/abs', 'C:/abs', 'C:\\abs', '\\\\server\\share']) expect(effectiveEngine({ engine: 'unity', engineRoot }).root).toBe('')
  })
})

// The renderer half of this contract (playAvailable) runs on the same cases in play-availability.test.ts.
describe('Play, the unit pool env, the test gate and asset placement resolve the same root', () => {
  it.each(ENGINE_CASES)('$name', ({ stored, play: offered, root }) => {
    const p = engineProject(stored, world)
    expect(effectiveEngine(p).root).toBe(root)
    const svc = play(p), env = unitPlayEnv(p, data, worktree)
    if (offered) {
      expect((svc.adapter('game') as UnityAdapter).root).toBe(path.resolve(world, root))
      // A unit's Play skill builds its pool from this env: same slots, same root as the player's pool.
      expect(env).toEqual({ GENIO_PLAY_DATA: data, GENIO_PLAY_WORLD: world, GENIO_PLAY_SOURCE: worktree, GENIO_PLAY_ENGINE_ROOT: root })
      expect(new PlayPool(env.GENIO_PLAY_DATA, env.GENIO_PLAY_WORLD, env.GENIO_PLAY_ENGINE_ROOT).root(1)).toBe(svc.pool('game').root(1))
      // The Unity test gate opens the worktree's copy of that root.
      expect(unityTestRoot(p, worktree)).toEqual({ dir: path.resolve(worktree, root || '.'), relative: root || '.' })
    } else {
      expect(() => svc.adapter('game')).toThrow('supports Unity')
      expect(() => svc.pool('game')).toThrow('supports Unity')
      expect(env).toEqual({})
      expect(unityTestRoot(p, worktree)).toBeUndefined()
    }
    // Asset placement keeps writes under that root.
    const inside = [root, 'Art/door.png'].filter(Boolean).join('/')
    expect(placementTarget(p, inside)).toBe(path.join(world, inside))
    if (root) expect(() => placementTarget(p, 'Elsewhere/Art/door.png')).toThrow('engine root')
  })
})
