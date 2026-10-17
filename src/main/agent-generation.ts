import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { AssetKind } from '@shared/inventory'
import type { GenerationCard } from '@shared/generation'
import type { ArtBibleStamp, FalRunRequest } from '@shared/api'
import { estimateRun } from '@shared/fal'
import { schemaDefaults, validateValues, type JsonSchema } from '@shared/fal-schema'
import { estimateUthana, textParamErrors, textParamsFor, UTHANA_BUILTINS, type UthanaGenerateRequest, type UthanaUploadRequest, type UthanaFormat } from '@shared/uthana'
import type { ChatImage } from '@shared/chat-images'
import type { ChatMessage } from '@shared/types'
import type { AppCtx } from './services'
import { bus } from './bus'
import { locateAsset } from './asset-tools'
import { noLinks, placementTarget, placeOutput } from './asset-placement'
import { chatImageGen, generateChatImages, MAX_REFS, resolveRefs, type GenerateImageArgs } from './chat-imagegen'
import { artBibleShape, bibleForCodex, bibleForFal, bibleForMotion } from './art-bible-gen'
import { chatImagePath } from './chat-images'
import { checkGenerationBudget, recordCodexGeneration } from './generation-spend'
import { provenanceInput, readWorldConfig, sha256File } from './fal-world'
import { nowIso, readJson, rid, writeJson } from './util'

const requestShape = { world: z.string().min(1), player_words: z.string().trim().min(1) }
const placementShape = { ...requestShape, place: z.string().min(1).optional(), name: z.string().min(1).optional() }
export const falGenerateShape = { ...placementShape, endpoint: z.string().min(3), input: z.record(z.string(), z.unknown()), ...artBibleShape }
export const uthanaMotionShape = { ...placementShape, prompt: z.string().min(3), model: z.string().default('text-to-motion-3.0'), character: z.string().optional(), length: z.number().positive().max(10).optional(), format: z.enum(['fbx', 'glb', 'bvh']).optional(), video: z.string().optional(), art_bible: artBibleShape.art_bible }
export const uthanaCharacterShape = { ...requestShape, path: z.string().min(1), name: z.string().optional(), auto_rig: z.boolean().default(true) }
export const assetPlaceShape = { ...requestShape, run: z.string(), output: z.number().int().min(0).max(3).default(0), path: z.string(), overwrite_words: z.string().trim().min(1).optional() }

type Placement = { world: string; player_words: string; place?: string; name?: string }
interface Job extends GenerationCard {
  wksp: string; ts: string; playerWords: string; target?: string; providerRun?: string; kind?: 'character'
  /** a design chat's image: its card posts into that conversation, never the project chat */
  conversation?: string
  request?: FalRunRequest | UthanaGenerateRequest | UthanaUploadRequest
  format?: UthanaFormat; images?: ChatImage[]; prompt?: string; refs?: string[]
  sourceHashes?: Record<string, string>
  /** provenance art_bible of a Codex image (FAL and Uthana keep theirs on the provider run) */
  artBibleStamp?: ArtBibleStamp
}

export class AgentGeneration {
  private jobs: Job[]
  private finishing = new Set<string>()
  private off: () => void
  private file: string
  constructor(private ctx: AppCtx) {
    this.file = path.join(ctx.main.home.data, 'generation-jobs.json')
    this.jobs = readJson<Job[]>(this.file, [])
    this.off = bus.onEvent(ev => {
      if (ev.type === 'fal-run' || ev.type === 'uthana-run') {
        const j = this.jobs.find(j => j.providerRun === ev.run.id)
        if (j) void this.advance(j).catch(e => this.failed(j, e))
      }
    })
    // Never resubmit an uncertain paid call after a restart. Existing provider jobs resume themselves.
    for (const j of this.jobs) if (j.status === 'running' || j.status === 'placing') {
      if (!j.providerRun) this.failed(j, new Error('Interrupted before the result was recorded. Inspect provider history before retrying.'))
      else void this.advance(j).catch(e => this.failed(j, e))
    }
  }
  stop(): void { this.off() }
  private save(): void { writeJson(this.file, this.jobs) }
  private project(world: string) {
    const p = this.ctx.projects.get(world)
    if (!p) throw new Error(`No project named ${world}`)
    return p
  }
  private requirePlayer(role: string, words?: string): void {
    if (role === 'bot' || !words?.trim()) throw new Error('Requires the player request; never available to Bot')
  }
  private post(j: Job): void {
    this.save()
    const text = `${j.model}: ${j.status}${j.paths.length ? '\n' + j.paths.join('\n') : ''}${j.error ? '\n' + j.error : ''}`
    const m: ChatMessage = { id: j.id, wksp: j.wksp, role: 'genio', ts: j.ts, text, generation: this.card(j), images: j.images }
    if (j.conversation) { this.ctx.home(j.wksp).design?.post(j.conversation, m); return }
    this.ctx.home(j.wksp).wksp.post(m, true)
    bus.publish({ type: 'generation', wksp: j.wksp, id: j.id, active: j.status === 'running' || j.status === 'placing' })
  }
  private card(j: Job): GenerationCard {
    const { id, provider, world, model, status, estimatedUsd, spentUsd, capUsd, paths, warnings, error, progress, outputs, artBible, approval } = j
    return { id, provider, world, model, status, estimatedUsd, spentUsd, capUsd, paths, warnings, error, progress, outputs, ...(approval ? { approval } : {}), ...(artBible ? { artBible } : {}) }
  }
  status(id: string, wksp: string): GenerationCard {
    return this.card(this.owned(id, wksp))
  }
  /** When the quote was shown: an approval in words must come after it. */
  quotedAt(id: string, wksp: string): string {
    return this.owned(id, wksp).ts
  }
  private owned(id: string, wksp: string): Job {
    const j = this.jobs.find(j => j.id === id && j.wksp === wksp)
    if (!j) throw new Error('No such generation in this chat')
    return j
  }
  /** The failed card is the report: the player sees it in chat, so no wake is queued for Genio. */
  private failed(j: Job, e: unknown): void {
    j.status = 'failed'; j.error = e instanceof Error ? e.message : String(e); this.post(j)
  }
  private async destination(a: Placement, kind: AssetKind, name: string): Promise<string> {
    this.requirePlayer('genio', a.player_words)
    let target = a.place
    if (!target) target = (await locateAsset(this.ctx, a.world, kind, a.name ?? name)).suggestions[0]?.path
    if (!target) throw new Error('No safe placement found; use asset_locate')
    await this.guardTarget(a.world, target)
    return target
  }
  private async guardTarget(world: string, target: string, overwrite = false): Promise<void> {
    const p = this.project(world), absolute = placementTarget(p, target)
    noLinks(p.path, '.genio/assets.json')
    const configured = readJson<{ vendor?: string[] }>(path.join(p.path, '.genio/assets.json'), {}).vendor
    if (Array.isArray(configured) && configured.some(v => typeof v === 'string' && target.toLowerCase().startsWith(v.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() + '/'))) throw new Error('Vendor assets are never placement targets')
    await this.ctx.inventory.refresh(world)
    // Include custom vendor flags measured by Inventory, not just known directory names.
    for (let offset = 0;; offset += 1000) {
      const vendors = await this.ctx.inventory.list(world, { scope: 'vendor', offset, limit: 1000 })
      if (vendors.items.some(a => target.toLowerCase().startsWith(a.folder.toLowerCase() + '/'))) throw new Error('Vendor assets are never placement targets')
      if (offset + vendors.items.length >= vendors.total || !vendors.items.length) break
    }
    if (!overwrite && fs.existsSync(absolute)) throw new Error('Target already exists; use asset_locate for a new name or asset_place with overwrite_words')
  }
  private create(wksp: string, a: Placement, provider: Job['provider'], model: string, usd: number, target?: string): Job {
    if (!Number.isFinite(usd) || usd < 0) throw new Error('A known nonnegative estimate is required')
    if (usd > 2) throw new Error('Delegate calls over $2 to a unit with an explicit budget')
    const budget = provider === 'codex' ? { confirm: false, spent: 0, cap: undefined } : checkGenerationBudget(this.ctx, a.world, usd)
    const j: Job = { id: `gen-${rid(8)}`, provider, model, world: a.world || undefined, status: budget.confirm ? 'awaiting_approval' : 'running', estimatedUsd: usd, spentUsd: budget.spent, capUsd: budget.cap, paths: [], warnings: [], wksp, ts: nowIso(), playerWords: a.player_words, target }
    this.jobs.push(j)
    return j
  }
  async fal(wksp: string, a: z.infer<z.ZodObject<typeof falGenerateShape>>, role = 'genio'): Promise<GenerationCard> {
    this.requirePlayer(role, a.player_words)
    const catalogue = this.ctx.fal.catalogue(a.world), info = await this.ctx.fal.model(a.endpoint)
    if (!info.schema) throw new Error('Cannot validate this endpoint: input schema unavailable')
    const entry = catalogue.entries.find(e => e.endpoint === a.endpoint)
    const root = this.project(a.world).path
    const config = readWorldConfig(root)
    const merged = { ...schemaDefaults(info.schema as JsonSchema), ...config.defaults?.[a.endpoint], ...a.input }
    // The Art Bible wraps the player's defaults and the request, before validation and the quote.
    const bible = a.art_bible === false ? undefined : bibleForFal(root, merged, { endpoint: a.endpoint, schema: info.schema, type: a.asset_type, kind: entry?.output })
    const input = bible?.value ?? merged
    const errors = validateValues(info.schema as JsonSchema, input)
    if (Object.keys(errors).length) throw new Error(JSON.stringify(errors))
    for (const k of ['num_images', 'num_samples', 'num_outputs']) if (input[k] !== undefined && (typeof input[k] !== 'number' || input[k] < 1 || input[k] > 4)) throw new Error('Delegate batches above four outputs to a unit')
    const usd = estimateRun(entry, info.price ?? entry?.price, input).usd
    if (usd === undefined) throw new Error('Price cannot be bounded from this input; delegate with an explicit budget')
    const kind = entry?.output === 'other' || !entry ? 'image' : entry.output
    const target = await this.destination(a, kind, 'new asset')
    const sourceHashes = this.fileHashes(input)
    const j = this.create(wksp, a, 'fal', a.endpoint, usd, target)
    j.request = { world: a.world, endpoint: a.endpoint, input, maxCostUsd: usd, ...(bible?.stamp ? { artBible: bible.stamp } : {}) }
    j.artBible = bible?.card
    j.sourceHashes = sourceHashes; this.post(j)
    if (j.status === 'running') this.start(j)
    return this.card(j)
  }
  async motion(wksp: string, a: z.infer<z.ZodObject<typeof uthanaMotionShape>>, role = 'genio'): Promise<GenerationCard> {
    this.requirePlayer(role, a.player_words)
    const p = this.project(a.world), format = a.format ?? (p.engine === 'unity' ? 'fbx' : 'glb')
    // Text models follow the Art Bible's Animation line; a video carries its own motion.
    const bible = a.art_bible === false || a.model.startsWith('video-') ? undefined : bibleForMotion(p.path, a.prompt)
    const text = textParamsFor(a.model, { prompt: bible?.value ?? a.prompt, length: a.length })
    const errors = textParamErrors(a.model, text)
    if (Object.keys(errors).length) throw new Error(JSON.stringify(errors))
    let video: UthanaGenerateRequest['video']
    if (a.video) {
      noLinks(p.path, a.video)
      const absolute = path.resolve(p.path, a.video)
      if (!absolute.startsWith(path.resolve(p.path) + path.sep)) throw new Error('Video must be in this project')
      this.ctx.uthana.inspect(absolute, 'video', a.world)
      video = { path: absolute, motionName: a.prompt }
    }
    if (a.model.startsWith('video-') !== !!video) throw new Error('Video models require a project-relative video; text models require a prompt')
    const usd = estimateUthana(a.model, { length: a.length }).usd
    if (usd === undefined) throw new Error('Unknown Uthana model')
    const target = await this.destination(a, 'animation', `${a.name ?? 'new motion'}.${format}`)
    if (path.extname(target) !== '.' + format) throw new Error('Placement extension must match the export format')
    const j = this.create(wksp, a, 'uthana', a.model, usd, target)
    j.format = format
    j.request = { world: a.world, model: a.model, characterId: a.character ?? UTHANA_BUILTINS.find(c => c.name === 'Manny')!.id, ...(video ? { video } : { text }), ...(bible?.stamp ? { artBible: bible.stamp } : {}) }
    j.artBible = bible?.card
    if (video) j.sourceHashes = { [video.path]: sha256File(video.path) }
    if (p.engine === 'unity') j.warnings.push('FBX imports as Generic until a unit or the player configures Humanoid import settings. Genio never edits .meta files.')
    this.post(j); if (j.status === 'running') this.start(j)
    return this.card(j)
  }
  async character(wksp: string, a: z.infer<z.ZodObject<typeof uthanaCharacterShape>>, role = 'genio') {
    this.requirePlayer(role, a.player_words)
    const p = this.project(a.world), absolute = path.resolve(p.path, a.path)
    if (!absolute.startsWith(path.resolve(p.path) + path.sep)) throw new Error('Character must be in this project')
    noLinks(p.path, path.relative(p.path, absolute).replace(/\\/g, '/'))
    this.ctx.uthana.inspect(absolute, 'character', a.world)
    const source = path.relative(p.path, absolute).replace(/\\/g, '/')
    const hash = sha256File(absolute)
    const existing = this.ctx.uthana.world(a.world).characters.find(c => c.source === source && c.sha256 === hash)
    if (existing) return { character: existing, reused: true }
    const j = this.create(wksp, a, 'uthana', 'auto-rig', estimateUthana('auto-rig', { autoRig: a.auto_rig }).usd!)
    j.kind = 'character'; j.request = { world: a.world, path: absolute, name: a.name ?? path.basename(absolute), autoRig: a.auto_rig }
    j.sourceHashes = { [absolute]: hash }
    this.post(j); if (j.status === 'running') this.start(j)
    return this.card(j)
  }
  /** The player's approval of one quote: their click on the card, or their own words verified by approve_run. */
  async approve(id: string, wksp: string, playerWords: string, role = 'genio', via: 'card' | 'words' = 'words'): Promise<GenerationCard> {
    this.requirePlayer(role, playerWords)
    const j = this.owned(id, wksp)
    if (j.status !== 'awaiting_approval') return this.card(j)
    checkGenerationBudget(this.ctx, j.world, j.estimatedUsd)
    if (j.target) await this.guardTarget(j.world!, j.target)
    // Re-check state after async preflight: double clicks submit exactly once.
    if (j.status === 'awaiting_approval') {
      j.approval = via === 'card' ? 'approved by you on this card' : 'approved by you in your own words'
      j.status = 'running'; this.start(j)
      if (j.status === 'running') this.ctx.stats.unlock('spend-approve')
    }
    return this.card(j)
  }
  private start(j: Job): void {
    try {
      for (const [file, hash] of Object.entries(j.sourceHashes ?? {})) if (sha256File(file) !== hash) throw new Error('Reference changed since the quote; request a fresh quote')
      checkGenerationBudget(this.ctx, j.world, j.estimatedUsd)
      this.post(j)
      const run = j.provider === 'fal' ? this.ctx.fal.run(j.request as FalRunRequest) : j.kind === 'character' ? this.ctx.uthana.upload(j.request as UthanaUploadRequest) : this.ctx.uthana.generate(j.request as UthanaGenerateRequest)
      j.providerRun = run.id; this.post(j)
      void this.advance(j).catch(e => this.failed(j, e))
    } catch (e) { this.failed(j, e) }
  }
  private fileHashes(value: unknown, result: Record<string, string> = {}): Record<string, string> {
    if (typeof value === 'string' && value.startsWith('@file:')) {
      const file = value.slice(6)
      result[file] = sha256File(file)
    } else if (Array.isArray(value)) value.forEach(v => this.fileHashes(v, result))
    else if (value && typeof value === 'object') Object.values(value).forEach(v => this.fileHashes(v, result))
    return result
  }
  private async advance(j: Job): Promise<void> {
    if (this.finishing.has(j.id) || !['running', 'placing'].includes(j.status)) return
    const run = j.provider === 'fal' ? this.ctx.fal.runs().find(r => r.id === j.providerRun) : this.ctx.uthana.runs().find(r => r.id === j.providerRun)
    if (!run) return this.failed(j, new Error('Provider run missing; no automatic resubmission'))
    if (run.status === 'failed' || run.status === 'cancelled') return this.failed(j, new Error(run.error ?? run.status))
    j.progress = run.status === 'queued' && 'queuePosition' in run && run.queuePosition !== undefined ? `Queue position ${run.queuePosition}` : run.status
    if ('outputs' in run) j.outputs = run.outputs.map(o => ({ name: o.fileName, kind: o.kind, url: o.mediaUrl }))
    if (run.status !== 'completed') { this.post(j); return }
    this.finishing.add(j.id)
    try {
      this.ctx.stats.unlock('agent-asset-first')
      if (j.kind === 'character') {
        j.warnings.push(`Character id: ${'characterId' in run ? run.characterId : ''}`)
      } else {
        j.status = 'placing'; this.post(j)
        const count = 'outputs' in run ? run.outputs.length : ('motionIds' in run ? run.motionIds?.length ?? 1 : 1)
        if (count < 1 || count > 4) throw new Error('Expected one to four outputs; inspect provider history')
        for (let i = j.paths.length; i < count; i++) {
          let target = j.target!
          if ('outputs' in run) {
            const output = run.outputs[i]
            const ext = path.extname(output.fileName)
            if (path.extname(target).toLowerCase() !== ext.toLowerCase()) target = (await locateAsset(this.ctx, j.world!, output.kind === 'other' ? 'image' : output.kind, path.basename(target, path.extname(target)) + ext, path.posix.dirname(target))).suggestions[0]?.path
          }
          if (!target) throw new Error('No safe destination for the output format')
          if (count > 1) target = target.slice(0, -path.extname(target).length) + `-${String(i + 1).padStart(2, '0')}` + path.extname(target)
          const result = await this.place(j.wksp, { run: j.id, output: i, world: j.world!, path: target, player_words: j.playerWords })
          j.paths.push(target); j.warnings.push(...(result.warnings ?? [])); this.post(j)
        }
      }
      j.status = 'completed'; this.post(j)
    } finally { this.finishing.delete(j.id) }
  }
  async place(wksp: string, a: z.infer<z.ZodObject<typeof assetPlaceShape>>, role = 'genio') {
    this.requirePlayer(role, a.player_words)
    const j = this.owned(a.run, wksp)
    if (j.world !== a.world) throw new Error('Output belongs to another project')
    const overwrite = !!a.overwrite_words?.trim()
    await this.guardTarget(a.world, a.path, overwrite)
    const by = wksp === 'main' ? 'genio' : `ally:${wksp}`
    const common = { project: a.world, folder: path.posix.dirname(a.path), fileName: path.posix.basename(a.path), overwrite, by, ...(j.approval ? { approval: j.approval.replace('by you', 'by the player') } : {}) }
    let result
    if (j.provider === 'fal') {
      const run = this.ctx.fal.runs().find(r => r.id === j.providerRun)
      if (!run || run.status !== 'completed' || !run.outputs[a.output]) throw new Error('Output is not ready')
      result = await this.ctx.fal.save({ ...common, runId: j.providerRun!, output: a.output })
    } else if (j.provider === 'uthana') {
      const run = this.ctx.uthana.runs().find(r => r.id === j.providerRun)
      if (!run || run.status !== 'completed' || a.output >= (run.motionIds?.length ?? 1)) throw new Error('Output is not ready')
      result = await this.ctx.uthana.saveToWorld({ ...common, runId: run.id, motionId: run.motionIds?.[a.output], format: j.format!, options: {}, dest: 'world' })
      const file = this.ctx.uthana.runs().find(r => r.id === run.id)?.files.find(f => f.motionId === (run.motionIds?.[a.output] ?? run.motionId) && f.format === j.format)
      if (file && !j.outputs?.some(o => o.name === file.fileName)) j.outputs = [...(j.outputs ?? []), { name: file.fileName, kind: 'animation', url: file.mediaUrl }]
    } else {
      const home = this.ctx.home(wksp).home, image = j.images?.[a.output]
      const source = image && chatImagePath(path.join(home.data, 'chat-images'), image.file)
      if (!source) throw new Error('No generated image at this output index')
      const p = this.project(a.world), prov = provenanceInput({ prompt: j.prompt, references: (j.refs ?? []).map(r => '@file:' + r) }, p.path)
      result = await placeOutput({ project: p, source, relative: a.path, role: 'genio', playerWords: a.player_words, overwrite,
        provenance: { schema: 'genio.provenance.v1', provider: 'codex', endpoint: 'image_gen', request_id: j.id, input: prov.input, price: null, recipe: null, derived_from: prov.derivedFrom, by, created: j.ts, ...(j.artBibleStamp ? { art_bible: j.artBibleStamp } : {}) },
        spend: { t: j.ts, provider: 'codex', request_id: j.id, est_usd: 0, by } })
    }
    if (!result.ok) throw new Error(result.message)
    this.ctx.stats.unlock('asset-placed-first')
    await this.ctx.inventory.refresh(a.world)
    return result
  }
  async image(wksp: string, a: GenerateImageArgs, role = 'genio', conversation?: string): Promise<GenerationCard> {
    if (role === 'bot') throw new Error('Bot cannot generate images')
    if (role === 'design' && (a.world || a.place || !conversation)) throw new Error('Lore chat images stay in their chat')
    if (a.place && !a.world) throw new Error('A placement requires a project')
    let target: string | undefined
    let root: string | undefined
    if (a.world) {
      this.requirePlayer(role, a.player_words)
      const p = this.project(a.world)
      root = p.path
      const codex = (readWorldConfig(p.path) as { providers?: { codex?: false | { enabled?: boolean } } }).providers?.codex
      if (codex === false || codex?.enabled === false) throw new Error('Codex images are disabled in this project')
      target = await this.destination({ world: a.world, place: a.place, player_words: a.player_words! }, 'image', 'new image.png')
      if (path.extname(target).toLowerCase() !== '.png') throw new Error('Codex outputs PNG; choose a .png placement')
    }
    const gen = chatImageGen(this.ctx, this.ctx.home(wksp).home)
    if (conversation) gen.quiet = true
    const own = resolveRefs(gen.chatDir, a.refs)
    // Project images follow its Art Bible: style text after the prompt, the type's references attached.
    const bible = root && a.art_bible !== false ? bibleForCodex(root, { prompt: a.prompt, type: a.asset_type, refs: own, room: MAX_REFS - own.length }) : undefined
    const sent: GenerateImageArgs = bible ? { ...a, prompt: bible.value.prompt, refs: bible.value.refs } : a
    const refs = bible?.value.refs ?? own
    const j = this.create(wksp, { world: a.world ?? '', player_words: a.player_words ?? '' }, 'codex', 'image_gen', 0, target)
    if (conversation) j.conversation = conversation
    j.prompt = sent.prompt; j.refs = refs; j.artBible = bible?.card; j.artBibleStamp = bible?.stamp; this.post(j)
    gen.post = (m) => {
      if (m.images) {
        j.images = m.images
        j.outputs = m.images.map(i => ({ name: i.file, kind: 'image', imageId: i.file }))
        // Preserve partial-failure and ChatGPT plan-meter notes from the existing helper.
        j.warnings.push(...m.text.split('\n').filter(line => /⚠|failed:/.test(line)))
      }
    }
    void generateChatImages(gen, sent).then(async result => {
      if (result.isError || !j.images?.length) throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'))
      recordCodexGeneration(this.ctx, j.id, j.world, j.ts)
      this.ctx.stats.unlock('agent-asset-first')
      if (target) {
        j.status = 'placing'; this.post(j)
        for (let i = 0; i < j.images.length; i++) {
          const dest = j.images.length === 1 ? target : target.replace(/\.png$/i, `-${String(i + 1).padStart(2, '0')}.png`)
          const result = await this.place(wksp, { run: j.id, output: i, world: a.world!, path: dest, player_words: a.player_words! })
          j.paths.push(dest); j.warnings.push(...(result.warnings ?? [])); this.post(j)
        }
      }
      j.status = 'completed'; this.post(j)
    }).catch(e => this.failed(j, e))
    return this.card(j)
  }
}

const services = new WeakMap<AppCtx, AgentGeneration>()
export function agentGeneration(ctx: AppCtx): AgentGeneration {
  let service = services.get(ctx)
  if (!service) { service = new AgentGeneration(ctx); services.set(ctx, service) }
  return service
}
