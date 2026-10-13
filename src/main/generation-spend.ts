import fs from 'node:fs'
import path from 'node:path'
import type { FalBudget, FalRun } from '@shared/api'
import { runCost, uthanaRequestId, type UthanaRun } from '@shared/uthana'
import type { AppCtx } from './services'
import { readSpend } from './fal-world'
import { noLinks } from './asset-placement'
import { ensureDir, readJson, readJsonl } from './util'

interface Charge { id: string; provider: string; world?: string; t: string; usd?: number; request?: string }
const fileOf = (ctx: AppCtx) => path.join(ctx.main.home.data, 'spend.jsonl')
const charges = (ctx: AppCtx) => new Map(readJsonl<Charge>(fileOf(ctx)).map(c => [c.id, c]))

export function generationBudget(ctx: AppCtx, world?: string): FalBudget | undefined {
  if (!world) return readJson<{ budget?: FalBudget }>(path.join(ctx.main.home.data, 'fal', 'scratch-config.json'), {}).budget
  const project = ctx.projects.get(world)
  if (!project) throw new Error(`No world named ${world}`)
  noLinks(project.path, '.genio/fal/config.json')
  const file = path.join(project.path, '.genio/fal/config.json')
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const budget = config.budget
  for (const key of ['monthly_usd', 'confirm_over_usd']) if (budget?.[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] < 0)) throw new Error(`Invalid generation budget: ${key}`)
  return budget
}

/** Union central receipts, retained provider history and unit/world receipts without double counting. */
export function generationSpent(ctx: AppCtx, world?: string): number {
  const all = charges(ctx)
  for (const r of ctx.fal?.runs() ?? []) if (!all.has(r.id)) all.set(r.id, { id: r.id, provider: 'fal', world: r.world, t: r.createdAt, usd: r.costUsd ?? r.estUsd, request: r.requestId })
  for (const r of ctx.uthana?.runs() ?? []) if (!all.has(r.id)) all.set(r.id, { id: r.id, provider: 'uthana', world: r.world, t: r.createdAt, usd: runCost(r), request: uthanaRequestId(r) })
  const month = new Date().toISOString().slice(0, 7)
  const seen = new Set<string>()
  let usd = 0
  for (const c of all.values()) {
    if ((c.world || undefined) !== world || c.t.slice(0, 7) !== month) continue
    usd += c.usd ?? 0
    if (c.request) seen.add(`${c.provider}:${c.request}`)
  }
  const project = world ? ctx.projects.get(world) : undefined
  for (const c of project ? readSpend(project.path) : []) {
    const key = c.request_id ? `${c.provider}:${c.request_id}` : undefined
    if (c.t?.slice(0, 7) !== month || key && seen.has(key)) continue
    usd += Math.max(0, c.est_usd ?? 0)
    if (key) seen.add(key)
  }
  return usd
}

export function checkGenerationBudget(ctx: AppCtx, world: string | undefined, usd: number | undefined): { confirm: boolean; spent: number; cap?: number } {
  const budget = generationBudget(ctx, world)
  const spent = generationSpent(ctx, world), cap = budget?.monthly_usd
  if (usd !== undefined && (!Number.isFinite(usd) || usd < 0)) throw new Error('Invalid generation estimate')
  if (cap !== undefined && (usd === undefined || spent >= cap || spent + usd > cap + 1e-9)) throw new Error(`Monthly cap is a hard stop: $${spent.toFixed(3)} spent, $${cap.toFixed(3)} cap`)
  return { confirm: usd === undefined || usd > (budget?.confirm_over_usd ?? 0.25), spent, cap }
}

/** Persist before submitting; retain uncertain/failed charges conservatively, even when history is removed. */
export function recordGenerationSpend(ctx: AppCtx, provider: 'fal' | 'uthana', run: FalRun | UthanaRun, starting = false): void {
  const r = run as FalRun & UthanaRun
  const usd = provider === 'fal' ? r.costUsd ?? r.estUsd : runCost(r)
  if (starting) checkGenerationBudget(ctx, run.world, usd)
  const charge: Charge = { id: run.id, provider, world: run.world, t: run.createdAt, usd, request: provider === 'fal' ? r.requestId : uthanaRequestId(r) }
  if (JSON.stringify(charges(ctx).get(run.id)) === JSON.stringify(charge)) return
  ensureDir(ctx.main.home.data)
  fs.appendFileSync(fileOf(ctx), JSON.stringify(charge) + '\n')
}

export function recordCodexGeneration(ctx: AppCtx, id: string, world: string | undefined, t: string): void {
  if (charges(ctx).has(id)) return
  ensureDir(ctx.main.home.data)
  fs.appendFileSync(fileOf(ctx), JSON.stringify({ id, provider: 'codex', world, t, usd: 0, request: id } satisfies Charge) + '\n')
}
