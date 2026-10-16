/**
 * Textures for every format but glTF, decoded and downscaled off the UI thread: the frame fetches each
 * image, a worker decodes it (TGA in JavaScript, other types with createImageBitmap), shrinks it to the
 * preview limit, flips it for WebGL and hands back an ImageBitmap. A 4K TGA decoded on the UI thread
 * froze the Recon's prototype for over 90 s.
 */
import * as THREE from 'three'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'
import { decodeTga } from './tga'
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'

interface Decoded { bitmap: ImageBitmap; width: number; height: number }

/** Size in the file of bitmaps the decoder shrank. */
export const originalSizes = new WeakMap<ImageBitmap, { width: number; height: number }>()
/** Bitmaps stored bottom-up for WebGL; previews turn them back. */
export const flippedBitmaps = new WeakSet<ImageBitmap>()
/** Includes failed images, so progress counts completed work rather than only successful decodes. */
export const settledSources = new WeakSet<THREE.Texture['source']>()

/**
 * Decode, shrink and flip one image. Runs in the worker, which is built from this source (an opaque-origin
 * frame can start only blob: workers), so it uses nothing from the module around it.
 */
async function decodeImage(bytes: ArrayBuffer, max: number, flip: boolean, readTga: typeof decodeTga): Promise<Decoded> {
  const b = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength))
  const at = (i: number, ...v: number[]): boolean => v.every((x, k) => b[i + k] === x)
  // PNG, JPEG, GIF, BMP, WebP and AVIF/HEIF by signature; anything else is read as TGA, which has none.
  const browser = at(0, 0x89, 0x50, 0x4e, 0x47) || at(0, 0xff, 0xd8) || at(0, 0x47, 0x49, 0x46) || at(0, 0x42, 0x4d) || at(8, 0x57, 0x45, 0x42, 0x50) || at(4, 0x66, 0x74, 0x79, 0x70)
  const plain: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }
  let source: ImageBitmap | ImageData
  if (browser) source = await createImageBitmap(new Blob([bytes]), plain)
  else { const tga = readTga(bytes); source = new ImageData(tga.data as Uint8ClampedArray<ArrayBuffer>, tga.width, tga.height) }
  const width = source.width, height = source.height
  const k = Math.min(1, max / Math.max(width, height))
  if (k === 1 && !flip && source instanceof ImageBitmap) return { bitmap: source, width, height }
  const bitmap = await createImageBitmap(source, {
    ...plain, imageOrientation: flip ? 'flipY' : 'from-image',
    ...k < 1 ? { resizeWidth: Math.max(1, Math.round(width * k)), resizeHeight: Math.max(1, Math.round(height * k)), resizeQuality: 'high' } : {}
  })
  if (source instanceof ImageBitmap) source.close()
  return { bitmap, width, height }
}

function workerMain(decode: typeof decodeImage, readTga: typeof decodeTga): void {
  self.onmessage = async (event: MessageEvent<{ id: number; bytes: ArrayBuffer; max: number; flip: boolean }>) => {
    const { id, bytes, max, flip } = event.data
    try {
      const done = await decode(bytes, max, flip, readTga)
      postMessage({ id, ...done }, { transfer: [done.bitmap] })
    } catch (e) { postMessage({ id, error: e instanceof Error ? e.message : String(e) }) }
  }
}

/** One cancellable worker per load; serial fetch/decode bounds peak image memory. */
export class TextureDecoder {
  private worker?: Worker | null
  private next = 0
  private readonly waiting = new Map<number, { resolve(d: Decoded): void; reject(e: Error): void }>()
  private readonly controller = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly gate: Promise<void>
  private release!: () => void
  constructor(private readonly max: number, deferred = false) {
    this.gate = new Promise(resolve => { this.release = resolve })
    if (!deferred) this.resume()
  }
  /** Geometry is submitted before any texture fetch/decode starts. */
  resume(): void { this.release() }
  async geometryReady(): Promise<void> { await this.gate; this.controller.signal.throwIfAborted() }

  private start(): Worker | null {
    if (this.worker !== undefined) return this.worker
    try {
      const source = URL.createObjectURL(new Blob([`(${workerMain})(${decodeImage}, ${decodeTga})`], { type: 'text/javascript' }))
      this.worker = new Worker(source)
      URL.revokeObjectURL(source)
    } catch { return this.worker = null }
    this.worker.onmessage = (event: MessageEvent<Decoded & { id: number; error?: string }>) => {
      const { id, error, ...done } = event.data
      const w = this.waiting.get(id)
      this.waiting.delete(id)
      if (error !== undefined) w?.reject(new Error(error)); else if (w) w.resolve(done); else done.bitmap.close()
    }
    this.worker.onerror = () => { this.worker?.terminate(); this.worker = null; this.fail(new Error('The texture decoder stopped.')) }
    return this.worker
  }

  /** Fetch, decode, shrink and (by default) flip one image for WebGL. */
  async decode(url: string, flip = true): Promise<Decoded> {
    const job = this.tail.then(async () => {
      await this.gate
      this.controller.signal.throwIfAborted()
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)])
      return this.decodeNow(url, flip, signal)
    })
    this.tail = job.catch(() => undefined)
    return job
  }

  private async decodeNow(url: string, flip: boolean, signal: AbortSignal): Promise<Decoded> {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = await response.arrayBuffer()
    signal.throwIfAborted()
    const worker = this.start()
    // Native browser image decoders remain asynchronous; never run the JS TGA decoder on the UI thread.
    if (!worker) throw new Error('The off-thread texture decoder is unavailable.')
    const id = ++this.next
    const done = await new Promise<Decoded>((resolve, reject) => {
      const abort = (): void => {
        this.waiting.delete(id)
        // A synchronous TGA decoder can only be cancelled by terminating its worker.
        worker.terminate(); if (this.worker === worker) this.worker = undefined
        reject(new Error('Texture loading was cancelled or exceeded 8 s.'))
      }
      signal.addEventListener('abort', abort, { once: true })
      this.waiting.set(id, {
        resolve: d => { signal.removeEventListener('abort', abort); resolve(d) },
        reject: e => { signal.removeEventListener('abort', abort); reject(e) }
      })
      worker.postMessage({ id, bytes, max: this.max, flip }, [bytes])
    })
    if (this.controller.signal.aborted) { done.bitmap.close(); this.controller.signal.throwIfAborted() }
    return this.mark(done, flip)
  }

  private fail(e: Error): void {
    for (const w of this.waiting.values()) w.reject(e)
    this.waiting.clear()
  }

  private mark(d: Decoded, flip: boolean): Decoded {
    if (Math.max(d.width, d.height) > this.max) originalSizes.set(d.bitmap, { width: d.width, height: d.height })
    if (flip) flippedBitmaps.add(d.bitmap)
    return d
  }

  dispose(): void {
    this.controller.abort(); this.resume()
    this.worker?.terminate()
    this.worker = undefined
    this.fail(new Error('The viewer was closed.'))
  }
}

/** glTF keeps its sampler/UV/extension handling; ordinary images arrive after the geometry, sharing
 * their Source with any texture-transform clones. Compressed KTX2 uses three's own worker decoder. */
export function progressiveGltfTextures(parser: GLTFParser, decoder: TextureDecoder, made: Set<THREE.Texture>): void {
  const original = parser.loadImageSource.bind(parser)
  const sources = new Map<number, THREE.Texture>()
  parser.loadImageSource = (index, loader) => {
    if (loader !== parser.textureLoader) return original(index, loader)
    const cached = sources.get(index)
    if (cached) { const clone = cached.clone(); made.add(clone); return Promise.resolve(clone) }
    const texture = new THREE.Texture()
    texture.flipY = false
    texture.needsUpdate = true
    made.add(texture); sources.set(index, texture)
    const image = parser.json.images[index] as { uri?: string; bufferView?: number; mimeType?: string }
    const manager = parser.options.manager
    const name = image.uri ?? `embedded image ${index + 1}`
    texture.userData.file = fileName(name)
    manager.itemStart(name)
    void (async () => {
      let blob: string | undefined
      try {
        await decoder.geometryReady()
        const url = image.bufferView !== undefined
          ? (blob = URL.createObjectURL(new Blob([await parser.getDependency('bufferView', image.bufferView)], { type: image.mimeType })))
          : manager.resolveURL(THREE.LoaderUtils.resolveURL(image.uri ?? '', parser.options.path))
        const decoded = await decoder.decode(url, false)
        texture.image = decoded.bitmap; texture.needsUpdate = true
      } catch { manager.itemError(name) } finally {
        if (blob) URL.revokeObjectURL(blob)
        settledSources.add(texture.source)
        manager.itemEnd(name)
      }
    })()
    return Promise.resolve(texture)
  }
}

const fileName = (url: string): string => {
  if (url.startsWith('blob:') || url.startsWith('data:')) return ''
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') } catch { return url.split(/[\\/]/).pop() ?? '' }
}

/**
 * Stands in for TextureLoader and TGALoader: returns the texture at once and fills it from the decoder,
 * reporting to the LoadingManager like three's loaders do, so missing files are counted the same way.
 */
export class DecodedTextureLoader extends THREE.Loader<THREE.Texture> {
  constructor(manager: THREE.LoadingManager, private readonly decoder: TextureDecoder, private readonly made: Set<THREE.Texture>) { super(manager) }

  override load(url: string, onLoad?: (t: THREE.Texture) => void, _onProgress?: unknown, onError?: (e: unknown) => void): THREE.Texture {
    const full = this.manager.resolveURL(this.path ? this.path + url : url)
    const texture = new THREE.Texture()
    texture.userData.file = fileName(full)
    this.made.add(texture)
    this.manager.itemStart(full)
    void this.decoder.decode(full).then(d => {
      texture.image = d.bitmap
      // The worker already flipped it; WebGL ignores UNPACK_FLIP_Y for ImageBitmap.
      texture.flipY = false
      texture.needsUpdate = true
      try { onLoad?.(texture) } finally { settledSources.add(texture.source); this.manager.itemEnd(full) }
    }, (e: unknown) => {
      try { onError?.(e) } finally { settledSources.add(texture.source); this.manager.itemError(full); this.manager.itemEnd(full) }
    })
    return texture
  }
}

type Loadable = { load: unknown }
/**
 * Runs a synchronous parse with every texture it asks for decoded off-thread: ColladaLoader and
 * TDSLoader make their own TextureLoader/TGALoader, so those two loaders load through ours meanwhile.
 * Blob URLs the parser makes (FBX embedded images) are returned for revoking once textures settle.
 */
export function withDecodedTextures<T>(decoder: TextureDecoder, made: Set<THREE.Texture>, parse: () => T): { value: T; blobs: string[] } {
  const prototypes = [THREE.TextureLoader.prototype, TGALoader.prototype] as unknown as Loadable[]
  const saved = prototypes.map(p => [Object.prototype.hasOwnProperty.call(p, 'load'), p.load] as const)
  const blobs: string[] = []
  const createObjectURL = URL.createObjectURL
  URL.createObjectURL = (obj: Blob | MediaSource): string => { const u = createObjectURL(obj); blobs.push(u); return u }
  const load = function (this: THREE.Loader, url: string, onLoad?: (t: THREE.Texture) => void, onProgress?: unknown, onError?: (e: unknown) => void): THREE.Texture {
    return new DecodedTextureLoader(this.manager, decoder, made).setPath(this.path).load(url, onLoad, onProgress, onError)
  }
  for (const p of prototypes) p.load = load
  try { return { value: parse(), blobs } } finally {
    URL.createObjectURL = createObjectURL
    prototypes.forEach((p, i) => { if (saved[i][0]) p.load = saved[i][1]; else delete (p as Partial<Loadable>).load })
  }
}

/**
 * Every remaining image texture becomes a bitmap of at most `max` px before its first upload. glTF
 * bitmaps are only shrunk; an <img> (USDLoader makes them without CORS, which WebGL refuses in this
 * opaque-origin frame) is fetched again and decoded by the decoder; others go through createImageBitmap.
 * Images are flipped here because WebGL ignores UNPACK_FLIP_Y for bitmaps. Returns file sizes of what
 * was shrunk, and names of images that could not be decoded (their textures are left empty).
 */
export async function prepareTextures(textures: THREE.Texture[], max: number, decoder: TextureDecoder): Promise<{ originals: Map<THREE.Texture['source'], { width: number; height: number }>; failed: string[] }> {
  const originals = new Map<THREE.Texture['source'], { width: number; height: number }>()
  const failed: string[] = []
  const done = new Set<THREE.Texture['source']>()
  for (const t of textures) {
    if ((t as THREE.CompressedTexture).isCompressedTexture || (t as THREE.DataTexture).isDataTexture || done.has(t.source)) continue
    done.add(t.source)
    const image = t.image as ImageBitmap | HTMLImageElement | HTMLCanvasElement | undefined
    const w = image?.width ?? 0, h = image?.height ?? 0
    if (!image || !w || !h) continue
    if (image instanceof ImageBitmap && originalSizes.has(image)) { originals.set(t.source, originalSizes.get(image)!); continue }
    if (image instanceof HTMLImageElement && image.src) {
      try {
        const d = await decoder.decode(image.src, t.flipY)
        t.image = d.bitmap
        t.flipY = false
        if (originalSizes.has(d.bitmap)) originals.set(t.source, originalSizes.get(d.bitmap)!)
      } catch {
        t.image = null
        failed.push(fileName(image.src) || 'embedded image')
      }
      t.needsUpdate = true
      continue
    }
    const flip = t.flipY && !(image instanceof ImageBitmap)
    const k = Math.min(1, max / Math.max(w, h))
    if (k === 1 && image instanceof ImageBitmap) continue
    const bitmap = await createImageBitmap(image, {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: flip ? 'flipY' : 'from-image',
      ...k < 1 ? { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' } : {}
    })
    if (image instanceof ImageBitmap) image.close()
    if (flip) { flippedBitmaps.add(bitmap); t.flipY = false }
    t.image = bitmap
    t.needsUpdate = true
    if (k < 1) originals.set(t.source, { width: w, height: h })
  }
  return { originals, failed }
}

/** Whether a texture holds pixels (a failed or undecodable file leaves it empty). */
export function hasImage(t: THREE.Texture): boolean {
  const image = t.image as { width?: number; data?: unknown } | null | undefined
  return !!image && (!!image.width || !!image.data) || !!(t as THREE.CompressedTexture).mipmaps?.length
}
