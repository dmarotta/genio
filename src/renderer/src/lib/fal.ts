import type { FalRun } from '@shared/api'
import type { Tone } from './vocab'

export interface FalPreset {
  id: string
  group: 'Image' | 'Audio / SFX' | '3D' | 'Video'
  label: string
  endpoint: string
  /** input key the prompt box fills (null: the endpoint takes no prompt) */
  promptKey: string | null
  params: Record<string, unknown>
  hint?: string
}

/** Starting points only: any FAL endpoint id can be typed in. */
export const FAL_PRESETS: FalPreset[] = [
  { id: 'flux-schnell', group: 'Image', label: 'FLUX schnell', endpoint: 'fal-ai/flux/schnell', promptKey: 'prompt', params: { image_size: 'square_hd', num_images: 1 }, hint: 'Fast drafts. image_size: square_hd, square, portrait_4_3, landscape_16_9…' },
  { id: 'flux-dev', group: 'Image', label: 'FLUX dev', endpoint: 'fal-ai/flux/dev', promptKey: 'prompt', params: { image_size: 'landscape_4_3', num_inference_steps: 28, guidance_scale: 3.5, num_images: 1 } },
  { id: 'stable-audio', group: 'Audio / SFX', label: 'Stable Audio', endpoint: 'fal-ai/stable-audio', promptKey: 'prompt', params: { seconds_total: 10, steps: 100 }, hint: 'Music loops and ambiences.' },
  { id: 'elevenlabs-sfx', group: 'Audio / SFX', label: 'ElevenLabs SFX', endpoint: 'fal-ai/elevenlabs/sound-effects', promptKey: 'text', params: { duration_seconds: 2 }, hint: 'Short sound effects from a description.' },
  { id: 'trellis', group: '3D', label: 'TRELLIS · image → 3D', endpoint: 'fal-ai/trellis', promptKey: null, params: { image_url: '' }, hint: 'Paste an image URL (an earlier output works). Returns a .glb.' },
  { id: 'hunyuan3d', group: '3D', label: 'Hunyuan3D v2 · image → 3D', endpoint: 'fal-ai/hunyuan3d/v2', promptKey: null, params: { input_image_url: '', textured_mesh: true }, hint: 'Paste an image URL. Returns a .glb.' },
  { id: 'ltx-video', group: 'Video', label: 'LTX Video', endpoint: 'fal-ai/ltx-video', promptKey: 'prompt', params: {}, hint: 'Short text-to-video clips.' }
]

export interface ParamRow {
  key: string
  value: string
}

/** Field text → JSON value: numbers, booleans, null, {…}/[…] JSON; anything else stays a string. */
export function parseParam(v: string): unknown {
  const t = v.trim()
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t)
  if (t === 'true' || t === 'false') return t === 'true'
  if (t === 'null') return null
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t) as unknown
    } catch {
      return v
    }
  }
  return v
}

export function paramText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export function rowsFrom(obj: Record<string, unknown>): ParamRow[] {
  return Object.entries(obj).map(([key, v]) => ({ key, value: paramText(v) }))
}

/** Rows with an empty key or value are left out (empty preset fields are placeholders). */
export function rowsToObject(rows: ParamRow[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const r of rows) if (r.key.trim() && r.value.trim()) o[r.key.trim()] = parseParam(r.value)
  return o
}

export function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  const v = JSON.parse(text) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Parameters must be a JSON object.')
  return v as Record<string, unknown>
}

export const FAL_STATUS: Record<FalRun['status'], { label: string; tone: Tone; live?: boolean }> = {
  submitting: { label: 'submitting', tone: 'neon', live: true },
  queued: { label: 'queued', tone: 'amber', live: true },
  running: { label: 'running', tone: 'neon', live: true },
  completed: { label: 'done', tone: 'volt' },
  failed: { label: 'failed', tone: 'alert' },
  cancelled: { label: 'cancelled', tone: 'mute' }
}

/** The text a run was prompted with, for history rows. */
export function runPrompt(r: FalRun): string {
  for (const k of ['prompt', 'text', 'description']) if (typeof r.input[k] === 'string' && r.input[k]) return r.input[k] as string
  return Object.keys(r.input).join(', ') || '(no input)'
}

export function bytes(n?: number): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
