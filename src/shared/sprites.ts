/** Sprite project and export formats. Pixel coordinates use a top-left origin. */
export interface SpriteSettings {
  animation: string
  count: number
  width: number
  height: number
  directions: 1 | 4 | 8
  playback: 'loop' | 'ping-pong'
  fps: number
  style: 'pixel' | 'hd'
  palette: string
  colors: number
  pixelScale: number
  method: 'grid' | 'frames' | 'video'
  pivot: { x: number; y: number }
  columns: number
  padding: number
}
export interface SpriteFrame { id: string; image: string; direction: number }
export interface SpriteProject {
  schema: 'genio.sprite-project.v1'
  id: string
  world: string | null
  name: string
  prompt: string
  source: string
  settings: SpriteSettings
  frames: SpriteFrame[]
  runIds: string[]
  generations: { prompt: string; created: string; sha256: string }[]
  updatedAt: string
}
export interface SpriteQuote {
  id: string
  usd: number
  calls: number
  reasons: string[]
  breakdown: { label: string; calls: number; usd: number }[]
}
export interface SpriteAsset { label: string; path: string }
export interface SpriteExport {
  project: SpriteProject
  sheet: string
  individual: boolean
  unity: boolean
  overwrite?: boolean
}
export interface SpriteExportResult { ok: boolean; exists?: boolean; paths: string[]; message: string }
export const DEFAULT_SPRITE_SETTINGS: SpriteSettings = {
  animation: 'idle', count: 8, width: 128, height: 128, directions: 1,
  playback: 'loop', fps: 10, style: 'pixel', palette: '', colors: 32, pixelScale: 1,
  method: 'grid', pivot: { x: 0.5, y: 1 }, columns: 8, padding: 0
}
export const SPRITE_PRESETS = ['idle', 'walk', 'run', 'attack', 'jump', 'hurt', 'death', 'custom']
export function directionLabel(index: number, count: number): string {
  return (count === 8 ? ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'] : count === 4 ? ['south', 'west', 'north', 'east'] : ['source direction'])[index] ?? 'source direction'
}
export interface Rect { x: number; y: number; w: number; h: number }
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export function checkImageSize(width: number, height: number): void {
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) || width * height > 32_000_000) throw new Error('Image exceeds the 32 megapixel limit.')
}
export function pixels(width: number, height: number): Pixels {
  checkImageSize(width, height)
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}
export function gridRects(width: number, height: number, count: number, columns: number): Rect[] {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(columns) || columns < 1 || width < columns || height < Math.ceil(count / columns)) throw new Error('Invalid sprite grid.')
  const rows = Math.ceil(count / columns)
  return Array.from({ length: count }, (_, i) => {
    const col = i % columns, row = Math.floor(i / columns)
    const x = Math.floor(col * width / columns), y = Math.floor(row * height / rows)
    return { x, y, w: Math.floor((col + 1) * width / columns) - x, h: Math.floor((row + 1) * height / rows) - y }
  })
}
export function blit(src: Pixels, dst: Pixels, rect: Rect, x: number, y: number): void {
  const skip = Math.max(0, -x), dx = Math.max(0, x), length = Math.min(rect.w - skip, dst.width - dx)
  if (length <= 0) return
  for (let sy = Math.max(0, -y); sy < Math.min(rect.h, dst.height - y); sy++) {
    const from = ((rect.y + sy) * src.width + rect.x + skip) * 4
    dst.data.set(src.data.subarray(from, from + length * 4), ((y + sy) * dst.width + dx) * 4)
  }
}
export function sliceGrid(src: Pixels, count: number, columns: number): Pixels[] {
  return gridRects(src.width, src.height, count, columns).map(r => {
    const out = pixels(r.w, r.h); blit(src, out, r, 0, 0); return out
  })
}
export function opaqueBounds(src: Pixels): Rect | null {
  let left = src.width, top = src.height, right = -1, bottom = -1
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    if (src.data[(y * src.width + x) * 4 + 3] > 0) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  return right < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}
/** Trim transparent margins, translate bottom-centre to the common pivot, never silently clip. */
export function alignFrame(src: Pixels, width: number, height: number, pivot: SpriteSettings['pivot']): Pixels {
  const out = pixels(width, height), b = opaqueBounds(src)
  if (!b) return out
  const x = Math.round(width * pivot.x - b.w / 2), y = Math.round(height * pivot.y - b.h)
  if (x < 0 || y < 0 || x + b.w > width || y + b.h > height) throw new Error('Opaque pixels would be clipped. Increase the cell size or move the pivot.')
  blit(src, out, b, x, y); return out
}
export function hasTransparency(src: Pixels): boolean {
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] < 255) return true
  return false
}
export function playbackIndex(tick: number, count: number, mode: SpriteSettings['playback']): number {
  if (count <= 1) return 0
  const t = tick % (mode === 'ping-pong' ? 2 * count - 2 : count)
  return t < count ? t : 2 * count - 2 - t
}
export function sheetMetadata(project: SpriteProject, unity = false) {
  const s = project.settings, count = project.frames.length
  if (!count) throw new Error('Add frames before exporting.')
  const columns = Math.min(s.columns, count), rows = Math.ceil(count / columns)
  const width = columns * s.width + (columns - 1) * s.padding
  const height = rows * s.height + (rows - 1) * s.padding
  if (width * height > 32_000_000 || width > 16384 || height > 16384) throw new Error('Sheet exceeds the 32 megapixel limit. Reduce cell size or export fewer frames.')
  return {
    schema: 'genio.sprite-sheet.v1', name: project.name, image: `${project.name}.png`,
    width, height, columns, rows, padding: s.padding, cell: { width: s.width, height: s.height },
    fps: s.fps, loop: true, playback: s.playback, pivot: s.pivot, origin: 'top-left',
    frames: project.frames.map((f, i) => ({
      id: f.id, direction: directionLabel(f.direction, s.directions),
      rect: { x: (i % columns) * (s.width + s.padding), y: Math.floor(i / columns) * (s.height + s.padding), w: s.width, h: s.height },
      duration: 1000 / s.fps, pivot: s.pivot
    })),
    ...(unity ? { unity: { origin: 'bottom-left', pixelsPerUnit: s.height, sprites: project.frames.map((f, i) => ({
      name: `${project.name}_${directionLabel(f.direction, s.directions)}_${i}`,
      rect: { x: (i % columns) * (s.width + s.padding), y: height - Math.floor(i / columns) * (s.height + s.padding) - s.height, width: s.width, height: s.height },
      pivot: { x: s.pivot.x, y: 1 - s.pivot.y }
    })) } } : {})
  }
}
export function packSheet(frames: Pixels[], project: SpriteProject): Pixels {
  if (frames.length !== project.frames.length) throw new Error('Frame count mismatch.')
  const meta = sheetMetadata(project), out = pixels(meta.width, meta.height)
  frames.forEach((f, i) => {
    if (f.width !== project.settings.width || f.height !== project.settings.height) throw new Error('Normalize frames to the cell size first.')
    const r = meta.frames[i].rect; blit(f, out, { x: 0, y: 0, w: f.width, h: f.height }, r.x, r.y)
  })
  return out
}
