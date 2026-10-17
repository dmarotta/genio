/**
 * Design notes: plain markdown files in the project's `.genio/design/` folder, next to the Art Bible
 * (docs/design-chats.md). A design chat writes one only when the player asks (player_words, checked by the
 * design_notes tool); the project chat, the main chat and units read them as context, never as authorization.
 * No schema: the format and the "Open questions" / "Decided" sections are conventions in the design chat's
 * prompt. Writes stay uncommitted, like Art Bible saves.
 *
 * Every access stays inside `.genio/design/`: a note is a plain name with no folders, markdown only, and the
 * folder chain and the note itself must not be links. Reads are versioned (a content hash): since=version
 * returns unchanged or a character splice, and a write is refused when the note changed since that version.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DESIGN_NOTE_MAX_BYTES, type DesignNote } from '@shared/design-notes'
import { readJson, writeJsonAtomic } from './util'

export const NOTES_DIR = '.genio/design'
export const NOTE_LIMITS = Object.freeze({ noteBytes: DESIGN_NOTE_MAX_BYTES, totalBytes: 64 * 1024, nameChars: 64 })

export const noteVersion = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const kb = (bytes: number): string => `${Math.round(bytes / 102.4) / 10} KB`
const rel = (file: string): string => `${NOTES_DIR}/${file}`
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p)
  } catch (e) {
    if (missing(e)) return undefined
    throw e
  }
}

/** The notes folder inside the project, never through a link; undefined while it does not exist (create makes it). */
function notesDir(root: string, create = false): string | undefined {
  let dir = fs.realpathSync(root)
  for (const part of ['.genio', 'design']) {
    dir = path.join(dir, part)
    const st = lstat(dir)
    if (!st) {
      if (!create) return undefined
      fs.mkdirSync(dir)
      continue
    }
    if (st.isSymbolicLink()) throw new Error(`${NOTES_DIR} must be a plain folder in the project, not a link.`)
    if (!st.isDirectory()) throw new Error(`${NOTES_DIR} is not a folder.`)
  }
  return dir
}

/** A new note's file name: lowercase words joined by dashes ("Enemy roster" -> enemy-roster.md). */
const slug = (stem: string): string => stem.trim().toLowerCase().replace(/[\s_]+/g, '-')

/**
 * The note a name points at: a plain name like "combat" or "combat.md", never a path. An existing note matches
 * by name in any case (or by its slug); otherwise the result is the new note's file. Refuses paths, traversal and
 * any extension but .md.
 */
function noteFile(dir: string | undefined, name: string): { file: string; exists: boolean } {
  const raw = String(name ?? '').trim()
  if (!raw) throw new Error('Name the note, like "combat".')
  if (/[\\/:*?"<>|\0-\x1f]/.test(raw) || raw.includes('..') || raw.startsWith('.') || path.isAbsolute(raw)) {
    throw new Error(`A note name is a plain name like "combat", never a path: notes live only in ${NOTES_DIR}/.`)
  }
  const ext = path.extname(raw)
  if (ext && ext.toLowerCase() !== '.md') throw new Error('Lore notes are markdown only: name it like "combat" or "combat.md".')
  const stem = ext ? raw.slice(0, -ext.length) : raw
  const entries = dir ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')) : []
  const found = entries.find(f => f.toLowerCase() === `${stem}.md`.toLowerCase()) ?? entries.find(f => slug(f.slice(0, -3)) === slug(stem))
  if (found) return { file: found, exists: true }
  const s = slug(stem)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s) || s.length > NOTE_LIMITS.nameChars || RESERVED.test(s)) {
    throw new Error(`A note name uses letters, digits and dashes (up to ${NOTE_LIMITS.nameChars}), like "combat" or "enemy-roster".`)
  }
  return { file: `${s}.md`, exists: false }
}

/** A regular file in the folder, never a link. */
function readFile(dir: string, file: string): string {
  const p = path.join(dir, file)
  const st = lstat(p)
  if (!st) throw new Error(`No note ${rel(file)}.`)
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${rel(file)} is not a plain file in ${NOTES_DIR}/.`)
  return fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
}

/** The plain .md files in the folder with their text; links and anything else are skipped. */
function notes(dir: string): { file: string; text: string; mtime: Date }[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.md'))
    .map(d => ({ file: d.name, text: fs.readFileSync(path.join(dir, d.name), 'utf8').replace(/^﻿/, ''), mtime: fs.statSync(path.join(dir, d.name)).mtime }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** The note's title: its front matter title, else its first heading. */
export function noteTitle(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const title = front && /^title:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '')
  return title || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || undefined
}

/** design_notes list: name, title, size and version of each note, and the folder's total against its limit. */
export function listNotes(root: string): Record<string, unknown> {
  const dir = notesDir(root)
  if (!dir) return { folder: `${NOTES_DIR}/`, notes: [], note: 'No Lore notes yet. A Lore chat writes one only when the player asks.' }
  const all = notes(dir)
  const bytes = all.reduce((n, x) => n + Buffer.byteLength(x.text), 0)
  return {
    folder: `${NOTES_DIR}/`,
    notes: all.map(x => ({ name: x.file.slice(0, -3), path: rel(x.file), title: noteTitle(x.text), size: kb(Buffer.byteLength(x.text)),
      version: noteVersion(x.text), updated: x.mtime.toISOString() })),
    total: `${kb(bytes)} of ${kb(NOTE_LIMITS.totalBytes)}`
  }
}

// ---------------------------------------------------------------- versions

type Versions = Record<string, { version: string; text: string }[]>

/** Remember what a chat was shown, in Genio's data (never the project), so since=version can return a splice. */
function remember(cacheFile: string | undefined, key: string, version: string, text: string): { version: string; text: string }[] {
  if (!cacheFile) return []
  const all = readJson<Versions>(cacheFile, {})
  const seen = all[key] ?? []
  if (!seen.some(v => v.version === version)) {
    delete all[key]
    all[key] = [...seen, { version, text }].slice(-4)
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - 64))) delete all[k]
    writeJsonAtomic(cacheFile, all)
  }
  return seen
}

/**
 * design_notes read: the note and its version. since = a version read before returns unchanged, or a splice
 * (start, deleteCount, insert) to apply to that version's text; an unknown version returns the full text with reset.
 */
export function readNote(root: string, name: string, since?: string, cacheFile?: string, key = root): Record<string, unknown> {
  const dir = notesDir(root)
  const { file, exists } = noteFile(dir, name)
  if (!dir || !exists) throw new Error(`No note named "${name}" in ${NOTES_DIR}/ (design_notes list shows the notes).`)
  const text = readFile(dir, file)
  const version = noteVersion(text)
  const head = { name: file.slice(0, -3), path: rel(file), version }
  const seen = remember(cacheFile, `${key}|${file.toLowerCase()}`, version, text)
  if (since === version) return { ...head, unchanged: true }
  const prior = since ? seen.find(v => v.version === since) : undefined
  if (!prior) return { ...head, text, ...(since ? { reset: true } : {}) }
  let start = 0
  while (start < text.length && start < prior.text.length && text[start] === prior.text[start]) start++
  let tail = 0
  while (tail < text.length - start && tail < prior.text.length - start && text[text.length - tail - 1] === prior.text[prior.text.length - tail - 1]) tail++
  return { ...head, delta: { baseVersion: prior.version, start, deleteCount: prior.text.length - start - tail, insert: text.slice(start, text.length - tail) } }
}

/**
 * design_notes write: the whole note, plain and uncommitted. Refused over the size limits, and when the note
 * changed since the version the chat read (an existing note needs since). The caller checks player_words.
 */
export function writeNote(root: string, name: string, text: string, since?: string, cacheFile?: string, key = root): Record<string, unknown> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to save: write the whole note as markdown text.')
  if (text.includes('\0')) throw new Error('Lore notes are markdown text only.')
  const body = text.endsWith('\n') ? text : `${text}\n`
  const bytes = Buffer.byteLength(body)
  if (bytes > NOTE_LIMITS.noteBytes) {
    throw new Error(`Not saved: the note is ${kb(bytes)}, over the ${kb(NOTE_LIMITS.noteBytes)} limit for one note. Split it into smaller notes or tighten it.`)
  }
  const existing = notesDir(root)
  const target = noteFile(existing, name)
  const current = existing && target.exists ? readFile(existing, target.file) : undefined
  if (current !== undefined) {
    const version = noteVersion(current)
    if (!since) throw new Error(`Not saved: ${rel(target.file)} already exists. Read it first (design_notes read) and write with its version as since, so the player's latest edits are kept.`)
    if (since !== version) throw new Error(`Not saved: ${rel(target.file)} changed since you read it (version ${since}, now ${version}). Read it again, keep the player's changes, and write with the new version.`)
  } else if (since) {
    throw new Error(`Not saved: ${rel(target.file)} no longer exists (deleted or renamed since you read it). Ask the player before writing it again.`)
  }
  const others = existing ? notes(existing).filter(x => x.file !== target.file).reduce((n, x) => n + Buffer.byteLength(x.text), 0) : 0
  if (others + bytes > NOTE_LIMITS.totalBytes) {
    throw new Error(`Not saved: the notes would total ${kb(others + bytes)}, over the ${kb(NOTE_LIMITS.totalBytes)} limit for ${NOTES_DIR}/. Ask the player which notes to merge or remove.`)
  }
  const dir = notesDir(root, true)!
  fs.writeFileSync(path.join(dir, target.file), body, 'utf8')
  const version = noteVersion(body)
  remember(cacheFile, `${key}|${target.file.toLowerCase()}`, version, body)
  return { name: target.file.slice(0, -3), path: rel(target.file), version, created: current === undefined, size: kb(bytes),
    note: 'Saved uncommitted. The player sees it in the project and commits it when they want units to have it.' }
}

/** The Design screen's notes: every plain note with its text and version (the folder holds 64 KB at most). */
export function screenNotes(root: string): DesignNote[] {
  const dir = notesDir(root)
  return dir ? notes(dir).map(x => ({ name: x.file.slice(0, -3), file: x.file, text: x.text, version: noteVersion(x.text) })) : []
}

/**
 * The player's own edit from the Design screen: the same limits and checks as a chat's write (no player_words:
 * the player typed it), refused in plain words when the note changed since the editor opened it.
 */
export function saveScreenNote(root: string, name: string, text: string, since: string): DesignNote[] {
  try {
    writeNote(root, name, text, since)
  } catch (e) {
    const m = (e as Error).message
    if (/changed since you read it/.test(m)) throw new Error('Not saved: the note changed while you edited it. Copy your text, Cancel, and edit the new version.')
    if (/no longer exists/.test(m)) throw new Error('Not saved: the note was deleted or renamed while you edited it.')
    throw e
  }
  return screenNotes(root)
}

/** The unit brief's design notes line: only when its copy has the folder. Units read notes as context, never as specs. */
export function designNotesBriefLines(worktree: string): string[] {
  try {
    if (!fs.statSync(path.join(worktree, '.genio', 'design')).isDirectory()) return []
  } catch {
    return []
  }
  return [`Design notes: \`${NOTES_DIR}/\` holds the player's design notes (markdown). Read them when they bear on your mission, as context only: your mission is your spec. Never edit them unless the mission says so.`]
}
