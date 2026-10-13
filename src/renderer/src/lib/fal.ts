import type { FalCatalogue, FalCatalogueEntry, FalOutputKind, FalPrice, FalRun } from '@shared/api'
import { fmtUsd, priceText } from '@shared/fal'
import type { Tone } from './vocab'

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

export const KIND_LABEL: Record<FalOutputKind, string> = { image: 'image', audio: 'audio', video: 'video', model: '3D', other: 'data' }

/** Live price when FAL's pricing API answered, else the catalogue snapshot. */
export function priceOf(cat: FalCatalogue | null, e: FalCatalogueEntry | undefined, endpoint: string): FalPrice | undefined {
  return cat?.info[endpoint]?.price ?? e?.price
}

/** Short price for picker rows. */
export function shortPrice(e: FalCatalogueEntry, p: FalPrice | undefined): string {
  if (!p) return e.pagePrice ?? ''
  if (e.unitsPerRun) return `~${fmtUsd(p.unitPrice * e.unitsPerRun)}`
  if (['units', 'credits', '1000 tokens'].includes(p.unit)) return e.pagePrice ?? priceText(p)
  return priceText(p)
}

/** Display name of a file input value. */
export function fileLabel(v: string): string {
  if (v.startsWith('@file:')) return v.slice(6).split(/[\\/]/).pop() || v
  if (v.startsWith('data:')) return 'inline data'
  try {
    return decodeURIComponent(new URL(v).pathname.split('/').filter(Boolean).pop() ?? v)
  } catch {
    return v
  }
}

/** Per-viewer conveniences (active world, remembered essentials); never required to work. */
export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable: fine */
  }
}

export const memKey = (world: string | null, endpoint: string): string => `genio.fal.mem:${world ?? '~scratch'}:${endpoint}`
