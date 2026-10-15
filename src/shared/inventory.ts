import type { Engine } from './types'
import { MODEL_PREVIEW_EXTS } from './model-viewer'

/** World-relative, forward-slash paths throughout. Inventory never writes to a world. */
export type AssetKind = 'image' | 'audio' | 'video' | 'model' | 'animation' | 'material'
export interface AssetMeta {
  path: string
  /** False until the lazy sidecar read completes. */
  loaded?: boolean
  mtimeMs?: number
  guid?: string
  uid?: string
  importer?: string
  textureType?: number
  labels: string[]
}
export interface AssetProvenance {
  schema: 'genio.provenance.v1'
  path: string
  sha256: string
  provider: string
  endpoint: string
  by: string
  created: string
  input?: Record<string, unknown>
  seed?: number
  price?: unknown
  derived_from?: string[]
}
export interface InventoryAsset {
  path: string
  name: string
  folder: string
  ext: string
  kind: AssetKind
  size: number
  mtimeMs: number
  tracked: boolean
  lfs: boolean
  lfsOid?: string
  lfsSize?: number
  vendor: boolean
  tags: string[]
  generated: boolean
  meta?: AssetMeta
  provenance?: AssetProvenance
}
export interface InventoryInfo extends InventoryAsset {
  mediaUrl: string
  thumbnailUrl?: string
  /** Hashing is opt-in; never hash large assets during enumeration. */
  editedSinceGeneration?: boolean
}
export interface InventoryQuery {
  query?: string
  folder?: string
  recursive?: boolean
  kinds?: AssetKind[]
  tags?: string[]
  generated?: boolean
  scope?: 'ours' | 'vendor' | 'all'
  sort?: 'name' | 'type' | 'size' | 'modified'
  descending?: boolean
  offset?: number
  limit?: number
}
export interface InventoryFolder { path: string; name: string; count: number; vendor: boolean }
export interface InventoryState {
  world: string
  engine?: Engine
  engineRoot?: string
  revision: number
  total: number
  updatedAt?: string
  refreshing: boolean
  watching: boolean
  error?: string
  /** Present while a world's first scan streams in; `total` is 0 until enumeration finishes. */
  indexing?: { done: number; total: number }
  enumerationMs?: number
  scanMs?: number
}
export interface InventoryResult {
  state: InventoryState
  items: InventoryAsset[]
  total: number
  /** Immediate child folders, with recursive counts under the same filters. */
  folders: InventoryFolder[]
}
export const NATIVE_THUMB_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'])
export const THUMB_MAX_BYTES = 64 * 1024 * 1024
/**
 * How an asset gets its grid thumbnail: an image decoded by Chromium, or a model the 3D viewer draws.
 * Models over the preview cap still say 'model': they get the reason instead of a picture.
 */
export function thumbnailKind(a: Pick<InventoryAsset, 'ext' | 'size' | 'lfs'>): 'image' | 'model' | undefined {
  if (a.lfs) return
  if (NATIVE_THUMB_EXTS.has(a.ext)) return a.size <= THUMB_MAX_BYTES ? 'image' : undefined
  if ((MODEL_PREVIEW_EXTS as readonly string[]).includes(a.ext)) return 'model'
}
export function inventoryMediaUrl(host: 'world' | 'thumb', world: string, asset: string): string {
  return `genio-media://${host}/${[world, ...asset.split('/')].map(encodeURIComponent).join('/')}`
}
