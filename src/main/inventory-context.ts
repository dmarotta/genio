import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MAX_IMAGES_PER_MESSAGE, type ChatImageInput } from '@shared/chat-images'
import { validateInventoryContext, type InventoryContext, type InventoryContextReceipt } from '@shared/inventory-context'
import type { ChatMessage } from '@shared/types'

/** Only already-delivered thumbnails may be reused: cancelling a queued message must not lose an image. */
export function previousThumbnail(history: readonly ChatMessage[], digest: string): InventoryContextReceipt['thumbnail'] {
  return [...history].reverse().find(m => !m.queue && m.context?.thumbnail?.digest === digest && m.context.thumbnail.image)?.context?.thumbnail
}

export async function prepareInventoryContext(input: InventoryContext | undefined, images: readonly ChatImageInput[],
  thumbnail: (world: string, asset: string) => Promise<string | undefined>, history: () => readonly ChatMessage[]
): Promise<{ context?: InventoryContextReceipt; images: ChatImageInput[] }> {
  if (!input) return { images: [...images] }
  const context: InventoryContextReceipt = validateInventoryContext(input)
  // A model's thumbnail is the 3D viewer's drawing of it, so Genio can see the selected model too.
  if (context.preview?.kind !== 'image' && context.preview?.kind !== 'model') return { context, images: [...images] }
  try {
    const file = await thumbnail(context.world, context.preview.path)
    const bytes = file ? await readFile(file) : undefined
    if (!bytes?.length || bytes.length > 1024 * 1024) throw new Error('Thumbnail unavailable')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const previous = previousThumbnail(history(), digest)
    if (previous) {
      context.thumbnail = { status: 'reused', digest, image: previous.image }
      return { context, images: [...images] }
    }
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      context.thumbnail = { status: 'attachment-limit' }
      return { context, images: [...images] }
    }
    context.thumbnail = { status: 'attached', digest }
    return { context, images: [...images, { mediaType: 'image/webp', data: bytes.toString('base64') }] }
  } catch {
    context.thumbnail = { status: 'unavailable' }
    return { context, images: [...images] }
  }
}
