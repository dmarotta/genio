/**
 * Truevision TGA to top-down RGBA: true colour, grey and colour-mapped, raw or RLE, 8/15/16/24/32 bits.
 * It runs inside the viewer's texture worker, which is built from this function's source, so it must
 * stay self-contained: no imports, no module-level names.
 */
export function decodeTga(buffer: ArrayBuffer): { width: number; height: number; data: Uint8ClampedArray } {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 18) throw new Error('Not a TGA image: the file is too short.')
  const u16 = (i: number): number => bytes[i] | bytes[i + 1] << 8
  const idLength = bytes[0], mapType = bytes[1], type = bytes[2]
  const mapFirst = u16(3), mapLength = u16(5), mapDepth = bytes[7]
  const width = u16(12), height = u16(14), depth = bytes[16], descriptor = bytes[17]
  const rle = type >= 9
  const kind = rle ? type - 8 : type
  if (![1, 2, 3].includes(kind) || !width || !height || width > 16384 || height > 16384) throw new Error(`Not a TGA image this viewer reads (type ${type}, ${width} x ${height}).`)
  if (kind === 1 && (mapType !== 1 || ![8, 16].includes(depth))) throw new Error('Unsupported colour-mapped TGA.')
  if (kind === 2 && ![15, 16, 24, 32].includes(depth) || kind === 3 && ![8, 16].includes(depth)) throw new Error(`Unsupported TGA pixel depth: ${depth} bits.`)
  let at = 18 + idLength
  // Colour map entries, decoded to RGBA once.
  const mapBytes = Math.ceil(mapDepth / 8)
  const palette = new Uint8Array(mapType === 1 ? mapLength * 4 : 0)
  const colour = (src: Uint8Array, i: number, bits: number, out: Uint8Array | Uint8ClampedArray, o: number): void => {
    if (bits === 24 || bits === 32) { out[o] = src[i + 2]; out[o + 1] = src[i + 1]; out[o + 2] = src[i]; out[o + 3] = bits === 32 ? src[i + 3] : 255 }
    else { const v = src[i] | src[i + 1] << 8; out[o] = (v >> 10 & 31) * 255 / 31; out[o + 1] = (v >> 5 & 31) * 255 / 31; out[o + 2] = (v & 31) * 255 / 31; out[o + 3] = 255 }
  }
  if (mapType === 1) {
    if (at + mapLength * mapBytes > bytes.length) throw new Error('The TGA colour map is cut short.')
    for (let i = 0; i < mapLength; i++) colour(bytes, at + i * mapBytes, mapDepth, palette, i * 4)
    at += mapLength * mapBytes
  }
  const size = Math.ceil(depth / 8), count = width * height
  // Pixels in file order, still as file-format bytes.
  let pixels: Uint8Array
  if (!rle) {
    if (at + count * size > bytes.length) throw new Error('The TGA image data is cut short.')
    pixels = bytes.subarray(at, at + count * size)
  } else {
    pixels = new Uint8Array(count * size)
    let n = 0
    while (n < count) {
      if (at >= bytes.length) throw new Error('The TGA image data is cut short.')
      const head = bytes[at++], run = (head & 127) + 1
      if (n + run > count) throw new Error('The TGA image data runs past the image.')
      if (head & 128) {
        if (at + size > bytes.length) throw new Error('The TGA image data is cut short.')
        for (let k = 0; k < run; k++) pixels.set(bytes.subarray(at, at + size), (n + k) * size)
        at += size
      } else {
        if (at + run * size > bytes.length) throw new Error('The TGA image data is cut short.')
        pixels.set(bytes.subarray(at, at + run * size), n * size)
        at += run * size
      }
      n += run
    }
  }
  const data = new Uint8ClampedArray(count * 4)
  const topDown = (descriptor & 0x20) !== 0, rightToLeft = (descriptor & 0x10) !== 0
  for (let y = 0; y < height; y++) {
    const row = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const col = rightToLeft ? width - 1 - x : x
      const i = (y * width + x) * size, o = (row * width + col) * 4
      if (kind === 2) colour(pixels, i, depth, data, o)
      else if (kind === 3) { data[o] = data[o + 1] = data[o + 2] = pixels[i]; data[o + 3] = depth === 16 ? pixels[i + 1] : 255 }
      else {
        const index = (size === 2 ? pixels[i] | pixels[i + 1] << 8 : pixels[i]) - mapFirst
        if (index >= 0 && index < mapLength) data.set(palette.subarray(index * 4, index * 4 + 4), o)
        else data[o + 3] = 255
      }
    }
  }
  return { width, height, data }
}
