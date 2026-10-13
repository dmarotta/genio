import type { InventoryAsset } from '@shared/inventory'
import { NATIVE_THUMB_EXTS, THUMB_MAX_BYTES, inventoryMediaUrl } from '@shared/inventory'

export function breadcrumbs(folder: string): { name: string; path: string }[] {
  const parts = folder.split('/').filter(Boolean)
  return [{ name: 'All assets', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))]
}

export function thumbnailUrl(world: string, asset: InventoryAsset): string | undefined {
  return !asset.lfs && asset.size <= THUMB_MAX_BYTES && NATIVE_THUMB_EXTS.has(asset.ext)
    ? inventoryMediaUrl('thumb', world, asset.path) : undefined
}

export function previewKind(asset: InventoryAsset): 'image' | 'audio' | 'video' | 'glb' | 'info' {
  if (asset.lfs) return 'info'
  if (NATIVE_THUMB_EXTS.has(asset.ext)) return 'image'
  if (asset.ext === 'glb') return 'glb'
  if (['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(asset.ext)) return 'audio'
  if (['mp4', 'webm', 'mov', 'mkv'].includes(asset.ext)) return 'video'
  return 'info'
}

/** Rows are fixed-height; only the viewport and three overscan rows enter the DOM or IPC. */
export function virtualWindow(total: number, width: number, height: number, top: number, tile: number, list: boolean) {
  const columns = list ? 1 : Math.max(1, Math.floor(width / tile))
  const rowHeight = list ? 48 : tile + 36
  const rows = Math.ceil(total / columns)
  const startRow = Math.max(0, Math.min(Math.max(0, rows - 1), Math.floor(top / rowHeight) - 3))
  const offset = startRow * columns
  const limit = Math.min(1000, (Math.ceil(height / rowHeight) + 7) * columns)
  return { columns, rowHeight, offset, limit, y: startRow * rowHeight, height: rows * rowHeight }
}

export function assetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
