#!/usr/bin/env node
/**
 * Genio Sound Studio kernel: a sound set (for example door_wood, four variations) made in
 * small reviewed steps. Node 18+, standard library only; the DSP is ./dsp.mjs.
 *
 * A set is a folder in the unit's data directory (never the worktree):
 *   manifest.json                   steps, branches, budget, history
 *   steps/<id>/recipe.json          the step's recipe, as it ran
 *   steps/<id>/<take>.wav           each take the step made: the 48 kHz master (24-bit)
 *   steps/<id>/<take>.sheet.png     waveform + spectrogram (+ loop seam) review sheet
 *   steps/<id>/receipt.json         caption, metrics, warnings, lineage (FAL request ids, cost)
 *   fal/<id>-<take>.*.json          FAL input, receipt and result of each paid take
 *   raw/<id>-<take>/                FAL's download, as it came
 *   failed/<id>-<kind>-<t>/         recipes that failed, with receipts
 *
 * A step is a JSON recipe: each take has one source (a FAL generation, an earlier take or a
 * WAV file) and a list of local ops. A step changes some takes of the set; the set at a step
 * is every take its line made, the latest of each name winning. Paid generation goes through
 * the FAL skill's fal.mjs with --world and --budget: the budget is a hard stop checked for the
 * whole step (or batch) before the first call, and again by fal.mjs per call. Takes stay in
 * step data and are never committed; `export` writes the final WAV into the project with a
 * provenance record for the derived file and the recipes under .genio/sound/<set>/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as dsp from './dsp.mjs'
import { appendSpend, checkBudget, openWorld, readSpend, sha256File, spendFile, worldRel, writeProvenance } from '../../../lib/genio-world.mjs'
import {
  addBranch, assertOutside, byId, chain, checkName, dirBytes, line, now, readJson, rel, renameRetry, resolveStep, revertHead, sleep, stepId, switchTo, withLock as lockDir, writeManifest
} from '../../../lib/step-kernel.mjs'

export { line }

const here = path.dirname(fileURLToPath(import.meta.url))
export const FAL_SCRIPT = path.resolve(here, '..', '..', 'fal', 'scripts', 'fal.mjs')
export const SCHEMA = 'genio.sound.v1'
export const STEP_SCHEMA = 'genio.sound-step.v1'
/** The player's default per-mission cap, in USD; a mission raises it with --budget. */
export const DEFAULT_BUDGET_USD = 0.5
/** Least time between two steps of a batch landing, so a live view shows each one. */
export const PUBLISH_GAP_MS = 600
export const KINDS = ['sfx', 'ui', 'ambience']
const TAKE_BITS = 24
const FAL_TIMEOUT_S = 600
const FAILURES_KEPT = 50
const DATA_WARN_MB = 500
const WHO = { tool: 'Sound Studio', cli: 'sound.mjs', thing: 'sound set', key: 'set' }

/** The FAL sources of v1: SFX, UI and ambience. Prices are the catalogue's, per second of audio. */
export const ENDPOINTS = {
  'fal-ai/elevenlabs/sound-effects/v2': { label: 'ElevenLabs SFX v2', usd_per_s: 0.002, prompt: 'text', seconds: 'duration_seconds', min: 0.5, max: 22, format: ['output_format', 'pcm_48000', /^pcm_\d+$/] },
  'sonilo/v1.1/text-to-sound-effects': { label: 'Sonilo SFX', usd_per_s: 0.0018, prompt: 'prompt', seconds: 'duration', min: 0.5, max: 180, format: ['audio_format', 'wav', /^wav$/] }
}
export const DEFAULT_ENDPOINT = 'fal-ai/elevenlabs/sound-effects/v2'

export class BudgetStop extends Error {
  constructor(message, gate) { super(message); this.code = 'BUDGET'; this.gate = gate }
}

const usd = (n) => Math.round(n * 1e6) / 1e6
const withLock = (dir, fn) => lockDir(dir, fn, WHO)
const byOf = (env) => (env.GENIO_TASK_ID ? `unit:${env.GENIO_TASK_ID}` : 'unit')

/** Where sets live: GENIO_SOUND_DATA, else next to the unit's Modeller data or Blender scratch, else temp. */
export function soundDataDir(env = process.env) {
  if (env.GENIO_SOUND_DATA) return path.resolve(env.GENIO_SOUND_DATA)
  for (const k of ['GENIO_MODELLER_DATA', 'GENIO_BLENDER_SCRATCH']) if (env[k]) return path.join(path.dirname(path.resolve(env[k])), 'sound')
  return path.join(os.tmpdir(), 'genio-sound')
}

function setDir(dataDir, set) {
  return path.join(dataDir, checkName('Set', set))
}

function readManifest(dir) {
  const m = readJson(path.join(dir, 'manifest.json'))
  if (!m) throw new Error(`No sound set at ${dir}. Run: sound.mjs init ${path.basename(dir)}`)
  if (m.schema !== SCHEMA) throw new Error(`Unknown manifest schema ${m.schema}`)
  return m
}

/** A step name from its recipe file: `s03_heavier.json` becomes `heavier`. */
export function stepName(file) {
  const base = path.basename(file).replace(/\.json$/i, '').replace(/^s?\d+[_-]+/i, '')
  return base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'step'
}

/** The set as a step sees it: every take its line made, the latest of each name winning. */
export function setAt(m, id) {
  const takes = {}
  for (const s of chain(m, id)) {
    for (const n of s.dropped ?? []) delete takes[n]
    for (const [n, t] of Object.entries(s.takes ?? {})) takes[n] = { ...t, step: s.id }
  }
  return takes
}

function summary(dir, m) {
  const head = m.branches[m.branch].head
  const brief = (s) => ({ id: s.id, name: s.name, caption: s.caption, takes: Object.keys(s.takes), dropped: s.dropped, warnings: s.warnings, est_usd: s.est_usd })
  return {
    set: m.set, dir, kind: m.kind, target: m.target, budget_usd: m.budget_usd, spent_usd: m.spent_usd,
    branch: m.branch, head, steps: line(m).map(brief), takes: head ? setAt(m, head) : {},
    branches: Object.fromEntries(Object.entries(m.branches).map(([k, b]) => [k, { head: b.head, from: b.from }])),
    failures: m.failures.slice(-3).map((f) => ({ id: f.id, kind: f.kind, error: f.error }))
  }
}

export async function init({ dataDir = soundDataDir(), set, kind, target, budget, cwd = process.cwd(), world } = {}) {
  assertOutside(dataDir, [cwd, world], 'Sound Studio data must live outside the project/worktree (set GENIO_SOUND_DATA)')
  if (kind != null && !KINDS.includes(kind)) throw new Error(`kind is ${KINDS.join(', ')} (music and voice are not part of the Sound Studio v1)`)
  if (target != null && !['unity', 'godot', 'web'].includes(target)) throw new Error('target is unity, godot or web')
  if (budget != null && !(Number(budget) >= 0)) throw new Error('budget is a USD amount, like 0.50')
  const dir = setDir(dataDir, set)
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true })
  return withLock(dir, async () => {
    let m = readJson(path.join(dir, 'manifest.json'))
    const existing = Boolean(m)
    if (!m) m = { schema: SCHEMA, set, created: now(), kind: kind ?? 'sfx', target: target ?? null, budget_usd: DEFAULT_BUDGET_USD, spent_usd: 0, branch: 'main', branches: { main: { head: null, from: null } }, next: 1, steps: [], failures: [], history: [] }
    if (kind != null) m.kind = kind
    if (target != null) m.target = target
    if (budget != null && Number(budget) !== m.budget_usd) {
      m.history.push({ op: 'budget', t: now(), from: m.budget_usd, to: Number(budget) })
      m.budget_usd = Number(budget)
    }
    writeManifest(dir, m)
    return { ok: true, existing, ...summary(dir, m) }
  })
}

// ---------------------------------------------------------------------------------------------
// Recipes

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** A FAL source with the model's own input fields, checked and completed so it is priced and decodable. */
function falSource(src, take) {
  const endpoint = src.endpoint ?? DEFAULT_ENDPOINT
  const spec = ENDPOINTS[endpoint]
  if (!spec) throw new Error(`Take ${take}: the Sound Studio v1 generates with ${Object.keys(ENDPOINTS).join(' or ')} (got ${endpoint}).`)
  if (!isObj(src.input)) throw new Error(`Take ${take}: a fal source has the model's input, like {"fal": {"input": {"${spec.prompt}": "...", "${spec.seconds}": 1.5}}}.`)
  const input = { ...src.input }
  if (typeof input[spec.prompt] !== 'string' || !input[spec.prompt].trim()) throw new Error(`Take ${take}: ${endpoint} takes its prompt in "${spec.prompt}".`)
  const s = input[spec.seconds]
  if (typeof s !== 'number' || s < spec.min || s > spec.max) throw new Error(`Take ${take}: set "${spec.seconds}" to ${spec.min}-${spec.max} seconds so the call is priced before it is paid.`)
  const [field, wav, ok] = spec.format
  input[field] ??= wav
  if (!ok.test(String(input[field]))) throw new Error(`Take ${take}: the Sound Studio decodes WAV/PCM only; use "${field}": "${wav}".`)
  if (input.sync_mode) throw new Error(`Take ${take}: leave sync_mode off.`)
  return { endpoint, input, units: s, est_usd: usd(s * spec.usd_per_s) }
}

/** Check a recipe completely (names, sources, ops) before anything runs or is paid. */
export function checkRecipe(raw, where = 'recipe') {
  if (!isObj(raw)) throw new Error(`${where} is not a JSON object.`)
  const takes = raw.takes ?? []
  if (!Array.isArray(takes)) throw new Error(`${where}: takes is a list.`)
  const drop = raw.drop ?? []
  if (!Array.isArray(drop) || drop.some((d) => typeof d !== 'string')) throw new Error(`${where}: drop is a list of take names.`)
  if (!takes.length && !drop.length) throw new Error(`${where} makes no takes and drops none.`)
  const seen = new Set()
  const out = takes.map((t, i) => {
    if (!isObj(t)) throw new Error(`${where}: take ${i + 1} is not an object.`)
    const name = checkName('Take', t.name)
    if (seen.has(name)) throw new Error(`${where}: take ${name} appears twice.`)
    seen.add(name)
    const src = t.source
    const kinds = isObj(src) ? Object.keys(src) : []
    if (kinds.length !== 1 || !['fal', 'take', 'file'].includes(kinds[0])) throw new Error(`Take ${name}: source is one of {"fal": {...}}, {"take": "<name> or s003:<name>"}, {"file": "<path.wav>"}.`)
    let source
    if (kinds[0] === 'fal') source = { fal: falSource(src.fal ?? {}, name) }
    else if (typeof src[kinds[0]] !== 'string' || !src[kinds[0]]) throw new Error(`Take ${name}: ${kinds[0]} source is a string.`)
    else source = { [kinds[0]]: src[kinds[0]] }
    if (t.expect_s != null && !(Number(t.expect_s) > 0)) throw new Error(`Take ${name}: expect_s is seconds.`)
    return { name, source, ops: dsp.checkOps(t.ops ?? []), ...(t.loop != null ? { loop: Boolean(t.loop) } : {}), ...(t.expect_s != null ? { expect_s: Number(t.expect_s) } : {}) }
  })
  const caption = typeof raw.caption === 'string' && raw.caption.trim() ? raw.caption.trim() : null
  return { caption, takes: out, drop: drop.map((d) => checkName('Take', d)), ...(typeof raw.name === 'string' ? { name: raw.name } : {}) }
}

/** A batch's recipes, in order: one folder of .json files (sorted by name), a batch file, or several recipe files. */
export function batchRecipes(args) {
  const list = (Array.isArray(args) ? args : [args]).map((a) => path.resolve(String(a)))
  const one = list.length === 1 ? fs.statSync(list[0], { throwIfNoEntry: false }) : undefined
  let files = list
  if (one?.isDirectory()) files = fs.readdirSync(list[0]).filter((f) => /\.json$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => path.join(list[0], f))
  else if (one) {
    const doc = readJson(list[0])
    if (Array.isArray(doc?.steps)) files = doc.steps.map((s) => path.resolve(path.dirname(list[0]), String(s)))
  }
  if (!files.length) throw new Error('The batch has no recipes.')
  return files.map((file) => {
    const raw = readJson(file)
    if (!raw) throw new Error(`No recipe at ${file} (or it is not valid JSON).`)
    return { file, raw }
  })
}

// ---------------------------------------------------------------------------------------------
// Budget

/** USD this unit has spent so far, from the world's ledger (the same count fal.mjs gates on). */
function ledgerGate(world, env, budget, estUsd) {
  return checkBudget({ lines: readSpend(spendFile(world)), by: byOf(env), estUsd, unitBudget: budget, config: world.config })
}

/** The FAL files of one paid take; an unchanged input with a receipt resumes for free. */
function falFiles(dir, id, take) {
  const base = path.join(dir, 'fal', `${id}-${take}`)
  return { input: `${base}.input.json`, receipt: `${base}.job.json`, result: `${base}.result.json`, raw: path.join(dir, 'raw', `${id}-${take}`) }
}

function resumable(files, input) {
  const before = readJson(files.input), rec = readJson(files.receipt)
  return Boolean(before && rec?.submission?.request_id && JSON.stringify(before) === JSON.stringify(input))
}

/** What a list of recipes would cost, before anything runs. Resumed calls cost nothing. */
function plannedSpend(dir, m, recipes) {
  let n = m.next, total = 0, calls = 0
  for (const r of recipes) {
    const id = stepId(n++)
    for (const t of r.takes) {
      if (!t.source.fal) continue
      if (resumable(falFiles(dir, id, t.name), t.source.fal.input)) continue
      total += t.source.fal.est_usd
      calls++
    }
  }
  return { est_usd: usd(total), calls }
}

function budgetStop(m, world, env, budget, plan) {
  if (!plan.calls) return null
  const gate = ledgerGate(world, env, budget, plan.est_usd)
  if (gate.ok) return null
  return new BudgetStop(`${gate.reason} This needs ${plan.calls} paid take(s), est. USD ${plan.est_usd}. Nothing was submitted. Vary earlier takes (source "take") for free, or ask the player to raise the budget.`, gate)
}

// ---------------------------------------------------------------------------------------------
// Steps

function runNode(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: (FAL_TIMEOUT_S + 60) * 1000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
    })
  })
}

class StepError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra) }
}

/** One FAL generation through fal.mjs (world mode, budget, spend line), decoded. */
async function generate(dir, m, id, take, fal, { world, env, budget, paid }) {
  const files = falFiles(dir, id, take)
  fs.mkdirSync(path.dirname(files.input), { recursive: true })
  if (fs.existsSync(files.receipt) && !resumable(files, fal.input)) {
    // A changed recipe under the same id: keep the old call's files, make a new call.
    const t = Date.now()
    for (const f of [files.input, files.receipt, files.result]) if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.json$/, `.${t}.json`))
    if (fs.existsSync(files.raw)) fs.renameSync(files.raw, `${files.raw}.${t}`)
  }
  if (!env.FAL_KEY) throw new StepError('fal', 'FAL key missing: FAL_KEY is not set. The player sets it in Genio under Settings -> Accounts & keys -> API keys.')
  const resuming = resumable(files, fal.input)
  fs.writeFileSync(files.input, JSON.stringify(fal.input, null, 1))
  const args = ['run', '--world', world.root, '--budget', String(budget), '--units', String(fal.units), '--endpoint', fal.endpoint, '--input', files.input, '--receipt', files.receipt, '--dir', files.raw, '--name', take, '--timeout', String(FAL_TIMEOUT_S)]
  const r = await runNode(FAL_SCRIPT, args, env)
  const rec = readJson(files.receipt)
  if (!resuming && rec?.submission?.request_id) paid.push({ take, request_id: rec.submission.request_id, est_usd: rec.price?.estimated_usd ?? fal.est_usd, raw: files.raw })
  let err = null
  try { err = JSON.parse(r.stderr.slice(r.stderr.indexOf('{')))?.error } catch { /* progress lines only */ }
  if (r.code === 6) throw new StepError('budget', `${err ?? 'Budget hard stop.'} (take ${take})`)
  if (r.code !== 0) throw new StepError('fal', `FAL generation for ${take} failed (exit ${r.code}): ${err ?? r.stderr.trim().split(/\r?\n/).slice(-4).join(' ')}`)
  const out = JSON.parse(r.stdout)
  let audio = null
  for (const f of out.files ?? []) {
    if (!f.path || !fs.existsSync(f.path)) continue
    const bytes = fs.readFileSync(f.path)
    try { audio = dsp.readWav(bytes); break } catch { /* maybe headerless PCM */ }
    const ct = String(f.content_type ?? '')
    if (/^audio\/L16/i.test(ct)) {
      const rate = Number(/rate=(\d+)/i.exec(ct)?.[1] ?? 48000), ch = Number(/channels=(\d+)/i.exec(ct)?.[1] ?? 1)
      audio = dsp.readPcm16(bytes, rate, ch)
      break
    }
  }
  if (!audio) throw new StepError('fal', `FAL returned no WAV/PCM audio for ${take} (files: ${(out.files ?? []).map((f) => path.basename(f.path ?? '?')).join(', ') || 'none'}).`)
  if (fal.input.loop === true) audio.info.loop = true
  const record = readJson(files.receipt) ?? {}
  const source = {
    endpoint: fal.endpoint, request_id: out.request_id ?? record.submission?.request_id ?? null, resumed: Boolean(out.resumed),
    est_usd: record.price?.estimated_usd ?? fal.est_usd, units: fal.units, input: record.input ?? fal.input,
    ...(record.genio?.art_bible ? { art_bible: record.genio.art_bible } : {})
  }
  const asked = fal.units, got = Math.round(audio.data[0].length / audio.rate * 1000) / 1000
  const drift = Math.abs(got - asked) > Math.max(0.05, 0.05 * asked) ? `length drift: FAL delivered ${got} s for the ${asked} s asked` : null
  return { audio, source, drift }
}

/** A take by `name` (made earlier in this step, else in the set at the parent) or `s003:name`. */
function takeRef(dir, m, parent, made, ref) {
  const at = /^(s?\d+):(.+)$/i.exec(ref)
  let entry, step
  if (at) {
    step = resolveStep(m, at[1]).id
    entry = setAt(m, step)[at[2]]
    if (!entry) throw new Error(`No take ${at[2]} in the set at ${step}.`)
  } else if (made.has(ref)) {
    return made.get(ref)
  } else {
    entry = parent ? setAt(m, parent)[ref] : null
    if (!entry) throw new Error(`No take ${ref} in the set so far. Takes: ${Object.keys(parent ? setAt(m, parent) : {}).join(', ') || 'none'}`)
    step = entry.step
  }
  const name = at ? at[2] : ref
  const r = readJson(path.join(dir, 'steps', entry.step, 'receipt.json'))
  const t = r?.takes?.find((x) => x.name === name)
  const audio = dsp.readWav(path.join(dir, entry.file))
  const mt = t?.metrics ?? {}
  // The master is 24-bit; what matters is what its own source was.
  Object.assign(audio.info, { source_bits: mt.source_bits ?? null, eff_bits: mt.eff_bits ?? null, source_clipped: mt.source_clipped ?? 0, loop: Boolean(mt.loop) })
  const lineage = t?.lineage ?? { fal: [], files: [], takes: [] }
  return { audio, lineage: { ...lineage, takes: [...new Set([...lineage.takes, `${entry.step}:${name}`])] } }
}

const joinLineage = (a, b) => ({
  fal: [...a.fal, ...b.fal.filter((x) => !a.fal.some((y) => y.request_id && y.request_id === x.request_id))],
  files: [...new Set([...a.files, ...b.files])],
  takes: [...new Set([...a.takes, ...b.takes])]
})

/** Make one take of a recipe into the staging folder: source, 48 kHz, ops, master, metrics, sheet. */
async function makeTake(dir, m, ctx, t) {
  const { staging, parent, made, world, id } = ctx
  let audio, lineage = { fal: [], files: [], takes: [] }
  const notes = []
  if (t.source.fal) {
    const g = await generate(dir, m, id, t.name, t.source.fal, ctx)
    audio = g.audio
    lineage.fal.push(g.source)
    if (g.drift) notes.push(g.drift)
  } else if (t.source.take) {
    const r = takeRef(dir, m, parent, made, t.source.take)
    audio = { ...r.audio, info: { ...r.audio.info } }
    lineage = r.lineage
  } else {
    const file = path.resolve(world.root, t.source.file)
    if (!fs.existsSync(file)) throw new Error(`Take ${t.name}: no file ${t.source.file}`)
    audio = dsp.readWav(file)
    lineage.files.push(worldRel(world, file) ?? path.basename(file))
  }
  audio = dsp.resample(audio, dsp.MASTER_RATE)
  if (t.loop != null) audio.info.loop = t.loop
  const layers = []
  const r = dsp.applyOps(audio, t.ops, {
    take: (ref) => {
      const x = takeRef(dir, m, parent, made, ref)
      layers.push(x.lineage)
      return x.audio
    }
  })
  audio = r.audio
  for (const l of layers) lineage = joinLineage(lineage, l)
  notes.push(...r.notes)
  const file = path.join(staging, `${t.name}.wav`), sheet = path.join(staging, `${t.name}.sheet.png`)
  dsp.writeWav(file, audio, { bits: TAKE_BITS })
  const metrics = dsp.measure(audio, { expect_s: t.expect_s ?? null })
  const warnings = [...notes.filter((n) => n.startsWith('length drift')), ...dsp.warningsFor(metrics)]
  fs.writeFileSync(sheet, dsp.renderSheet(audio, { title: `${m.set} ${id} ${t.name}`, metrics, warnings }))
  made.set(t.name, { audio, lineage: { ...lineage, takes: [...lineage.takes, `${id}:${t.name}`] } })
  return { name: t.name, file, sheet, metrics, warnings, notes: notes.filter((n) => !n.startsWith('length drift')), lineage, source: Object.keys(t.source)[0] }
}

/**
 * Run recipes back to back on the current branch's head (with amend, the first replaces the
 * head). Each is a normal step (own id, receipt, takes, parent chain), published to the manifest
 * as it finishes, at least `gapMs` after the last. The first failure stops the batch: earlier
 * steps stay, it goes under failed/. The budget is checked for all of them before any runs.
 */
async function runSteps(dir, m, recipes, { amend = false, world, env, budget, gapMs = PUBLISH_GAP_MS }) {
  const head = m.branches[m.branch].head
  if (amend && !head) throw new Error('Nothing to amend: this branch has no steps yet.')
  const stop = budgetStop(m, world, env, budget, plannedSpend(dir, m, recipes))
  if (stop) {
    m.failures.push({ id: stepId(m.next), name: recipes[0].name, kind: 'budget', parent: head, branch: m.branch, t: now(), error: stop.message, dir: null })
    m.failures = m.failures.slice(-FAILURES_KEPT)
    writeManifest(dir, m)
    throw stop
  }
  let parent = amend ? byId(m, head).parent : head, lastAt = 0
  const published = []
  for (const [k, recipe] of recipes.entries()) {
    const n = m.next, id = stepId(n), staging = path.join(dir, 'steps', `.pending-${id}`), started = Date.now()
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const { name, file, raw, ...clean } = recipe
    fs.writeFileSync(path.join(staging, 'recipe.json'), JSON.stringify(clean, null, 1))
    const ctx = { staging, parent, made: new Map(), world, env, budget, id, paid: [] }
    const takes = []
    try {
      const current = parent ? setAt(m, parent) : {}
      for (const d of recipe.drop) if (!current[d]) throw new StepError('error', `Cannot drop ${d}: it is not in the set. Takes: ${Object.keys(current).join(', ') || 'none'}`)
      for (const t of recipe.takes) takes.push(await makeTake(dir, m, ctx, t))
    } catch (e) {
      const kind = e instanceof StepError ? e.kind : 'error'
      const failDir = path.join(dir, 'failed', `${id}-${kind}-${Date.now()}`)
      fs.writeFileSync(path.join(staging, 'receipt.json'), JSON.stringify({ schema: STEP_SCHEMA, ok: false, id, kind, error: e.message, paid: ctx.paid }, null, 1))
      fs.mkdirSync(path.dirname(failDir), { recursive: true })
      renameRetry(staging, failDir)
      for (const f of fs.readdirSync(failDir)) if (!['recipe.json', 'receipt.json'].includes(f)) fs.rmSync(path.join(failDir, f), { recursive: true, force: true })
      const spent = usd(ctx.paid.reduce((a, p) => a + (p.est_usd ?? 0), 0))
      m.spent_usd = usd((m.spent_usd ?? 0) + spent)
      m.failures.push({ id, name, kind, parent, branch: m.branch, t: now(), error: e.message, paid: ctx.paid, dir: rel(dir, failDir) })
      m.failures = m.failures.slice(-FAILURES_KEPT)
      writeManifest(dir, m)
      const notRun = recipes.slice(k + 1).map((r) => ({ name: r.name, recipe: r.file ?? null }))
      const at = m.branches[m.branch].head
      return {
        published, notRun,
        failure: {
          ok: false, kind, set: m.set, id, name, branch: m.branch, head: at, error: e.message, paid: ctx.paid,
          message: `${e.message} The set stays at ${at ?? 'empty'}.${ctx.paid.length ? ` Paid takes so far are kept in step data (${ctx.paid.map((p) => p.request_id).join(', ')}); re-running the same recipe resumes them without paying again.` : ''}`,
          recipe: path.join(failDir, 'recipe.json')
        }
      }
    }
    const spent = usd(ctx.paid.reduce((a, p) => a + (p.est_usd ?? 0), 0))
    await sleep(lastAt + gapMs - Date.now())
    const t = now(), final = path.join(dir, 'steps', id)
    renameRetry(staging, final)
    const abs = (f) => path.join(final, path.basename(f))
    const warnings = takes.flatMap((x) => x.warnings.map((w) => `${x.name}: ${w}`))
    const receipt = {
      schema: STEP_SCHEMA, ok: true, set: m.set, id, n, parent, branch: m.branch, name, caption: recipe.caption ?? name, t, ms: Date.now() - started,
      takes: takes.map((x) => ({ ...x, file: abs(x.file), sheet: abs(x.sheet) })), dropped: recipe.drop, est_usd: spent, warnings
    }
    fs.writeFileSync(path.join(final, 'receipt.json'), JSON.stringify(receipt, null, 1))
    const entry = {
      id, n, parent, branch: m.branch, name, caption: receipt.caption, t, ms: receipt.ms,
      takes: Object.fromEntries(takes.map((x) => [x.name, {
        file: `steps/${id}/${x.name}.wav`, sheet: `steps/${id}/${x.name}.sheet.png`, duration_s: x.metrics.duration_s,
        peak_dbfs: x.metrics.peak_dbfs, lufs: x.metrics.lufs, loop: x.metrics.loop, warnings: x.warnings.length
      }])),
      dropped: recipe.drop, warnings: warnings.length, est_usd: spent, files: { recipe: `steps/${id}/recipe.json`, receipt: `steps/${id}/receipt.json` }
    }
    if (amend && k === 0) {
      byId(m, head).superseded_by = id
      m.history.push({ op: 'amend', t, branch: m.branch, replaced: head, by: id })
    }
    m.steps.push(entry)
    m.next = n + 1
    m.spent_usd = usd((m.spent_usd ?? 0) + spent)
    m.branches[m.branch].head = id
    const mb = dirBytes(dir) / 2 ** 20
    if (mb > DATA_WARN_MB) warnings.push(`This set's step data is ${Math.round(mb)} MB; takes are kept for A/B and later steps.`)
    writeManifest(dir, m)
    published.push({
      ok: true, set: m.set, id, n, name, caption: entry.caption, branch: m.branch, parent, est_usd: spent,
      takes: receipt.takes.map((x) => ({ name: x.name, file: x.file, sheet: x.sheet, duration_s: x.metrics.duration_s, peak_dbfs: x.metrics.peak_dbfs, lufs: x.metrics.lufs, warnings: x.warnings })),
      warnings, receipt: path.join(final, 'receipt.json')
    })
    parent = id
    lastAt = Date.now()
  }
  return { published, failure: null, notRun: [] }
}

function context({ world, env, budget, m }) {
  const w = openWorld(world ?? process.cwd())
  const b = budget != null ? Number(budget) : m.budget_usd ?? DEFAULT_BUDGET_USD
  if (!(b >= 0)) throw new Error('budget is a USD amount, like 0.50')
  return { world: w, env, budget: b }
}

function loadRecipe(recipe) {
  if (typeof recipe === 'string') {
    const raw = readJson(path.resolve(recipe))
    if (!raw) throw new Error(`No recipe at ${recipe} (or it is not valid JSON).`)
    return { ...checkRecipe(raw, path.basename(recipe)), file: path.resolve(recipe) }
  }
  return checkRecipe(recipe)
}

/** Run one recipe on the current branch's head (or, with amend, replace the head). */
export async function step({ dataDir = soundDataDir(), set, recipe, name, amend = false, world, budget, env = process.env } = {}) {
  const dir = setDir(dataDir, set)
  const r = loadRecipe(recipe)
  r.name = checkName('Step', name ?? r.name ?? (r.file ? stepName(r.file) : 'step'))
  return withLock(dir, async () => {
    const m = readManifest(dir)
    assertOutside(dir, [world ?? process.cwd()], 'Sound Studio data must live outside the project/worktree (set GENIO_SOUND_DATA)')
    const out = await runSteps(dir, m, [r], { amend, ...context({ world, env, budget, m }) })
    return out.failure ?? out.published[0]
  })
}

/** Run several recipes as one batch: each lands as it finishes; the budget covers all of them up front. */
export async function batch({ dataDir = soundDataDir(), set, recipes, world, budget, env = process.env, gapMs = PUBLISH_GAP_MS } = {}) {
  const dir = setDir(dataDir, set)
  const items = (Array.isArray(recipes) && recipes.every(isObj) ? recipes.map((raw, i) => ({ raw, file: null, i })) : batchRecipes(recipes)).map(({ raw, file }, i) => {
    const r = checkRecipe(raw, file ? path.basename(file) : `recipe ${i + 1}`)
    return { ...r, file, name: checkName('Step', r.name ?? (file ? stepName(file) : `step${i + 1}`)) }
  })
  if (!items.length) throw new Error('The batch has no recipes.')
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const { published, failure, notRun } = await runSteps(dir, m, items, { gapMs, ...context({ world, env, budget, m }) })
    const did = `${published.length} of ${items.length} steps landed`
    return {
      ok: !failure, set: m.set, branch: m.branch, head: m.branches[m.branch].head, steps: published, failure, not_run: notRun,
      est_usd: usd(published.reduce((a, s) => a + s.est_usd, 0)),
      message: failure ? `${did}; ${failure.id} (${failure.name}) failed. ${failure.message}${notRun.length ? ` Not run: ${notRun.map((x) => x.name).join(', ')}.` : ''}` : `${did}. Review the sheets of ${published.at(-1).id} before the next batch.`
    }
  })
}

async function edit(dataDir, set, fn) {
  const dir = setDir(dataDir, set)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const extra = fn(m) ?? {}
    writeManifest(dir, m)
    return { ok: true, ...extra, ...summary(dir, m) }
  })
}

export function revert({ dataDir = soundDataDir(), set, to } = {}) {
  return edit(dataDir, set, (m) => revertHead(m, to, WHO))
}

export function branch({ dataDir = soundDataDir(), set, name, from } = {}) {
  return edit(dataDir, set, (m) => { addBranch(m, name, from, WHO) })
}

export function switchBranch({ dataDir = soundDataDir(), set, name } = {}) {
  return edit(dataDir, set, (m) => { switchTo(m, name) })
}

export async function status({ dataDir = soundDataDir(), set } = {}) {
  const dir = setDir(dataDir, set)
  return { ok: true, ...summary(dir, readManifest(dir)) }
}

/** The budget as the world's ledger sees it: no network, nothing paid. */
export async function budgetInfo({ dataDir = soundDataDir(), set, world, budget, env = process.env } = {}) {
  const m = readManifest(setDir(dataDir, set))
  const ctx = context({ world, env, budget, m })
  const g = ledgerGate(ctx.world, env, ctx.budget, 0)
  return { ok: true, set: m.set, budget_usd: ctx.budget, spent_usd: g.spent_by_unit, remaining_usd: usd(Math.max(0, ctx.budget - g.spent_by_unit)), set_spent_usd: m.spent_usd, by: byOf(env), endpoints: Object.fromEntries(Object.entries(ENDPOINTS).map(([k, v]) => [k, { label: v.label, usd_per_s: v.usd_per_s }])) }
}

// ---------------------------------------------------------------------------------------------
// Export

/** Destinations for the exported takes: one .wav for one take, a folder for several, or a {take: path} map. */
function destinations(world, names, to) {
  if (isObj(to)) return names.map((n) => [n, path.resolve(world.root, String(to[n] ?? ''))])
  if (typeof to !== 'string' || !to) throw new Error('Export needs --to <path.wav> (one take) or --to <folder> (several), from asset_locate.')
  const p = path.resolve(world.root, to)
  if (/\.wav$/i.test(to)) {
    if (names.length !== 1) throw new Error(`--to ${to} names one file, but ${names.length} takes are exported; give a folder or --take <name>.`)
    return [[names[0], p]]
  }
  return names.map((n) => [n, path.join(p, `${n}.wav`)])
}

/**
 * Write the set's final WAVs into the project: each verified by reading it back (same length,
 * channels and rate), with a provenance record for the derived file (provider local,
 * derived_from the FAL request ids), its spend lines in the ledger, and the recipes that made
 * it under .genio/sound/<set>/. Takes themselves stay in step data.
 */
export async function exportSet({ dataDir = soundDataDir(), set, world: worldArg, step: ref, takes: only, to, bits = 16, overwrite = false, env = process.env } = {}) {
  const dir = setDir(dataDir, set)
  if (![16, 24].includes(Number(bits))) throw new Error('bits is 16 or 24')
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const world = openWorld(worldArg ?? process.cwd())
    const at = ref ? resolveStep(m, ref).id : m.branches[m.branch].head
    if (!at) throw new Error('This branch has no steps yet.')
    const all = setAt(m, at)
    const names = only?.length ? only : Object.keys(all)
    for (const n of names) if (!all[n]) throw new Error(`No take ${n} in the set at ${at}. Takes: ${Object.keys(all).join(', ') || 'none'}`)
    if (!names.length) throw new Error(`The set at ${at} has no takes.`)
    const plan = destinations(world, names, to)
    for (const [, dest] of plan) {
      const r = worldRel(world, dest)
      if (!r || r === '.genio' || r.startsWith('.genio/')) throw new Error(`Export to ${dest}: final sounds go inside the project (${world.root}), outside .genio/.`)
      if (!/\.wav$/i.test(dest)) throw new Error(`Export to ${dest}: the Sound Studio v1 writes WAV.`)
      if (fs.existsSync(dest) && !overwrite) throw new Error(`${r} already exists. Pick a free path from asset_locate, or pass --overwrite when replacing your own export.`)
    }
    const soundDir = path.join(world.dir, 'sound', m.set)
    const ledger = spendFile(world), by = byOf(env)
    const exported = []
    const stepsUsed = new Set(chain(m, at).map((s) => s.id))
    for (const [name, dest] of plan) {
      const take = all[name]
      const receipt = readJson(path.join(dir, 'steps', take.step, 'receipt.json'))
      const info = receipt?.takes?.find((x) => x.name === name) ?? {}
      const lineage = info.lineage ?? { fal: [], files: [], takes: [] }
      for (const t of lineage.takes) stepsUsed.add(t.split(':')[0])
      stepsUsed.add(take.step)
      const audio = dsp.readWav(path.join(dir, take.file))
      Object.assign(audio.info, { eff_bits: info.metrics?.eff_bits ?? null, source_bits: info.metrics?.source_bits ?? null, source_clipped: info.metrics?.source_clipped ?? 0, loop: Boolean(info.metrics?.loop) })
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      dsp.writeWav(dest, audio, { bits: Number(bits) })
      const back = dsp.readWav(dest)
      const drift = back.data[0].length !== audio.data[0].length || back.data.length !== audio.data.length || back.rate !== audio.rate
      if (drift) {
        fs.rmSync(dest, { force: true })
        throw new Error(`length drift: ${name} read back as ${back.data[0].length} samples x ${back.data.length} at ${back.rate} Hz against ${audio.data[0].length} x ${audio.data.length} at ${audio.rate} Hz; nothing was kept.`)
      }
      back.info = audio.info
      const metrics = dsp.measure(back)
      const warnings = dsp.warningsFor(metrics)
      // Spend lines: fal.mjs wrote one per paid call; add any this world's ledger lacks (a step run against another world).
      const lines = readSpend(ledger)
      const spend = []
      for (const f of lineage.fal) {
        let lineFor = lines.find((l) => l.request_id === f.request_id)
        if (!lineFor && f.request_id) {
          lineFor = { t: now(), provider: 'fal', endpoint: f.endpoint, request_id: f.request_id, units: f.units ?? null, unit: 'seconds', est_usd: f.est_usd ?? null, by, recorded_at_export: true }
          appendSpend(ledger, lineFor)
        }
        if (lineFor) spend.push(lineFor)
      }
      const est = usd(lineage.fal.reduce((a, f) => a + (f.est_usd ?? 0), 0))
      const recipeRel = `.genio/sound/${m.set}/steps/${take.step}.json`
      const bible = lineage.fal.find((f) => f.art_bible)?.art_bible
      const provenance = writeProvenance(world, dest, {
        provider: 'local', endpoint: 'genio/sound', request_id: null,
        input: { set: m.set, step: take.step, take: name, bits: Number(bits), rate: back.rate, channels: back.data.length },
        price: { unit: null, unit_price_usd: null, estimated_usd: est, checked: now().slice(0, 10) },
        recipe: recipeRel,
        derived_from: [...lineage.fal.map((f) => f.request_id).filter(Boolean), ...lineage.files],
        sources: lineage.fal.map((f) => ({ endpoint: f.endpoint, request_id: f.request_id, est_usd: f.est_usd, input: f.input })),
        takes: lineage.takes,
        metrics: { duration_s: metrics.duration_s, peak_dbfs: metrics.peak_dbfs, true_peak_dbtp: metrics.true_peak_dbtp, lufs: metrics.lufs, loop: metrics.loop, seam: metrics.seam },
        by, created: now(),
        ...(bible ? { art_bible: bible } : {})
      })
      exported.push({ take: name, step: take.step, path: worldRel(world, dest), file: dest, provenance, recipe: recipeRel, est_usd: est, spend, metrics, warnings, sha256: sha256File(dest) })
    }
    // The recipes and a manifest copy: how each final sound was made, reproducible from its sources.
    fs.mkdirSync(path.join(soundDir, 'steps'), { recursive: true })
    for (const id of [...stepsUsed].sort()) {
      const recipe = readJson(path.join(dir, 'steps', id, 'recipe.json'))
      if (recipe) fs.writeFileSync(path.join(soundDir, 'steps', `${id}.json`), JSON.stringify({ id, parent: byId(m, id)?.parent ?? null, caption: byId(m, id)?.caption ?? null, ...recipe }, null, 1) + '\n')
    }
    fs.writeFileSync(path.join(soundDir, 'manifest.json'), JSON.stringify(m, null, 1) + '\n')
    const indexFile = path.join(soundDir, 'exports.json')
    const index = (readJson(indexFile) ?? []).filter((e) => !exported.some((x) => x.path === e.path))
    index.push(...exported.map((x) => ({ path: x.path, take: x.take, step: x.step, sha256: x.sha256, est_usd: x.est_usd, t: now() })))
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 1) + '\n')
    return {
      ok: true, set: m.set, step: at, exported,
      recipes: worldRel(world, soundDir), est_usd: usd(exported.reduce((a, x) => a + x.est_usd, 0)),
      message: `${exported.length} WAV(s) written and verified; commit them with ${worldRel(world, path.join(world.dir, 'provenance'))}/, .genio/spend.jsonl and .genio/sound/${m.set}/.`
    }
  })
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `Usage: sound.mjs <command> <set> [args] [--data <dir>] [--world <project root>]
  init <set> [--kind sfx|ui|ambience] [--target unity|godot|web] [--budget <usd>]
  step <set> <recipe.json> [--name <name>] [--amend] [--budget <usd>]
  batch <set> <folder|batch.json|recipe.json...> [--budget <usd>]
  revert <set> <step>
  branch <set> <name> [--from <step>]
  switch <set> <branch>
  status <set>
  budget <set> [--budget <usd>]
  export <set> --to <path.wav|folder> [--take <name>]... [--step <step>] [--bits 16|24] [--overwrite]`

function parseArgs(argv) {
  const pos = [], opt = { take: [] }
  const bools = new Set(['amend', 'overwrite'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const key = a.slice(2)
    if (bools.has(key)) { opt[key] = true; continue }
    if (!['data', 'world', 'kind', 'target', 'budget', 'name', 'from', 'to', 'take', 'step', 'bits'].includes(key) || argv[i + 1] == null) throw new Error(`Unknown or incomplete option ${a}\n${USAGE}`)
    if (key === 'take') opt.take.push(argv[++i])
    else opt[key] = argv[++i]
  }
  return { pos, opt }
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2))
  const [command, set, arg] = pos
  if (!command || !set) throw new Error(USAGE)
  const dataDir = opt.data ? path.resolve(opt.data) : soundDataDir()
  const common = { dataDir, set }
  const world = opt.world ? path.resolve(opt.world) : undefined
  let result
  switch (command) {
    case 'init': result = await init({ ...common, kind: opt.kind, target: opt.target, budget: opt.budget, world }); break
    case 'step':
      if (!arg) throw new Error(USAGE)
      result = await step({ ...common, recipe: arg, name: opt.name, amend: opt.amend, world, budget: opt.budget })
      break
    case 'batch':
      if (!arg) throw new Error(USAGE)
      result = await batch({ ...common, recipes: pos.slice(2), world, budget: opt.budget })
      break
    case 'revert': result = await revert({ ...common, to: arg }); break
    case 'branch': result = await branch({ ...common, name: arg, from: opt.from }); break
    case 'switch': result = await switchBranch({ ...common, name: arg }); break
    case 'status': result = await status(common); break
    case 'budget': result = await budgetInfo({ ...common, world, budget: opt.budget }); break
    case 'export': result = await exportSet({ ...common, world, to: opt.to, takes: opt.take, step: opt.step, bits: opt.bits ? Number(opt.bits) : 16, overwrite: opt.overwrite }); break
    default: throw new Error(USAGE)
  }
  console.log(JSON.stringify(result, null, 1))
  if (!result.ok) process.exitCode = (result.failure ?? result).kind === 'budget' ? 6 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = e instanceof BudgetStop ? 6 : 1
  })
}
