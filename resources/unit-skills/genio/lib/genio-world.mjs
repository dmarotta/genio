/**
 * A world's `.genio/` folder as Genio's bundled unit helpers see it. Node 18+,
 * standard library only.
 *
 *   .genio/fal/config.json    genio.fal-config.v1: folders, budget, defaults, providers  (read only)
 *   .genio/fal/recipes.json   named presets                                             (read only)
 *   .genio/provenance/<asset path>.json   genio.provenance.v1, one per generated asset  (written)
 *   .genio/spend.jsonl        one line per paid call                                    (appended)
 *
 * Units read everything but write only provenance files and spend lines, in
 * their own worktree, so the records land with their branch. Config and
 * recipes belong to the player and are never written here.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROVENANCE_SCHEMA = 'genio.provenance.v1'
export const CONFIG_SCHEMA = 'genio.fal-config.v1'

export class WorldError extends Error {}

/** Parsed JSON, or null when the file does not exist. A broken file is an error, never ignored. */
function readOptionalJson(file, kind) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  let v
  try {
    v = JSON.parse(raw)
  } catch (e) {
    throw new WorldError(`${file} is not valid JSON (${e.message}). Ask the player to fix it; units never edit it.`)
  }
  const ok = kind === 'array' ? Array.isArray(v) : v && typeof v === 'object' && !Array.isArray(v)
  if (!ok) throw new WorldError(`${file} must hold a JSON ${kind}.`)
  return v
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Open a world (the unit's own worktree root) and read its FAL config and recipes. */
export function openWorld(worldArg) {
  const root = path.resolve(worldArg)
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new WorldError(`World folder not found: ${root}`)
  const dir = path.join(root, '.genio')
  const config = readOptionalJson(path.join(dir, 'fal', 'config.json'), 'object')
  const recipes = readOptionalJson(path.join(dir, 'fal', 'recipes.json'), 'array') ?? []
  const budget = config?.budget ?? {}
  for (const k of ['monthly_usd', 'confirm_over_usd']) {
    if (budget[k] != null && !isNum(budget[k])) throw new WorldError(`.genio/fal/config.json: budget.${k} must be a non-negative number.`)
  }
  return { root, dir, config: config ?? {}, recipes, hasConfig: config !== null }
}

/** Whether Codex images are on for the world: on by default, off only on an explicit opt-out (`"providers": {"codex": {"enabled": false}}`). */
export function codexEnabled(config) {
  const p = config?.providers?.codex
  return !(p === false || (Boolean(p) && typeof p === 'object' && p.enabled === false))
}

export function findRecipe(world, id) {
  const r = world.recipes.find((x) => x && x.id === id)
  if (!r) throw new WorldError(`No recipe "${id}" in .genio/fal/recipes.json (have: ${world.recipes.map((x) => x?.id).filter(Boolean).join(', ') || 'none'}).`)
  return r
}

/** The save folder for an output kind (image, audio, model, video, ...), as an absolute path, or null. */
export function folderFor(world, kind) {
  const rel = kind ? world.config.folders?.[kind] : undefined
  return typeof rel === 'string' && rel.trim() ? path.resolve(world.root, rel) : null
}

/** World-relative POSIX path of `file`, or null when it lies outside the world. */
export function worldRel(world, file) {
  const rel = path.relative(world.root, path.resolve(file))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

export const provenancePath = (world, rel) => path.join(world.dir, 'provenance', ...rel.split('/')) + '.json'
export const spendFile = (world) => path.join(world.dir, 'spend.jsonl')

export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Who is generating: the unit id Genio set, never the player. */
export const unitBy = () => (process.env.GENIO_TASK_ID ? `unit:${process.env.GENIO_TASK_ID}` : 'unit')

/**
 * Write the provenance record for a generated asset inside the world (replacing
 * an earlier record for the same path). Returns the record's world-relative
 * path, or null when the asset is outside the world or inside `.genio/`.
 */
export function writeProvenance(world, assetFile, fields) {
  const rel = worldRel(world, assetFile)
  if (!rel || rel === '.genio' || rel.startsWith('.genio/')) return null
  const record = { schema: PROVENANCE_SCHEMA, path: rel, sha256: sha256File(assetFile), ...fields }
  const out = provenancePath(world, rel)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return worldRel(world, out)
}

/** Append one spend line (`{"t", "provider", ..., "est_usd", "by"}`) to a ledger. */
export function appendSpend(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8')
}

export function readSpend(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const lines = []
  for (const l of raw.split(/\r?\n/)) {
    if (!l.trim()) continue
    try {
      const v = JSON.parse(l)
      if (v && typeof v === 'object') lines.push(v)
    } catch {
      /* a torn or hand-edited line never blocks the ledger */
    }
  }
  return lines
}

const usd = (n) => Math.round(n * 1e6) / 1e6
const sum = (lines) => usd(lines.reduce((a, l) => a + (isNum(l.est_usd) ? l.est_usd : 0), 0))

/**
 * Budget gate before a paid call. The unit budget (from the brief) is a hard
 * stop on this unit's own spend; the world's monthly cap counts every line of
 * the current UTC month; a call above `confirm_over_usd` needs the player's
 * approval, which a stated unit budget gives up to its amount.
 */
export function checkBudget({ lines, by, estUsd, unitBudget, config, now = new Date() }) {
  const month = now.toISOString().slice(0, 7)
  const spentByUnit = sum(lines.filter((l) => l.by === by))
  const spentMonth = sum(lines.filter((l) => typeof l.t === 'string' && l.t.startsWith(month)))
  const b = config?.budget ?? {}
  const out = { est_usd: usd(estUsd), spent_by_unit: spentByUnit, spent_this_month: spentMonth, unit_budget_usd: unitBudget ?? null, monthly_usd: b.monthly_usd ?? null }
  const eps = 1e-9
  if (unitBudget != null && spentByUnit + estUsd > unitBudget + eps) {
    return { ...out, ok: false, reason: `Budget hard stop: this call (est. USD ${usd(estUsd)}) on top of USD ${spentByUnit} already spent exceeds your USD ${unitBudget} budget.` }
  }
  if (isNum(b.monthly_usd) && spentMonth + estUsd > b.monthly_usd + eps) {
    return { ...out, ok: false, reason: `World budget: this call (est. USD ${usd(estUsd)}) on top of USD ${spentMonth} spent in ${month} exceeds the world's USD ${b.monthly_usd} monthly cap (.genio/fal/config.json).` }
  }
  if (unitBudget == null && isNum(b.confirm_over_usd) && estUsd > b.confirm_over_usd + eps) {
    return { ...out, ok: false, reason: `This call (est. USD ${usd(estUsd)}) is above the world's USD ${b.confirm_over_usd} confirm threshold and your brief states no budget that approves it.` }
  }
  return { ...out, ok: true }
}
