import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '@shared/types'
import type { SpendLine } from '@shared/fal'
import { appendSpend, lfsWarnings, provenancePath, sha256File, writeProvenance, type Provenance } from './fal-world'

const MEDIA = /\.(png|jpe?g|webp|gif|tga|tiff?|exr|bmp|psd|wav|ogg|mp3|flac|m4a|aac|mp4|webm|mov|glb|gltf|fbx|obj|bvh)$/i
const FORBIDDEN = /^(?:\.git|\.genio|\.godot|\.import|Library|Temp|Logs|obj|Build.*|dist|out|UserSettings|ProjectSettings|Packages|Intermediate|Saved|DerivedDataCache|Binaries|node_modules|Editor|Resources|StreamingAssets|AddressableAssetsData|generated|vendor|third[-_ ]?party|plugins|textmesh pro|microsplatdata|addons)$/i

/** No link traversal, including provenance and scaffold files. Check again immediately before writes. */
export function noLinks(root: string, relative: string): void {
  let p = root
  for (const part of ['', ...relative.split('/')]) {
    p = path.join(p, part)
    const stat = fs.lstatSync(p, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() || stat?.isFile() && stat.nlink > 1) throw new Error('Refusing symlink, junction or hardlink placement')
  }
}

export function placementTarget(project: Pick<Project, 'path' | 'engine' | 'engineRoot'>, relative: string, agent = true): string {
  if (!relative || /[\\:\x00-\x1f<>"|?*]/.test(relative) || relative.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))) throw new Error('Expected a safe world-relative media path')
  if (!MEDIA.test(relative)) throw new Error('Only generated media may be placed; no code, scenes, prefabs or .meta files')
  const parts = relative.split('/')
  if (parts.slice(0, -1).some(s => (FORBIDDEN.test(s) && (agent || !/^generated$/i.test(s))) || project.engine === 'unreal' && /^Content$/i.test(s))) throw new Error('Forbidden placement directory')
  const engineRoot = (project.engineRoot ?? '').replace(/\\/g, '/').replace(/\/$/, '')
  if (engineRoot && !relative.toLowerCase().startsWith(engineRoot.toLowerCase() + '/')) throw new Error('Placement must stay under the engine root')
  if (agent && project.engine === 'unity' && /\.(glb|gltf)$/i.test(relative) && parts.some(s => /^Assets$/i.test(s))) throw new Error('Unity glTF sources must stay outside Assets; use asset_locate')
  noLinks(project.path, relative)
  // Match Inventory's inferred pack roots, including new sibling folders with no media yet.
  let ancestor = project.path
  for (const part of parts.slice(0, -1)) {
    ancestor = path.join(ancestor, part)
    if (!fs.existsSync(ancestor)) break
    const children = fs.readdirSync(ancestor, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name.toLowerCase())
    if (children.includes('documentation') && (children.includes('demo') || children.includes('scenes'))) throw new Error('Vendor pack root is a forbidden placement directory')
  }
  return path.join(project.path, relative)
}

export interface PlaceOutput {
  project: Project
  source: string
  relative: string
  provenance: Omit<Provenance, 'path' | 'sha256'>
  spend: SpendLine
  overwrite?: boolean
  role?: 'genio' | 'bot' | 'player'
  playerWords?: string
}

/** Shared by the existing Save buttons and the guarded agent tool. Never commits. */
export async function placeOutput(a: PlaceOutput) {
  if (a.role === 'bot') throw new Error('Bot cannot place assets')
  if (a.role === 'genio' && !a.playerWords?.trim()) throw new Error('Placement requires player_words quoting the asset request')
  const target = placementTarget(a.project, a.relative, a.provenance.by !== 'player' || a.role === 'genio')
  if (path.extname(a.source).toLowerCase() !== path.extname(target).toLowerCase()) throw new Error('Target extension must match the generated output')
  if (fs.existsSync(target) && !a.overwrite) return { ok: false, exists: true, path: target, message: `${a.relative} already exists; choose another name or confirm overwrite.` }
  const provPath = provenancePath(a.project.path, a.relative)
  for (const file of ['.genio/README.md', '.genio/.gitignore', '.genio/.gitattributes', '.genio/.gdignore', '.genio/spend.jsonl', path.relative(a.project.path, provPath).replace(/\\/g, '/')]) noLinks(a.project.path, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(a.source, target, a.overwrite ? 0 : fs.constants.COPYFILE_EXCL)
  const provenance = writeProvenance(a.project.path, { ...a.provenance, path: a.relative, sha256: sha256File(target) }, a.project.engine)
  appendSpend(a.project.path, a.spend, a.project.engine)
  return { ok: true, path: target, provenance, warnings: await lfsWarnings(a.project.path, a.relative), message: `Saved to ${a.project.name}/${a.relative}` }
}
