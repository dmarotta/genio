import type { InventoryAsset } from '@shared/inventory'
import { NATIVE_THUMB_EXTS, THUMB_MAX_BYTES, inventoryMediaUrl } from '@shared/inventory'
import { MODEL_PREVIEW_EXTS, MODEL_PREVIEW_MAX_BYTES } from '@shared/model-viewer'

export function breadcrumbs(folder: string): { name: string; path: string }[] {
  const parts = folder.split('/').filter(Boolean)
  return [{ name: 'All assets', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))]
}

export function thumbnailUrl(world: string, asset: InventoryAsset): string | undefined {
  return !asset.lfs && asset.size <= THUMB_MAX_BYTES && NATIVE_THUMB_EXTS.has(asset.ext)
    ? inventoryMediaUrl('thumb', world, asset.path) : undefined
}

const AUDIO_EXTS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus']
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'mkv']

export function previewKind(asset: InventoryAsset): 'image' | 'audio' | 'video' | 'model' | 'none' {
  if (asset.lfs) return 'none'
  if (NATIVE_THUMB_EXTS.has(asset.ext)) return 'image'
  if ((MODEL_PREVIEW_EXTS as readonly string[]).includes(asset.ext)) return 'model'
  if (AUDIO_EXTS.includes(asset.ext)) return 'audio'
  if (VIDEO_EXTS.includes(asset.ext)) return 'video'
  return 'none'
}

export interface PreviewUnavailable { title: string; reason: string }

/** Why an asset shows no preview, in the player's words, with what to do instead. */
export function unavailablePreview(asset: InventoryAsset): PreviewUnavailable {
  const ext = asset.ext.toLowerCase()
  const type = `This file type can't be previewed here: .${ext}`
  if (asset.lfs) return { title: 'Git LFS file not pulled', reason: 'The local file is an LFS pointer. Pull the asset in your Git client to preview it.' }
  if (ext === 'blend') return { title: `${type} needs Blender`, reason: 'Open it in Blender to see the scene.' }
  if (asset.kind === 'model' || ext === 'bvh') return { title: type, reason: 'Genio\'s 3D preview reads glTF and GLB. Open it in your 3D app, or export it as glTF or GLB to preview it here.' }
  if (ext === 'anim') return { title: `${type} is a Unity animation clip`, reason: 'Unity clips play only in the Unity editor. Open it there.' }
  if (asset.kind === 'material') return { title: `${type} is an engine material`, reason: 'Materials render only in the engine that uses them. Open it there.' }
  if (asset.kind === 'image') return { title: type, reason: 'Genio shows PNG, JPEG, WebP, GIF, BMP, AVIF and SVG images. Open this one in your image editor.' }
  if (asset.kind === 'audio') return { title: type, reason: `Genio plays ${AUDIO_EXTS.map(e => e.toUpperCase()).join(', ')}. Open this one in your audio app.` }
  if (asset.kind === 'video') return { title: type, reason: `Genio plays ${VIDEO_EXTS.map(e => e.toUpperCase()).join(', ')}. Open this one in your video player.` }
  return { title: type, reason: 'Open it in its default app.' }
}

/** Models above the cap are never loaded; the player sees the size and the limit. */
export function modelTooLarge(asset: InventoryAsset): PreviewUnavailable | undefined {
  if (asset.size <= MODEL_PREVIEW_MAX_BYTES) return
  return { title: `Too large to preview: ${assetBytes(asset.size)} (limit ${assetBytes(MODEL_PREVIEW_MAX_BYTES)})`, reason: 'Big models can freeze the preview, so this one is not loaded. Open it in your 3D app instead.' }
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
