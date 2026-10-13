import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPRITE_SETTINGS, alignFrame, gridRects, hasTransparency, opaqueBounds, packSheet, pixels, playbackIndex, sheetMetadata, sliceGrid,
  type Pixels, type SpriteProject
} from '../src/shared/sprites'

export function project(): SpriteProject {
  return { schema: 'genio.sprite-project.v1', id: 'test-project', world: 'garden', name: 'fox', prompt: 'A fox', source: '',
    settings: { ...DEFAULT_SPRITE_SETTINGS, width: 8, height: 8, pivot: { x: .5, y: 1 } }, frames: [], runIds: [], generations: [], updatedAt: '' }
}
function dot(p: Pixels, x: number, y: number, color = 200): void { p.data.set([color, 20, 30, 255], (y * p.width + x) * 4) }
describe('sprite image operations', () => {
  it('slices a row-major grid, including uneven dimensions and an incomplete last row', () => {
    const src = pixels(7, 5)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) dot(src, x, y, y * 7 + x)
    expect(gridRects(7, 5, 5, 3)).toEqual([
      { x: 0, y: 0, w: 2, h: 2 }, { x: 2, y: 0, w: 2, h: 2 }, { x: 4, y: 0, w: 3, h: 2 },
      { x: 0, y: 2, w: 2, h: 3 }, { x: 2, y: 2, w: 2, h: 3 }
    ])
    const sliced = sliceGrid(src, 5, 3)
    expect(sliced[4].data[0]).toBe(16)
    expect(sliced[2].data.at(-4)).toBe(13)
    expect(() => sliceGrid(src, 0, 3)).toThrow()
  })
  it('aligns differently offset opaque bounds to the same bottom-centre anchor', () => {
    const a = pixels(8, 8), b = pixels(8, 8)
    dot(a, 1, 1); dot(a, 2, 2); dot(b, 5, 4); dot(b, 6, 5)
    expect(opaqueBounds(a)).toEqual({ x: 1, y: 1, w: 2, h: 2 })
    const alignedA = alignFrame(a, 8, 8, { x: .5, y: 1 }), alignedB = alignFrame(b, 8, 8, { x: .5, y: 1 })
    expect(alignedA).toEqual(alignedB)
    expect(opaqueBounds(alignedA)).toEqual({ x: 3, y: 6, w: 2, h: 2 })
    expect(hasTransparency(alignedA)).toBe(true)
  })
  it('honours an edited pivot, pads blank frames, and refuses clipping', () => {
    const a = pixels(8, 8); dot(a, 2, 2); dot(a, 3, 3)
    expect(opaqueBounds(alignFrame(a, 16, 16, { x: .25, y: .5 }))).toEqual({ x: 3, y: 6, w: 2, h: 2 })
    expect(opaqueBounds(alignFrame(pixels(8, 8), 16, 16, { x: 0, y: 0 }))).toBeNull()
    expect(() => alignFrame(a, 8, 8, { x: 0, y: 0 })).toThrow(/clipped/)
  })
  it('identifies fully opaque backgrounds', () => {
    const a = pixels(8, 8); a.data.fill(255)
    expect(hasTransparency(a)).toBe(false)
    a.data[3] = 200; expect(hasTransparency(a)).toBe(true)
  })
  it('packs pixels with transparent gutters and exact frame rects and durations', () => {
    const p = project(); p.settings.columns = 2; p.settings.padding = 2; p.settings.fps = 8
    p.frames = Array.from({ length: 3 }, (_, i) => ({ id: `f-${i}`, image: '', direction: 0 }))
    const frames = p.frames.map((_, i) => { const f = pixels(8, 8); dot(f, 0, 0, i + 1); return f })
    const sheet = packSheet(frames, p), meta = sheetMetadata(p)
    expect([sheet.width, sheet.height]).toEqual([18, 18])
    expect(sheet.data[10 * 4]).toBe(2)
    expect(sheet.data[10 * 18 * 4]).toBe(3)
    expect(sheet.data[8 * 4 + 3]).toBe(0)
    expect(meta.frames[2].rect).toEqual({ x: 0, y: 10, w: 8, h: 8 })
    expect(meta.frames[2].duration).toBe(125)
    expect(meta.pivot).toEqual({ x: .5, y: 1 })
    expect(() => packSheet([pixels(9, 8), ...frames.slice(1)], p)).toThrow(/Normalize/)
  })
  it('exports Unity bottom-left rectangles and pivot without changing general metadata', () => {
    const p = project(); p.settings.columns = 1; p.settings.padding = 1; p.settings.pivot.y = .75
    p.frames = [{ id: 'a', image: '', direction: 0 }, { id: 'b', image: '', direction: 0 }]
    const meta = sheetMetadata(p, true)
    expect(meta.unity?.sprites.map(s => s.rect.y)).toEqual([9, 0])
    expect(meta.unity?.sprites[0].pivot.y).toBe(.25)
    expect(meta.frames.map(f => f.rect.y)).toEqual([0, 9])
    expect(sheetMetadata(p).unity).toBeUndefined()
  })
  it('plays loop and ping-pong without repeating the endpoints', () => {
    expect(Array.from({ length: 8 }, (_, i) => playbackIndex(i, 3, 'ping-pong'))).toEqual([0, 1, 2, 1, 0, 1, 2, 1])
    expect(Array.from({ length: 5 }, (_, i) => playbackIndex(i, 3, 'loop'))).toEqual([0, 1, 2, 0, 1])
    expect(playbackIndex(17, 1, 'ping-pong')).toBe(0)
  })
  it('rejects oversized sheets and empty exports', () => {
    const p = project(); expect(() => sheetMetadata(p)).toThrow(/Add frames/)
    p.frames = Array.from({ length: 128 }, (_, i) => ({ id: String(i), image: '', direction: 0 }))
    p.settings.width = p.settings.height = 1024
    expect(() => sheetMetadata(p)).toThrow(/limit/)
  })
})
