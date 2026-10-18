/**
 * Images attached to a chat message: limits, downscale sizing and the
 * Anthropic content blocks the companion session receives. Pure, shared by
 * main (delivery, storage) and renderer (composer downscale, thumbnails).
 */

export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ChatImageType = (typeof CHAT_IMAGE_TYPES)[number]

/** cap on the long edge before sending (keeps aspect) */
export const MAX_IMAGE_EDGE = 2000
/** raw bytes per image: base64 grows by 4/3, so this stays under the API's 5 MB per-image limit */
export const MAX_IMAGE_BYTES = 3_750_000
export const MAX_IMAGES_PER_MESSAGE = 10

export const IMAGE_EXT: Record<ChatImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** An image on its way from the composer to a session (base64, no data: prefix). */
export interface ChatImageInput {
  mediaType: ChatImageType
  data: string
  width?: number
  height?: number
}

/** A stored image referenced from a ChatMessage (file lives in the base's data/chat-images). */
export interface ChatImage {
  file: string
  mediaType: ChatImageType
  width?: number
  height?: number
}

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ChatImageType; data: string } }

export function isChatImageType(t: string): t is ChatImageType {
  return (CHAT_IMAGE_TYPES as readonly string[]).includes(t)
}

/** Size that fits inside max×max keeping aspect; never upscales. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= max || long <= 0) return { width, height }
  const k = max / long
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

export interface ImagePlan {
  width: number
  height: number
  /** true when the original bytes cannot be sent as they are */
  reencode: boolean
  /** type to encode to when reencoding */
  outType: ChatImageType
}

/** What the composer must do with a picked/pasted image before it can be sent. */
export function planImage(type: string, bytes: number, width: number, height: number): ImagePlan {
  const size = fitWithin(width, height)
  const scaled = size.width !== width || size.height !== height
  const accepted = isChatImageType(type)
  const reencode = !accepted || scaled || bytes > MAX_IMAGE_BYTES
  // canvases cannot write GIF; a scaled GIF becomes a still PNG
  const outType: ChatImageType = accepted && type !== 'image/gif' ? type : 'image/png'
  return { ...size, reencode, outType }
}

/** Next smaller size to try when an encoded image is still over MAX_IMAGE_BYTES. */
export function shrinkStep(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(width * 0.75)), height: Math.max(1, Math.round(height * 0.75)) }
}

/** Decoded size of a base64 string. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

/**
 * The user-message content for a turn: a plain string without images,
 * otherwise image blocks followed by the text (images-only is allowed).
 */
export function userContent(text: string, images?: readonly ChatImageInput[]): string | UserContentBlock[] {
  if (!images?.length) return text
  const blocks: UserContentBlock[] = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))
  if (text.trim()) blocks.push({ type: 'text', text })
  return blocks
}

/** A stored image file name as written by main: no folders, known extension. */
export function validChatImageFile(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,80}\.(png|jpg|gif|webp)$/i.test(name)
}

/** genio-media:// URL the renderer loads a stored chat image from. */
export function chatImageUrl(workspace: string, file: string): string {
  return `genio-media://chat/${encodeURIComponent(workspace)}/${encodeURIComponent(file)}`
}
