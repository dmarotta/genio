import { MAX_IMAGE_BYTES, planImage, shrinkStep, type ChatImageType } from '@shared/chat-images'
import type { DraftImage } from '../drafts'

const MAX_TRIES = 6

let seq = 0

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = (): void => resolve(String(r.result))
    r.onerror = (): void => reject(r.error ?? new Error('could not read the image'))
    r.readAsDataURL(blob)
  })
}

async function encode(bmp: ImageBitmap, width: number, height: number, type: ChatImageType, quality?: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('no 2D canvas')
  if (type === 'image/jpeg') {
    // JPEG has no alpha: flatten transparent pixels onto white rather than black
    g.fillStyle = '#fff'
    g.fillRect(0, 0, width, height)
  }
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  if (!blob) throw new Error('could not encode the image')
  return blob
}

/**
 * A pasted/dropped image ready to attach: PNG/JPEG/GIF/WebP sent as-is when
 * small enough, otherwise downscaled (long edge ≤ 2000px) and re-encoded,
 * falling back to smaller JPEGs until it fits the per-image byte cap.
 */
export async function toDraftImage(file: Blob): Promise<DraftImage> {
  if (!file.type.startsWith('image/')) throw new Error('Only images can be attached.')
  const bmp = await createImageBitmap(file)
  try {
    const plan = planImage(file.type, file.size, bmp.width, bmp.height)
    let blob: Blob = file
    let type = plan.outType
    let { width, height } = plan
    if (plan.reencode) {
      blob = await encode(bmp, width, height, type, 0.92)
      for (let i = 0; blob.size > MAX_IMAGE_BYTES && i < MAX_TRIES; i++) {
        if (type === 'image/jpeg') ({ width, height } = shrinkStep(width, height))
        type = 'image/jpeg'
        blob = await encode(bmp, width, height, type, 0.85)
      }
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is too large to send.')
    } else type = file.type as ChatImageType
    const preview = await dataUrl(blob)
    const data = preview.slice(preview.indexOf(',') + 1)
    return { id: `img-${Date.now()}-${seq++}`, mediaType: type, data, width, height, preview: `data:${type};base64,${data}` }
  } finally {
    bmp.close()
  }
}
