export const ART_BIBLE_SCHEMA: 'genio.art-bible.v1'
export const BIBLE_FILE: '.genio/art-bible.md'
export const LIMITS: Readonly<{
  warnBytes: number; maxBytes: number; refs: number; summary: number; typeLine: number; avoid: number
  codexStyle: number; codexPrompt: number; codexRefs: number; falStyle: number; editRefs: number; recraftStyle: number; recraftRefs: number
}>
export const ASSET_TYPES: Readonly<Record<string, { title: string; words: string[] }>>
export class ArtBibleError extends Error {}

export interface BibleIssue { level: 'error' | 'warning'; file?: string; message: string }
export interface BibleColor { name: string; hex: string; use: string; origin: string }
export interface BibleRef {
  path: string | null; href: string; caption: string; role: 'style' | 'subject' | 'layout'; types: string[]; weight: number
  titled: boolean; section: string; section_type: string | null; origin: string; weight_origin: string; exists: boolean | null; external: boolean
}
export interface BibleType { title: string; line: string; text: string; custom: boolean; origin?: string }
export interface BibleStyle { title: string | null; summary: string; text: string }

/** One parsed markdown document (a bible or the doc its `source:` points at). */
export interface ParsedBible {
  file: string; bytes: number; blob: string | null; front: Record<string, unknown>; title: string | null
  style: BibleStyle | null; palette: BibleColor[]; accents: BibleColor[]; references: BibleRef[]
  do: string[]; dont: string[]; checklist: string[]; avoid: string[]; types: Record<string, BibleType>; issues: BibleIssue[]
}

/** The bible after merging its `source:` doc; `origins` names the file behind every part. */
export interface ResolvedBible {
  schema: string; path: string; root?: string
  source: { path: string; blob: string | null; bytes: number } | null
  version: { blob: string | null; source_blob: string | null }
  title: string | null; kind: string | null; defaults: Record<string, unknown>
  style: BibleStyle | null; palette: BibleColor[]; accents: BibleColor[]; references: BibleRef[]
  avoid: string[]; do: string[]; dont: string[]; checklist: string[]; types: Record<string, BibleType>
  origins: {
    title: string | null; kind: string | null; defaults: string[]; style: string | null; palette: string | null
    accents: string[]; references: string[]; reference_weights: string[]; avoid: string[]; do: string[]; dont: string[]
    checklist: string | null; types: Record<string, string>
  }
  issues: BibleIssue[]
}

export type CompileTarget = 'codex' | 'fal-text' | 'fal-edit' | 'recraft' | 'recraft-style' | 'image2pixel' | '3d' | 'audio' | 'music' | 'voice' | 'animation'
export interface CompileOptions {
  world?: string; bible?: ResolvedBible | null; provider?: string; endpoint?: string; schema?: unknown
  type?: string; subject?: string; styleId?: string; limit?: number
}
export interface CompiledRef { path: string; file: string | null; caption: string; role: string; types: string[]; weight: number }
export interface Compiled {
  target: CompileTarget; type: string | null; prompt: string; prefix: string; negative: string
  refs: CompiledRef[]; palette: { name: string; hex: string; accent?: boolean }[]; params: Record<string, unknown>
  applied: string[]; notes: string[]; version: ResolvedBible['version'] | null; path: string | null
}

export function gitBlobSha(buf: Buffer | string): string
export function plainText(s: string): string
export function clip(text: string, max: number): string
export function typeOfHeading(title: string): string | null
export function normalizeType(t: string | null | undefined): string | null
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string; lines: number; errors: string[] }
export function parseArtBible(text: string, opts?: { file?: string; custom?: boolean; bytes?: number }): ParsedBible
export function mergeArtBible(bible: ParsedBible, source?: ParsedBible | null): ResolvedBible
export function loadArtBible(root: string, opts?: { text?: string; file?: string }): ResolvedBible | null
export function summarize(bible: ResolvedBible | null): Record<string, unknown> | null
export function readArtBibleText(root: string): string | null
export function writeArtBible(root: string, text: string): ResolvedBible | null
export function targetOf(opts?: { provider?: string; endpoint?: string }): CompileTarget
export function selectRefs(bible: ResolvedBible | null, type?: string | null, limit?: number): BibleRef[]
export function compile(opts?: CompileOptions): Compiled | null

/** What provenance records as `art_bible` (only when something was applied). */
export interface BibleStamp { blob: string | null; source_blob?: string; type: string | null; refs: string[]; applied: string[] }
export function bibleStamp(compiled: Compiled | null | undefined): BibleStamp | null
export function applyToCodex(opts: { bible: ResolvedBible | null; type?: string; prompt: string; limit?: number }): { prompt: string; refs: string[]; compiled: Compiled; stamp: BibleStamp | null } | null
export function applyToFal(input: Record<string, unknown>, opts: { bible: ResolvedBible | null; endpoint: string; schema?: unknown; type?: string; kind?: string }): { input: Record<string, unknown>; compiled: Compiled | null; stamp: BibleStamp | null; notes: string[] } | null
export function applyToMotion(opts: { bible: ResolvedBible | null; prompt: string }): { prompt: string; compiled: Compiled; stamp: BibleStamp | null } | null
