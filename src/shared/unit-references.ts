/**
 * A unit's references: the files, chat images and inline text the player handed Genio for a mission,
 * copied into the unit's data folder (references/, with references.json) outside its worktree.
 * Main side: src/main/unit-references.ts. Docs: docs/unit-worktrees.md (Attachments).
 */

/** One file: big enough for a texture, a PDF or a short video; a whole mission stays under the unit cap. */
export const REFERENCE_FILE_MAX_BYTES = 25 * 1024 * 1024
export const REFERENCES_MAX_BYTES = 100 * 1024 * 1024
/** A folder adds its files up to this many. */
export const REFERENCE_FOLDER_MAX_FILES = 200
/** Inline text Genio passes without a file. */
export const REFERENCE_TEXT_MAX_BYTES = 1024 * 1024
/** Items in one attachments list. */
export const MAX_ATTACHMENTS = 50

export type ReferenceType = 'image' | 'pdf' | 'text' | 'document' | 'spreadsheet' | 'slides' | 'audio' | 'video' | 'model' | 'archive' | 'other'

/** An orthographic view a Modeller matches an image reference in by numbers (front from -Y, side from +X, top from above). */
export type OrthoView = 'front' | 'side' | 'top'

/** One entry of references.json. */
export interface UnitReference {
  /** path inside references/, with forward slashes (a folder's files keep their sub-folders) */
  file: string
  /** where it came from: a chat image id, the original path, or "inline text" */
  source: string
  note?: string
  bytes: number
  type: ReferenceType
  addedAt: string
  /** an image of one orthographic view (from its name or note, or tagged by the unit) */
  view?: OrthoView
  /** metres across the shape in the image, left to right (the unit may add it) */
  span?: number
}

/** A checked attachment, ready to copy (the deploy tools resolve; crew and plans stage). */
export type ResolvedAttachment =
  | { kind: 'file'; path: string; name: string; bytes: number; source: string; note?: string }
  | { kind: 'text'; name: string; text: string; bytes: number; source: string; note?: string }

/** The Brief tab's row: name and note, a thumbnail for small images, the path the click opens. */
export interface ReferenceView {
  file: string
  note?: string
  type: ReferenceType
  path: string
  thumb?: string
}

const TYPES: [ReferenceType, string[]][] = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tga', 'tif', 'tiff', 'psd', 'exr', 'hdr', 'avif', 'heic', 'ico', 'dds', 'ktx', 'ktx2']],
  ['pdf', ['pdf']],
  ['document', ['doc', 'docx', 'odt', 'rtf', 'pages', 'epub']],
  ['spreadsheet', ['xls', 'xlsx', 'xlsm', 'ods', 'numbers']],
  ['slides', ['ppt', 'pptx', 'odp', 'key']],
  ['audio', ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'aif', 'aiff', 'mid', 'midi']],
  ['video', ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv']],
  ['model', ['glb', 'gltf', 'fbx', 'obj', 'blend', 'stl', 'ply', 'dae', '3ds', 'usd', 'usda', 'usdc', 'usdz', 'abc', 'vox']],
  ['archive', ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'unitypackage']],
  ['text', [
    'txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'svg', 'log', 'url',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'lua', 'sh', 'ps1', 'bat', 'sql',
    'gd', 'gdshader', 'tscn', 'tres', 'shader', 'hlsl', 'glsl', 'uss', 'uxml', 'unity', 'prefab', 'mat', 'asset', 'meta', 'srt', 'vtt'
  ]]
]
const BY_EXT = new Map(TYPES.flatMap(([type, exts]) => exts.map((e) => [e, type] as const)))

export function referenceType(file: string): ReferenceType {
  const ext = /\.([^./\\]+)$/.exec(file)?.[1]?.toLowerCase() ?? ''
  return BY_EXT.get(ext) ?? 'other'
}

const VIEW_WORDS: [OrthoView, RegExp, RegExp][] = [
  // [view, a word of the file name, a phrase of the note]
  ['front', /^front$/, /\bfront[- ](view|elevation)\b/],
  ['side', /^(side|profile)$/, /\b(side|profile)[- ](view|elevation)\b|\bside profile\b/],
  ['top', /^(top|topdown|plan)$/, /\b(top|top[- ]down|plan)[- ]view\b/]
]
/** Perspective images are never matched by numbers, whatever else the name says. */
const PERSPECTIVE = /(^|[^0-9])3[/_-]4([^0-9]|$)|three[- ]quarter|perspective|isometric|concept|sketch/i

/**
 * The orthographic view an image shows, from its file name (`ship_side.png`, `front.jpg`) or its note
 * ("side view", "top-down view"); undefined when neither names exactly one, or they call it perspective.
 */
export function orthoView(file: string, note?: string): OrthoView | undefined {
  const name = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '').toLowerCase()
  if (PERSPECTIVE.test(name) || PERSPECTIVE.test(note ?? '')) return undefined
  const words = name.split(/[^a-z]+/)
  const text = (note ?? '').toLowerCase()
  const hits = new Set(VIEW_WORDS.filter(([, word, phrase]) => words.some((w) => word.test(w)) || phrase.test(text)).map(([v]) => v))
  return hits.size === 1 ? [...hits][0] : undefined
}

/** Images the file-read tools and the Brief tab show as they are. */
export const VIEWABLE_IMAGE = /\.(png|jpe?g|gif|webp)$/i
