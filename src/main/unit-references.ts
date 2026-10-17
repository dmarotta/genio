/**
 * Attachments for units (docs/unit-worktrees.md, Attachments): whatever the player hands Genio for a
 * mission (chat images by id, files and folders on this PC, project files, inline text) is checked here,
 * copied into the quest's folder when the quest is filed (data/quest-references/<quest>/), and from there
 * into the unit's data folder (data/<unit>/references/, with references.json) when it starts. The copies
 * live outside the worktree and are never committed. Only safety limits apply: credential and config
 * locations, secrets by name, size caps and a folder cap; everything else of any type is welcome.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_ATTACHMENTS, REFERENCE_FILE_MAX_BYTES, REFERENCE_FOLDER_MAX_FILES, REFERENCE_TEXT_MAX_BYTES, REFERENCES_MAX_BYTES, VIEWABLE_IMAGE, referenceType,
  type ReferenceType, type ReferenceView, type ResolvedAttachment, type UnitReference
} from '@shared/unit-references'
import { validChatImageFile } from '@shared/chat-images'
import { chatImagePath } from './chat-images'
import { ensureDir, fwd, isSubPath, nowIso, readJson, truncate, writeJson } from './util'

/** What one item of the tools' `attachments` list says. */
export interface AttachmentInput {
  /** a chat image id, an absolute path (file or folder), or a project-relative path */
  source?: string
  /** inline text: its file name, and the text itself */
  name?: string
  text?: string
  note?: string
}

export interface AttachmentContext {
  /** this chat's image folder (chat image ids) */
  chatDir?: string
  /** the project's own checkout (project-relative paths) */
  projectPath?: string
  /** Genio's own folder (~/.genio): only its shareable parts may be attached */
  genioRoot: string
  /** the player's home folder (defaults to the OS one) */
  homeDir?: string
  /** bytes already in the destination (an edited plan step's references) */
  existingBytes?: number
}

export interface Resolved {
  items: ResolvedAttachment[]
  /** one plain line per refused item: what and why */
  rejected: string[]
}

export const REFERENCES_FILE = 'references.json'
export const questReferencesDir = (dataDir: string, questId: string): string => path.join(dataDir, 'quest-references', questId)
export const unitReferencesDir = (taskDir: string): string => path.join(taskDir, 'references')
/** Where a unit extracts an attached archive: its data folder, never the worktree. */
export const extractedDir = (taskDir: string): string => path.join(taskDir, 'references-extracted')

const MB = (n: number): string => `${Math.round((n / 2 ** 20) * 10) / 10} MB`

/** Credential and config folders under the player's home, never attached (also anything inside them). */
const HOME_SECRET_DIRS = [
  '.codex', '.claude', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.password-store', '.config/gcloud', '.config/gh', '.config/git',
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect', 'AppData/Roaming/Microsoft/Crypto',
  'AppData/Roaming/Microsoft/SystemCertificates', 'Library/Keychains'
]
const HOME_SECRET_FILES = ['.claude.json', '.gitconfig', '.bash_history', '.zsh_history', '.pgpass', '.yarnrc', '_netrc']
/** Secrets by file name, wherever they are. */
const SECRET_NAME = [
  /^\.env(\.(?!example$|sample$|template$|dist$)[^.]+)*$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc|ovpn)$/i,
  /^(credentials?|secrets?|auth|token|tokens)(\.(json|ya?ml|toml|txt|ini|xml))?$/i,
  /^(\.git-credentials|\.netrc|\.npmrc|\.pypirc|authorized_keys|known_hosts|service[-_]account.*\.json)$/i
]
/** Inside Genio's own folder only these parts may be attached: chat images, project clones and copies, generated media, reports, references. */
const GENIO_SHAREABLE = new Set(['chat-images', 'worktrees', 'projects', 'references', 'quest-references', 'references-extracted', 'fal', 'uthana', 'takes', 'modeller', 'sound'])

/** Why a path may never be attached, or undefined when it may. */
export function secretPathReason(file: string, ctx: Pick<AttachmentContext, 'genioRoot' | 'homeDir'>): string | undefined {
  const abs = path.resolve(file)
  const home = path.resolve(ctx.homeDir ?? os.homedir())
  const base = path.basename(abs)
  if (SECRET_NAME.some((re) => re.test(base))) return 'its name says it holds secrets or keys'
  const parts = abs.split(/[\\/]+/)
  if (parts.some((s) => s.toLowerCase() === '.git')) return 'it is inside a .git folder (git config and credentials)'
  const genio = path.resolve(ctx.genioRoot)
  if (isSubPath(abs, genio)) {
    const rel = path.relative(genio, abs).split(/[\\/]+/)
    if (rel.some((s) => /^(claude-home|codex-home)$/i.test(s)) || /^(secrets|settings)\.json$/i.test(base)) return "it is Genio's own sign-in or settings data"
    if (!rel.some((s) => GENIO_SHAREABLE.has(s)) && !/^report.*\.md$/i.test(base)) return "it is Genio's private data (only chat images, project copies, generated media, reports and references can be attached from there)"
  }
  for (const d of HOME_SECRET_DIRS) if (isSubPath(abs, path.join(home, d))) return `it is in ~/${d}, a credential or config folder`
  for (const f of HOME_SECRET_FILES) if (path.resolve(home, f).toLowerCase() === abs.toLowerCase()) return `~/${f} is a credential or config file`
  return undefined
}

/** A safe file name for inline text or a copy: no folders, no reserved characters. */
function safeName(name: string, fallback: string): string {
  const clean = name.replace(/[\\/:*?"<>|\0]/g, '_').trim().slice(0, 120)
  return clean && !/^\.+$/.test(clean) ? clean : fallback
}

/** A folder's files (recursive, sorted), skipping .git and node_modules; stops one past the cap. */
function folderFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length > REFERENCE_FOLDER_MAX_FILES) return
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(p)
      } else if (e.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * Check the tools' attachments: each becomes files to copy, or a plain line saying why it was refused.
 * Nothing is copied here; a later stageReferences does that.
 */
export function resolveAttachments(inputs: readonly AttachmentInput[] | undefined, ctx: AttachmentContext): Resolved {
  const items: ResolvedAttachment[] = []
  const rejected: string[] = []
  let total = ctx.existingBytes ?? 0
  const list = inputs ?? []
  if (list.length > MAX_ATTACHMENTS) rejected.push(`${list.length - MAX_ATTACHMENTS} attachment(s) past the first ${MAX_ATTACHMENTS}: too many in one list`)
  const take = (label: string, bytes: number): boolean => {
    if (bytes > REFERENCE_FILE_MAX_BYTES) {
      rejected.push(`${label}: too large (${MB(bytes)}; the limit is ${MB(REFERENCE_FILE_MAX_BYTES)} per file)`)
      return false
    }
    if (total + bytes > REFERENCES_MAX_BYTES) {
      rejected.push(`${label}: would pass the ${MB(REFERENCES_MAX_BYTES)} limit for one unit`)
      return false
    }
    total += bytes
    return true
  }
  const addFile = (abs: string, name: string, source: string, note: string | undefined, label: string): void => {
    const why = secretPathReason(abs, ctx) ?? realReason(abs, ctx)
    if (why) return void rejected.push(`${label}: refused, ${why}`)
    const size = fs.statSync(abs).size
    if (take(label, size)) items.push({ kind: 'file', path: abs, name, bytes: size, source, ...(note ? { note } : {}) })
  }
  for (const raw of list.slice(0, MAX_ATTACHMENTS)) {
    const note = raw.note?.replace(/\s+/g, ' ').trim() ? truncate(raw.note.replace(/\s+/g, ' ').trim(), 300) : undefined
    if (raw.text !== undefined) {
      const label = raw.name?.trim() || 'inline text'
      if (raw.source?.trim()) { rejected.push(`${label}: give either source or text, not both`); continue }
      if (!raw.name?.trim()) { rejected.push('inline text: needs a name (for example notes.md)'); continue }
      if (!raw.text.trim()) { rejected.push(`${label}: the text is empty`); continue }
      const bytes = Buffer.byteLength(raw.text, 'utf8')
      if (bytes > REFERENCE_TEXT_MAX_BYTES) { rejected.push(`${label}: inline text too large (${MB(bytes)}; the limit is ${MB(REFERENCE_TEXT_MAX_BYTES)}): attach it as a file`); continue }
      let name = safeName(raw.name, 'text.txt')
      if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.txt'
      if (take(label, bytes)) items.push({ kind: 'text', name, text: raw.text, bytes, source: 'inline text', ...(note ? { note } : {}) })
      continue
    }
    const src = raw.source?.trim()
    if (!src) { rejected.push('an attachment with neither source nor text'); continue }
    if (validChatImageFile(src)) {
      const p = ctx.chatDir ? chatImagePath(ctx.chatDir, src) : undefined
      if (!p) { rejected.push(`${src}: no chat image with this id in this chat`); continue }
      const size = fs.statSync(p).size
      if (take(src, size)) items.push({ kind: 'file', path: p, name: src, bytes: size, source: `chat image ${src}`, ...(note ? { note } : {}) })
      continue
    }
    if (/^https?:\/\//i.test(src)) { rejected.push(`${src}: a URL is not a file; pass the page's text (and the URL) as inline text instead`); continue }
    let abs: string
    const tilde = src.replace(/^~(?=$|[\\/])/, ctx.homeDir ?? os.homedir())
    if (path.isAbsolute(tilde)) abs = path.resolve(tilde)
    else {
      if (!ctx.projectPath) { rejected.push(`${src}: not an absolute path, and no project to resolve it in`); continue }
      abs = path.resolve(ctx.projectPath, src)
      if (!isSubPath(abs, ctx.projectPath)) { rejected.push(`${src}: a project-relative path must stay inside the project`); continue }
    }
    const st = fs.statSync(abs, { throwIfNoEntry: false })
    if (!st) { rejected.push(`${src}: not found`); continue }
    if (st.isDirectory()) {
      const why = secretPathReason(abs, ctx) ?? realReason(abs, ctx)
      if (why) { rejected.push(`${src}: refused, ${why}`); continue }
      const files = folderFiles(abs)
      if (!files.length) { rejected.push(`${src}: the folder has no files`); continue }
      const folder = safeName(path.basename(abs), 'folder')
      for (const f of files.slice(0, REFERENCE_FOLDER_MAX_FILES)) {
        const rel = path.relative(abs, f).split(path.sep).map((s) => safeName(s, '_')).join('/')
        addFile(f, `${folder}/${rel}`, f, note, `${folder}/${rel}`)
      }
      if (files.length > REFERENCE_FOLDER_MAX_FILES) rejected.push(`${src}: only its first ${REFERENCE_FOLDER_MAX_FILES} files were added (the folder cap)`)
      continue
    }
    if (!st.isFile()) { rejected.push(`${src}: not a file or folder`); continue }
    addFile(abs, safeName(path.basename(abs), 'file'), abs, note, src)
  }
  return { items, rejected }
}

/** A link or junction leading somewhere refused is refused too. */
function realReason(abs: string, ctx: Pick<AttachmentContext, 'genioRoot' | 'homeDir'>): string | undefined {
  try {
    const real = fs.realpathSync(abs)
    return real.toLowerCase() === abs.toLowerCase() ? undefined : secretPathReason(real, ctx)
  } catch {
    return 'it could not be read'
  }
}

export function readReferences(dir: string): UnitReference[] {
  const list = readJson<UnitReference[]>(path.join(dir, REFERENCES_FILE), [])
  return Array.isArray(list) ? list.filter((r) => r && typeof r.file === 'string') : []
}

export const referencesBytes = (dir: string): number => readReferences(dir).reduce((n, r) => n + (r.bytes || 0), 0)

/** A free name in the folder: `name`, else `name-2.ext`, `name-3.ext`... */
function freeName(taken: Set<string>, name: string): string {
  if (!taken.has(name.toLowerCase())) return name
  const ext = path.posix.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; ; i++) {
    const n = `${stem}-${i}${ext}`
    if (!taken.has(n.toLowerCase())) return n
  }
}

/**
 * Copy checked attachments into a references folder and list them in its references.json. The same
 * source with the same size is listed once; another file under a taken name gets `-2`, `-3`.
 */
export function stageReferences(dir: string, items: readonly ResolvedAttachment[], at = nowIso()): UnitReference[] {
  if (!items.length) return []
  ensureDir(dir)
  const list = readReferences(dir)
  const taken = new Set(list.map((r) => r.file.toLowerCase()))
  const added: UnitReference[] = []
  for (const it of items) {
    if (list.some((r) => r.source === it.source && r.bytes === it.bytes && (it.kind === 'file' || r.file.endsWith(it.name)))) continue
    const file = freeName(taken, it.name)
    const dest = path.join(dir, ...file.split('/'))
    ensureDir(path.dirname(dest))
    if (it.kind === 'file') fs.copyFileSync(it.path, dest)
    else fs.writeFileSync(dest, it.text, 'utf8')
    taken.add(file.toLowerCase())
    const ref: UnitReference = { file, source: it.source, ...(it.note ? { note: it.note } : {}), bytes: it.bytes, type: referenceType(file), addedAt: at }
    list.push(ref)
    added.push(ref)
  }
  writeJson(path.join(dir, REFERENCES_FILE), list)
  return added
}

/** Copy one references folder into another (a quest's into its unit's); returns everything the target lists. */
export function copyReferences(from: string, to: string): UnitReference[] {
  const refs = readReferences(from)
  const items: ResolvedAttachment[] = []
  for (const r of refs) {
    const p = path.join(from, ...r.file.split('/'))
    if (fs.statSync(p, { throwIfNoEntry: false })?.isFile()) items.push({ kind: 'file', path: p, name: r.file, bytes: r.bytes, source: r.source, ...(r.note ? { note: r.note } : {}) })
  }
  stageReferences(to, items)
  return readReferences(to)
}

/** The tool result's lines: what was attached and what was refused, and why. */
export function attachmentsReport(added: number, rejected: readonly string[]): string {
  const lines: string[] = []
  if (added) lines.push(`attached ${added} reference file${added === 1 ? '' : 's'}`)
  if (rejected.length) lines.push(`not attached (tell the player): ${rejected.join('; ')}`)
  return lines.length ? `\n${lines.join('\n')}` : ''
}

const OPEN_HOW: Record<ReferenceType, (o: { scratch: string; blender?: string }) => string> = {
  image: () => 'Images: open PNG, JPEG, GIF and WebP with your file-read tool to see them. Convert other formats (PSD, TGA, EXR, TIFF, BMP, HEIC) to a PNG in your scratch folder first (Python Pillow, or Blender\'s image API), then read the PNG.',
  pdf: () => 'PDFs: read them with your file-read tool (a page range at a time for long ones), or extract their text with a script.',
  text: () => 'Text, code and data (Markdown, JSON, CSV, YAML, source files, URLs and page text Genio saved): read them as text.',
  document: (o) => `Documents (DOCX, ODT, RTF...): DOCX and ODT are zip archives of XML; extract the text with a short Python script (zipfile, or python-docx when installed) into \`${o.scratch}\`. For old binary formats try \`soffice --headless --convert-to pdf\` when LibreOffice is installed.`,
  spreadsheet: (o) => `Spreadsheets (XLSX, ODS...): read the cells with Python (openpyxl when installed, else zipfile and the sheet XML), or save each sheet as CSV into \`${o.scratch}\` and read that.`,
  slides: (o) => `Slides (PPTX, ODP...): extract each slide's text and images with Python (zipfile, or python-pptx) into \`${o.scratch}\`, then read them.`,
  audio: (o) => `Audio: you cannot hear it. Use \`ffprobe\` for its length and format and \`ffmpeg -i <file> -lavfi showspectrumpic=s=1024x512 ${o.scratch}/<name>.png\` (or \`showwavespic\`) for a picture you can read, when ffmpeg is installed; a WAV can also be a Sound Studio source once copied into the project, if the mission needs it.`,
  video: (o) => `Video: extract a few frames with \`ffmpeg -i <file> -vf fps=1/2 ${o.scratch}/<name>-%03d.png\` (and \`ffprobe\` for its length) when ffmpeg is installed, then read the frames.`,
  model: (o) => {
    const skill = o.blender ? fwd(o.blender) : '<blender skill>'
    return `3D models: render one with the blender skill, \`node "${skill}/scripts/blender.mjs" --script "${skill}/scripts/genio_bpy.py" -- preview <file> ${o.scratch}/<name>.png\`, and read the PNG; \`-- validate <file> --out ${o.scratch}/<name>.json\` gives its size, parts and triangles.`
  },
  archive: (o) => `Archives (ZIP, 7z, TAR, .unitypackage): extract into \`${o.scratch}/<name>/\`, never into the worktree, then open each file by its type.`,
  other: () => 'Other or unknown types: look at the first bytes (a hex dump) or try reading it as text to identify it; say in your notes when you cannot use one.'
}

/**
 * The brief's References section: each file with its note and type, and how to open the types present.
 * It stays small (no file contents); past 40 files it points at references.json.
 */
export function referencesBriefLines(dir: string, refs: readonly UnitReference[], o: { taskDir: string; blender?: string; modeller?: boolean; generator?: boolean }): string[] {
  if (!refs.length) return []
  const d = fwd(dir)
  const scratch = fwd(extractedDir(o.taskDir))
  const shown = refs.slice(0, 40)
  const out = [
    `The player attached these for this mission. Copies are in \`${d}/\` (also GENIO_REFERENCES), outside the worktree: never commit them, and copy one into the project only when the mission says so.`,
    ...shown.map((r) => `- \`${r.file}\` (${r.type})${r.note ? `: ${r.note}` : ''}`),
    ...(refs.length > shown.length ? [`- and ${refs.length - shown.length} more, listed in \`${d}/${REFERENCES_FILE}\``] : []),
    '',
    'How to open them:',
    ...[...new Set(refs.map((r) => r.type))].map((t) => `- ${OPEN_HOW[t]({ scratch, blender: o.blender })}`)
  ]
  const images = refs.some((r) => r.type === 'image')
  if (o.modeller) out.push(`- Modeller: every step's review names the references. Compare each step's sheet with them${images ? ' (open the reference images beside the sheet)' : ''}, say in a line what still differs, and fix it in the next steps. Ask the player (\`needs-decision\`) only for a real ambiguity, such as references that disagree.`)
  if (o.generator && images) out.push('- Generator: pass the reference images a job should follow to codex-image as `--ref <file>` (one per image).')
  return out
}

/** The Brief tab's rows: small viewable images carry a thumbnail. */
export function referenceViews(dir: string, thumbMax = 2 * 1024 * 1024, thumbs = 24): ReferenceView[] {
  let left = thumbs
  return readReferences(dir).map((r) => {
    const p = path.join(dir, ...r.file.split('/'))
    const view: ReferenceView = { file: r.file, ...(r.note ? { note: r.note } : {}), type: r.type, path: p }
    if (r.type === 'image' && VIEWABLE_IMAGE.test(r.file) && left > 0) {
      const st = fs.statSync(p, { throwIfNoEntry: false })
      if (st?.isFile() && st.size <= thumbMax) {
        left--
        const ext = path.extname(r.file).slice(1).toLowerCase()
        view.thumb = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(p).toString('base64')}`
      }
    }
    return view
  })
}
