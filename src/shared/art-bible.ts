/** The Art Bible screen's view of `.genio/art-bible.md` (resolved in main by lib/art-bible.mjs). */

/** Which file the Markdown tab saves: the bible itself, or the doc its `source:` line extends. */
export type ArtBibleFile = 'bible' | 'source'

export interface ArtBibleColor { name: string; hex: string; use: string }

export interface ArtBibleRef {
  /** project-relative path, or null for an external URL */
  path: string | null
  href: string
  caption: string
  role: 'style' | 'subject' | 'layout'
  types: string[]
  weight: number
  exists: boolean
  external: boolean
  /** genio-media://art-bible/... for an image the screen may show */
  url: string | null
}

export interface ArtBibleOverview {
  title: string | null
  /** the doc a `source:` line extends, shown as "From <path>" */
  source: string | null
  style: { summary: string; text: string } | null
  palette: ArtBibleColor[]
  accents: ArtBibleColor[]
  references: ArtBibleRef[]
  do: string[]
  dont: string[]
  avoid: string[]
  issues: { level: 'error' | 'warning'; message: string }[]
}

export interface ArtBibleView {
  /** '.genio/art-bible.md' */
  path: string
  /** the bible's raw text; null when the file does not exist */
  text: string | null
  /** the source doc's path and raw text, when the bible extends one */
  source: { path: string; text: string } | null
  /** null when there is no bible (missing or empty file) or it could not be read */
  bible: ArtBibleOverview | null
  /** why a non-empty bible could not be read */
  error?: string
}

/** Above this the bible warns; above ART_BIBLE_MAX_BYTES it is not compiled (lib/art-bible.mjs LIMITS). */
export const ART_BIBLE_WARN_BYTES = 16 * 1024
export const ART_BIBLE_MAX_BYTES = 64 * 1024

/** Whether the project has a bible to show; an empty or missing file shows the empty state. */
export const hasArtBible = (v: ArtBibleView | null | undefined): boolean => !!v?.text?.trim()

/** Every swatch for the narrow palette strip: base colours, then accents. */
export const paletteStrip = (b: ArtBibleOverview): string[] => [...b.palette, ...b.accents].map(c => c.hex)

/** A reference's tile label: its caption, else its file name. */
export const refLabel = (r: ArtBibleRef): string => r.caption.trim() || (r.path ?? r.href).split('/').pop() || r.href
