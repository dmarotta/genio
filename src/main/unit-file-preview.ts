/**
 * Before and after of one binary file a unit changed, for the Changes tab (git shows binaries only as
 * "Bin"). Images: the base blob and the worktree file as data URLs. Models: before is Inventory's
 * thumbnail of the same path in the player's own copy; after is the Modeller's head step render, with
 * its triangles and parts. Read only and size capped; anything else answers kind 'other'.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MODEL_PREVIEW_EXTS } from '@shared/model-viewer'
import { inventoryMediaUrl } from '@shared/inventory'
import type { ModellerLive, UnitFilePreview } from '@shared/modeller'

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' }
/** Larger images are described by size only. */
export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024

const gitBuffer = (cwd: string, args: string[]): Promise<Buffer | undefined> => new Promise((resolve) => {
  execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: PREVIEW_MAX_BYTES + 1024, timeout: 20_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout) => resolve(err ? undefined : stdout))
})
const dataUrl = (type: string, bytes: Buffer): string => `data:${type};base64,${bytes.toString('base64')}`

export interface FilePreviewSource {
  worktree: string
  /** The base the Changes tab compares against (git.baseRef). */
  ref: string
  file: string
  /** The project's own checkout and its name, for Inventory's thumbnail of the model before. */
  projectRoot?: string
  world?: string
  /** The unit's model, when it is a Modeller. */
  modeller?: () => ModellerLive | null
}

export async function unitFilePreview(o: FilePreviewSource): Promise<UnitFilePreview> {
  const file = o.file
  if (!file || path.isAbsolute(file) || file.includes('\\') || file.split('/').some((s) => !s || s === '.' || s === '..') || file.startsWith('-')) throw new Error('Not a file of this unit.')
  const ext = path.posix.extname(file).slice(1).toLowerCase()
  const image = IMAGE_TYPES[ext]
  const model = (MODEL_PREVIEW_EXTS as readonly string[]).includes(ext) || ext === 'blend'
  if (!image && !model) return { kind: 'other' }
  const size = await gitBuffer(o.worktree, ['cat-file', '-s', `${o.ref}:${file}`])
  const beforeBytes = size ? Number(size.toString().trim()) || undefined : undefined
  const abs = path.join(o.worktree, ...file.split('/'))
  const st = fs.statSync(abs, { throwIfNoEntry: false })
  const afterBytes = st?.isFile() ? st.size : undefined
  const out: UnitFilePreview = { kind: image ? 'image' : 'model', ...(beforeBytes !== undefined ? { beforeBytes } : {}), ...(afterBytes !== undefined ? { afterBytes } : {}) }
  if (image) {
    if (beforeBytes !== undefined && beforeBytes <= PREVIEW_MAX_BYTES) {
      const blob = await gitBuffer(o.worktree, ['show', `${o.ref}:${file}`])
      if (blob) out.before = dataUrl(image, blob)
    }
    if (afterBytes !== undefined && afterBytes <= PREVIEW_MAX_BYTES) out.after = dataUrl(image, fs.readFileSync(abs))
    return out
  }
  if (beforeBytes !== undefined && ext !== 'blend' && o.world && o.projectRoot && fs.existsSync(path.join(o.projectRoot, ...file.split('/')))) {
    out.before = inventoryMediaUrl('thumb', o.world, file)
  }
  const head = afterBytes !== undefined ? o.modeller?.()?.steps.at(-1) : undefined
  if (head) Object.assign(out, head.view ? { after: head.view } : {}, { triangles: head.triangles, parts: head.parts })
  return out
}
