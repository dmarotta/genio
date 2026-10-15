/**
 * Small generated model fixtures for formats Blender no longer writes: TGA images (raw or RLE, either
 * row order) and a textured 3DS crate. `node tests/helpers/model-fixtures.ts` rewrites the committed
 * copies in tests/fixtures/models.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Rgba = [number, number, number, number]

/** A 24- or 32-bit true-colour TGA; `pixel` is asked in top-down image order. */
export function tga(width: number, height: number, pixel: (x: number, y: number) => Rgba, opts: { rle?: boolean; topDown?: boolean; bits?: 24 | 32 } = {}): Uint8Array {
  const bits = opts.bits ?? 24, size = bits / 8
  const header = new Uint8Array(18)
  header[2] = opts.rle ? 10 : 2
  header[12] = width & 255; header[13] = width >> 8; header[14] = height & 255; header[15] = height >> 8
  header[16] = bits
  header[17] = (opts.topDown ? 0x20 : 0) | (bits === 32 ? 8 : 0)
  const pixels: number[][] = []
  for (let row = 0; row < height; row++) {
    const y = opts.topDown ? row : height - 1 - row
    for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); pixels.push(bits === 32 ? [b, g, r, a] : [b, g, r]) }
  }
  const body: number[] = []
  if (!opts.rle) for (const p of pixels) body.push(...p)
  else {
    const same = (a: number[], b: number[]): boolean => a.every((v, i) => v === b[i])
    for (let i = 0; i < pixels.length;) {
      let run = 1
      while (i + run < pixels.length && run < 128 && same(pixels[i], pixels[i + run])) run++
      if (run > 1) { body.push(128 | run - 1, ...pixels[i]); i += run; continue }
      let raw = 1
      while (i + raw < pixels.length && raw < 128 && !(i + raw + 1 < pixels.length && same(pixels[i + raw], pixels[i + raw + 1]))) raw++
      body.push(raw - 1)
      for (let k = 0; k < raw; k++) body.push(...pixels[i + k])
      i += raw
    }
  }
  const out = new Uint8Array(18 + body.length)
  out.set(header); out.set(body, 18)
  return out
}

/** The crate texture: an 8 px cyan grid on dark blue. */
export const crateGrid = (x: number, y: number): Rgba => x % 8 === 0 || y % 8 === 0 ? [0, 229, 255, 255] : [16, 32, 64, 255]

function chunk(id: number, ...parts: Uint8Array[]): Uint8Array {
  const length = 6 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(length)
  const view = new DataView(out.buffer)
  view.setUint16(0, id, true); view.setUint32(2, length, true)
  let at = 6
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const cstring = (s: string): Uint8Array => new Uint8Array([...new TextEncoder().encode(s), 0])
const u16 = (...v: number[]): Uint8Array => new Uint8Array(new Uint16Array(v).buffer)
const u32 = (v: number): Uint8Array => new Uint8Array(new Uint32Array([v]).buffer)
const f32 = (...v: number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer)

/** A 1 m crate (Z-up, as 3ds Max writes it) whose material maps `texture`. */
export function crate3ds(texture = 'crate_grid.tga'): Uint8Array {
  // Four vertices per face so each face has its own UVs.
  const faces = [
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]]
  ]
  const points = faces.flat().flatMap(([x, y, z]) => [x - 0.5, y - 0.5, z])
  const uvs = faces.flatMap(() => [0, 0, 1, 0, 1, 1, 0, 1])
  const tris = faces.flatMap((_, f) => [f * 4, f * 4 + 1, f * 4 + 2, 0, f * 4, f * 4 + 2, f * 4 + 3, 0])
  const material = chunk(0xafff,
    chunk(0xa000, cstring('CrateMat')),
    chunk(0xa020, chunk(0x0011, new Uint8Array([200, 200, 200]))),
    chunk(0xa200, chunk(0xa300, cstring(texture))))
  const mesh = chunk(0x4100,
    chunk(0x4110, u16(points.length / 3), f32(...points)),
    chunk(0x4140, u16(uvs.length / 2), f32(...uvs)),
    chunk(0x4120, u16(tris.length / 4), u16(...tris), chunk(0x4130, cstring('CrateMat'), u16(tris.length / 4), u16(...tris.filter((_, i) => i % 4 === 0).map((_, i) => i)))),
    chunk(0x4160, f32(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)))
  return chunk(0x4d4d, chunk(0x0002, u32(3)), chunk(0x3d3d, chunk(0x3d3e, u32(3)), material, chunk(0x0100, f32(1)), chunk(0x4000, cstring('Crate'), mesh)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = fileURLToPath(new URL('../fixtures/models/', import.meta.url))
  fs.writeFileSync(path.join(dir, 'Textures', 'crate_grid.tga'), tga(32, 32, crateGrid, { rle: true }))
  fs.writeFileSync(path.join(dir, 'crate.3ds'), crate3ds())
}
