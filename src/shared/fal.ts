/** Shared generation estimates, budget accounting, folder suggestions and asset search. */
import type { FalBudget, FalCatalogueEntry, FalOutputKind, FalPrice, FalRun } from './api'
import type { Engine } from './types'

// ---------------------------------------------------------------- cost

export interface CostEstimate {
  /** USD when the units of one run are known */
  usd?: number
  /** what to show before Run */
  text: string
  units?: number
  unit?: string
}

const IMAGE_PRESETS: Record<string, [number, number]> = {
  square_hd: [1024, 1024],
  square: [512, 512],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576]
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export const fmtUsd = (v: number): string => (v === 0 ? '$0' : v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`)

const UNIT_SHORT: Record<string, string> = {
  megapixels: 'MP',
  seconds: 's',
  'compute seconds': 'compute-s',
  '1000 characters': '1k chars',
  '1000 tokens': '1k tokens',
  minutes: 'min'
}

export const priceText = (p: FalPrice): string => `$${p.unitPrice} / ${UNIT_SHORT[p.unit] ?? p.unit.replace(/s$/, '')}`

function megapixels(input: Record<string, unknown>): number | undefined {
  const s = input.image_size
  if (typeof s === 'string' && IMAGE_PRESETS[s]) return (IMAGE_PRESETS[s][0] * IMAGE_PRESETS[s][1]) / 1_000_000
  if (s && typeof s === 'object') {
    const w = num((s as Record<string, unknown>).width)
    const h = num((s as Record<string, unknown>).height)
    if (w && h) return (w * h) / 1_000_000
  }
  const w = num(input.width)
  const h = num(input.height)
  return w && h ? (w * h) / 1_000_000 : undefined
}

function seconds(input: Record<string, unknown>): number | undefined {
  for (const k of ['duration_seconds', 'duration', 'seconds_total', 'seconds', 'length_seconds']) {
    const v = num(input[k])
    if (v !== undefined) return v
  }
  const ms = num(input.music_length_ms)
  return ms !== undefined ? ms / 1000 : undefined
}

function characters(input: Record<string, unknown>): number | undefined {
  for (const k of ['text', 'prompt', 'input']) if (typeof input[k] === 'string') return (input[k] as string).length
  return undefined
}

/**
 * Estimate one run from the unit price and the input. `defaults` are the
 * schema defaults (what FAL uses for fields left empty).
 */
export function estimateRun(
  entry: Pick<FalCatalogueEntry, 'unitsPerRun' | 'pagePrice' | 'accepts'> | undefined,
  price: FalPrice | undefined,
  input: Record<string, unknown>,
  defaults: Record<string, unknown> = {}
): CostEstimate {
  const fallback = entry?.pagePrice ?? (price ? priceText(price) : 'price unknown')
  if (!price) return { text: fallback }
  const all = { ...defaults, ...input }
  const n = num(all.num_images) ?? num(all.num_samples) ?? num(all.num_outputs) ?? 1
  const unit = price.unit.toLowerCase()
  let units: number | undefined
  if (['images', 'generations', 'requests', 'audios', 'videos', 'cloned voices', 'voices', 'tracks'].includes(unit)) units = n
  else if (unit === 'megapixels') {
    const mp = megapixels(all) ?? (entry?.accepts ? undefined : 1)
    units = mp !== undefined ? mp * n : undefined
  } else if (unit === 'seconds') units = seconds(all)
  else if (unit === 'minutes') {
    const s = seconds(all)
    units = s !== undefined ? s / 60 : undefined
  } else if (unit === '1000 characters') {
    const c = characters(all)
    units = c !== undefined ? c / 1000 : undefined
  } else if (entry?.unitsPerRun) units = entry.unitsPerRun * n
  if (units === undefined) return { text: fallback }
  const usd = units * price.unitPrice
  return { usd, units, unit: price.unit, text: `≈ ${fmtUsd(usd)}${entry?.pagePrice && entry.unitsPerRun ? ` · ${entry.pagePrice}` : ''}` }
}

// ---------------------------------------------------------------- budget

export interface BudgetCheck {
  /** ask the player before the paid call */
  confirm: boolean
  reasons: string[]
}

/** Every paid run asks the player first, whatever the amount; `confirm_over_usd` no longer lowers that. */
export function budgetCheck(spentUsd: number, estUsd: number | undefined, budget: FalBudget | undefined, worldLabel = 'this project'): BudgetCheck {
  const reasons: string[] = []
  const cap = budget?.monthly_usd
  if (estUsd === undefined || estUsd > 0) {
    reasons.push(estUsd === undefined ? 'This run has no price estimate; it costs money.' : `This run is estimated at ${fmtUsd(estUsd)}.`)
  }
  if (cap !== undefined && cap >= 0) {
    if (spentUsd >= cap) reasons.push(`Spend in ${worldLabel} this month is already ${fmtUsd(spentUsd)} of its ${fmtUsd(cap)} cap.`)
    else if (estUsd !== undefined && spentUsd + estUsd > cap) {
      reasons.push(`This run would bring ${worldLabel} to ${fmtUsd(spentUsd + estUsd)} of its ${fmtUsd(cap)} monthly cap.`)
    }
  }
  return { confirm: reasons.length > 0, reasons }
}

export const monthKey = (d: Date | string = new Date()): string => new Date(d).toISOString().slice(0, 7)

export interface SpendLine {
  t: string
  provider: string
  endpoint?: string
  request_id?: string | null
  est_usd?: number
  by?: string
  [k: string]: unknown
}

/**
 * Estimated spend of a world this month: its .genio/spend.jsonl (saved runs,
 * units) plus Genio's own runs for the world that are not in the ledger yet.
 */
export function worldSpend(lines: SpendLine[], runs: FalRun[], world: string | null, month = monthKey()): number {
  let total = 0
  const seen = new Set<string>()
  for (const l of lines) {
    if (typeof l.t !== 'string' || monthKey(l.t) !== month) continue
    if (typeof l.est_usd === 'number' && Number.isFinite(l.est_usd)) total += l.est_usd
    if (l.request_id) seen.add(l.request_id)
  }
  for (const r of runs) {
    if ((r.world ?? null) !== world || monthKey(r.createdAt) !== month) continue
    if (r.status === 'failed' || r.status === 'cancelled') continue
    if (r.requestId && seen.has(r.requestId)) continue
    total += r.costUsd ?? r.estUsd ?? 0
  }
  return total
}

// ---------------------------------------------------------------- history

// ---------------------------------------------------------------- worlds

const KIND_DIR: Record<FalOutputKind, string> = { image: 'Art', audio: 'Audio', model: 'Models', video: 'Video', other: 'Generated' }

/** A sensible save folder for an output kind in this engine's layout. */
export function suggestFolder(engine: Engine | undefined, kind: FalOutputKind, engineRoot = ''): string {
  const d = KIND_DIR[kind]
  const prefix = engineRoot && engineRoot !== '.' ? `${engineRoot.replace(/\\/g, '/').replace(/\/$/, '')}/` : ''
  switch (engine) {
    case 'unity':
      return prefix + (kind === 'other' ? 'Assets/Generated' : `Assets/${d}/Generated`)
    case 'godot':
      return prefix + `assets/generated/${d.toLowerCase()}`
    case 'unreal':
      // Content/ holds imported .uasset files: keep sources outside it
      return prefix + `SourceArt/Generated/${d}`
    case 'bevy':
      return prefix + `assets/generated/${d.toLowerCase()}`
    default:
      return prefix + `assets/generated/${d.toLowerCase()}`
  }
}

// ---------------------------------------------------------------- catalogue

/** Substring first, then subsequence (same idea as the command palette). -1 = no match. */
export function matchScore(needle: string, hay: string): number {
  const n = needle.trim().toLowerCase()
  if (!n) return 0
  const h = hay.toLowerCase()
  const at = h.indexOf(n)
  if (at >= 0) return at
  let i = 0
  for (const ch of h) if (ch === n[i]) i++
  return i === n.length ? 1000 : -1
}
