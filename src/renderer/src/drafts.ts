/**
 * Unsent composer text, one draft per chat (keyed by wksp). Lives outside
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
}
