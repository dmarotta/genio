/**
 * Uthana generation logic shared by main and renderer: run and
 * character records, the models Genio offers with their published prices,
 * download (export) option mapping, cost estimates and the per-world spend.
 * Pure functions; no I/O. API facts were checked against uthana.com/docs/api
 * and uthana.com/pricing on 2026-10-13.
 */
import type { FalBudget, FalRun } from './api'
import { fmtUsd, monthKey, worldSpend, type SpendLine } from './fal'
import type { Engine } from './types'

export const UTHANA_ORIGIN = 'https://uthana.com'
export const UTHANA_GRAPHQL = `${UTHANA_ORIGIN}/graphql`
/** when the snapshot prices below were read from uthana.com/pricing */
export const UTHANA_PRICES_CHECKED = '2026-10-13'

// ---------------------------------------------------------------- characters

export interface UthanaBuiltin {
  id: string
  name: string
}

/** Uthana's stock characters (ids from the official clients). Tar is the API default. */
export const UTHANA_BUILTINS: UthanaBuiltin[] = [
  { id: 'cXi2eAP19XwQ', name: 'Tar' },
  { id: 'cmEE2fT4aSaC', name: 'Ava' },
  { id: 'c43tbGks3crJ', name: 'Manny' },
  { id: 'czCjWEMtWxt8', name: 'Quinn' },
  { id: 'cJM4ngRqXg83', name: 'Y Bot' }
]
export const UTHANA_DEFAULT_CHARACTER = UTHANA_BUILTINS[0]

/** Characters the docs name for roblox_compatible FBX (others need Roblox metadata, e.g. an R15 rerig). */
export const UTHANA_ROBLOX_CHARACTERS = ['cFB7NoFCUCvf', 'cg1RuTM77HXu', 'c8EaC2nVbPS8']

/** A character uploaded from Genio, remembered per world. */
export interface UthanaCharacterRecord {
  id: string
  name: string
  /** world it was uploaded for (undefined: Scratch) */
  world?: string
  /** world-relative path of the source file, or local:<name> for files outside the world */
  source?: string
  sha256?: string
  /** 0-1 from Uthana when it auto-rigged the mesh */
  autoRigConfidence?: number
  rerigTarget?: string
  message?: string
  /** the upload run that created it */
  runId?: string
  createdAt: string
}

/** A character as Uthana's `characters` query lists it. */
export interface UthanaRemoteCharacter {
  id: string
  name: string
  created?: string
}

export const UTHANA_CHARACTER_EXTS = ['fbx', 'glb', 'gltf']
export const UTHANA_VIDEO_EXTS = ['mp4', 'mov', 'avi']
export const UTHANA_CHARACTER_MAX_BYTES = 30 * 1024 * 1024
export const UTHANA_RERIG_TARGETS = ['r15', 'ue5'] as const

// ---------------------------------------------------------------- models and prices

export type UthanaRunKind = 'text' | 'video' | 'character'

export interface UthanaModel {
  /** the string the API takes (`model` argument) */
  id: string
  kind: UthanaRunKind
  label: string
  hint: string
  /** async job (submit, then poll `job`) instead of an immediate result */
  job: boolean
  /** USD per generated second (motions) or per operation (rigging) */
  unitPrice: number
  unit: 'seconds' | 'rig'
}

export const UTHANA_MODELS: UthanaModel[] = [
  {
    id: 'text-to-motion-3.0',
    kind: 'text',
    label: 'Text to motion 3.0',
    hint: 'Diffusion model, best quality, 4-10 s. Async job. Pay-as-you-go accounts.',
    job: true,
    unitPrice: 0.1,
    unit: 'seconds'
  },
  { id: 'text-to-motion-bucmd', kind: 'text', label: 'Text to motion 2.0', hint: 'Length, steps, guidance and seed control. Immediate result.', job: false, unitPrice: 0.03, unit: 'seconds' },
  { id: 'text-to-motion', kind: 'text', label: 'Text to motion 1.0', hint: 'Fast and cheapest; the model picks the length. Immediate result.', job: false, unitPrice: 0.02, unit: 'seconds' },
  { id: 'video-to-motion-2.0', kind: 'video', label: 'Video to motion 2.0', hint: 'Motion capture from a 2-60 s video of one person. Async job.', job: true, unitPrice: 0.05, unit: 'seconds' },
  { id: 'video-to-motion-2.1', kind: 'video', label: 'Video to motion 2.1', hint: '2.0 plus post-processing refinements; returns refined motions. Async job.', job: true, unitPrice: 0.05, unit: 'seconds' },
  { id: 'auto-rig', kind: 'character', label: 'Character upload', hint: 'Auto-rigging is billed per rig when the mesh has no skeleton.', job: false, unitPrice: 0.15, unit: 'rig' }
]

export const uthanaModel = (id: string): UthanaModel | undefined => UTHANA_MODELS.find((m) => m.id === id)

/** Longest output each model can produce, for "up to" estimates when the length is not known up front. */
const MAX_SECONDS: Record<string, number> = { 'text-to-motion': 10, 'text-to-motion-bucmd': 10, 'text-to-motion-3.0': 10, 'video-to-motion-2.0': 60, 'video-to-motion-2.1': 60 }

/** Text-to-motion parameters as the form holds them (the API's names). */
export interface UthanaTextParams {
  prompt: string
  foot_ik?: boolean
  /** 2.0: 0.25-10 s (default 10); 3.0: integer 4-10 (default 8) */
  length?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  retargeting_ik?: boolean
  rewrite_prompt?: boolean
  fast?: boolean
}

/** Model defaults the API applies when a field is left out. */
export const UTHANA_DEFAULTS: Record<string, Partial<UthanaTextParams>> = {
  'text-to-motion': { foot_ik: false },
  'text-to-motion-bucmd': { length: 10, steps: 50, cfg_scale: 2, foot_ik: false, retargeting_ik: true },
  'text-to-motion-3.0': { length: 8, rewrite_prompt: true, fast: false }
}

/** The parameters each text model takes. */
const TEXT_FIELDS: Record<string, (keyof UthanaTextParams)[]> = {
  'text-to-motion': ['prompt', 'foot_ik'],
  'text-to-motion-bucmd': ['prompt', 'foot_ik', 'length', 'steps', 'cfg_scale', 'seed', 'retargeting_ik'],
  'text-to-motion-3.0': ['prompt', 'length', 'rewrite_prompt', 'fast']
}

/** Only the parameters this model takes (the form keeps every model's values while the player switches). */
export function textParamsFor(model: string, p: UthanaTextParams): UthanaTextParams {
  const keys = TEXT_FIELDS[model] ?? ['prompt']
  const out = Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) as Partial<UthanaTextParams>
  return { ...out, prompt: (p.prompt ?? '').trim() }
}

/** Field problems for a text-to-motion request (empty: OK to send). */
export function textParamErrors(model: string, p: UthanaTextParams): Record<string, string> {
  const e: Record<string, string> = {}
  if (!p.prompt?.trim()) e.prompt = 'Describe the motion.'
  const range = (k: keyof UthanaTextParams, lo: number, hi: number, int = false): void => {
    const v = p[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) e[k] = `${int ? 'A whole number' : 'A number'} from ${lo} to ${hi}.`
  }
  if (model === 'text-to-motion-bucmd') {
    range('length', 0.25, 10)
    range('steps', 1, 150, true)
    range('cfg_scale', 0, 10)
    range('seed', 1, 99999, true)
  }
  if (model === 'text-to-motion-3.0') range('length', 4, 10, true)
  return e
}

export interface UthanaEstimate {
  /** USD to budget against: exact when the output length is known, else the most it can cost */
  usd?: number
  /** the length is not known before the run: usd is a ceiling */
  upTo?: boolean
  text: string
}

/** Estimate one generation from the snapshot price. `seconds` is the output length when known (e.g. the video's). */
export function estimateUthana(modelId: string, opts: { length?: number; seconds?: number; autoRig?: boolean } = {}): UthanaEstimate {
  const m = uthanaModel(modelId)
  if (!m) return { text: 'price unknown' }
  if (m.unit === 'rig') {
    if (opts.autoRig === false) return { usd: 0, text: '$0 (no auto-rig)' }
    return { usd: m.unitPrice, upTo: true, text: `up to ${fmtUsd(m.unitPrice)} (only if Uthana auto-rigs it)` }
  }
  const rate = `$${m.unitPrice}/s`
  const def = UTHANA_DEFAULTS[modelId]?.length
  const takesLength = TEXT_FIELDS[modelId]?.includes('length')
  const secs = opts.seconds ?? (m.kind === 'text' && takesLength ? opts.length ?? def : undefined)
  if (secs !== undefined && Number.isFinite(secs) && secs > 0) {
    const s = modelId === 'text-to-motion-3.0' ? Math.round(Math.min(10, Math.max(4, secs))) : secs
    return { usd: s * m.unitPrice, text: `≈ ${fmtUsd(s * m.unitPrice)} · ${+s.toFixed(2)} s × ${rate}` }
  }
  const max = MAX_SECONDS[modelId]
  return max ? { usd: max * m.unitPrice, upTo: true, text: `up to ${fmtUsd(max * m.unitPrice)} · ${rate}, length set by the ${m.kind === 'video' ? 'video' : 'model'}` } : { text: rate }
}

// ---------------------------------------------------------------- runs

export type UthanaRunStatus = 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export const UTHANA_IN_FLIGHT: ReadonlySet<UthanaRunStatus> = new Set(['submitting', 'queued', 'running'])

/** A file Genio downloaded for a run (preview or export), kept in its run folder. */
export interface UthanaFile {
  fileName: string
  motionId: string
  format: UthanaFormat
  options: UthanaExportOptions
  /** 'mesh' = GLB with the character; 'skeleton' = motion-only GLB */
  preview?: 'mesh' | 'skeleton'
  size: number
  mediaUrl: string
  localPath: string
  createdAt: string
}

/** One Uthana generation service call (generation or character upload) and what came back. */
export interface UthanaRun {
  id: string
  kind: UthanaRunKind
  /** model id as sent to the API ('auto-rig' for uploads) */
  model: string
  /** what was asked: prompt and parameters; files as "@file:<absolute path>" */
  input: Record<string, unknown>
  /** the character motions are retargeted to on download */
  characterId: string
  characterName?: string
  status: UthanaRunStatus
  /** Uthana job id (async models) */
  jobId?: string
  /** the job's own status (RESERVED, READY, FINISHED, FAILED) */
  jobStatus?: string
  /** Uthana's estimate in seconds, when it gives one */
  estProcessingSecs?: number
  motionId?: string
  /** every motion the run produced (video-to-motion 2.1 can return several) */
  motionIds?: string[]
  motionName?: string
  /** a character upload's result */
  character?: UthanaCharacterRecord
  /** seconds of motion, measured from the downloaded clip */
  outputSeconds?: number
  /** Genio's estimate before the run (USD; a ceiling when upTo) */
  estUsd?: number
  estUpTo?: boolean
  /** the job result as Uthana returned it (trimmed) */
  result?: unknown
  files: UthanaFile[]
  error?: string
  world?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

/** Cost of a run: measured length × rate when known, else the estimate. */
export function runCost(r: Pick<UthanaRun, 'model' | 'outputSeconds' | 'estUsd' | 'status' | 'kind' | 'character'>): number | undefined {
  const m = uthanaModel(r.model)
  if (r.kind === 'character') return r.status === 'completed' && r.character?.autoRigConfidence === undefined ? 0 : r.estUsd
  if (m && r.outputSeconds !== undefined) return r.outputSeconds * m.unitPrice
  return r.estUsd
}

/** The ledger id of a run's spend line (what save-to-world writes, so a run is never counted twice). */
export const uthanaRequestId = (r: Pick<UthanaRun, 'motionId' | 'jobId' | 'id' | 'character'>): string => `uthana:${r.motionId ?? r.character?.id ?? r.jobId ?? r.id}`

/**
 * A world's estimated spend this month across providers: its .genio/spend.jsonl,
 * Genio's unsaved FAL runs, and Uthana runs whose spend line is not in the ledger yet.
 */
export function uthanaWorldSpend(lines: SpendLine[], falRuns: FalRun[], runs: UthanaRun[], world: string | null, month = monthKey()): number {
  let total = worldSpend(lines, falRuns, world, month)
  const seen = new Set(lines.map((l) => l.request_id).filter(Boolean))
  for (const r of runs) {
    if ((r.world ?? null) !== world || monthKey(r.createdAt) !== month) continue
    if (r.status === 'failed' || r.status === 'cancelled') continue
    if (seen.has(uthanaRequestId(r))) continue
    total += runCost(r) ?? 0
  }
  return total
}

/** Characters remembered for a world, newest first, without duplicates. */
export function worldCharacters(list: UthanaCharacterRecord[], world: string | null): UthanaCharacterRecord[] {
  const seen = new Set<string>()
  return list
    .filter((c) => (c.world ?? null) === world)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((c) => !seen.has(c.id) && Boolean(seen.add(c.id)))
}

/** The job's result object (Uthana sends it as JSON, sometimes as a JSON string). */
export function jobResult(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') {
    try {
      return jobResult(JSON.parse(v))
    } catch {
      return v.trim() ? { message: v } : undefined
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** Motion ids in a finished job: result.result.id (documented), plus lists of refined motions (2.1). */
export function jobMotionIds(result: unknown): string[] {
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v)
  }
  const visit = (o: Record<string, unknown> | undefined, depth: number): void => {
    if (!o || depth > 3) return
    const motion = jobResult(o.motion)
    add(o.motion_id)
    if (motion) add(motion.id)
    for (const [k, v] of Object.entries(o)) {
      if (/motion_ids$|^motions$/i.test(k) && Array.isArray(v)) for (const x of v) add(typeof x === 'string' ? x : jobResult(x)?.id)
    }
    if (o.result !== undefined) {
      const inner = jobResult(o.result)
      if (inner) {
        add(inner.id)
        visit(inner, depth + 1)
      }
    }
  }
  visit(jobResult(result), 0)
  return out
}

/** A failed job's reason, from its result. */
export function jobError(result: unknown): string {
  const r = jobResult(result)
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  return pick(r?.message) ?? pick(r?.error) ?? pick(jobResult(r?.result)?.message) ?? pick(jobResult(r?.result)?.error) ?? (r ? JSON.stringify(r).slice(0, 400) : 'Uthana reported the job as failed.')
}

/** Map Uthana's job status onto the run states the screen shows. */
export function runStatusOfJob(status: string | undefined): UthanaRunStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'FINISHED':
      return 'completed'
    case 'FAILED':
      return 'failed'
    case 'RESERVED':
      return 'queued'
    default:
      return 'running'
  }
}

// ---------------------------------------------------------------- export / download

export type UthanaFormat = 'glb' | 'fbx' | 'bvh'
export const UTHANA_FORMATS: UthanaFormat[] = ['fbx', 'glb', 'bvh']
export const UTHANA_FPS = [24, 30, 60] as const

/** Download options; every field maps to one query parameter of the motion download endpoint. */
export interface UthanaExportOptions {
  /** fps: 24, 30 or 60 (server default when unset) */
  fps?: number
  /** in_place: remove horizontal root motion */
  inPlace?: boolean
  /** torso_only: keep the lower body still */
  torsoOnly?: boolean
  /** roblox_compatible: FBX for Roblox Studio (experimental; Roblox characters only) */
  robloxCompatible?: boolean
  /** no_mesh: true = animation only; 'minimal' = skeleton-like mesh (GLB only) */
  noMesh?: boolean | 'minimal'
  /** speed_multiplier: 0 < x <= 2 */
  speed?: number
}

/** Why Uthana would refuse these options (it answers 400); empty when fine. */
export function exportProblems(format: UthanaFormat, o: UthanaExportOptions): string[] {
  const p: string[] = []
  if (o.fps !== undefined && !(UTHANA_FPS as readonly number[]).includes(o.fps)) p.push('FPS must be 24, 30 or 60.')
  if (o.robloxCompatible && format !== 'fbx') p.push('Roblox-compatible export is FBX only.')
  if (o.noMesh === 'minimal' && format !== 'glb') p.push('The minimal skeleton mesh is GLB only.')
  if (o.speed !== undefined && !(Number.isFinite(o.speed) && o.speed > 0 && o.speed <= 2)) p.push('Speed must be above 0 and at most 2.')
  return p
}

/** Notes that don't block the download but may make Uthana refuse it. */
export function exportWarnings(format: UthanaFormat, o: UthanaExportOptions, characterId: string): string[] {
  const w: string[] = []
  if (o.robloxCompatible && format === 'fbx' && !UTHANA_ROBLOX_CHARACTERS.includes(characterId)) {
    w.push('Uthana accepts Roblox-compatible FBX only for Roblox characters (its Roblox stock characters, or uploads rerigged to R15).')
  }
  return w
}

/** Query string for the download endpoint: only options that differ from Uthana's defaults. */
export function exportQuery(o: UthanaExportOptions): string {
  const q: string[] = []
  if (o.fps !== undefined) q.push(`fps=${o.fps}`)
  if (o.noMesh !== undefined && o.noMesh !== false) q.push(`no_mesh=${o.noMesh === 'minimal' ? 'minimal' : 'true'}`)
  if (o.inPlace) q.push('in_place=true')
  if (o.torsoOnly) q.push('torso_only=true')
  if (o.robloxCompatible) q.push('roblox_compatible=true')
  if (o.speed !== undefined && o.speed !== 1) q.push(`speed_multiplier=${o.speed}`)
  return q.length ? `?${q.join('&')}` : ''
}

const idPart = (v: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error(`Not an Uthana id: ${v}`)
  return v
}

/** https://uthana.com/motion/file/motion_viewer/<character>/<motion>/<format>/<name>.<format>?... */
export function motionFileUrl(characterId: string, motionId: string, format: UthanaFormat, o: UthanaExportOptions = {}, name = 'motion'): string {
  if (!UTHANA_FORMATS.includes(format)) throw new Error(`Unsupported format: ${format}`)
  const base = (name.replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'motion').slice(0, 60)
  return `${UTHANA_ORIGIN}/motion/file/motion_viewer/${idPart(characterId)}/${idPart(motionId)}/${format}/${encodeURIComponent(base)}.${format}${exportQuery(o)}`
}

/** Motion-only GLB (no character mesh; does not count against a download quota). */
export function motionOnlyUrl(characterId: string, motionId: string, fps?: number): string {
  return `${UTHANA_ORIGIN}/motion/animation/motion_viewer/${idPart(characterId)}/${idPart(motionId)}/glb/motion.glb${fps ? `?fps=${fps}` : ''}`
}

/** Short tag for a set of options, used in cached file names (e.g. "30fps-inplace"). */
export function optionsTag(o: UthanaExportOptions): string {
  const t: string[] = []
  if (o.fps) t.push(`${o.fps}fps`)
  if (o.inPlace) t.push('inplace')
  if (o.torsoOnly) t.push('torso')
  if (o.robloxCompatible) t.push('roblox')
  if (o.noMesh === 'minimal') t.push('minimal')
  else if (o.noMesh) t.push('nomesh')
  if (o.speed !== undefined && o.speed !== 1) t.push(`x${o.speed}`)
  return t.join('-')
}

/** Suggested file name for an export: the motion's name plus the options that change it. */
export function exportFileName(motionName: string | undefined, format: UthanaFormat, o: UthanaExportOptions): string {
  const stem =
    (motionName ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48)
      .replace(/-$/, '') || 'motion'
  const tag = optionsTag(o)
  return `${stem}${tag ? `-${tag}` : ''}.${format}`
}

// ---------------------------------------------------------------- world

/** <world>/.genio/uthana/config.json */
export interface UthanaWorldConfig {
  schema?: string
  /** where generated animations are saved, relative to the world root */
  folder?: string
  [k: string]: unknown
}

export interface UthanaWorldState {
  /** null: Scratch */
  world: string | null
  /** an Uthana key is stored (the key itself never leaves the main process) */
  keySet: boolean
  config: UthanaWorldConfig
  /** the configured folder, else an engine-aware suggestion */
  folder: string
  characters: UthanaCharacterRecord[]
  /** the world's FAL budget, which also covers Animation runs */
  budget?: FalBudget
  /** estimated spend this month across providers (USD) */
  spentUsd: number
  month: string
  engine?: Engine
}

/** A sensible animations folder in this engine's layout. */
export function suggestAnimationFolder(engine: Engine | undefined, engineRoot = ''): string {
  const prefix = engineRoot && engineRoot !== '.' ? `${engineRoot.replace(/\\/g, '/').replace(/\/$/, '')}/` : ''
  switch (engine) {
    case 'unity':
      return prefix + 'Assets/Animations/Generated'
    case 'unreal':
      // Content/ holds imported .uasset files: keep sources outside it
      return prefix + 'SourceArt/Generated/Animations'
    default:
      return prefix + 'assets/generated/animations'
  }
}

// ---------------------------------------------------------------- requests (renderer → main)

/** A local file the player picked or dropped, as main inspected it. */
export interface UthanaFileInfo {
  path: string
  name: string
  ext: string
  bytes: number
  /** video length, when Genio could read it (MP4/MOV) */
  seconds?: number
  /** world-relative path when the file is inside the active world */
  inWorld?: string
}

export interface UthanaUploadRequest {
  world?: string
  path: string
  name: string
  autoRig?: boolean
  frontFacing?: boolean
  includeFingers?: boolean
  rerigTarget?: string
}

export interface UthanaGenerateRequest {
  world?: string
  model: string
  characterId: string
  characterName?: string
  text?: UthanaTextParams
  video?: { path: string; motionName: string }
}

export interface UthanaPreviewRequest {
  runId: string
  /** default: the run's first motion */
  motionId?: string
  source: 'mesh' | 'skeleton'
}

export interface UthanaExportRequest {
  by?: string
  runId: string
  motionId?: string
  format: UthanaFormat
  options: UthanaExportOptions
  /** 'world': copy into a world with provenance; 'file': a Save As dialog anywhere */
  dest: 'world' | 'file'
  project?: string
  folder?: string
  fileName: string
  overwrite?: boolean
}

export interface UthanaExportResult {
  ok: boolean
  message: string
  /** the target exists and overwrite was not confirmed */
  exists?: boolean
  path?: string
  provenance?: string
  warnings?: string[]
}

// ---------------------------------------------------------------- account

/** What Uthana reports about the account (free queries). Fields are absent when the plan has no such limit. */
export interface UthanaAccount {
  org?: string
  user?: string
  /** legacy subscriptions: monthly download allowance in seconds */
  downloadSecsPerMonth?: number
  downloadSecsRemaining?: number
  charactersAllowed?: number
  charactersRemaining?: number
  /** pay-as-you-go, when the API reports it */
  paygEnabled?: boolean
  paygTotalUsd?: number
  prices?: { model: string; unit: string; price: string }[]
  checkedAt: string
}

/** One line for the account strip. */
export function accountLine(a: UthanaAccount): string {
  const parts: string[] = []
  if (a.paygEnabled !== undefined) parts.push(a.paygEnabled ? 'pay-as-you-go' : 'pay-as-you-go off')
  if (a.paygTotalUsd !== undefined) parts.push(`PAYG total ${fmtUsd(a.paygTotalUsd)}`)
  if (a.downloadSecsRemaining !== undefined) parts.push(`${Math.round(a.downloadSecsRemaining)} s of downloads left${a.downloadSecsPerMonth ? ` of ${Math.round(a.downloadSecsPerMonth)}` : ''}`)
  if (a.charactersRemaining !== undefined) parts.push(`${a.charactersRemaining} character slot${a.charactersRemaining === 1 ? '' : 's'} left`)
  return parts.join(' · ') || 'no limits reported'
}

/** Seconds of animation in a .glb: the longest animation sampler input (glTF requires its max). */
export function glbAnimationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 20) return undefined
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) return undefined
  const len = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len > bytes.byteLength) return undefined
  let json: { animations?: { samplers?: { input: number }[] }[]; accessors?: { max?: number[] }[] }
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)))
  } catch {
    return undefined
  }
  let max: number | undefined
  for (const a of json.animations ?? []) {
    for (const s of a.samplers ?? []) {
      const m = json.accessors?.[s.input]?.max?.[0]
      if (typeof m === 'number' && Number.isFinite(m)) max = Math.max(max ?? 0, m)
    }
  }
  return max
}
