import type { InventoryContext } from '@shared/inventory-context'
import type { ChatImageInput } from '@shared/chat-images'

/**
 * Unsent composer text and attached images, one draft per chat (keyed by workspace). Lives outside
 * React so it survives the Comms view unmounting; not persisted across restarts.
 * Deliberately not in the reactive store: typing should not re-render every subscriber.
 */
const drafts = new Map<string, string>()

export function getDraft(workspace: string): string {
  return drafts.get(workspace) ?? ''
}

export function setDraft(workspace: string, text: string): void {
  if (text) drafts.set(workspace, text)
  else drafts.delete(workspace)
}

export function clearDraft(workspace: string): void {
  drafts.delete(workspace)
  imageDrafts.delete(workspace)
  contextDrafts.delete(workspace)
}

/** An image attached to a draft, ready to send (already downscaled). */
export interface DraftImage extends ChatImageInput {
  id: string
  /** data: URL for the thumbnail */
  preview: string
}

const imageDrafts = new Map<string, DraftImage[]>()

export function getDraftImages(workspace: string): DraftImage[] {
  return imageDrafts.get(workspace) ?? []
}

export function setDraftImages(workspace: string, images: DraftImage[]): void {
  if (images.length) imageDrafts.set(workspace, images)
  else imageDrafts.delete(workspace)
}

const contextDrafts = new Map<string, InventoryContext>()
export const getDraftContext = (workspace: string): InventoryContext | undefined => contextDrafts.get(workspace)
export function setDraftContext(workspace: string, context?: InventoryContext): void {
  if (context) contextDrafts.set(workspace, context)
  else contextDrafts.delete(workspace)
}
