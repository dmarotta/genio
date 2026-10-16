/**
 * The Art Bible screen's file access: read `.genio/art-bible.md` (and the doc
 * its `source:` line extends) and write either one back, plain and uncommitted.
 * A bible edit that would not compile is refused by `writeArtBible`; a source
 * doc is written only at the path the bible on disk names. Reference images are
 * served to the screen over genio-media://art-bible/<world>/<path>, and only
 * paths the bible lists as references.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ArtBibleFile, ArtBibleView } from '@shared/art-bible'
import { BIBLE_FILE, loadArtBible, readArtBibleText, writeArtBible, type ResolvedBible } from '../../resources/unit-skills/genio/lib/art-bible.mjs'
import { guardedWorldFile } from './inventory'

const IMAGE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i

export const artBibleMediaUrl = (world: string, rel: string): string =>
  `genio-media://art-bible/${[world, ...rel.split('/')].map(encodeURIComponent).join('/')}`

function load(root: string): { bible: ResolvedBible | null; error?: string } {
  try {
    return { bible: loadArtBible(root) }
  } catch (e) {
    return { bible: null, error: (e as Error).message }
  }
}

/** What the screen shows: both raw texts and the resolved bible, or no bible at all. */
export function readArtBibleView(world: string, root: string): ArtBibleView {
  const text = readArtBibleText(root)
  if (text == null || !text.trim()) return { path: BIBLE_FILE, text, source: null, bible: null }
  const { bible, error } = load(root)
  const sourcePath = bible?.source?.path
  let source: ArtBibleView['source'] = null
  if (sourcePath) {
    try { source = { path: sourcePath, text: fs.readFileSync(path.join(root, ...sourcePath.split('/')), 'utf8').replace(/^﻿/, '') } } catch { /* reported by the bible's issues */ }
  }
  return {
    path: BIBLE_FILE, text, source, error,
    bible: bible && {
      title: bible.title,
      source: sourcePath ?? null,
      style: bible.style ? { summary: bible.style.summary, text: bible.style.text } : null,
      palette: bible.palette.map(({ name, hex, use }) => ({ name, hex, use })),
      accents: bible.accents.map(({ name, hex, use }) => ({ name, hex, use })),
      references: bible.references.map(r => ({
        path: r.path, href: r.href, caption: r.caption, role: r.role, types: r.types, weight: r.weight,
        exists: r.exists === true, external: r.external,
        url: r.path && r.exists && IMAGE.test(r.path) ? artBibleMediaUrl(world, r.path) : null
      })),
      do: bible.do, dont: bible.dont, avoid: bible.avoid,
      issues: bible.issues.map(({ level, message }) => ({ level, message }))
    }
  }
}

/**
 * Save the bible or its source doc. The bible goes through `writeArtBible`, which refuses text
 * that would not compile; the source is written only where the bible on disk points.
 */
export function writeArtBibleFile(world: string, root: string, file: ArtBibleFile, text: string): ArtBibleView {
  if (typeof text !== 'string') throw new Error('Nothing to save.')
  if (file === 'bible') writeArtBible(root, text)
  else if (file === 'source') {
    const rel = load(root).bible?.source?.path
    if (!rel) throw new Error('This Art Bible has no source doc to save.')
    fs.writeFileSync(path.join(root, ...rel.split('/')), text, 'utf8')
  } else throw new Error(`Unknown Art Bible file: ${String(file)}`)
  return readArtBibleView(world, root)
}

/** The image file behind genio-media://art-bible/<world>/<path>: a reference the bible lists, inside the project. */
export async function artBibleRefPath(root: string, rel: string): Promise<string | undefined> {
  if (!IMAGE.test(rel)) return
  const { bible } = load(root)
  if (!bible?.references.some(r => !r.external && r.path === rel)) return
  return guardedWorldFile(root, rel, true)
}
