/**
 * A world's .genio/ folder: small, committable text that travels with the
 * world (units see it once it is committed). Genio writes here only on an
 * explicit player action (Save to world, saving FAL settings or a recipe) and
 * never commits; it never edits the world's root .gitignore/.gitattributes.
 *
 *   .genio/README.md        what this folder is
 *   .genio/.gitignore       cache/  (self-contained)
 *   .genio/.gitattributes   *.jsonl merge=union  (append-only logs merge cleanly)
 *   .genio/.gdignore        Godot worlds only: keep the editor out
 *   .genio/fal/config.json  save folders per kind, budget, per-endpoint defaults
 *   .genio/fal/recipes.json named presets (per-world favourites)
 *   .genio/fal/catalogue.json  optional: {add: [...entries], hide: [...endpoints]}
 *   .genio/uthana/config.json  Animation screen: save folder
 *   .genio/provenance/<asset path>.json  one record per saved generated asset
 *   .genio/spend.jsonl      one line per paid call (estimated USD)
 *
 * The run cache (history, downloaded outputs) stays in Genio's own data.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FalRecipe, FalWorldConfig } from '@shared/api'
import type { SpendLine } from '@shared/fal'
import type { Engine } from '@shared/types'
import type { WorldCatalogue } from './fal-catalogue'
import { git } from './git'
import { ensureDir, exists, isSubPath, readJson, readJsonl, readText, run, writeJson, writeText } from './util'

export const GENIO_DIR = '.genio'

export const genioPath = (root: string, ...parts: string[]): string => path.join(root, GENIO_DIR, ...parts)

const README = `# .genio

Machine-readable data Genio keeps with this world. Small text only; safe to read and edit by hand.

- \`fal/config.json\`: save folders per output kind, the monthly budget and the confirm threshold for the FAL screen.
- \`fal/recipes.json\`: named generation presets (this world's favourites). Units read them.
- \`fal/catalogue.json\` (optional): \`{"add": [...], "hide": [...]}\` to extend or trim Genio's curated FAL catalogue for this world.
- \`uthana/config.json\`: the Animation screen's save folder for this world.
- \`provenance/<asset path>.json\`: how each saved generated asset was made (model, request id, input, estimated price, sha256).
- \`spend.jsonl\`: one line per paid generation call (estimated USD). Merges with \`merge=union\`.
- \`cache/\`: ignored, normally empty. Genio keeps run history and downloads in its own data folder.

Genio writes here only when you save something from its FAL or Animation screens, and never commits. Commit these files with the assets they describe.
`

/** Create .genio/ with its own README, .gitignore and .gitattributes (never overwrites them). */
export function ensureGenioDir(root: string, engine?: Engine): string {
  const dir = ensureDir(genioPath(root))
  const put = (name: string, content: string): void => {
    const p = path.join(dir, name)
    if (!exists(p)) writeText(p, content)
  }
  put('README.md', README)
  put('.gitignore', 'cache/\n')
  put('.gitattributes', '*.jsonl merge=union\n')
  if (engine === 'godot') put('.gdignore', '')
  return dir
}

// ---------------------------------------------------------------- config / recipes / catalogue

export function readWorldConfig(root: string): FalWorldConfig {
  const c = readJson<FalWorldConfig>(genioPath(root, 'fal', 'config.json'), {})
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {}
}

/** Normalised config; keys the screen does not edit (e.g. providers) are kept as they are. */
export function cleanConfig(c: FalWorldConfig): FalWorldConfig {
  const { schema: _s, folders: _f, budget: _b, defaults: _d, ...rest } = c
  const out: FalWorldConfig = { schema: 'genio.fal-config.v1', ...rest }
  const folders = Object.fromEntries(Object.entries(c.folders ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim().replace(/\\/g, '/').replace(/^\/+/, '')]))
  if (Object.keys(folders).length) out.folders = folders
  const b = c.budget ?? {}
  const budget = Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0))
  if (Object.keys(budget).length) out.budget = budget
  if (c.defaults && Object.keys(c.defaults).length) out.defaults = c.defaults
  return out
}

export function writeWorldConfig(root: string, c: FalWorldConfig, engine?: Engine): FalWorldConfig {
  ensureGenioDir(root, engine)
  // merge over what is on disk so hand-edited keys (providers, ...) survive a save from the screen
  const clean = cleanConfig({ ...readWorldConfig(root), ...c })
  writeJson(genioPath(root, 'fal', 'config.json'), clean)
  return clean
}

export function readRecipesFile(file: string): FalRecipe[] {
  const v = readJson<unknown>(file, [])
  return Array.isArray(v) ? (v as FalRecipe[]).filter((r) => r && typeof r.id === 'string' && typeof r.endpoint === 'string') : []
}

export const worldRecipesFile = (root: string): string => genioPath(root, 'fal', 'recipes.json')

export function readWorldCatalogue(root: string): WorldCatalogue | undefined {
  const v = readJson<WorldCatalogue | undefined>(genioPath(root, 'fal', 'catalogue.json'), undefined)
  return v && typeof v === 'object' ? v : undefined
}

// ---------------------------------------------------------------- spend

export const spendFile = (root: string): string => genioPath(root, 'spend.jsonl')

export function readSpend(root: string): SpendLine[] {
  return readJsonl<SpendLine>(spendFile(root))
}

/** Append one paid call; a request id already in the ledger is not counted twice. */
export function appendSpend(root: string, line: SpendLine, engine?: Engine): boolean {
  if (line.request_id && readSpend(root).some((l) => l.request_id === line.request_id)) return false
  ensureGenioDir(root, engine)
  const p = spendFile(root)
  // keep the file newline-terminated so union merges stay line-based
  const prev = readText(p)
  fs.appendFileSync(p, `${prev && !prev.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`, 'utf8')
  return true
}

// ---------------------------------------------------------------- provenance

/**
 * .genio/provenance/<asset path mirrored>.json (same layout as the unit
 * helper's resources/unit-skills/genio/lib/genio-world.mjs); refuses assets
 * inside .genio/ and paths escaping .genio/provenance.
 */
export function provenancePath(root: string, relAsset: string): string {
  const rel = relAsset.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === GENIO_DIR || rel.startsWith(`${GENIO_DIR}/`)) throw new Error('Generated assets do not go inside .genio/.')
  const base = genioPath(root, 'provenance')
  const p = path.resolve(base, `${rel}.json`)
  if (!isSubPath(p, base) || p === path.resolve(base)) throw new Error('Provenance path escapes .genio/provenance.')
  return p
}

/** genio.provenance.v1, field for field what the unit helper writes. */
export interface Provenance {
  schema: 'genio.provenance.v1'
  path: string
  sha256: string
  provider: 'fal' | 'codex' | 'local' | 'uthana'
  endpoint: string
  request_id: string | null
  input: Record<string, unknown>
  seed?: number
  price: { unit: string | null; unit_price_usd: number | null; estimated_usd: number | null; checked: string } | null
  recipe: string | null
  derived_from: string[]
  /** 'player' from the screen, 'unit:<id>' from units */
  by: string
  created: string
}

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/**
 * Local file refs ("@file:<absolute path>") must not leak machine paths into a
 * committed record: files inside the world become world-relative, others keep
 * only their name. Returns the cleaned input and what the asset was derived from.
 */
export function provenanceInput(input: Record<string, unknown>, root: string): { input: Record<string, unknown>; derivedFrom: string[] } {
  const derived: string[] = []
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('@file:')) {
      const abs = v.slice(6)
      const ref = isSubPath(abs, root) ? path.relative(root, abs).replace(/\\/g, '/') : `local:${path.basename(abs)}`
      derived.push(ref)
      return `@file:${ref}`
    }
    if (typeof v === 'string' && /^https:\/\//.test(v) && /(fal\.media|fal\.run|fal\.ai)\//.test(v)) derived.push(v)
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]))
    return v
  }
  return { input: clean(input) as Record<string, unknown>, derivedFrom: [...new Set(derived)] }
}

export function writeProvenance(root: string, rec: Provenance, engine?: Engine): string {
  ensureGenioDir(root, engine)
  const p = provenancePath(root, rec.path)
  writeJson(p, rec)
  return path.relative(root, p).replace(/\\/g, '/')
}

// ---------------------------------------------------------------- git lfs

/**
 * Warnings for saving `rel` into a world that uses Git LFS: the file type is
 * not covered by its .gitattributes, or git-lfs is not installed. Read-only.
 */
export async function lfsWarnings(root: string, rel: string): Promise<string[]> {
  const attrs = readText(path.join(root, '.gitattributes'))
  if (!/filter=lfs/.test(attrs)) return []
  const r = await git(root, ['check-attr', 'filter', '--', rel], 15_000)
  if (r.code !== 0) return []
  const ext = path.extname(rel) || path.basename(rel)
  if (!/:\s*filter:\s*lfs\s*$/m.test(r.stdout)) {
    return [`This world uses Git LFS, but ${ext} files are not covered by its .gitattributes: committing ${rel} would store it as a regular blob.`]
  }
  const lfs = await run('git', ['lfs', 'version'], { cwd: root, timeoutMs: 15_000 })
  return lfs.code === 0 ? [] : ['This world tracks the file with Git LFS, but git-lfs is not installed: install it before committing.']
}
