import fs from 'node:fs/promises'
import type { AppCtx } from './services'
import type { AssetKind, InventoryAsset, InventoryQuery } from '@shared/inventory'
import { suggestLocation } from '../../resources/unit-skills/genio/lib/genio-world.mjs'
import { guardedWorldFile } from './inventory'

/** Read only a small header: never decode images, spawn media tools or hydrate LFS. */
export async function cheapMediaInfo(file: string): Promise<{ width?: number; height?: number; duration?: number }> {
  const handle = await fs.open(file, 'r')
  try {
    const b = Buffer.alloc(65536), { bytesRead } = await handle.read(b, 0, b.length, 0)
    const data = b.subarray(0, bytesRead)
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
      let rate = 0
      for (let i = 12; i + 8 <= data.length;) {
        const id = data.toString('ascii', i, i + 4), size = data.readUInt32LE(i + 4)
        if (id === 'fmt ' && size >= 16 && i + 24 <= data.length) rate = data.readUInt32LE(i + 16)
        if (id === 'data' && rate > 0) return { duration: size / rate }
        i += 8 + size + size % 2
      }
    }
    return {}
  } finally { await handle.close() }
}

export async function findAssets(ctx: AppCtx, world: string, query: InventoryQuery) {
  await ctx.inventory.refresh(world)
  return ctx.inventory.list(world, { ...query, scope: 'all' })
}
export async function assetInfo(ctx: AppCtx, world: string, asset: string) {
  await ctx.inventory.refresh(world)
  const info = await ctx.inventory.info(world, asset)
  if (!info) throw new Error('Asset not found in world Inventory')
  const neighbours = await ctx.inventory.list(world, { folder: info.folder, recursive: false, scope: 'all', limit: 51 })
  const file = !info.lfs ? await ctx.inventory.mediaPath(world, asset) : undefined
  const metadata = file ? await cheapMediaInfo(file).catch(() => ({})) : {}
  return { ...info, ...metadata, neighbours: neighbours.items.filter(a => a.path !== asset).slice(0, 50).map(a => ({ path: a.path, kind: a.kind })), neighboursTotal: Math.max(0, neighbours.total - 1) }
}
export async function locateAsset(ctx: AppCtx, world: string, kind: AssetKind, name?: string, hint?: string) {
  const project = ctx.projects.get(world)
  if (!project) throw new Error(`No world named ${world}.`)
  await ctx.inventory.refresh(world)
  const assets: InventoryAsset[] = []
  for (let offset = 0;; offset += 1000) {
    const page = await ctx.inventory.list(world, { scope: 'all', offset, limit: 1000 })
    assets.push(...page.items)
    if (offset + page.items.length >= page.total || !page.items.length) break
  }
  let config = {}
  const file = await guardedWorldFile(project.path, '.genio/fal/config.json', true)
  if (file) {
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('World config is too large')
    config = JSON.parse(await fs.readFile(file, 'utf8')) ?? {}
  }
  return suggestLocation({ assets, kind, name, hint, engine: project.engine, engineRoot: project.engineRoot ?? '', config, root: project.path })
}
