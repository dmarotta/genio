/**
 * The project Art Bible (.genio/art-bible.md, docs/art-bible.md) in Genio's
 * generators and units. Nothing here is automatic about the bible itself: a
 * project has one only when the player made that file, and a missing or empty
 * file applies nothing. When one exists, the chat's generate_image,
 * fal_generate and uthana_motion compile it into the request, and each unit
 * gets GENIO_ART_BIBLE (a launch snapshot when the main copy has edits the
 * unit's branch lacks) plus a brief line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ArtBibleStamp } from '@shared/api'
import type { GenerationCard } from '@shared/generation'
import {
  ArtBibleError, BIBLE_FILE, applyToCodex, applyToFal, applyToMotion, gitBlobSha, loadArtBible, readArtBibleText, summarize, writeArtBible,
  type Compiled, type ResolvedBible
} from '../../resources/unit-skills/genio/lib/art-bible.mjs'
import { ensureDir, fwd } from './util'

export { BIBLE_FILE }

/** Generation tool fields: the project's Art Bible applies when it has one; these pick its section or skip it. */
export const artBibleShape = {
  asset_type: z.string().min(1).optional().describe('Art Bible section to follow: concepts, sprites, ui, textures, models, buildings, characters, wildlife, audio, music or a custom one'),
  art_bible: z.boolean().optional().describe("false generates without the project's Art Bible (default: applied when the project has one)")
}

/** The project's resolved bible, or null; a bible that cannot be compiled stops the generation with a fix. */
export function projectBible(root: string): ResolvedBible | null {
  const bible = loadArtBible(root)
  const errors = bible?.issues.filter((i) => i.level === 'error') ?? []
  if (errors.length) throw new Error(`The Art Bible cannot be applied: ${errors.map((e) => e.message).join(' ')} Fix ${BIBLE_FILE} or pass art_bible: false.`)
  return bible
}

type CardBible = NonNullable<GenerationCard['artBible']>
const cardOf = (stamp: ArtBibleStamp | null, compiled: Compiled | null | undefined, notes: string[] = compiled?.notes ?? []): CardBible => ({
  type: stamp?.type ?? compiled?.type ?? null, applied: stamp?.applied ?? [], refs: stamp?.refs ?? [], ...(notes.length ? { notes: [...new Set(notes)] } : {})
})

export interface Applied<T> { value: T; stamp?: ArtBibleStamp; card?: CardBible }

const guard = <T>(fn: () => T): T => {
  try {
    return fn()
  } catch (e) {
    if (e instanceof ArtBibleError) throw new Error(`${e.message} Fix ${BIBLE_FILE} or pass art_bible: false.`)
    throw e
  }
}

/** A Codex image prompt and refs with the bible applied; `room` caps the refs it may add. */
export function bibleForCodex(root: string, a: { prompt: string; type?: string; refs: string[]; room: number }): Applied<{ prompt: string; refs: string[] }> {
  const bible = projectBible(root)
  const r = bible && guard(() => applyToCodex({ bible, type: a.type, prompt: a.prompt }))
  if (!r) return { value: { prompt: a.prompt, refs: a.refs } }
  const own = new Set(a.refs.map((p) => path.resolve(p).toLowerCase()))
  const fresh = r.refs.map((p, i) => ({ p, rel: r.compiled.refs[i]?.path })).filter((x) => !own.has(path.resolve(x.p).toLowerCase()))
  const kept = fresh.slice(0, Math.max(0, a.room))
  let stamp = r.stamp
  if (stamp && kept.length < r.refs.length) {
    const applied = kept.length ? stamp.applied : stamp.applied.filter((x) => x !== 'refs')
    stamp = applied.length ? { ...stamp, refs: kept.map((x) => x.rel!).filter(Boolean), applied } : null
  }
  return { value: { prompt: r.prompt, refs: [...a.refs, ...kept.map((x) => x.p)] }, stamp: stamp ?? undefined, card: cardOf(stamp, r.compiled) }
}

/** A FAL model input with the bible applied (after player defaults, before validation and pricing). */
export function bibleForFal(root: string, input: Record<string, unknown>, a: { endpoint: string; schema?: unknown; type?: string; kind?: string }): Applied<Record<string, unknown>> {
  const bible = projectBible(root)
  const r = bible && guard(() => applyToFal(input, { bible, endpoint: a.endpoint, schema: a.schema, type: a.type, kind: a.kind }))
  if (!r) return { value: input }
  return { value: r.input, stamp: r.stamp ?? undefined, card: cardOf(r.stamp, r.compiled, r.notes) }
}

/** A text-to-motion prompt with the bible's Animation line. */
export function bibleForMotion(root: string, prompt: string): Applied<string> {
  const bible = projectBible(root)
  const r = bible && guard(() => applyToMotion({ bible, prompt }))
  if (!r) return { value: prompt }
  return { value: r.prompt, stamp: r.stamp ?? undefined, card: cardOf(r.stamp, r.compiled) }
}

// ---------------------------------------------------------------- units

export interface UnitArtBible {
  /** what GENIO_ART_BIBLE points to: the worktree's own bible or the launch snapshot */
  file: string
  blob: string | null
  /** the main copy's bible differs from the unit's branch: the unit reads the player's latest edits */
  snapshot: boolean
  /** no bible from the player's point of view (an empty snapshot keeps the helpers from applying the branch's) */
  empty: boolean
}

const readBuf = (file: string): Buffer | null => {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}
const hasText = (b: Buffer | null): b is Buffer => !!b && b.toString('utf8').replace(/^﻿/, '').trim() !== ''

/**
 * The bible a unit sees. Units branch from committed code, so when the main
 * copy's .genio/art-bible.md differs from the worktree's (uncommitted edits,
 * a new or deleted file) it is copied to <task data>/art-bible/art-bible.md
 * at every launch; its references and `source:` still resolve in the
 * worktree. Null when neither copy has a bible.
 */
export function unitArtBible(main: string, worktree: string, taskDir: string): UnitArtBible | null {
  const mainBuf = readBuf(path.join(main, '.genio', 'art-bible.md'))
  const wtFile = path.join(worktree, '.genio', 'art-bible.md')
  const wtBuf = readBuf(wtFile)
  if (!hasText(mainBuf) && !hasText(wtBuf)) return null
  if (mainBuf && wtBuf && mainBuf.equals(wtBuf)) return { file: fwd(wtFile), blob: gitBlobSha(wtBuf), snapshot: false, empty: false }
  const snap = path.join(taskDir, 'art-bible', 'art-bible.md')
  ensureDir(path.dirname(snap))
  fs.writeFileSync(snap, hasText(mainBuf) ? mainBuf : '')
  return { file: fwd(snap), blob: hasText(mainBuf) ? gitBlobSha(mainBuf) : null, snapshot: true, empty: !hasText(mainBuf) }
}

/** The launch env: GENIO_ART_BIBLE whenever either copy has a bible (an empty snapshot means "none"). */
export function unitArtBibleEnv(main: string, worktree: string, taskDir: string): Record<string, string> {
  try {
    const b = unitArtBible(main, worktree, taskDir)
    return b ? { GENIO_ART_BIBLE: b.file } : {}
  } catch {
    return {} // never blocks a launch
  }
}

/** The brief's Art Bible lines (none without a bible); `cli` is the installed genio-art.mjs. */
export function artBibleBriefLines(b: UnitArtBible | null | undefined, cli: string): string[] {
  if (!b || b.empty) return []
  const version = b.blob ? `, version ${b.blob.slice(0, 8)}` : ''
  const where = b.snapshot ? `a launch snapshot of the player's uncommitted edits at \`${b.file}\`${version}` : `\`${BIBLE_FILE}\`${version}`
  return [
    `- Art Bible: this project has one (${where}; the path is also in GENIO_ART_BIBLE). codex-image.mjs and fal.mjs apply it automatically in --world mode and record it in provenance; pass --type <asset type> for its section, --no-bible only when the mission says so.`,
    `- Read it before making or reviewing any asset (\`node "${fwd(cli)}" compile --world . --type <t>\` shows what a generation gets). Never edit ${BIBLE_FILE} unless the mission says so.`
  ]
}

// ---------------------------------------------------------------- chat tool

/** art_bible read: the file as it is, plus what Genio makes of it. */
export function readBibleFile(root: string): Record<string, unknown> {
  const text = readArtBibleText(root)
  if (text == null || !text.trim()) return { path: BIBLE_FILE, exists: text != null, text: text ?? '', bible: null, note: 'No Art Bible: nothing is applied to generations. Create one only when the player asks.' }
  let bible: ResolvedBible | null = null
  let error: string | undefined
  try {
    bible = loadArtBible(root)
  } catch (e) {
    error = (e as Error).message
  }
  return { path: BIBLE_FILE, exists: true, text, summary: summarize(bible), issues: bible?.issues ?? [], ...(error ? { error } : {}) }
}

/** art_bible write: a plain, uncommitted file edit, refused when the text would not compile. */
export function writeBibleFile(root: string, text: string): Record<string, unknown> {
  const bible = writeArtBible(root, text)
  return {
    path: BIBLE_FILE, written: true, summary: summarize(bible), issues: bible?.issues ?? [],
    note: bible ? 'Saved uncommitted. Generations apply it now; units launched from now on see it.' : 'Saved empty: no Art Bible, nothing is applied.'
  }
}
