/** Design notes as the Design screen sees them (src/main/design-notes.ts owns the folder and its rules). */
export interface DesignNote {
  /** the file name without .md, as design_notes names it */
  name: string
  /** the file name shown in the list, like combat.md */
  file: string
  text: string
  /** a content hash; a save names the version it was edited from */
  version: string
}

/** One note's size limit; the folder holds at most 64 KB. */
export const DESIGN_NOTE_MAX_BYTES = 16 * 1024

/** The note without its front matter (title, updated), for reading. */
export function noteBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}
