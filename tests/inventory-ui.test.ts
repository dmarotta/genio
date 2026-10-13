import { describe, expect, it } from 'vitest'
import { breadcrumbs, previewKind, thumbnailUrl, virtualWindow } from '../src/renderer/src/lib/inventory'
import { queryInventory } from '../src/main/inventory-query'
import type { InventoryAsset } from '../src/shared/inventory'

function asset(path: string, extra: Partial<InventoryAsset> = {}): InventoryAsset {
  const parts = path.split('/'), name = parts.pop()!
  return { path, name, folder: parts.join('/'), ext: name.split('.').pop()!, kind: 'image', size: 100, mtimeMs: 1, tracked: true, lfs: false, vendor: false, generated: false, tags: [], ...extra }
}

describe('Inventory browser', () => {
  const assets = [asset('Assets/UI/door.png', { tags: ['sprite', 'door'] }), asset('Assets/UI-kit/door.png'), asset('Assets/Audio/Music/theme.mp3', { kind: 'audio', tags: ['music'], generated: true }), asset('Assets/ThirdParty/Pack/door.psd', { vendor: true })]
  it('keeps tree counts and search results under the same scope/type/tag/provenance filters', () => {
    expect(queryInventory(assets, { folder: 'Assets' }).folders.map(f => [f.name, f.count])).toEqual([['Audio', 1], ['UI', 1], ['UI-kit', 1]])
    expect(queryInventory(assets, { scope: 'vendor', folder: 'Assets' }).folders).toEqual([{ path: 'Assets/ThirdParty', name: 'ThirdParty', count: 1, vendor: true }])
    expect(queryInventory(assets, { generated: true, query: 't:music' }).items.map(a => a.name)).toEqual(['theme.mp3'])
    expect(queryInventory(assets, { tags: ['sprite'], kinds: ['image'], query: 'door' }).total).toBe(1)
    expect(queryInventory(assets, { kinds: ['audio'], query: 'door' }).total).toBe(0)
  })
  it('uses folder boundaries and supports descending pages without changing folder counts', () => {
    expect(queryInventory(assets, { folder: 'Assets/UI' }).total).toBe(1)
    const q = { folder: 'Assets', scope: 'all' as const, sort: 'name' as const, descending: true }
    const all = queryInventory(assets, q)
    expect(queryInventory(assets, { ...q, offset: 1, limit: 2 }).items).toEqual(all.items.slice(1, 3))
    expect(queryInventory(assets, { ...q, offset: 100 }).folders).toEqual(all.folders)
    expect(breadcrumbs('Nested/Assets/UI')).toEqual([{ name: 'All assets', path: '' }, { name: 'Nested', path: 'Nested' }, { name: 'Assets', path: 'Nested/Assets' }, { name: 'UI', path: 'Nested/Assets/UI' }])
  })
  it('bounds rendered items independently of index size, including resized and scrolled-to-end layouts', () => {
    const grid = virtualWindow(30000, 640, 600, 20000, 150, false)
    expect(grid.columns).toBe(4)
    expect(grid.offset % grid.columns).toBe(0)
    expect(grid.limit).toBeLessThan(100)
    expect(grid.y).toBeLessThanOrEqual(20000)
    expect(grid.y + grid.limit / grid.columns * grid.rowHeight).toBeGreaterThan(20600)
    const list = virtualWindow(30000, 640, 600, 20000, 150, true)
    expect(list.columns).toBe(1)
    expect(list.limit).toBeLessThan(30)
    expect(virtualWindow(0, 0, 0, 9000, 150, false).offset).toBe(0)
    expect(virtualWindow(2, 640, 600, 20000, 150, true).offset).toBeLessThan(2)
  })
  it('keeps a screen page payload small for a large index', () => {
    const big = Array.from({ length: 30000 }, (_, i) => asset(`Assets/Area${i % 40}/Set${i % 7}/asset_${i}.png`, { tags: ['sprite'] }))
    const { limit } = virtualWindow(big.length, 1200, 900, 0, 120, false)
    const page = queryInventory(big, { folder: '', offset: 0, limit }), tree = queryInventory(big, { folder: '', limit: 1 })
    expect(page.items.length).toBe(limit)
    expect(JSON.stringify(page).length).toBeLessThan(64 * 1024)
    expect(JSON.stringify(tree).length).toBeLessThan(8 * 1024)
  })
  it('uses guarded thumbnail URLs and metadata fallbacks for unsupported formats, large files and LFS', () => {
    expect(thumbnailUrl('my-world', assets[0])).toBe('genio-media://thumb/my-world/Assets/UI/door.png')
    expect(thumbnailUrl('my-world', asset('large.png', { size: 70 * 1024 ** 2 }))).toBeUndefined()
    for (const ext of ['psd', 'tga', 'tiff', 'fbx', 'gltf', 'aiff']) expect(previewKind(asset(`asset.${ext}`))).toBe('info')
    expect(previewKind(asset('asset.png', { lfs: true }))).toBe('info')
    expect(thumbnailUrl('world', asset('asset.png', { lfs: true }))).toBeUndefined()
    for (const [ext, kind] of [['png', 'image'], ['wav', 'audio'], ['mp4', 'video'], ['glb', 'glb']]) expect(previewKind(asset(`asset.${ext}`))).toBe(kind)
  })
})
