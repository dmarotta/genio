import zlib from 'node:zlib'
import { DEFAULT_SPRITE_SETTINGS, type SpriteProject } from '../src/shared/sprites'
/** Small valid PNG fixture, including CRCs, without browser/native image dependencies. */
export function png(width = 8, height = 8): string {
  const crc = (data: Buffer) => {
    let c = 0xffffffff
    for (const byte of data) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), len = Buffer.alloc(4), check = Buffer.alloc(4)
    len.writeUInt32BE(data.length); check.writeUInt32BE(crc(Buffer.concat([type, data])))
    return Buffer.concat([len, type, data, check])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}
export function fixture(): SpriteProject {
  return { schema: 'genio.sprite-project.v1', id: 'test-project', world: 'garden', name: 'fox', prompt: 'A fox', source: png(),
    settings: { ...DEFAULT_SPRITE_SETTINGS, count: 2, width: 8, height: 8, pivot: { x: .5, y: 1 } },
    frames: [{ id: 'first', image: png(), direction: 0 }], runIds: [], generations: [], updatedAt: '' }
}
