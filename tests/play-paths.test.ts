import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimShortFolder, isShortId } from '../resources/unit-skills/genio/skills/play/scripts/clone.mjs'
import { PlayPool } from '../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { longPathWarning, longestProjectPath, pathWarning } from '../resources/unit-skills/genio/lib/path-length.mjs'
import { unityPoolPaths } from '../resources/unit-skills/genio/lib/unity-guard.mjs'

// Temp folders only: no git, no Unity.
let root: string, data: string, world: string
const write = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'genio-play-paths-')))
  data = path.join(root, 'data'); world = path.join(root, 'world')
  fs.mkdirSync(world)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('short folder ids', () => {
  it('takes the 8-hex prefix, a longer one when another key holds it, and reuses its own or an empty folder', () => {
    const key = '0123456789abcdef01234567', parent = path.join(root, 'pc')
    expect(claimShortFolder(parent, key)).toBe(path.join(parent, '01234567'))
    // Empty (a claim that never got its marker): reused.
    expect(claimShortFolder(parent, key)).toBe(path.join(parent, '01234567'))
    write(path.join(parent, '01234567', 'owner'), 'someone else')
    expect(claimShortFolder(parent, key)).toBe(path.join(parent, '0123456789ab'))
    write(path.join(parent, '0123456789ab', 'owner'), key)
    expect(claimShortFolder(parent, key, d => fs.readFileSync(path.join(d, 'owner'), 'utf8') === key)).toBe(path.join(parent, '0123456789ab'))
    expect(isShortId('01234567', key)).toBe(true)
    expect(isShortId('0123456789ab', key)).toBe(true)
    expect(isShortId('0123456', key)).toBe(false)
    expect(isShortId('11234567', key)).toBe(false)
    expect(isShortId('copy', key)).toBe(false)
  })
})

describe('Play slot folders', () => {
  it('places a new pool\'s slots at <data>/ps/<8 hex>, which the unit guards follow', async () => {
    const pool = new PlayPool(data, world)
    const dir = await pool.place()
    expect(dir).toBe(path.join(data, 'ps', path.basename(pool.dir).slice(0, 8)))
    expect(pool.root(1)).toBe(path.join(dir, 'slot-1'))
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'genio-pool.json'), 'utf8')).pool).toBe(path.basename(pool.dir))
    expect(unityPoolPaths({ play: { data, world } } as never).copies).toBe(dir)
    // A second process reads the same placement.
    expect(new PlayPool(data, world).slots()).toBe(dir)
  })

  it('moves legacy slots to a short folder only while every slot is idle, keeping their files', async () => {
    const pool = new PlayPool(data, world, 'Game')
    write(path.join(pool.dir, 'slot-1', 'Game', 'Library', 'ArtifactDB'), 'warm')
    write(path.join(pool.dir, 'slot-2', 'Game', 'Temp', 'UnityLockfile'))
    // Slot 2 is open in an editor: nothing moves.
    expect(await pool.relocate()).toBe(pool.dir)
    expect(fs.existsSync(path.join(pool.dir, 'slot-1'))).toBe(true)
    fs.rmSync(path.join(pool.dir, 'slot-2', 'Game', 'Temp'), { recursive: true })
    // A live lease: nothing moves.
    fs.writeFileSync(path.join(pool.dir, 'state.json'), JSON.stringify({ cap: 2, slots: [{ id: 1, lease: { owner: 'unit:a', pid: process.pid, token: 't', since: Date.now(), expires: Date.now() + 60000 } }], queue: [] }))
    expect(await pool.relocate()).toBe(pool.dir)
    fs.writeFileSync(path.join(pool.dir, 'state.json'), JSON.stringify({ cap: 2, slots: [{ id: 1 }], queue: [] }))
    const moved = await pool.relocate()
    expect(moved).toBe(path.join(data, 'ps', path.basename(pool.dir).slice(0, 8)))
    expect(pool.root(1)).toBe(path.join(moved, 'slot-1', 'Game'))
    expect(fs.readFileSync(path.join(pool.root(1), 'Library', 'ArtifactDB'), 'utf8')).toBe('warm')
    expect(fs.existsSync(path.join(moved, 'slot-2'))).toBe(true)
    expect(fs.readdirSync(pool.dir).filter(n => n.startsWith('slot-'))).toEqual([])
    expect(await pool.relocate()).toBe(moved)
  })

  it('moves a legacy Dev Drive placement within its volume folder', async () => {
    const pool = new PlayPool(data, world)
    const volumeHome = path.join(root, 'vol', '.genio', '0123456789abcdef'), legacy = path.join(volumeHome, 'play-pools', path.basename(pool.dir))
    write(path.join(legacy, 'slot-1', 'Assets', 'a.txt'))
    fs.writeFileSync(path.join(pool.dir, 'placement.json'), JSON.stringify({ dir: legacy }))
    const moved = await pool.relocate()
    expect(moved).toBe(path.join(volumeHome, 'ps', path.basename(pool.dir).slice(0, 8)))
    expect(fs.existsSync(path.join(moved, 'slot-1', 'Assets', 'a.txt'))).toBe(true)
    expect(fs.existsSync(legacy)).toBe(false)
  })
})

describe('the Windows path-length check', () => {
  /** A Unity project whose deepest file makes the absolute path exactly `length` characters long. */
  function deep(project: string, tree: string, length: number) {
    const start = path.join(project, ...tree.split('/'))
    const pad = length - start.length - 1 - 'x.dll'.length - 1
    const file = path.join(start, 'p'.repeat(pad), 'x.dll')
    write(file)
    expect(file.length).toBe(length)
    return file
  }

  it('finds the longest path under Library/PackageCache, Packages and Assets', async () => {
    const project = path.join(root, 'Game')
    write(path.join(project, 'Assets', 'a.txt'))
    deep(project, 'Library/PackageCache/com.unity.visualscripting@8bed5ad90189', 230)
    write(path.join(project, 'Library', 'Bee', 'p'.repeat(240 - project.length)))
    const longest = await longestProjectPath(project)
    expect(longest.length).toBe(230)
    expect(longest.rel.split(path.sep).slice(0, 3)).toEqual(['Library', 'PackageCache', 'com.unity.visualscripting@8bed5ad90189'])
    expect(longest.partial).toBe(false)
  })

  it('reads another PackageCache when the copy has none yet, rebased onto the copy', async () => {
    const main = path.join(root, 'main', 'Game'), copy = path.join(root, 'data', 'pc', '01234567', 'Game')
    deep(main, 'Library/PackageCache/com.unity.deep@1', 220)
    fs.mkdirSync(copy, { recursive: true })
    const longest = await longestProjectPath(copy, { packageCache: path.join(main, 'Library', 'PackageCache') })
    expect(longest.length).toBe(220 + copy.length - main.length)
  })

  it('stops a large scan at its bound and reports what it saw', async () => {
    const project = path.join(root, 'Game')
    for (let i = 0; i < 20; i++) write(path.join(project, 'Assets', `f${i}.txt`))
    expect((await longestProjectPath(project, { maxEntries: 5 })).partial).toBe(true)
  })

  it('warns within 20 characters of 260 or over it, naming the package, on Windows only', () => {
    const pkg = (n: number) => ({ length: n, rel: ['Library', 'PackageCache', 'com.unity.visualscripting@8bed5ad90189', 'Editor', 'x.dll'].join(path.sep) })
    expect(pathWarning(pkg(239), { platform: 'win32' })).toBeUndefined()
    expect(pathWarning(pkg(240), { platform: 'win32' })).toBe('Paths in com.unity.visualscripting reach 240 characters, near Windows\' 260 limit, so Unity may fail to load them. Remove that package or shorten the Unity folder name.')
    expect(pathWarning(pkg(260), { platform: 'win32' })).toMatch(/^Paths in com.unity.visualscripting reach 260 characters, over Windows' 260 limit/)
    expect(pathWarning(pkg(300), { platform: 'linux' })).toBeUndefined()
    expect(pathWarning({ length: 250, rel: ['Packages', 'com.studio.tools', 'Runtime', 'x.cs'].join(path.sep) }, { platform: 'win32' })).toMatch(/^Paths in com.studio.tools reach 250/)
    expect(pathWarning({ length: 250, rel: ['Assets', 'Art', 'x.png'].join(path.sep) }, { platform: 'win32' })).toBe('Paths in Assets reach 250 characters, near Windows\' 260 limit, so Unity may fail to load them. Shorten the folder names in Assets or the Unity folder name.')
  })

  it('runs only on Windows, and never throws', async () => {
    const project = path.join(root, 'Game')
    deep(project, 'Assets', 250)
    expect(await longPathWarning(project, { platform: 'win32' })).toMatch(/^Paths in Assets reach 250 characters/)
    expect(await longPathWarning(project, { platform: 'darwin' })).toBeUndefined()
    expect(await longPathWarning(path.join(root, 'missing'), { platform: 'win32' })).toBeUndefined()
  })
})

describe('a slot editor launch', () => {
  it('adds the path warning to the slot\'s editor warning and launches anyway', async () => {
    const pool = new PlayPool(data, world, '', { platform: 'win32', desktop: { available: () => false } as never, spawnVisible: async () => process.pid })
    const lease = (await pool.acquire('unit:a'))!
    write(path.join(pool.root(lease.id), 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.1f1\n')
    const start = path.join(pool.root(lease.id), 'Assets')
    write(path.join(start, 'p'.repeat(250 - start.length - 1 - 6), 'x.png'))
    const launch = await pool.launchEditor(lease.id, lease.token, 'FakeUnity.exe')
    expect(launch.warning).toMatch(/Paths in Assets reach 250 characters, near Windows' 260 limit/)
    const state = await pool.state()
    expect(state.slots.find(s => s.id === lease.id)?.warning).toMatch(/Paths in Assets reach 250/)
  })
})
