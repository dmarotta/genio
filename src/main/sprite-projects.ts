import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { SpriteExport, SpriteExportResult, SpriteProject } from '@shared/sprites'
import { sheetMetadata } from '@shared/sprites'
import type { FalRun } from '@shared/api'
import { suggestFolder } from '@shared/fal'
import type { Project } from '@shared/types'
import { appendSpend, provenancePath, readWorldConfig, sha256File, writeProvenance } from './fal-world'
import { ensureDir } from './util'

const int = (min: number, max: number) => z.number().int().min(min).max(max)
const png = z.string().max(24_000_000).startsWith('data:image/png;base64,')
export const spriteSchema = z.object({
  schema: z.literal('genio.sprite-project.v1'), id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  world: z.string().min(1).max(200).nullable(), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/),
  prompt: z.string().max(3000), source: z.union([z.literal(''), png]), updatedAt: z.string(),
  settings: z.object({
    animation: z.string().min(1).max(500), count: int(1, 16), width: int(8, 1024), height: int(8, 1024),
    directions: z.union([z.literal(1), z.literal(4), z.literal(8)]), playback: z.enum(['loop', 'ping-pong']),
    fps: int(1, 60), style: z.enum(['pixel', 'hd']), palette: z.string().max(2048), colors: int(1, 256), pixelScale: int(1, 64),
    method: z.enum(['grid', 'frames', 'video']), pivot: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    columns: int(1, 128), padding: int(0, 64)
  }),
  frames: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), image: png, direction: int(0, 7) })).max(128),
  runIds: z.array(z.string().max(100)).max(2000),
  generations: z.array(z.object({ prompt: z.string().max(6000), created: z.string(), sha256: z.string() })).max(2000)
})
export function validateProject(input: unknown): SpriteProject {
  const p = spriteSchema.parse(input)
  if (p.frames.some(f => f.direction >= p.settings.directions)) throw new Error('A frame has an invalid direction.')
  if (new Set(p.frames.map(f => f.id)).size !== p.frames.length) throw new Error('Frame IDs must be unique.')
  if (Math.max(p.frames.length, p.settings.count * p.settings.directions) * p.settings.width * p.settings.height > 32_000_000) throw new Error('Animation exceeds 32 megapixels of frame cells. Reduce cell size, frames or directions.')
  if (p.settings.style === 'pixel' && p.settings.palette.trim() && p.settings.palette.trim().split(/[\s,]+/).some(c => !/^#[a-f\d]{6}$/i.test(c))) throw new Error('Palette colors must be six-digit hex values, such as #182030.')
  if (JSON.stringify(p).length > 96_000_000) throw new Error('Project exceeds 96 MB. Reduce the frame size.')
  return p
}
export function pngBytes(uri: string): Buffer {
  const data = Buffer.from(png.parse(uri).slice('data:image/png;base64,'.length), 'base64')
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Expected a PNG image.')
  const w = data.readUInt32BE(16), h = data.readUInt32BE(20)
  if (!w || !h || w * h > 32_000_000 || w > 16384 || h > 16384) throw new Error('Image exceeds size limits.')
  return data
}
export class SpriteProjects {
  constructor(private readonly data: string) {}
  directory(world: string | null): string {
    return path.join(this.data, 'sprites', crypto.createHash('sha256').update(world === null ? 'scratch:' : `world:${world}`).digest('hex').slice(0, 24))
  }
  list(world: string | null): SpriteProject[] {
    const dir = this.directory(world)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9-]+\.json$/.test(n)).flatMap(n => {
      try { return [validateProject(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))] } catch { return [] }
    }).filter(p => p.world === world).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  save(input: SpriteProject): SpriteProject {
    const p = validateProject(input)
    if (p.source) pngBytes(p.source)
    p.frames.forEach(f => pngBytes(f.image))
    p.updatedAt = new Date().toISOString()
    const dest = path.join(ensureDir(this.directory(p.world)), `${p.id}.json`)
    fs.writeFileSync(`${dest}.tmp`, JSON.stringify(p))
    fs.renameSync(`${dest}.tmp`, dest)
    return p
  }
}
/** Reject traversal and links in both asset and provenance destinations. */
export function safeSpriteTarget(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(s => s === '..' || s.toLowerCase() === '.git')) throw new Error('Invalid export path.')
  const target = path.resolve(root, relative)
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Export must be inside the selected folder.')
  let current = target
  while (current !== path.resolve(root)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Export path contains a symbolic link.')
    current = path.dirname(current)
  }
  return target
}
export function exportSprites(req: SpriteExport, destination: string, world?: Project, runs: FalRun[] = []): SpriteExportResult {
  const p = validateProject(req.project), meta = sheetMetadata(p, req.unity), sheet = pngBytes(req.sheet)
  if (sheet.readUInt32BE(16) !== meta.width || sheet.readUInt32BE(20) !== meta.height) throw new Error('Sheet dimensions do not match metadata.')
  const cfg = world ? readWorldConfig(world.path) : {}
  const folders = cfg.folders as Record<string, string> | undefined
  const folder = world ? (folders?.sprite ?? folders?.image ?? suggestFolder(world.engine, 'image')) : ''
  if (folder.split(/[\\/]/)[0] === '.genio') throw new Error('Sprite assets cannot be saved inside .genio/.')
  const files: { name: string; data: string | Buffer }[] = [
    { name: `${p.name}.png`, data: sheet }, { name: `${p.name}.json`, data: JSON.stringify(meta, null, 2) + '\n' }
  ]
  if (req.individual) p.frames.forEach((f, i) => {
    const data = pngBytes(f.image)
    if (data.readUInt32BE(16) !== p.settings.width || data.readUInt32BE(20) !== p.settings.height) throw new Error('Normalize frames before export.')
    files.push({ name: `${p.name}-${String(i).padStart(3, '0')}.png`, data })
  })
  const targets = files.map(f => safeSpriteTarget(destination, path.join(folder, f.name)))
  if (world && targets.some(t => path.relative(destination, t).split(/[\\/]/)[0].toLowerCase() === '.genio')) throw new Error('Sprite assets cannot be saved inside .genio/.')
  const provTargets = world ? targets.map(t => {
    const rel = path.relative(destination, t)
    return safeSpriteTarget(destination, path.relative(destination, provenancePath(destination, rel)))
  }) : []
  if (world) safeSpriteTarget(destination, '.genio/spend.jsonl')
  const existing = [...targets, ...provTargets].filter(t => fs.existsSync(t))
  if (existing.length && !req.overwrite) return { ok: false, exists: true, paths: existing, message: `${existing.length} export files already exist. Replace them?` }
  const usedRuns = runs.filter(r => p.runIds.includes(r.id) && (r.world ?? null) === p.world)
  const sourceHash = p.source ? crypto.createHash('sha256').update(pngBytes(p.source)).digest('hex') : null
  files.forEach((f, i) => {
    const target = targets[i]
    ensureDir(path.dirname(target))
    fs.writeFileSync(target, f.data, { flag: req.overwrite ? 'w' : 'wx' })
    if (world) writeProvenance(destination, {
      schema: 'genio.provenance.v1', path: path.relative(destination, target).replace(/\\/g, '/'), sha256: sha256File(target),
      provider: usedRuns.length ? 'fal' : p.generations.length ? 'codex' : 'local', endpoint: 'genio/sprites', request_id: null,
      input: { project: p.id, prompt: p.prompt, settings: p.settings, source_sha256: sourceHash, generations: p.generations,
        runs: usedRuns.map(r => ({ endpoint: r.endpoint, request_id: r.requestId, estimated_usd: r.costUsd ?? r.estUsd })) },
      price: null, recipe: null, derived_from: usedRuns.flatMap(r => r.requestId ? [r.requestId] : []), by: 'player', created: new Date().toISOString()
    }, world.engine)
  })
  if (world) for (const r of usedRuns) appendSpend(destination, { t: r.createdAt, provider: 'fal', endpoint: r.endpoint, request_id: r.requestId ?? r.id, est_usd: r.costUsd ?? r.estUsd ?? 0, by: 'player' }, world.engine)
  return { ok: true, paths: targets, message: world ? `Saved to ${world.name}; files are uncommitted.` : 'Exported PNG and JSON.' }
}
