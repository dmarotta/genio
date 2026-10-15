import type { InventoryAsset } from '@shared/inventory'
import { NATIVE_THUMB_EXTS, inventoryMediaUrl, thumbnailKind } from '@shared/inventory'
import { MODEL_PREVIEW_EXTS, MODEL_PREVIEW_MAX_BYTES, type ModelFailure } from '@shared/model-viewer'

export function breadcrumbs(folder: string): { name: string; path: string }[] {
  const parts = folder.split('/').filter(Boolean)
  return [{ name: 'All assets', path: '' }, ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))]
}

export function thumbnailUrl(world: string, asset: InventoryAsset): string | undefined {
  return thumbnailKind(asset) === 'image' ? inventoryMediaUrl('thumb', world, asset.path) : undefined
}

/** A model tile's short note under its icon, with the full reason as its tooltip. */
export interface TileNote { note: string; reason: string }
export const MODEL_THUMB_NOTES: Record<ModelFailure, string> = { 'too-large': 'Too large', timeout: 'Took too long', unreadable: 'Can\'t be read', 'no-webgl': 'No WebGL' }

/**
 * A model tile asks for its drawing (`url`) or, when the 3D viewer cannot read it, says why at once.
 * Undefined for everything else (images, audio, LFS pointers keep their own tiles).
 */
export function modelTile(world: string, asset: InventoryAsset): { url: string } | TileNote | undefined {
  if (asset.lfs) return
  if (thumbnailKind(asset) === 'model') {
    const big = modelTooLarge(asset)
    return big ? { note: MODEL_THUMB_NOTES['too-large'], reason: `${big.title}. ${big.reason}` } : { url: inventoryMediaUrl('thumb', world, asset.path) }
  }
  if (asset.kind !== 'model') return
  const { title, reason } = unavailablePreview(asset)
  const ext = asset.ext.toLowerCase()
  return { note: ext === 'blend' ? 'Needs Blender' : ext === 'usdz' || ext === 'usdc' ? 'Binary USD' : 'No 3D preview', reason: `${title}. ${reason}` }
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
const PREVIEW_FORMATS = 'glTF, GLB, FBX, OBJ, STL, PLY, Collada (.dae), BVH, USDA and 3DS'

/** Why an asset shows no preview, in the player's words, with what to do instead. */
export function unavailablePreview(asset: InventoryAsset): PreviewUnavailable {
  const ext = asset.ext.toLowerCase()
  const type = `This file type can't be previewed here: .${ext}`
  if (asset.lfs) return { title: 'Git LFS file not pulled', reason: 'The local file is an LFS pointer. Pull the asset in your Git client to preview it.' }
  if (ext === 'blend') return { title: `${type} needs Blender`, reason: 'Genio does not run Blender to read .blend files. Open it in Blender, or export it as glTF, GLB or FBX to preview it here.' }
  if (ext === 'usdz' || ext === 'usdc') return { title: `${type} is binary USD`, reason: `Genio's 3D viewer reads USD only as text (USDA): its binary USD reader fails on ${ext === 'usdz' ? 'USDZ packages' : 'USDC files'}. Open it in your 3D app, or export it as USDA, glTF or FBX to preview it here.` }
  if (asset.kind === 'model') return { title: type, reason: `Genio's 3D preview reads ${PREVIEW_FORMATS}. Open it in your 3D app, or export it as one of those to preview it here.` }
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
