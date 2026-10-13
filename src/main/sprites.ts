import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { budgetCheck, estimateRun } from '@shared/fal'
import { directionLabel, type SpriteProject, type SpriteQuote, type SpriteAsset } from '@shared/sprites'
import type { AppCtx } from './services'
import { chatImageGen, friendlyError, runCodexImage } from './chat-imagegen'
import { chatImageDir } from './chat-images'
import { pngBytes, SpriteProjects, validateProject } from './sprite-projects'
import { ensureDir, rid } from './util'

export const SPRITE_ENDPOINTS = { video: 'fal-ai/veo3.1/lite/image-to-video', cutout: 'fal-ai/birefnet/v2', pixel: 'fal-ai/image2pixel' }
type Step = { kind: keyof typeof SPRITE_ENDPOINTS; direction: number; frame?: number; input: Record<string, unknown>; usd: number }
interface Ticket { project: SpriteProject; steps: Step[]; next: number; expires: number; budget: string }
export function spritePrompt(p: SpriteProject, kind: 'source' | 'grid' | 'frame' | 'video', direction: number, frame = 0): string {
  const s = p.settings
  const style = s.style === 'pixel' ? `Crisp pixel art, ${s.width}x${s.height} logical pixels, at most ${s.colors} colors. ${s.palette ? `Palette: ${s.palette}.` : ''} No antialiasing.` : 'High-definition illustrated game sprite.'
  const base = `${p.prompt}\n${style} Preserve the reference character's identity, costume, proportions and colors. Full body, no cropping, no text, no border, no checkerboard. Fixed camera and scale. ${kind === 'video' ? 'Plain contrasting background.' : 'Transparent background.'}`
  if (kind === 'source') return `Create a single character/object reference for game animation. ${base}`
  const action = `${s.animation} animation, facing ${directionLabel(direction, s.directions)}. ${s.playback === 'loop' ? 'Seamless cycle.' : 'Motion suitable for ping-pong playback.'}`
  if (kind === 'video') return `${base} ${action} One complete action over exactly four seconds. Stationary camera, plain contrasting background, no camera movement or scene cuts.`
  if (kind === 'frame') return `${base} ${action} Draw only pose ${frame + 1} of ${s.count}, at phase ${frame / s.count}. Neighbour references show adjacent poses for continuity. Keep ground contact at bottom centre.`
  const columns = Math.ceil(Math.sqrt(s.count)), rows = Math.ceil(s.count / columns)
  return `${base} ${action} Exactly ${s.count} sequential poses in a regular ${columns}-column by ${rows}-row grid of equal cells, row-major. Each pose centred horizontally, feet on the same baseline within its own cell. No gutters or labels. Empty final cells transparent. Every pose entirely inside its cell.`
}
export function createSpriteService(getCtx: () => AppCtx, generate = runCodexImage) {
  const tickets = new Map<string, Ticket>()
  const ctx = () => getCtx()
  const store = () => new SpriteProjects(ctx().main.home.data)
  const checkWorld = (world: string | null) => {
    if (world && !ctx().projects.get(world)) throw new Error(`No world named ${world}.`)
  }
  const budgetStamp = (world: string | null) => {
    const state = ctx().fal.world(world)
    return JSON.stringify([state.spentUsd, state.config.budget])
  }
  return {
    list(world: string | null) { checkWorld(world); return store().list(world) },
    save(p: SpriteProject) { checkWorld(p.world); return store().save(p) },
    assets(world: string | null): SpriteAsset[] {
      checkWorld(world)
      const result: SpriteAsset[] = []
      for (const [name, home] of ctx().homes) {
        const dir = chatImageDir(home.home.data)
        if (fs.existsSync(dir)) for (const file of fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).slice(-80)) result.push({ label: `Chat ${name} / ${file}`, path: path.join(dir, file) })
      }
      for (const r of ctx().fal.runs().filter(r => (r.world ?? null) === world)) for (const o of r.outputs) {
        if (o.kind === 'image' && o.localPath) result.push({ label: `FAL / ${o.fileName}`, path: o.localPath })
      }
      return result.slice(-200)
    },
    readImage(file: string): string {
      const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
      const type = mime[path.extname(file).toLowerCase()]
      if (!path.isAbsolute(file) || !type || !fs.statSync(file).isFile() || fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, WebP or GIF under 20 MB.')
      return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
    },
    async codex(input: SpriteProject, kind: 'source' | 'grid' | 'frame', direction: number, frame = 0) {
      const p = validateProject(input); checkWorld(p.world)
      if (!['source', 'grid', 'frame'].includes(kind) || !Number.isInteger(direction) || direction < 0 || direction >= p.settings.directions || !Number.isInteger(frame) || frame < 0 || frame >= 128) throw new Error('Invalid generation request.')
      const provider = ctx().fal.world(p.world).config.providers?.codex as { enabled?: boolean } | undefined
      if (provider?.enabled === false) throw new Error('Codex images are disabled for this world.')
      if (kind !== 'source' && !p.source) throw new Error('Choose a source first.')
      const gen = chatImageGen(ctx(), ctx().main.home)
      ensureDir(gen.run.scratch)
      const dir = ensureDir(path.join(store().directory(p.world), 'generation', rid(8)))
      const refs: string[] = []
      const addRef = (uri: string) => {
        const file = path.join(dir, `ref-${refs.length}.png`); fs.writeFileSync(file, pngBytes(uri)); refs.push(file)
      }
      if (p.source) addRef(p.source)
      if (kind === 'frame') {
        const same = p.frames.filter(f => f.direction === direction)
        const at = p.frames[frame]
        const index = at?.direction === direction ? same.findIndex(f => f.id === at.id) : same.length
        for (const f of [same[index - 1], same[index + 1]].filter(Boolean)) addRef(f.image)
      }
      const target = p.frames[frame]
      const same = p.frames.filter(f => f.direction === direction)
      const regenerating = kind === 'frame' && target?.direction === direction
      const phase = regenerating ? same.findIndex(f => f.id === target.id) : frame
      const prompt = spritePrompt(regenerating ? { ...p, settings: { ...p.settings, count: same.length } } : p, kind, direction, phase), out = path.join(dir, 'generated.png')
      const { result, error } = await generate(gen.run, [out], prompt, true, refs)
      if (!result?.images.some(i => i.ok && i.out === out) || !fs.existsSync(out)) throw new Error(friendlyError(error ?? result?.images[0]?.error ?? 'Codex made no image.'))
      const image = `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`
      const bytes = pngBytes(image)
      return { image, generation: { prompt, created: new Date().toISOString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, warning: result.warning ?? result.plan_meter?.warning ?? undefined }
    },
    async quote(input: SpriteProject): Promise<SpriteQuote> {
      const p = validateProject(input); checkWorld(p.world)
      if (!p.source) throw new Error('Choose a source first.')
      pngBytes(p.source)
      const catalogue = ctx().fal.catalogue(p.world), kinds: (keyof typeof SPRITE_ENDPOINTS)[] = ['video', 'cutout', ...(p.settings.style === 'pixel' ? ['pixel' as const] : [])]
      const prices = new Map<keyof typeof SPRITE_ENDPOINTS, number>()
      for (const kind of kinds) {
        const endpoint = SPRITE_ENDPOINTS[kind], entry = catalogue.entries.find(e => e.endpoint === endpoint)
        const info = await ctx().fal.model(endpoint)
        const estimate = estimateRun(entry, info.price ?? entry?.price, kind === 'video' ? { duration_seconds: 4 } : {})
        if (estimate.usd === undefined || !Number.isFinite(estimate.usd) || estimate.usd < 0) throw new Error(`No usable price for ${endpoint}; cannot confirm a paid pipeline.`)
        prices.set(kind, estimate.usd)
      }
      const steps: Step[] = []
      for (let d = 0; d < p.settings.directions; d++) {
        steps.push({ kind: 'video', direction: d, input: { prompt: spritePrompt(p, 'video', d), duration: '4s', resolution: '720p', aspect_ratio: '16:9', generate_audio: false }, usd: prices.get('video')! })
        for (let f = 0; f < p.settings.count; f++) {
          steps.push({ kind: 'cutout', direction: d, frame: f, input: { output_format: 'png' }, usd: prices.get('cutout')! })
          if (p.settings.style === 'pixel') steps.push({ kind: 'pixel', direction: d, frame: f, input: {
            max_colors: p.settings.colors, scale: p.settings.pixelScale, transparent_background: true,
            ...(p.settings.palette.trim() ? { fixed_palette: p.settings.palette.split(/[\s,]+/).filter(Boolean) } : {})
          }, usd: prices.get('pixel')! })
        }
      }
      const usd = steps.reduce((n, s) => n + s.usd, 0), state = ctx().fal.world(p.world), id = rid(16)
      for (const [key, t] of tickets) if (t.expires < Date.now()) tickets.delete(key)
      tickets.set(id, { project: p, steps, next: 0, expires: Date.now() + 5 * 60_000, budget: budgetStamp(p.world) })
      return { id, usd, calls: steps.length, reasons: budgetCheck(state.spentUsd, usd, state.config.budget, p.world ?? 'Scratch').reasons,
        breakdown: kinds.map(kind => ({ label: kind, calls: steps.filter(s => s.kind === kind).length, usd: steps.filter(s => s.kind === kind).reduce((n, s) => n + s.usd, 0) })) }
    },
    /** A ticket authorizes only the displayed plan, once and in order. No hidden paid retries. */
    paidStep(id: string, confirmed: boolean, stepIndex: number, image: string) {
      const t = tickets.get(id)
      if (!confirmed || !t || t.expires < Date.now()) throw new Error('Confirm a fresh FAL cost estimate before running.')
      if (stepIndex !== t.next || !t.steps[stepIndex]) throw new Error('This paid step was already submitted or is out of order.')
      if (t.next === 0 && t.budget !== budgetStamp(t.project.world)) throw new Error('World spend or budget changed. Review a new estimate.')
      const step = t.steps[t.next]
      const bytes = pngBytes(image)
      const file = path.join(ensureDir(path.join(store().directory(t.project.world), 'fal-inputs', id)), `${stepIndex}.png`)
      fs.writeFileSync(file, bytes, { flag: 'wx' })
      t.next++ // consume before the provider call, including an uncertain failure
      t.expires = Date.now() + 2 * 60 * 60_000
      const run = ctx().fal.run({ endpoint: SPRITE_ENDPOINTS[step.kind], world: t.project.world ?? undefined, input: { ...step.input, image_url: `@file:${file}` } })
      return run
    },
    abandon(id: string): void { tickets.delete(id) }
  }
}
export type SpriteService = ReturnType<typeof createSpriteService>
