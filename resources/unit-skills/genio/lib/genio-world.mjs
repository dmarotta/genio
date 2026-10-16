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
 * recipes belong to the player and are never written here. A paid call needs
 * the unit's spend grant (spend-grant.mjs), which only Genio records.
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
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new WorldError(`Project folder not found: ${root}`)
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
 * Budget gate before a paid call. No paid call runs without the player's
 * approval: `grant` (readGrant in spend-grant.mjs) is what the player approved
 * for this unit, and this unit's spend plus the call must fit in it. A
 * `unitBudget` (--budget) is the unit's own lower limit on top of it; the
 * world's monthly cap counts every line of the current UTC month and stops
 * everything. A call estimated at zero is not a spend and needs no grant.
 * `confirm_over_usd` is no longer a threshold: every paid call needs a grant.
 */
export function checkBudget({ lines, by, estUsd, unitBudget, grant, config, now = new Date() }) {
  const month = now.toISOString().slice(0, 7)
  const spentByUnit = sum(lines.filter((l) => l.by === by))
  const spentMonth = sum(lines.filter((l) => typeof l.t === 'string' && l.t.startsWith(month)))
  const b = config?.budget ?? {}
  const granted = grant?.ok ? grant.total_usd : 0
  const out = { est_usd: usd(estUsd), spent_by_unit: spentByUnit, spent_this_month: spentMonth, grant_usd: granted, unit_budget_usd: unitBudget ?? null, monthly_usd: b.monthly_usd ?? null }
  const eps = 1e-9
  if (estUsd > eps && !grant?.ok) {
    return { ...out, ok: false, reason: `${grant?.reason ?? 'No spend grant: the player has approved no spending for you yet.'} This call is est. USD ${usd(estUsd)}.` }
  }
  if (estUsd > eps && spentByUnit + estUsd > granted + eps) {
    return { ...out, ok: false, reason: `Spend grant exceeded: this call (est. USD ${usd(estUsd)}) on top of USD ${spentByUnit} already spent exceeds the USD ${granted} the player approved for you.` }
  }
  if (unitBudget != null && spentByUnit + estUsd > unitBudget + eps) {
    return { ...out, ok: false, reason: `Budget hard stop: this call (est. USD ${usd(estUsd)}) on top of USD ${spentByUnit} already spent exceeds your USD ${unitBudget} budget.` }
  }
  if (isNum(b.monthly_usd) && spentMonth + estUsd > b.monthly_usd + eps) {
    return { ...out, ok: false, reason: `Project budget: this call (est. USD ${usd(estUsd)}) on top of USD ${spentMonth} spent in ${month} exceeds the project's USD ${b.monthly_usd} monthly cap (.genio/fal/config.json).` }
  }
  return { ...out, ok: true }
}

/** What a unit's spend line says about its approval: the grant's total and who approved it how. */
export function approvalFields(grant) {
  return grant?.ok ? { grant_usd: grant.total_usd, approved_by: 'player', approval: grant.approval } : {}
}

/** Read-only placement helpers. Inputs are world-relative POSIX paths from Inventory.
 * No filesystem writes, directory creation, or asset decoding happens here.
 */
const placementKinds = ['image', 'audio', 'video', 'model', 'animation', 'material']
const beneath = (p, base) => !base || p.toLowerCase() === base.toLowerCase() || p.toLowerCase().startsWith(base.toLowerCase() + '/')
const safeRelative = p => typeof p === 'string' && !!p && !/[\\:\x00-\x1f]/.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s))
function allowedFolder(folder, engine, engineRoot, vendorFolders) {
  return safeRelative(folder) && beneath(folder, engineRoot) && !folder.split('/').some(s =>
    /^(?:\.git|\.genio|\.godot|\.import|Library|Temp|Logs|obj|Build.*|dist|out|UserSettings|ProjectSettings|Packages|Intermediate|Saved|DerivedDataCache|Binaries|node_modules|Editor|Resources|StreamingAssets|AddressableAssetsData|generated|third[-_ ]?party|plugins|textmesh pro|microsplatdata|addons)$/i.test(s) || engine === 'unreal' && /^Content$/i.test(s)) &&
    !vendorFolders.some(v => beneath(folder, v))
}
const wordsOf = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? []

/** Measure naming and kind folders from the world's own indexed media. */
export function conventionsOf({ assets, kind, engine = 'other', engineRoot = '' }) {
  if (!placementKinds.includes(kind)) throw new WorldError(`Unsupported asset kind: ${kind}`)
  if (engineRoot && !safeRelative(engineRoot)) throw new WorldError('Invalid engine root')
  const vendorFolders = [...new Set(assets.filter(a => a.vendor).map(a => a.folder))]
  const groups = new Map()
  for (const a of assets) {
    if (a.kind !== kind || a.vendor || !allowedFolder(a.folder, engine, engineRoot, vendorFolders)) continue
    const siblings = groups.get(a.folder) ?? []
    siblings.push(a); groups.set(a.folder, siblings)
  }
  return [...groups].map(([folder, siblings]) => {
    const stems = siblings.map(a => path.posix.basename(a.path, path.posix.extname(a.path)))
    const styles = { 'kebab-case': 0, snake_case: 0, PascalCase: 0 }
    for (const s of stems) {
      if (s.includes('-')) styles['kebab-case']++
      else if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(s)) styles.snake_case++
      else if (/^[A-Z]/.test(s)) styles.PascalCase++
    }
    const style = Object.entries(styles).sort((a, b) => b[1] - a[1])[0]
    const numbered = stems.filter(s => /-\d{2,}$/.test(s)).length > stems.length / 2
    const suffixCounts = new Map(), prefixCounts = new Map()
    for (const stem of stems) {
      const suffix = /(_(?:BaseColor|Albedo|Normal|Roughness|Metallic|LOD\d+))$/.exec(stem)?.[1]
      const prefix = /^(icon-|T_|SM_)/.exec(stem)?.[1]
      if (suffix) suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1)
      if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
    }
    const majority = counts => [...counts].find(([, n]) => n > stems.length / 2)?.[0] ?? ''
    const suffix = majority(suffixCounts), prefix = majority(prefixCounts)
    const extensions = [...new Set(siblings.map(a => path.posix.extname(a.path).toLowerCase()))]
    return { folder, count: siblings.length, style: style[1] ? style[0] : 'kebab-case', numbered, prefix, suffix, extensions, examples: siblings.slice(0, 3).map(a => a.path) }
  }).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
}

/** Ranked, collision-free suggestions, never a write authorization. hint is folder/subject text. */
export function suggestLocation({ assets, kind, name = 'new asset', hint = '', engine = 'other', engineRoot = '', config = {}, root }) {
  const conventions = conventionsOf({ assets, kind, engine, engineRoot })
  const vendorFolders = [...new Set(assets.filter(a => a.vendor).map(a => a.folder))]
  const allowed = folder => {
    if (!allowedFolder(folder, engine, engineRoot, vendorFolders)) return false
    // Reject symlink/junction ancestors, even when they currently point inside the world.
    if (root) {
      let current = root
      for (const part of folder.split('/')) {
        current = path.join(current, part)
        try { if (fs.lstatSync(current).isSymbolicLink()) return false } catch (e) { if (e.code !== 'ENOENT') return false }
      }
    }
    return true
  }
  const candidates = new Map(), warnings = []
  const add = (folder, score, reason, convention) => {
    if (!allowed(folder)) return
    if (!candidates.has(folder) || candidates.get(folder).score < score) candidates.set(folder, { folder, score, reason, convention })
  }
  const terms = wordsOf(hint + ' ' + name).filter(w => w.length > 2)
  for (const c of conventions) {
    const matches = terms.filter(w => wordsOf(c.folder).includes(w)).length
    add(c.folder, 40 + Math.min(15, Math.log2(c.count + 1) * 3) + Math.min(25, matches * 10), `${c.count} existing ${kind} assets; ${c.style}${c.numbered ? ' with -NN numbering' : ''}${matches ? '; matches subject/hint' : ''}`, c)
  }
  const configured = config.folders?.[kind]
  if (typeof configured === 'string') {
    add(configured, 90, 'Project configured folder', conventions.find(c => c.folder === configured))
    if (!allowed(configured)) warnings.push('Configured folder is unsafe; ignored.')
  }
  if (hint && safeRelative(hint) && (hint.includes('/') || conventions.some(c => c.folder === hint))) {
    // Only an exact existing folder or a path under the engine root is a path hint.
    if (beneath(hint, engineRoot)) add(hint, 95, 'Explicit folder hint', conventions.find(c => c.folder === hint))
  }
  const dirs = { image: 'Textures', audio: 'Audio', video: 'Video', model: 'Models', animation: 'Animations', material: 'Materials' }
  const base = engine === 'unity' ? 'Assets' : engine === 'unreal' ? 'SourceArt' : 'assets'
  add([engineRoot, base, engine === 'godot' ? dirs[kind].toLowerCase() : dirs[kind]].filter(Boolean).join('/'), 20, `${engine} engine fallback under engine root`)
  const defaults = { image: '.png', audio: '.wav', video: '.mp4', model: engine === 'unity' ? '.fbx' : '.glb', animation: engine === 'unity' ? '.fbx' : '.glb', material: engine === 'unity' ? '.mat' : '.tres' }
  const requestedExt = path.posix.extname(name).toLowerCase()
  const ext = requestedExt || defaults[kind]
  if (!/^\.[a-z0-9]+$/.test(ext)) throw new WorldError('Invalid asset extension')
  if (engine === 'unity' && ['.glb', '.gltf'].includes(ext)) {
    candidates.clear()
    add([engineRoot, 'ArtSource', '3D'].filter(Boolean).join('/'), 80, 'Unity glTF source kept outside Assets; importer support is not assumed')
    warnings.push('Convert to FBX or verify a glTF importer before importing into Unity.')
  }
  const existing = new Set(assets.map(a => a.path.toLowerCase()))
  const suggestions = [...candidates.values()].sort((a, b) => b.score - a.score || a.folder.localeCompare(b.folder)).slice(0, 5).map(c => {
    const style = c.convention?.style ?? (engine === 'godot' ? 'snake_case' : 'kebab-case')
    const words = wordsOf(requestedExt ? name.slice(0, -requestedExt.length) : name)
    let stem = style === 'PascalCase' ? words.map(w => w[0].toUpperCase() + w.slice(1)).join('') : words.join(style === 'snake_case' ? '_' : '-')
    stem ||= 'new-asset'
    const prefix = c.convention?.prefix ?? '', suffix = c.convention?.suffix ?? ''
    if (prefix && !stem.toLowerCase().startsWith(prefix.toLowerCase())) stem = prefix + stem
    if (suffix && !stem.toLowerCase().endsWith(suffix.replace('_', '').toLowerCase()) && !stem.toLowerCase().endsWith(suffix.toLowerCase())) stem += suffix
    let n = c.convention?.numbered ? 1 : 0
    const make = () => `${c.folder}/${stem}${n ? '-' + String(n).padStart(2, '0') : ''}${ext}`
    // The index is media-only; also check disk for unindexed collisions when a root is supplied.
    while (existing.has(make().toLowerCase()) || root && fs.existsSync(path.join(root, make()))) n++
    return { path: make(), folder: c.folder, confidence: c.score / 100, reason: c.reason, naming: style, examples: c.convention?.examples ?? [] }
  })
  return { engine, engineRoot, suggestions, warnings }
}
