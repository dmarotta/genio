/**
 * Chat image storage: images the player attaches are written to the base's
 * data/chat-images (Genio's data, never a world) and referenced from the
 * ChatMessage, so the transcript keeps them across restarts.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  IMAGE_EXT, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, isChatImageType, validChatImageFile, type ChatImage, type ChatImageInput
} from '@shared/chat-images'
import { ensureDir, rid } from './util'

export const chatImageDir = (dataDir: string): string => path.join(dataDir, 'chat-images')

/** Validate and store attached images; returns the refs to record and the inputs to send. */
export function saveChatImages(dir: string, inputs: readonly ChatImageInput[]): { refs: ChatImage[]; send: ChatImageInput[] } {
  if (inputs.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`)
  const refs: ChatImage[] = []
  const send: ChatImageInput[] = []
  if (!inputs.length) return { refs, send }
  ensureDir(dir)
  for (const i of inputs) {
    if (!isChatImageType(i.mediaType)) throw new Error(`Unsupported image type ${String(i.mediaType)} (PNG, JPEG, GIF or WebP).`)
    const buf = Buffer.from(i.data, 'base64')
    if (!buf.length) throw new Error('An attached image is empty.')
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('An attached image is too large to send.')
    const file = `${Date.now().toString(36)}-${rid(4)}.${IMAGE_EXT[i.mediaType]}`
    fs.writeFileSync(path.join(dir, file), buf)
    const dims = i.width && i.height ? { width: i.width, height: i.height } : {}
    refs.push({ file, mediaType: i.mediaType, ...dims })
    // re-encode from the decoded bytes so only clean base64 reaches the session
    send.push({ mediaType: i.mediaType, data: buf.toString('base64'), ...dims })
  }
  return { refs, send }
}

/** Absolute path of a stored image, or undefined when the name is not one main wrote. */
export function chatImagePath(dir: string, file: string): string | undefined {
  if (!validChatImageFile(file)) return undefined
  const p = path.join(dir, file)
  return fs.existsSync(p) ? p : undefined
}
