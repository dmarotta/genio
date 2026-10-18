import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { conventionsOf, suggestLocation } from '../resources/unit-skills/genio/lib/genio-world.mjs'
import { createInventoryService } from '../src/main/inventory'
import { assetKind, vendorPath } from '../src/main/inventory-query'
import { assetInfo, findAssets, locateAsset } from '../src/main/asset-tools'
import { buildTools } from '../src/main/wksp-tools'
import { ACHIEVEMENTS } from '../src/main/stats'
import type { AppCtx } from '../src/main/services'
import type { Home } from '../src/main/home'

let root: string, data: string, ctx: AppCtx
const write = (p: string, content: string | Buffer) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content) }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-tools-world-'))
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-tools-cache-'))
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
  ctx = { main: { home: { data } }, projects: { get: (world: string) => world === 'fixture' ? { path: root, engine: 'unity', engineRoot: 'Nested' } : undefined }, stats: { unlock: vi.fn() } } as unknown as AppCtx
  ctx.inventory = createInventoryService(() => ctx)
  write('Nested/Assets/Audio/SFX/road-placement-01.wav', 'sound')
  write('Nested/Assets/Audio/SFX/road-placement-02.wav', 'sound')
  write('Nested/Assets/ThirdParty/Audio/vendor.wav', 'sound')
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(32, 16); png.writeUInt32BE(16, 20)
  write('Nested/Assets/UI/icon.png', png)
  write('Nested/Assets/UI/missing.png', `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 500\n`)
})
afterEach(async () => {
  ctx.inventory.stop(); await new Promise(r => setTimeout(r, 50))
  fs.rmSync(root, { force: true, recursive: true }); fs.rmSync(data, { force: true, recursive: true })
})
it('finds, inspects and locates without changing the world or opening a watcher', async () => {
  const before = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
  expect((await findAssets(ctx, 'fixture', { query: 't:sfx', limit: 1 })).total).toBe(2)
  expect(await assetInfo(ctx, 'fixture', 'Nested/Assets/UI/icon.png')).toMatchObject({ width: 32, height: 16, neighboursTotal: 1, lfs: false })
  expect(await assetInfo(ctx, 'fixture', 'Nested/Assets/UI/missing.png')).toMatchObject({ lfs: true, lfsSize: 500 })
  const result = await locateAsset(ctx, 'fixture', 'audio', 'road placement')
  expect(result.suggestions[0].path).toBe('Nested/Assets/Audio/SFX/road-placement-03.wav')
  expect(result.suggestions[0].reason).toContain('-NN')
  expect((await ctx.inventory.list('fixture')).state.watching).toBe(false)
  expect(execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })).toBe(before)
  await expect(assetInfo(ctx, 'fixture', '../secret.png')).rejects.toThrow('not found')
  await expect(locateAsset(ctx, 'unknown', 'image')).rejects.toThrow('No project')
})
it('reads WAV duration cheaply and refreshes closed indexes', async () => {
  await ctx.inventory.refresh('fixture')
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt32LE(48000, 28); wav.write('data', 36); wav.writeUInt32LE(96000, 40)
  write('Nested/Assets/Audio/test.wav', wav)
  expect(await assetInfo(ctx, 'fixture', 'Nested/Assets/Audio/test.wav')).toMatchObject({ duration: 2 })
})
it('registers read tools for both roles and unlocks the feature only after success', async () => {
  for (const role of ['genio', 'bot'] as const) {
    const registered = new Map<string, (a: any) => Promise<any>>()
    const tool = ((name: string, _desc: string, _shape: unknown, fn: any) => { registered.set(name, fn); return {} }) as Parameters<typeof buildTools>[0]
    buildTools(tool, () => ctx, { name: 'main' } as Home, role)
    expect(registered.has('asset_info')).toBe(true)
    expect((await registered.get('asset_locate')!({ world: 'unknown', kind: 'audio' })).isError).toBe(true)
    const calls = () => vi.mocked(ctx.stats.unlock).mock.calls.filter(([id]) => id === 'inventory-scout' || id === 'asset-pathfinder').length
    const before = calls()
    await registered.get('assets_find')!({ world: 'fixture' })
    await registered.get('asset_locate')!({ world: 'fixture', kind: 'audio' })
    expect(calls()).toBe(before + 2)
  }
  expect(ACHIEVEMENTS.find(a => a.id === 'inventory-scout')?.feature).toBe('assets_find')
})
it('rejects unsafe configured/hinted folders and vendor targets, including junctions', () => {
  const folders = ['Library', 'Temp', 'generated', 'ThirdParty', 'Packages', 'Editor', 'Resources', 'StreamingAssets', 'AddressableAssetsData', 'BuildOutput', 'node_modules']
  for (const folder of folders) {
    const target = `Nested/Assets/${folder}/Audio`
    const result = suggestLocation({ assets: [{ path: target + '/a.wav', folder: target, kind: 'audio' }], engine: 'unity', engineRoot: 'Nested', kind: 'audio', hint: target, config: { folders: { audio: target } } })
    expect(result.suggestions.some(s => s.folder === target)).toBe(false)
  }
  fs.symlinkSync(data, path.join(root, 'link'), 'junction')
  expect(suggestLocation({ root, assets: [], kind: 'audio', hint: 'link/Audio' }).suggestions.some(s => s.folder.startsWith('link/'))).toBe(false)
  expect(suggestLocation({ assets: [], kind: 'audio', hint: '../outside' }).suggestions.every(s => !s.path.includes('..'))).toBe(true)
})
it('uses engine fallbacks, configuration, local case style and source-art format rules', () => {
  expect(suggestLocation({ assets: [], engine: 'godot', engineRoot: 'Game', kind: 'audio', name: 'Door Slam' }).suggestions[0].path).toBe('Game/assets/audio/door_slam.wav')
  expect(suggestLocation({ assets: [], engine: 'unreal', kind: 'model', hint: 'Content/Models' }).suggestions[0].path).toBe('SourceArt/Models/new-asset.glb')
  const source = suggestLocation({ assets: [], engine: 'unity', engineRoot: 'Nested', kind: 'model', name: 'Oak.glb' })
  expect(source.suggestions[0].path).toBe('Nested/ArtSource/3D/oak.glb')
  expect(source.warnings.length).toBe(1)
  expect(suggestLocation({ assets: [], kind: 'image', config: { folders: { image: 'Art/UI' } } }).suggestions[0].folder).toBe('Art/UI')
  const assets = [{ path: 'Assets/Wildlife/Textures/MeadowSheep_BaseColor.png', folder: 'Assets/Wildlife/Textures', kind: 'image' }]
  expect(conventionsOf({ assets, kind: 'image' })[0].style).toBe('PascalCase')
})

// Read-only layout checks against tracked files in the temporary fixture.
for (const [engineRoot, kind, hint, expected] of [
  ['Nested', 'audio', 'road', /Nested\/Assets\/.*Audio/i],
  ['', 'audio', 'sfx', /Game Assets\/Audio/i]
] as const) {
  it(`measures the tracked layout read-only: ${engineRoot || 'root'}`, () => {
    write('Game Assets/Audio/SFX/hit.wav', 'sound')
    execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true })
    const assetRoot = engineRoot ? `${engineRoot}/Assets` : 'Game Assets'
    const paths = execFileSync('git', ['ls-files', '-z', '--', assetRoot], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).split('\0')
    const assets = paths.filter(p => assetKind(p)).map(p => ({ path: p, folder: path.posix.dirname(p), kind: assetKind(p)!, vendor: vendorPath(p) }))
    const result = suggestLocation({ assets, engine: 'unity', engineRoot, kind, hint, name: 'door creak' })
    expect(result.suggestions[0].path).toMatch(expected)
    if (engineRoot) expect(result.suggestions[0].path).toMatch(/door-creak-01\.wav$/)
  })
}
