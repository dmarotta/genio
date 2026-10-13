import type { ChatImageInput } from '@shared/chat-images'

/**
 * Unsent composer text and attached images, one draft per chat (keyed by wksp). Lives outside
 * React so it survives the Comms view unmounting; not persisted across restarts.
 * Deliberately not in the reactive store: typing should not re-render every subscriber.
 */
const drafts = new Map<string, string>()

export function getDraft(wksp: string): string {
  return drafts.get(wksp) ?? ''
}

export function setDraft(wksp: string, text: string): void {
  if (text) drafts.set(wksp, text)
  else drafts.delete(wksp)
}

export function clearDraft(wksp: string): void {
  drafts.delete(wksp)
  imageDrafts.delete(wksp)
}

/** An image attached to a draft, ready to send (already downscaled). */
export interface DraftImage extends ChatImageInput {
  id: string
  /** data: URL for the thumbnail */
  preview: string
}

const imageDrafts = new Map<string, DraftImage[]>()

export function getDraftImages(wksp: string): DraftImage[] {
  return imageDrafts.get(wksp) ?? []
}

export function setDraftImages(wksp: string, images: DraftImage[]): void {
  if (images.length) imageDrafts.set(wksp, images)
  else imageDrafts.delete(wksp)
}
