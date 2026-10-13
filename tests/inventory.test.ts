import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'
import { createInventoryService, enumerateInventory, guardedWorldFile, validInventoryPath, type InventoryService } from '../src/main/inventory'
import { assetKind, ignoredAssetPath } from '../src/main/inventory-query'
import { inventoryMediaUrl, THUMB_MAX_BYTES } from '../src/shared/inventory'
import { mediaResponse } from '../src/main/fal-service'
import type { AppCtx } from '../src/main/services'

let base: string, root: string, data: string
let services: InventoryService[]
const write = (p: string, text: string | Buffer): void => { const file = path.join(root, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true })
const context = (): AppCtx => ({ main: { home: { data } }, projects: { get: (name: string) => name === 'fixture' ? { name, path: root, engine: 'unity', engineRoot: 'Nested' } : undefined } }) as unknown as AppCtx
const create = (decode?: (url: string) => Promise<Buffer | undefined>, cap?: number): InventoryService => {
  const s = createInventoryService(context, decode, cap); services.push(s); return s
}
const provenance = (asset: string, content: string): void => write(`.genio/provenance/${asset}.json`, JSON.stringify({ schema: 'genio.provenance.v1', path: asset,
  sha256: createHash('sha256').update(content).digest('hex'), by: 'unit:test', provider: 'fal', endpoint: 'test/sfx', created: '2026-10-13T12:00:00Z' }))

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-inventory-')); root = path.join(base, 'world'); data = path.join(base, 'data')
  fs.mkdirSync(root); git('init', '-q'); services = []
  write('.gitignore', 'ignored/\n')
  write('Nested/Assets/UI/door icon.png', 'image')
  write('Nested/Assets/UI/door icon.png.meta', 'fileFormatVersion: 2\nguid: abcdef012345\nlabels:\n- ui\n- Door\nTextureImporter:\n  textureType: 8\n')
  write('Nested/Assets/Audio/SFX/door.wav', 'sound'); provenance('Nested/Assets/Audio/SFX/door.wav', 'sound')
  write('Nested/Assets/ThirdParty/Pack/stone.psd', 'psd')
  write('Library/never.png', 'cache'); write('Nested/Library/never.png', 'cache')
  write('ignored/never.png', 'ignored')
  write('misc/clip.fbx', 'model'); write('misc/missing.tga', `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 90000000\n`)
  write('misc/surface.tres', '[gd_resource type="StandardMaterial3D" load_steps=2 format=3]')
  write('misc/other.tres', '[gd_resource type="Resource" format=3]')
  write('misc/texture.webp', 'webp'); write('misc/texture.webp.import', '[remap]\nimporter="texture"\nuid="uid://123"\n')
  git('add', '--', 'Nested', 'misc', '.gitignore', '.genio')
  write('new/新 image.EXR', 'exr')
})
afterEach(async () => {
  for (const s of services) s.stop()
  // Wait for file handles from fs.watch and worker shutdown to close on Windows.
  await new Promise(r => setTimeout(r, 50))
  fs.rmSync(base, { recursive: true, force: true })
})

describe('Inventory backend', () => {
  it('reports successful indexing, but not failed scans or cached reads, for achievements', async () => {
    const used: string[] = []
    const off = bus.onEvent((event) => { if (event.type === 'feature-used') used.push(event.feature) })
    try {
      const service = create()
      await expect(service.list('unknown')).rejects.toThrow()
      expect(used).toEqual([])
      await service.list('fixture')
      expect(used).toEqual(['inventory-index'])
      await service.list('fixture')
      expect(used).toEqual(['inventory-index'])
    } finally { off() }
  })
  it('enumerates tracked + untracked paths without ignored engine caches; indexes kinds, sidecars, LFS and provenance', async () => {
    const enumerated = await enumerateInventory(root)
    expect(enumerated.files.has('Library/never.png')).toBe(false)
    expect(enumerated.files.has('Nested/Library/never.png')).toBe(false)
    expect(enumerated.files.has('ignored/never.png')).toBe(false)
    expect(enumerated.files.get('new/新 image.EXR')).toBe(false)
    const service = create(), all = await service.list('fixture', { scope: 'all', limit: 1000 })
    expect(all.items).toHaveLength(8)
    expect(all.state).toMatchObject({ engine: 'unity', engineRoot: 'Nested' })
    expect(all.items.some(a => /\.meta$|\.import$|\.genio\//.test(a.path))).toBe(false)
    const image = (await service.info('fixture', 'Nested/Assets/UI/door icon.png'))!
    expect(image.meta).toMatchObject({ guid: 'abcdef012345', textureType: 8, importer: 'TextureImporter', labels: ['ui', 'Door'] })
    expect(image.tags).toContain('sprite')
    expect((await service.info('fixture', 'misc/texture.webp'))?.meta).toMatchObject({ importer: 'texture', uid: 'uid://123' })
    expect(all.items.find(a => a.name === 'missing.tga')).toMatchObject({ lfs: true, lfsOid: 'a'.repeat(64), lfsSize: 90000000 })
    expect(all.items.find(a => a.name === 'stone.psd')).toMatchObject({ vendor: true, kind: 'image' })
    expect(all.items.find(a => a.name === 'door.wav')).toMatchObject({ generated: true, tags: ['sfx'] })
    expect(all.items.find(a => a.ext === 'exr')).toMatchObject({ tracked: false, kind: 'image' })
    expect(fs.existsSync(path.join(data, 'inventory/fixture/index.json'))).toBe(true)
  })
  it('searches and filters kinds, fuzzy names, folders, tags, generated records and scope, with folder counts/pagination', async () => {
    const s = create()
    expect((await s.list('fixture')).items).toHaveLength(7)
    expect((await s.list('fixture', { query: 'door t:sfx by:unit via:fal', generated: true })).items.map(a => a.name)).toEqual(['door.wav'])
    expect((await s.list('fixture', { query: 't:sprite l:ui in:UI ext:png' })).items.map(a => a.name)).toEqual(['door icon.png'])
    expect((await s.list('fixture', { kinds: ['image'], tags: ['Door'], folder: 'Nested' })).total).toBe(1)
    expect((await s.list('fixture', { scope: 'vendor' })).total).toBe(1)
    expect((await s.list('fixture', { query: 'lfs:missing size<1kb' })).total).toBe(1)
    expect((await s.list('fixture', { query: 'dr icn' })).total).toBe(1)
    const folder = await s.list('fixture', { folder: 'Nested/Assets', recursive: false })
    expect(folder.items).toEqual([])
    expect(folder.folders.map(f => [f.name, f.count])).toEqual([['Audio', 1], ['UI', 1]])
    expect((await s.list('fixture', { limit: 2, offset: 2 })).items).toHaveLength(2)
  })
  it('keeps unpulled material resources as LFS placeholders before checking their unavailable type header', async () => {
    write('misc/unpulled.tres', `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 10000\n`)
    const result = await create().list('fixture', { query: 'lfs:missing', kinds: ['material'] })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'unpulled.tres', lfs: true, lfsSize: 10000 })
  })
  it('joins provenance and hashes only on asset-info request, exposing edited state and encoded URLs', async () => {
    const s = create(), p = 'Nested/Assets/Audio/SFX/door.wav'
    expect((await s.info('fixture', p, true))?.editedSinceGeneration).toBe(false)
    write(p, 'edited'); await s.refresh('fixture')
    expect((await s.info('fixture', p, true))?.editedSinceGeneration).toBe(true)
    const image = await s.info('fixture', 'Nested/Assets/UI/door icon.png')
    expect(image?.thumbnailUrl).toBe('genio-media://thumb/fixture/Nested/Assets/UI/door%20icon.png')
    expect((await s.info('fixture', 'misc/missing.tga'))?.thumbnailUrl).toBeUndefined()
    expect(inventoryMediaUrl('world', 'fixture', 'a/#%.png')).toContain('%23%25.png')
  })
  it('applies world ignore/vendor settings and recognizes conservative pack shapes', async () => {
    write('.genio/assets.json', JSON.stringify({ vendor: ['misc'], ignore: ['new'] }))
    write('packs/example/Documentation/readme.md', 'docs'); write('packs/example/Demo/scene.unity', 'demo'); write('packs/example/Art/test.png', 'image')
    const result = await create().list('fixture', { scope: 'vendor' })
    expect(result.items.map(a => a.name)).toEqual(expect.arrayContaining(['test.png', 'clip.fbx']))
    expect(result.items.some(a => a.ext === 'exr')).toBe(false)
  })
  it('loads a cache on open and reconciles changes made while closed', async () => {
    const first = create(); await first.refresh('fixture'); first.stop()
    write('after-close.png', 'new')
    const second = create(), opened = await second.open('fixture')
    expect(opened.refreshing).toBe(true)
    expect(opened.total).toBe(8)
    await second.refresh('fixture')
    expect((await second.list('fixture')).items.some(a => a.path === 'after-close.png')).toBe(true)
    second.close('fixture')
    expect((await second.list('fixture')).state.watching).toBe(false)
  })
  it('updates additions, renames, deletions, metadata and provenance through the watcher, and stops on close', async () => {
    const s = create(); const state = await s.open('fixture')
    expect(state.watching).toBe(true)
    const waitRevision = (revision: number): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(Error('watcher update timeout')) }, 5000)
      const off = bus.onEvent(e => { if (e.type === 'inventory' && e.state.revision > revision && e.state.updatedAt !== state.updatedAt && !e.state.refreshing) { clearTimeout(timer); off(); resolve() } })
    })
    const pending = waitRevision(state.revision)
    write('added.png', 'new')
    fs.renameSync(path.join(root, 'misc/clip.fbx'), path.join(root, 'misc/renamed.fbx'))
    fs.unlinkSync(path.join(root, 'new/新 image.EXR'))
    write('Nested/Assets/UI/door icon.png.meta', 'guid: fffff\nlabels:\n- changed\nTextureImporter:\n  textureType: 1\n')
    provenance('added.png', 'new')
    await pending
    const result = await s.list('fixture', { scope: 'all' })
    expect(result.items.find(a => a.path === 'added.png')?.generated).toBe(true)
    expect((await s.info('fixture', 'Nested/Assets/UI/door icon.png'))?.tags).toContain('changed')
    expect(result.items.some(a => a.path === 'misc/renamed.fbx')).toBe(true)
    expect(result.items.some(a => a.path === 'misc/clip.fbx' || a.ext === 'exr')).toBe(false)
    s.close('fixture'); const revision = (await s.list('fixture')).state.revision; write('closed.png', 'closed')
    await new Promise(r => setTimeout(r, 450))
    expect((await s.list('fixture')).state).toMatchObject({ revision, watching: false })
  })
  it('guards nested media reads against traversal, control folders, symlinks and unknown worlds; retains Range seeking', async () => {
    const s = create()
    for (const p of ['../outside.png', 'C:/outside.png', '/outside.png', 'x\\y.png', 'a/../file.png', '.git/config', '.genio/assets.json', 'Nested/Library/never.png', 'x:stream', 'dir./file.png']) {
      expect(await s.mediaPath('fixture', p)).toBeUndefined()
    }
    expect(validInventoryPath('Assets/nested/hello world.png')).toBe(true)
    expect(await s.mediaPath('missing', 'test.png')).toBeUndefined()
    const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.png'), 'secret')
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction')
    expect(await guardedWorldFile(root, 'linked/secret.png')).toBeUndefined()
    fs.symlinkSync(path.join(root, 'Library'), path.join(root, 'cache-alias'), 'junction')
    expect(await guardedWorldFile(root, 'cache-alias/never.png')).toBeUndefined()
    write('media/test.wav', '0123456789')
    const file = await s.mediaPath('fixture', 'media/test.wav')
    const response = mediaResponse(file!, 'bytes=2-5')
    expect(response.status).toBe(206); expect(await response.text()).toBe('2345')
    expect(mediaResponse(file!, 'bytes=20-30').status).toBe(416)
  })
  it('generates thumbnails lazily, deduplicates requests, invalidates modified assets and enforces input/cache caps', async () => {
    const webp = Buffer.from('RIFF0000WEBPfake'), decode = vi.fn(async () => webp), s = create(decode, webp.length)
    await s.list('fixture'); expect(decode).not.toHaveBeenCalled()
    const p = 'Nested/Assets/UI/door icon.png'
    const [a, b] = await Promise.all([s.thumbnail('fixture', p), s.thumbnail('fixture', p)])
    expect(a).toBe(b); expect(a).toContain(path.join(data, 'thumbs')); expect(decode).toHaveBeenCalledTimes(1)
    expect(await s.thumbnail('fixture', p)).toBe(a); expect(decode).toHaveBeenCalledTimes(1)
    write(p, 'larger edited image'); const c = await s.thumbnail('fixture', p)
    expect(c).not.toBe(a); expect(fs.existsSync(a!)).toBe(false); expect(fs.existsSync(c!)).toBe(true)
    write('large.png', ''); fs.truncateSync(path.join(root, 'large.png'), THUMB_MAX_BYTES + 1)
    await s.refresh('fixture')
    expect(await s.thumbnail('fixture', 'large.png')).toBeUndefined()
    expect(await s.thumbnail('fixture', 'misc/missing.tga')).toBeUndefined()
    expect(await s.thumbnail('fixture', 'Nested/Assets/ThirdParty/Pack/stone.psd')).toBeUndefined()
    expect(decode).toHaveBeenCalledTimes(2)
  })
  it('classifies DCC/HDR/animation/media extensions and hides sidecars and engine caches', () => {
    for (const ext of ['psd', 'tga', 'tif', 'tiff', 'exr', 'hdr']) expect(assetKind(`x.${ext}`)).toBe('image')
    expect(assetKind('a.anim')).toBe('animation'); expect(assetKind('a.bvh')).toBe('animation')
    expect(assetKind('a.material')).toBe('material'); expect(assetKind('a.mat')).toBe('material')
    expect(assetKind('x.png.meta')).toBeUndefined(); expect(assetKind('x.import')).toBeUndefined()
    expect(ignoredAssetPath('Nested/Library/images/a.png')).toBe(true)
    expect(ignoredAssetPath('Assets/Buildings/Building.png')).toBe(false)
  })
})
