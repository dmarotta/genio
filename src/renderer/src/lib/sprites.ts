import { alignFrame, checkImageSize, sliceGrid, type Pixels, type SpriteSettings } from '@shared/sprites'

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  checkImageSize(width, height)
  const c = document.createElement('canvas'); c.width = width; c.height = height
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas is unavailable.')
  return [c, ctx]
}
export async function decodeImage(uri: string): Promise<Pixels> {
  const image = new Image(); image.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not read the image.')); image.src = uri })
  const [, ctx] = canvas(image.naturalWidth, image.naturalHeight)
  ctx.drawImage(image, 0, 0)
  return { width: image.naturalWidth, height: image.naturalHeight, data: ctx.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data }
}
export function encodeImage(p: Pixels): string {
  const [c, ctx] = canvas(p.width, p.height)
  ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0)
  return c.toDataURL('image/png')
}
export function fitFrame(src: Pixels, s: SpriteSettings): Pixels {
  const [source, sc] = canvas(src.width, src.height)
  sc.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0)
  const [, ctx] = canvas(s.width, s.height)
  ctx.imageSmoothingEnabled = s.style !== 'pixel'
  const scale = Math.min(s.width / src.width, s.height / src.height)
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale))
  ctx.drawImage(source, 0, 0, w, h)
  return alignFrame({ width: s.width, height: s.height, data: ctx.getImageData(0, 0, s.width, s.height).data }, s.width, s.height, s.pivot)
}
export async function generatedFrames(uri: string, s: SpriteSettings, grid: boolean): Promise<string[]> {
  const src = await decodeImage(uri)
  return (grid ? sliceGrid(src, s.count, Math.ceil(Math.sqrt(s.count))) : [src]).map(f => encodeImage(fitFrame(f, s)))
}
export async function videoReference(uri: string): Promise<string> {
  const src = await decodeImage(uri), [image, ic] = canvas(src.width, src.height), [out, ctx] = canvas(1280, 720)
  ic.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0)
  ctx.fillStyle = '#e8e8e8'; ctx.fillRect(0, 0, 1280, 720)
  const scale = Math.min(1100 / src.width, 620 / src.height), w = src.width * scale, h = src.height * scale
  ctx.drawImage(image, (1280 - w) / 2, 720 - h - 40, w, h)
  return out.toDataURL('image/png')
}
export async function sampleVideo(url: string, count: number): Promise<string[]> {
  const video = document.createElement('video'); video.crossOrigin = 'anonymous'; video.muted = true; video.preload = 'auto'
  const event = (name: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Video decoding timed out. No further paid steps were submitted.')), 30_000)
    const ready = () => finish(), failed = () => finish(new Error('This video could not be decoded.'))
    function finish(error?: Error) { clearTimeout(timer); video.removeEventListener(name, ready); video.removeEventListener('error', failed); error ? reject(error) : resolve() }
    video.addEventListener(name, ready, { once: true }); video.addEventListener('error', failed, { once: true })
  })
  try {
    const loaded = event('loadeddata'); video.src = url; await loaded
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('Video has no finite duration.')
    const [c, ctx] = canvas(video.videoWidth, video.videoHeight), frames: string[] = []
    for (let i = 0; i < count; i++) {
      const time = Math.min(video.duration - 0.01, i * video.duration / count + 0.001)
      const sought = event('seeked'); video.currentTime = time; await sought
      ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(video, 0, 0)
      frames.push(c.toDataURL('image/png'))
    }
    return frames
  } finally { video.removeAttribute('src'); video.load() }
}
