#!/usr/bin/env node
/**
 * Genio Modeller kernel: one headless Blender per step, or per batch of steps, through the safe runner.
 *
 * A model is a folder in the unit's data directory (never the worktree):
 *   manifest.json            steps, branches, the pinned Blender, history
 *   steps/<id>/script.py     the agent's step script, as it ran
 *   steps/<id>/lib.py        the lib.py next to that script, as the step ran with it (run first)
 *   steps/<id>/model.blend   compressed snapshot (pruned to the last few per branch)
 *   steps/<id>/model.glb     modifier-applied GLB, what the live view loads
 *   steps/<id>/sheet.png     2x2 Workbench review sheet (3/4, front, side, top); a batch's last step only
 *   steps/<id>/view.png      the 3/4 view alone, 512 px (with the sheet)
 *   steps/<id>/receipt.json  caption, counts, bounds, text review, advisory checks, timings, and the
 *                            step's measures: agent_ms (the agent's time since the kernel returned the
 *                            run before), script and lib bytes, amend and rerun, split phases
 *   failed/<id>-<kind>-<t>/  scripts that raised, crashed or hung, with receipts
 *
 * `report <model>` sums a model's run up from these, for recons and benchmarks. `init --kind <kind>` starts the
 * model's lib.py (beside its step scripts, in the worktree) from templates/<kind>.py: a plan to adapt.
 *
 * Each step runs on its parent's snapshot and writes into a staging folder. Its
 * GLB moves to steps/<id> and the step becomes the head as soon as Blender has
 * exported it (landed.json); the snapshot, sheet and receipt follow when Blender
 * finishes the step. A step that fails before its GLB never lands, so a crash or
 * a hang leaves the model at its last good snapshot; one that stops after landing
 * stays, without its sheet. Snapshots older than the retention window are
 * rebuilt on demand by replaying the scripts that made them, each after the
 * lib.py it ran with.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bytecodeEnv, runBlender, assertOutside } from './blender.mjs'
import { blenderVersion, listBlenders, pickModellerBlender } from '../../../lib/blender-path.mjs'
import {
  addBranch, byId, checkName, dirBytes, line, now, readJson, rel, renameRetry, resolveStep, revertHead, sha256, sleep, stepId, switchTo, withLock as lockDir, writeManifest
} from '../../../lib/step-kernel.mjs'

export { line }

const here = path.dirname(fileURLToPath(import.meta.url))
export const STEP_SCRIPT = path.join(here, 'genio_step.py')
export const WARM_SCRIPT = path.join(here, 'genio_warm.py')
export const SCHEMA = 'genio.modeller.v1'
/** Snapshots kept per branch; older ones replay from their scripts. */
export const KEEP_SNAPSHOTS = 5
/** Watchdog per step, seconds. */
export const STEP_TIMEOUT = 60
/** Least time between two steps of a batch landing, so the live view shows each one's change. */
export const PUBLISH_GAP_MS = 600
const POLL_MS = 50
const SESSION_WARN_MB = 300
const FAILURES_KEPT = 50
/** An agent_ms past this is a gap (a respawn, a wait for the player), left out of the report's sums. */
export const AGENT_GAP_MS = 10 * 60 * 1000
/** Lib templates per model kind (templates/<kind>.py): a plan to adapt and the order of steps; `symmetry` is the kind's default. */
export const TEMPLATES = path.join(here, '..', 'templates')
export const KINDS = { vehicle: { symmetry: 'x' }, building: {}, prop: {}, weapon: {}, character: { symmetry: 'x' } }
const WHO = { tool: 'Modeller', cli: 'modeller.mjs', thing: 'model', key: 'model' }

/** Where models live: GENIO_MODELLER_DATA, else next to the unit's Blender scratch, else temp. */
export function modellerDataDir(env = process.env) {
  if (env.GENIO_MODELLER_DATA) return path.resolve(env.GENIO_MODELLER_DATA)
  if (env.GENIO_BLENDER_SCRATCH) return path.join(path.dirname(path.resolve(env.GENIO_BLENDER_SCRATCH)), 'modeller')
  return path.join(os.tmpdir(), 'genio-modeller')
}

const withLock = (dir, fn) => lockDir(dir, fn, WHO)

/** A step name from its script: `s03_deck.py` becomes `deck`. */
export function stepName(script) {
  const base = path.basename(script).replace(/\.py$/i, '').replace(/^s?\d+[_-]+/i, '')
  return base.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'step'
}

function modelDir(dataDir, model) {
  return path.join(dataDir, checkName('Model', model))
}

function readManifest(dir) {
  const m = readJson(path.join(dir, 'manifest.json'))
  if (!m) throw new Error(`No model at ${dir}. Run: modeller.mjs init ${path.basename(dir)}`)
  if (m.schema !== SCHEMA) throw new Error(`Unknown manifest schema ${m.schema}`)
  return m
}

function describeBlender(p, version) {
  const st = fs.statSync(p)
  return { path: p, version: version.join('.'), size: st.size, mtimeMs: Math.round(st.mtimeMs) }
}

/**
 * The Blender a model is pinned to: an explicit path or version, GENIO_BLENDER, else 4.2 when installed.
 * The installed list is the cached one (listBlenders) unless `fresh`, as for `init --repin`.
 */
export function chooseBlender(choice, env = process.env, fresh = false) {
  if (choice && typeof choice === 'object') return describeBlender(choice.path, String(choice.version).split('.').map(Number))
  const wanted = choice ?? env.GENIO_BLENDER
  if (wanted && /[\\/]|\.exe$/i.test(wanted)) {
    const v = blenderVersion(wanted)
    if (!v) throw new Error(`Not a Blender executable: ${wanted}`)
    return describeBlender(wanted, v)
  }
  const found = listBlenders({ fresh, env })
  const pick = wanted ? found.find((b) => b.version.join('.') === wanted || b.version.join('.').startsWith(`${wanted}.`)) : pickModellerBlender(found)
  if (!pick) {
    const have = found.map((b) => b.version.join('.')).join(', ') || 'none'
    throw new Error(wanted ? `Blender ${wanted} is not installed (found: ${have}).` : `No Blender 4.2 or newer found (found: ${have}). Install Blender 4.2 LTS or set GENIO_BLENDER.`)
  }
  return describeBlender(pick.path, pick.version)
}

/** Same binary as when the model was pinned, or a clear error: GLBs are byte-identical within one version only. */
function checkPin(m) {
  const pin = m.blender
  const st = fs.statSync(pin.path, { throwIfNoEntry: false })
  if (!st) throw new Error(`The pinned Blender ${pin.version} is gone (${pin.path}). Run: modeller.mjs init ${m.model} --repin`)
  if (st.size === pin.size && Math.round(st.mtimeMs) === pin.mtimeMs) return
  const v = blenderVersion(pin.path)?.join('.')
  if (v !== pin.version) throw new Error(`The pinned Blender changed from ${pin.version} to ${v ?? 'unknown'}. Run: modeller.mjs init ${m.model} --repin`)
  Object.assign(pin, { size: st.size, mtimeMs: Math.round(st.mtimeMs) })
}

function parseSize(size) {
  if (size == null || Array.isArray(size)) return size ?? null
  const v = String(size).split(/[x,]/i).map(Number)
  if (v.length !== 3 || v.some((x) => !Number.isFinite(x) || x < 0)) throw new Error('size is three metres, like 3.5x3.5x10 (0 for an axis you do not care about)')
  return v
}

function summary(dir, m) {
  const brief = (s) => ({ id: s.id, name: s.name, caption: s.caption, triangles: s.triangles, warnings: s.warnings, snapshot: Boolean(s.files.blend) })
  const head = m.branches[m.branch].head
  return {
    model: m.model, dir, blender: m.blender.version, target: m.target, checks: m.checks,
    branch: m.branch, head, steps: line(m).map(brief),
    branches: Object.fromEntries(Object.entries(m.branches).map(([k, b]) => [k, { head: b.head, from: b.from }])),
    failures: m.failures.slice(-3).map((f) => ({ id: f.id, kind: f.kind, error: f.error }))
  }
}

/**
 * `init --kind`: the kind's template becomes the model's lib.py beside its step scripts (`.genio/modeller/<model>/`
 * in the worktree), unless one is there already. Returns where it is and whether it was written now.
 */
function writeTemplate(kind, model, cwd) {
  const lib = path.join(cwd, '.genio', 'modeller', model, 'lib.py')
  if (fs.existsSync(lib)) return { kind, lib, written: false }
  fs.mkdirSync(path.dirname(lib), { recursive: true })
  fs.copyFileSync(path.join(TEMPLATES, `${kind}.py`), lib)
  return { kind, lib, written: true }
}

export async function init({ dataDir = modellerDataDir(), model, blender, target, budget, size, symmetry, kind, repin = false, cwd = process.cwd(), env = process.env } = {}) {
  assertOutside(dataDir, [cwd], 'Modeller data must live outside the project/worktree (set GENIO_MODELLER_DATA)')
  if (target != null && !['unity', 'godot', 'web'].includes(target)) throw new Error('target is unity, godot or web')
  if (symmetry != null && !['x', 'y', 'none'].includes(symmetry)) throw new Error('symmetry is x (left and right mirror), y (front and back) or none')
  if (kind != null && !Object.hasOwn(KINDS, kind)) throw new Error(`kind is ${Object.keys(KINDS).join(', ')}`)
  const dir = modelDir(dataDir, model)
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true })
  return withLock(dir, async () => {
    let m = readJson(path.join(dir, 'manifest.json'))
    const existing = Boolean(m)
    if (!m) {
      m = { schema: SCHEMA, model, created: now(), blender: chooseBlender(blender, env, repin), target: target ?? null, checks: { budget: null, size: null, symmetry: null }, branch: 'main', branches: { main: { head: null, from: null } }, next: 1, steps: [], failures: [], history: [] }
    } else if (repin || blender) {
      const before = m.blender.version
      m.blender = chooseBlender(blender, env, repin)
      m.history.push({ op: 'repin', t: now(), from: before, to: m.blender.version })
    }
    if (target != null) m.target = target
    if (budget != null) m.checks.budget = Number(budget) || null
    if (size != null) m.checks.size = parseSize(size)
    if (symmetry != null) m.checks.symmetry = symmetry === 'none' ? null : symmetry
    else if (kind != null && !existing) m.checks.symmetry = KINDS[kind].symmetry ?? null
    const template = kind != null ? writeTemplate(kind, model, cwd) : null
    // The first step's agent_ms runs from here: the agent writes its lib and first script now.
    m.returned_at = now()
    writeManifest(dir, m)
    const marker = warmMarker(m.blender)
    if (marker && !fs.existsSync(marker)) startWarm(dataDir, model, env)
    return { ok: true, existing, ...summary(dir, m), ...(template ? { template } : {}) }
  })
}

/**
 * The bytecode cache's marker for one exact Blender binary (path, size, mtime), written once genio_warm.py
 * has filled the cache with it; null when the cache is off for it (bytecodeEnv) or it is not Blender
 * (tests pin Node).
 */
export function warmMarker(pin) {
  const cache = bytecodeEnv(pin.path).PYTHONPYCACHEPREFIX
  if (!cache || !/^blender(\.exe)?$/i.test(path.basename(pin.path))) return null
  const id = crypto.createHash('sha256').update(`${pin.path}|${pin.size}|${pin.mtimeMs}`).digest('hex').slice(0, 16)
  return path.join(cache, `warm-${id}`)
}

/** `modeller.mjs warm <model>` in the background: init returns at once and the warm-up overlaps the first step's writing. */
function startWarm(dataDir, model, env) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'warm', model, '--data', dataDir],
      { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
    child.once('error', () => {})
    child.unref()
  } catch { /* the first step compiles instead */ }
}

/**
 * Fill the bytecode cache for a model's pinned Blender: one short headless run of genio_warm.py (the step
 * runner's imports, a box exported through the GLB preset and the checks), then the marker. On a new
 * machine or after a Blender upgrade, a first step without it reached the live view 1.5 s later than a
 * warm one, compiling numpy, the add-ons and the helpers (measured). init starts it; nothing to do when
 * that binary is warm already.
 */
export async function warm({ dataDir = modellerDataDir(), model, timeout = 120, runner, marker } = {}) {
  const dir = modelDir(dataDir, model)
  const m = readManifest(dir)
  marker ??= warmMarker(m.blender)
  if (!marker || fs.existsSync(marker)) return { ok: true, model: m.model, blender: m.blender.version, warmed: false }
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  const run = await runBlender({ blender: m.blender.path, prefix: runner?.prefix ?? [], script: WARM_SCRIPT, args: [marker], timeout, scratch: path.join(dir, 'logs') })
  return { ok: run.code === 0 && fs.existsSync(marker), model: m.model, blender: m.blender.version, warmed: true, ms: run.ms, log: run.log }
}

/** A step to replay: its script and the lib.py it ran with. */
const replayOf = (dir, s) => ({ script: path.join(dir, s.files.script), lib: s.files.lib ? path.join(dir, s.files.lib) : null })

/** The snapshot to open and the steps to replay on it to reach `parentId`. */
function baseFor(m, dir, parentId) {
  const chain = []
  for (let s = parentId && byId(m, parentId); s; s = s.parent && byId(m, s.parent)) {
    const blend = s.files.blend && path.join(dir, s.files.blend)
    if (blend && fs.existsSync(blend)) return { blend, replay: chain.reverse().map((x) => replayOf(dir, x)) }
    chain.push(s)
  }
  return { blend: null, replay: chain.reverse().map((x) => replayOf(dir, x)) }
}

/** The step folder's helper file, run before each of its scripts: lib.py next to the script. */
function libFor(script) {
  const lib = path.join(path.dirname(script), 'lib.py')
  return fs.statSync(lib, { throwIfNoEntry: false })?.isFile() ? lib : null
}

/** Drop snapshots outside the last `keep` steps of every branch, except kept steps. Scripts stay. */
export function prune(m, dir, keep = KEEP_SNAPSHOTS) {
  const wanted = new Set(m.steps.filter((s) => s.keep).map((s) => s.id))
  for (const b of Object.keys(m.branches)) for (const s of line(m, b).slice(-keep)) wanted.add(s.id)
  const dropped = []
  for (const s of m.steps) {
    if (wanted.has(s.id) || !s.files.blend) continue
    fs.rmSync(path.join(dir, s.files.blend), { force: true })
    s.files.blend = null
    s.blend_sha256 = null
    dropped.push(s.id)
  }
  return dropped
}

const BAKES = /\bp\.bake_maps\s*\(/

/**
 * Blender's --threads caps Cycles too, and a script cannot raise it: a plan whose scripts (replays
 * and lib.py files included) call p.bake_maps runs on every core, others on the runner's default.
 * An explicit `threads` wins.
 */
export function planThreads(plan, threads) {
  if (threads) return threads
  const replay = plan.replay.map((r) => typeof r === 'string' ? { script: r } : r)
  const scripts = [...replay, ...plan.steps].flatMap((s) => [s.script, s.lib]).filter(Boolean)
  return scripts.some((f) => BAKES.test(fs.readFileSync(f, 'utf8'))) ? os.availableParallelism() : undefined
}

/**
 * One Blender for the whole plan; its plan.json goes into the first step's folder. The step runner
 * opens the base snapshot itself, so the receipt times its load (and the live modifiers it evaluates).
 */
function runPlan(m, dir, plan, base, { timeout, threads, runner, signal }) {
  const planFile = path.join(plan.steps[0].out, 'plan.json')
  // `spawned`: the step runner times Blender's start and imports from it.
  fs.writeFileSync(planFile, JSON.stringify({ spawned: Date.now(), base: base.blend, ...plan }, null, 1))
  return runBlender({ blender: m.blender.path, prefix: runner?.prefix ?? [], script: STEP_SCRIPT, args: [planFile], threads: planThreads(plan, threads), timeout, signal, scratch: path.join(dir, 'logs') })
}

/** A step's pair results for the next step's incremental checks (genio_step `pairs`), or null. */
function pairsOf(receipt) {
  const pairs = receipt?.checks?.pairs
  return pairs ? { ...pairs, pierces: receipt.checks.pierces ?? [] } : null
}

function failureKind(run, receipt) {
  if (run.timedOut) return 'hang'
  if (receipt && !receipt.ok) return receipt.kind === 'replay' ? 'replay' : 'error'
  return 'crash'
}

function failureMessage(kind, { receipt, run, timeout, head }) {
  const at = head ? `The model stays at ${head}, its last good snapshot.` : 'The model stays empty.'
  if (kind === 'hang') return `The step ran past ${timeout} s and was stopped. ${at}`
  if (kind === 'crash') return `Blender exited (code ${run.code}) without finishing the step. ${at}`
  if (kind === 'replay') return `Rebuilding an earlier snapshot failed: ${receipt.error}. ${at}`
  return `${receipt.error}. ${at}`
}

/**
 * The step's warnings that its parent did not have, word for word, and how many it shares with it.
 * The same checks repeat on every step until fixed (17 pass-throughs on 14 of 15 village steps), so
 * the agent reads each warning once; the receipt keeps the full list.
 */
function newWarnings(dir, parentId, warnings) {
  const before = new Set(parentId ? readJson(path.join(dir, 'steps', parentId, 'receipt.json'))?.warnings ?? [] : [])
  const fresh = warnings.filter((w) => !before.has(w))
  return { fresh, known: warnings.length - fresh.length }
}

/** A batch's step scripts, in order: one folder of .py files (sorted by name, lib.py aside), a batch .json, or several .py files. */
export function batchScripts(args) {
  const raw = Array.isArray(args) ? args : [args]
  if (raw.some((a) => a && typeof a === 'object')) return raw.map((a) => typeof a === 'object' ? { script: path.resolve(String(a.script ?? '')), name: a.name } : { script: path.resolve(String(a)) })
  const list = raw.map((a) => path.resolve(String(a)))
  let items = list.map((script) => ({ script }))
  const one = list.length === 1 ? fs.statSync(list[0], { throwIfNoEntry: false }) : undefined
  if (one?.isDirectory()) {
    items = fs.readdirSync(list[0]).filter((f) => /\.py$/i.test(f) && !/^lib\.py$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => ({ script: path.join(list[0], f) }))
  } else if (one && /\.json$/i.test(list[0])) {
    const doc = readJson(list[0])
    const entries = Array.isArray(doc) ? doc : doc?.steps
    if (!Array.isArray(entries)) throw new Error(`${list[0]} is not a batch: use ["s01_body.py", ...] or {"steps": [{"script": "s01_body.py", "name": "body"}, ...]}`)
    const at = path.dirname(list[0])
    items = entries.map((e) => typeof e === 'string' ? { script: path.resolve(at, e) } : { script: path.resolve(at, String(e?.script ?? '')), name: e?.name })
  }
  if (!items.length) throw new Error('The batch has no step scripts.')
  return items
}

/**
 * Run step scripts back to back in one Blender on the current branch's head (with amend, the first
 * replaces the head). Each one is a normal step (own id, receipt, snapshot, GLB, parent chain),
 * published to the manifest as soon as Blender has exported its GLB, at least `gapMs` after the
 * last, so the live view shows each change; its snapshot, checks and sheet complete the entry when
 * Blender writes the receipt. Only the last step renders the review sheet unless `everySheet`.
 * The first failure stops the batch: earlier steps stay, it goes under failed/.
 */
async function runSteps(dir, m, scripts, { amend = false, everySheet = false, timeout = STEP_TIMEOUT, threads, runner, gapMs = PUBLISH_GAP_MS }) {
  checkPin(m)
  // The agent's time for this run: since the kernel returned the run before it (or init).
  const agentMs = m.returned_at ? Math.max(0, Date.now() - Date.parse(m.returned_at)) : null
  const items = scripts.map((it) => {
    const source = path.resolve(it.script)
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`No step script at ${source}`)
    return { source, lib: libFor(source), name: checkName('Step', it.name ?? stepName(source)) }
  })
  const head = m.branches[m.branch].head
  if (amend && !head) throw new Error('Nothing to amend: this branch has no steps yet.')
  const parent0 = amend ? byId(m, head).parent : head
  const base = baseFor(m, dir, parent0)
  const plan = { replay: base.replay, steps: [], checks: m.checks, sheet_size: 512 }
  // The text review's "Changes" line compares the first step with its parent's parts (none: no parent;
  // null: unknown, so no line), each later one with the step before it; the checks examine only the
  // pairs with a part changed since then, and an item the parent's review printed is a count (`seen`;
  // none: every item is printed).
  const parentReceipt = parent0 ? readJson(path.join(dir, 'steps', parent0, 'receipt.json')) : null
  const previous = parent0 ? parentReceipt?.parts ?? null : []
  const pairs = pairsOf(parentReceipt)
  const seen = parentReceipt?.review_seen ?? null
  const parentLib = parent0 && byId(m, parent0)?.files.lib
  let libBefore = parentLib && fs.existsSync(path.join(dir, parentLib)) ? sha256(path.join(dir, parentLib)) : null
  const last = m.last_run
  const staged = items.map((it, k) => {
    const n = m.next + k, id = stepId(n), staging = path.join(dir, 'steps', `.pending-${id}`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    fs.copyFileSync(it.source, path.join(staging, 'script.py'))
    // The lib.py as it is now: a later edit never changes what this step ran with.
    if (it.lib) fs.copyFileSync(it.lib, path.join(staging, 'lib.py'))
    const sheet = everySheet || k === items.length - 1
    plan.steps.push({ out: staging, script: path.join(staging, 'script.py'), lib: it.lib && path.join(staging, 'lib.py'), outputs: ['blend', 'glb', ...(sheet ? ['sheet'] : [])], step: { id, n, name: it.name, model: m.model }, ...(k === 0 ? { previous, pairs, seen } : {}) })
    // The step's measures for its receipt: a batch's later steps follow the first with no agent time.
    const lib = it.lib ? sha256(path.join(staging, 'lib.py')) : null
    const measure = {
      agent_ms: k === 0 ? agentMs : 0, ...(k === 0 && agentMs > AGENT_GAP_MS ? { agent_gap: true } : {}),
      script_bytes: fs.statSync(path.join(staging, 'script.py')).size, lib_bytes: it.lib ? fs.statSync(path.join(staging, 'lib.py')).size : 0,
      lib_changed: lib !== libBefore, amend: amend && k === 0,
      rerun_of: k === 0 && last?.name === it.name ? { id: last.id, ...(last.failed ? { failed: last.failed } : {}) } : null
    }
    libBefore = lib
    return { ...it, id, n, staging, measure }
  })

  const started = Date.now()
  // Per staged step, in order: `landed` (its GLB is on disk) and `done` (its receipt says ok).
  const marks = staged.map(() => ({ landed: null, done: null, ms: 0 }))
  const published = [], entries = []
  let completed = 0, parent = parent0, lastAt = 0, stepStart = started, prevAt = started
  // What Blender has finished (each file written atomically): a step's landed.json right after its
  // GLB export, its receipt last. Blender runs the steps in order, so the scan stops at the first one
  // without a receipt.
  const scan = () => {
    for (let k = completed; k < staged.length; k++) {
      const mk = marks[k]
      if (!mk.done) {
        const file = path.join(staged[k].staging, 'receipt.json')
        const receipt = readJson(file)
        if (receipt?.ok) {
          const at = fs.statSync(file).mtimeMs
          Object.assign(mk, { done: receipt, ms: Math.max(0, Math.round(at - prevAt)) })
          prevAt = at
          stepStart = Date.now()
        }
      }
      if (!mk.landed) mk.landed = readJson(path.join(staged[k].staging, 'landed.json'))?.ok ? true : mk.done ? true : null
      if (!mk.done) return
    }
  }
  const absFiles = (files) => Object.fromEntries(Object.entries(files).map(([key, v]) => [key, v && path.join(dir, v)]))
  // Into the live view: the step's GLB and script move to steps/<id>/ and it becomes the head now,
  // while Blender still saves its snapshot, runs the checks and renders the sheet in the staging folder.
  const land = () => {
    const k = published.length, s = staged[k], mk = marks[k]
    const r = mk.done ?? readJson(path.join(s.staging, 'landed.json')) ?? {}
    const t = now(), final = path.join(dir, 'steps', s.id)
    fs.mkdirSync(final, { recursive: true })
    fs.copyFileSync(path.join(s.staging, 'script.py'), path.join(final, 'script.py'))
    if (s.lib) fs.copyFileSync(path.join(s.staging, 'lib.py'), path.join(final, 'lib.py'))
    if (fs.existsSync(path.join(s.staging, 'model.glb'))) renameRetry(path.join(s.staging, 'model.glb'), path.join(final, 'model.glb'))
    const has = (f) => fs.existsSync(path.join(final, f))
    const files = { script: `steps/${s.id}/script.py`, lib: s.lib ? `steps/${s.id}/lib.py` : null, blend: null, glb: has('model.glb') ? `steps/${s.id}/model.glb` : null, sheet: null, view: null, receipt: `steps/${s.id}/receipt.json` }
    const entry = {
      id: s.id, n: s.n, parent, branch: m.branch, name: s.name, caption: r.caption || s.name, t, ms: Math.max(0, Math.round(Date.now() - prevAt)),
      triangles: r.triangles ?? 0, vertices: r.vertices ?? 0, objects: r.objects ?? 0, warnings: r.warnings?.length ?? 0, blend_sha256: null, files
    }
    // The live view reads the head's receipt for its checks: none yet.
    fs.writeFileSync(path.join(final, 'receipt.json'), JSON.stringify({ ok: true, stage: 'glb', id: s.id, caption: entry.caption, parent, branch: m.branch, t, warnings: [] }, null, 1))
    if (amend && k === 0) {
      byId(m, head).superseded_by = s.id
      m.history.push({ op: 'amend', t, branch: m.branch, replaced: head, by: s.id })
    }
    m.steps.push(entry)
    m.next = s.n + 1
    m.branches[m.branch].head = s.id
    writeManifest(dir, m)
    entries.push(entry)
    published.push(null)
    parent = s.id
    lastAt = Date.now()
  }
  // Blender finished the step (or stopped after landing it): the rest of its files join it and its
  // entry gets the receipt's counts, warnings and snapshot. A step whose receipt never came stays
  // published, with a warning; the next step replays its script when its snapshot is missing.
  const complete = (stopped) => {
    const k = completed, s = staged[k], entry = entries[k], final = path.join(dir, 'steps', s.id)
    const receipt = marks[k].done ?? { ...readJson(path.join(final, 'receipt.json')), warnings: [`Blender stopped (${stopped}) after this step reached the live view: ${fs.existsSync(path.join(s.staging, 'model.blend')) ? 'it has no text review or review sheet; its snapshot is kept.' : 'it has no snapshot or review sheet; the next step replays its script.'}`] }
    // A step stopped after landing keeps the timings Blender had by then.
    receipt.timings_ms ??= readJson(path.join(s.staging, 'landed.json'))?.timings_ms ?? {}
    for (const f of ['model.blend', 'sheet.png', 'view.png']) if (fs.existsSync(path.join(s.staging, f))) renameRetry(path.join(s.staging, f), path.join(final, f))
    fs.rmSync(s.staging, { recursive: true, force: true })
    const has = (f) => fs.existsSync(path.join(final, f))
    Object.assign(entry.files, { blend: has('model.blend') ? `steps/${s.id}/model.blend` : null, sheet: has('sheet.png') ? `steps/${s.id}/sheet.png` : null, view: has('view.png') ? `steps/${s.id}/view.png` : null })
    const ms = marks[k].done ? marks[k].ms : Math.max(0, Math.round(Date.now() - prevAt))
    Object.assign(entry, {
      caption: receipt.caption || entry.caption, ms, triangles: receipt.triangles ?? 0, vertices: receipt.vertices ?? 0, objects: receipt.objects ?? 0,
      warnings: receipt.warnings.length, blend_sha256: entry.files.blend ? sha256(path.join(dir, entry.files.blend)) : null
    })
    const pruned = prune(m, dir)
    const mb = dirBytes(dir) / 2 ** 20
    if (mb > SESSION_WARN_MB) receipt.warnings.push(`This model's step data is ${Math.round(mb)} MB; older snapshots are pruned, but GLBs and sheets add up.`)
    entry.warnings = receipt.warnings.length
    const { fresh, known } = newWarnings(dir, entry.parent, receipt.warnings)
    const abs = absFiles(entry.files)
    const times = receipt.timings_ms
    Object.assign(receipt, {
      id: s.id, parent: entry.parent, branch: m.branch, t: entry.t, wall_ms: ms, files: abs, ...s.measure,
      // think is the agent's time before the step, blender the step's own; export, checks and sheet are parts of it.
      phases_ms: { think: s.measure.agent_ms, blender: ms, export: times.export ?? 0, checks: times.checks ?? 0, sheet: times.sheet ?? 0 },
      warnings_new: fresh.length, ...(stopped ? { killed_after_landing: stopped } : {})
    })
    delete receipt.stage
    fs.writeFileSync(path.join(final, 'receipt.json'), JSON.stringify(receipt, null, 1))
    writeManifest(dir, m)
    published[k] = {
      ok: true, model: m.model, id: s.id, n: s.n, name: s.name, caption: entry.caption, branch: m.branch, parent: entry.parent,
      triangles: entry.triangles, vertices: entry.vertices, objects: entry.objects, bounds: receipt.bounds ?? null,
      review: receipt.review ?? [], warnings: fresh, known_warnings: known, sheet: abs.sheet, glb: abs.glb, blend: abs.blend, receipt: abs.receipt, lib: abs.lib, ms, pruned,
      ...(receipt.bakes ? { bakes: receipt.bakes } : {})
    }
    completed++
  }
  const advance = () => {
    if (published.length < staged.length && marks[published.length].landed && Date.now() - lastAt >= gapMs) land()
    while (completed < published.length && marks[completed].done) complete()
  }

  // Blender works ahead; steps land one by one while it runs. A step that runs past `timeout` is stopped.
  const watchdog = new AbortController()
  let finished = false
  const running = runPlan(m, dir, plan, base, { timeout: timeout * staged.length, threads, runner, signal: watchdog.signal }).finally(() => { finished = true })
  try {
    while (!finished) {
      scan()
      advance()
      if (Date.now() - stepStart > timeout * 1000) watchdog.abort()
      await Promise.race([running, sleep(POLL_MS)])
    }
  } catch (e) {
    // Never leave Blender writing into the model after the lock is gone.
    watchdog.abort()
    await running
    throw e
  }
  const run = await running
  scan()
  while (published.length < staged.length && marks[published.length].landed) {
    await sleep(lastAt + gapMs - Date.now())
    advance()
  }
  advance()
  if (completed < published.length) complete(run.timedOut ? 'hang' : `exit code ${run.code}`)
  // The Blender log is known once the run ends.
  for (const p of published) {
    const r = readJson(p.receipt)
    if (r) fs.writeFileSync(p.receipt, JSON.stringify({ ...r, log: run.log }, null, 1))
  }
  // The next run's agent_ms starts now; the same step name again is a rerun of this one.
  if (published.length === staged.length) {
    Object.assign(m, { returned_at: now(), last_run: { id: staged.at(-1).id, name: staged.at(-1).name } })
    writeManifest(dir, m)
    return { published, failure: null, notRun: [] }
  }

  // The first step without a good receipt failed; the ones after it never ran.
  const s = staged[published.length]
  const receipt = readJson(path.join(s.staging, 'receipt.json'))
  const kind = failureKind(run, receipt)
  const failDir = path.join(dir, 'failed', `${s.id}-${kind}-${Date.now()}`)
  fs.mkdirSync(path.dirname(failDir), { recursive: true })
  renameRetry(s.staging, failDir)
  for (const f of fs.readdirSync(failDir)) if (!['script.py', 'lib.py', 'receipt.json', 'plan.json'].includes(f)) fs.rmSync(path.join(failDir, f), { recursive: true, force: true })
  const notRun = staged.slice(published.length + 1)
  for (const x of notRun) fs.rmSync(x.staging, { recursive: true, force: true })
  const at = m.branches[m.branch].head
  const recovered = verifySnapshot(m, dir, parent)
  const error = receipt?.error ?? run.tail.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  const ms = Math.round(Date.now() - prevAt)
  m.failures.push({ id: s.id, name: s.name, kind, parent, branch: m.branch, t: now(), ms, log: run.log, error, dir: rel(dir, failDir), ...s.measure })
  m.failures = m.failures.slice(-FAILURES_KEPT)
  Object.assign(m, { returned_at: now(), last_run: { id: s.id, name: s.name, failed: kind } })
  writeManifest(dir, m)
  return {
    published, notRun: notRun.map((x) => ({ name: x.name, script: x.source })),
    failure: {
      ok: false, kind, model: m.model, id: s.id, name: s.name, branch: m.branch, head: at, error, trace: receipt?.trace ?? [], output: receipt?.output ?? '',
      message: failureMessage(kind, { receipt, run, timeout, head: at }), recovered, log: run.log, script: path.join(failDir, 'script.py')
    }
  }
}

/**
 * The player's references (GENIO_REFERENCES, the unit's references/ folder with references.json): a review
 * line naming them, so every step's sheet is compared with them, and the image files to open beside it.
 */
export function referenceReview(refDir = process.env.GENIO_REFERENCES) {
  const list = refDir ? readJson(path.join(refDir, 'references.json')) : null
  if (!Array.isArray(list) || !list.length) return null
  const named = list.slice(0, 6).map((r) => `${r.file}${r.note ? ` (${String(r.note).slice(0, 80)})` : ''}`).join('; ')
  return {
    line: `References: ${named}${list.length > 6 ? `, and ${list.length - 6} more` : ''}. Compare the sheet with them and say what still differs.`,
    images: list.filter((r) => r.type === 'image').map((r) => path.join(refDir, ...String(r.file).split('/')))
  }
}

/** Run one step script on the current branch's head (or, with amend, replace the head). */
export async function step({ dataDir = modellerDataDir(), model, script, name, amend = false, timeout = STEP_TIMEOUT, threads, runner, references } = {}) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const r = await runSteps(dir, readManifest(dir), [{ script, name }], { amend, timeout, threads, runner })
    if (r.failure) return r.failure
    const ref = referenceReview(references)
    return ref ? { ...r.published[0], review: [...r.published[0].review, ref.line], references: ref.images } : r.published[0]
  })
}

/**
 * Run several step scripts as one batch (see runSteps): each lands in the live view as Blender
 * finishes it. The result lists the steps, the last review sheet, and on a failure the failed step
 * and the scripts that did not run.
 */
export async function batch({ dataDir = modellerDataDir(), model, scripts, everySheet = false, timeout = STEP_TIMEOUT, threads, runner, gapMs = PUBLISH_GAP_MS, references } = {}) {
  const dir = modelDir(dataDir, model)
  const items = batchScripts(scripts)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const { published, failure, notRun } = await runSteps(dir, m, items, { everySheet, timeout, threads, runner, gapMs })
    const last = published.at(-1)
    const ref = referenceReview(references)
    const brief = (s) => ({ id: s.id, n: s.n, name: s.name, caption: s.caption, triangles: s.triangles, objects: s.objects, review: ref ? [...s.review, ref.line] : s.review, warnings: s.warnings, known_warnings: s.known_warnings, glb: s.glb, sheet: s.sheet, ms: s.ms })
    const did = `${published.length} of ${items.length} steps landed`
    return {
      ok: !failure, model: m.model, branch: m.branch, head: m.branches[m.branch].head, steps: published.map(brief), ...(ref ? { references: ref.images } : {}),
      sheet: last?.sheet ?? null, receipt: last?.receipt ?? null, warnings: last?.warnings ?? [], known_warnings: last?.known_warnings ?? 0, failure, not_run: notRun,
      message: failure
        ? `${did}; ${failure.id} (${failure.name}) failed. ${failure.message}${notRun.length ? ` Not run: ${notRun.map((x) => x.name).join(', ')}.` : ''}`
        : `${did}. Read the review of each step before the next batch${last.sheet ? `; the sheet of ${last.id} is there when you need it` : ''}.`
    }
  })
}

/** After a failed step: is the snapshot it ran on still the one recorded? If not, forget it so it replays. */
function verifySnapshot(m, dir, id) {
  const s = id && byId(m, id)
  if (!s?.files.blend) return { head: id ?? null, snapshot: null }
  const file = path.join(dir, s.files.blend)
  const intact = fs.existsSync(file) && sha256(file) === s.blend_sha256
  if (!intact) {
    fs.rmSync(file, { force: true })
    s.files.blend = null
    s.blend_sha256 = null
  }
  return { head: id, snapshot: intact ? file : null, intact }
}

/**
 * Make sure a step has its .blend (rebuilding a pruned one by replay) and return its path: where an
 * export starts. A step whose checks were incremental (pairs of unchanged parts kept their parent's
 * results) also gets one check of every pair, in the same Blender: its `review` and `warnings` come
 * back and stay in the step's receipt as `full_check`. A step checked in full returns its own.
 */
export async function materialize({ dataDir = modellerDataDir(), model, step: ref, timeout = STEP_TIMEOUT * 4, threads, runner } = {}) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const s = ref ? resolveStep(m, ref) : byId(m, m.branches[m.branch].head)
    if (!s) throw new Error('This branch has no steps yet.')
    const receiptFile = path.join(dir, 'steps', s.id, 'receipt.json')
    const r = readJson(receiptFile)
    const check = r?.checks?.pairs?.full === false && !r.full_check
    // Every item in full: a step's own review counts the items it printed before.
    const reviewed = (x) => x ? { review: x.review_full ?? x.review ?? [], warnings: x.warnings ?? [] } : {}
    const own = r?.checks?.pairs?.full ? r : r?.full_check
    const kept = Boolean(s.files.blend && fs.existsSync(path.join(dir, s.files.blend)))
    if (kept && !check) return { ok: true, id: s.id, blend: path.join(dir, s.files.blend), replayed: 0, ...reviewed(own) }
    checkPin(m)
    const base = kept ? { blend: path.join(dir, s.files.blend), replay: [] } : baseFor(m, dir, s.parent)
    const staging = path.join(dir, 'steps', `.rebuild-${s.id}`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const previous = s.parent ? readJson(path.join(dir, 'steps', s.parent, 'receipt.json'))?.parts ?? null : []
    const item = { out: staging, script: null, outputs: [...(kept ? [] : ['blend']), ...(check ? ['check'] : [])], step: { id: s.id, n: s.n, name: s.name, model: m.model }, ...(check ? { full: true, previous } : {}) }
    const plan = { replay: kept ? [] : [...base.replay, replayOf(dir, s)], steps: [item], checks: m.checks }
    const run = await runPlan(m, dir, plan, base, { timeout, threads, runner })
    const receipt = readJson(path.join(staging, 'receipt.json'))
    if (run.timedOut || run.code !== 0 || !receipt?.ok) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw new Error(`${kept ? 'Checking' : 'Rebuilding'} ${s.id} failed (${failureKind(run, receipt)}): ${receipt?.error ?? run.tail.slice(-800)}`)
    }
    const blend = path.join(dir, 'steps', s.id, 'model.blend')
    if (!kept) {
      fs.renameSync(path.join(staging, 'model.blend'), blend)
      s.files.blend = `steps/${s.id}/model.blend`
      s.blend_sha256 = sha256(blend)
      writeManifest(dir, m)
    }
    fs.rmSync(staging, { recursive: true, force: true })
    if (check) fs.writeFileSync(receiptFile, JSON.stringify({ ...r, full_check: reviewed(receipt) }, null, 1))
    return { ok: true, id: s.id, blend, replayed: plan.replay.length, ...reviewed(check ? receipt : own) }
  })
}

async function edit(dataDir, model, fn) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const extra = fn(m) ?? {}
    writeManifest(dir, m)
    return { ok: true, ...extra, ...summary(dir, m) }
  })
}

/** Move the current branch's head back to step N. Later steps stay on disk, off the branch. */
export function revert({ dataDir = modellerDataDir(), model, to } = {}) {
  return edit(dataDir, model, (m) => revertHead(m, to, WHO))
}

/** Start a new branch at step N (default: the head) and switch to it. */
export function branch({ dataDir = modellerDataDir(), model, name, from } = {}) {
  return edit(dataDir, model, (m) => { addBranch(m, name, from, WHO) })
}

export function switchBranch({ dataDir = modellerDataDir(), model, name } = {}) {
  return edit(dataDir, model, (m) => { switchTo(m, name) })
}

/** Keep (or stop keeping) a step's snapshot regardless of retention, e.g. the step you deliver. */
export function keep({ dataDir = modellerDataDir(), model, step: ref, on = true } = {}) {
  return edit(dataDir, model, (m) => {
    const s = resolveStep(m, ref)
    if (on) s.keep = true
    else delete s.keep
  })
}

export async function status({ dataDir = modellerDataDir(), model } = {}) {
  const dir = modelDir(dataDir, model)
  return { ok: true, ...summary(dir, readManifest(dir)) }
}

/** Count, median, 90th percentile (nearest rank) and sum of some milliseconds. */
function spread(values) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  const rank = (q) => s.length ? Math.round(s[Math.max(0, Math.ceil(q * s.length) - 1)]) : null
  return { n: s.length, median: rank(0.5), p90: rank(0.9), sum: Math.round(s.reduce((a, b) => a + b, 0)) }
}

/** Per key, the sum over records of their numbers (`{export: 180}` and `{export: 200}` make `{export: 380}`). */
function sums(records) {
  const out = {}
  for (const r of records) for (const [k, v] of Object.entries(r ?? {})) if (Number.isFinite(v)) out[k] = Math.round((out[k] ?? 0) + v)
  return out
}

const sizeOf = (file) => fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
const seconds = (ms) => ms == null ? null : Math.round(ms / 100) / 10

/**
 * A model's run summed up, for recons and benchmarks (no UI): wall time from init and to the first
 * step, steps, runs, amends, reruns and failures, the agent's time between runs (agent_ms, gaps left
 * out) and Blender's per run (median, 90th percentile, sum), Blender's phases and checks, script and
 * lib sizes, triangles against the budget, the review's new and known items, the head's open review
 * lines and killed steps. Receipts from before the measures existed give what they have.
 */
export async function report({ dataDir = modellerDataDir(), model } = {}) {
  const dir = modelDir(dataDir, model)
  const m = readManifest(dir)
  const onLine = new Set(line(m).map((s) => s.id))
  const runs = [
    ...m.steps.map((s) => {
      const receiptFile = path.join(dir, s.files.receipt)
      const r = readJson(receiptFile) ?? {}
      const killed = r.killed_after_landing ?? (r.warnings ?? []).find((w) => /^Blender stopped \(/.test(w)) ?? null
      return {
        id: s.id, name: s.name, t: s.t, end: fs.statSync(receiptFile, { throwIfNoEntry: false })?.mtimeMs ?? Date.parse(s.t), landed: true,
        outcome: s.superseded_by ? 'replaced' : onLine.has(s.id) ? 'step' : 'other branch', receipt: r, ms: s.ms,
        agent_ms: r.agent_ms ?? null, agent_gap: Boolean(r.agent_gap), script_bytes: r.script_bytes ?? sizeOf(path.join(dir, s.files.script)),
        lib_changed: r.lib_changed ?? null, rerun: Boolean(r.rerun_of), killed: Boolean(killed)
      }
    }),
    ...m.failures.map((f) => ({
      id: f.id, name: f.name, t: f.t, end: Date.parse(f.t), landed: false, outcome: f.kind, receipt: readJson(path.join(dir, f.dir, 'receipt.json')) ?? {}, ms: f.ms ?? null,
      agent_ms: f.agent_ms ?? null, agent_gap: Boolean(f.agent_gap), script_bytes: f.script_bytes ?? sizeOf(path.join(dir, f.dir, 'script.py')),
      lib_changed: f.lib_changed ?? null, rerun: Boolean(f.rerun_of), killed: false
    }))
  ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
  const head = byId(m, m.branches[m.branch].head)
  const headReceipt = head ? readJson(path.join(dir, head.files.receipt)) ?? {} : {}
  const landed = runs.filter((r) => r.landed)
  const counted = runs.filter((r) => r.agent_ms != null && !r.agent_gap)
  const kinds = {}
  for (const f of m.failures) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1
  const end = runs.length ? Math.max(...runs.map((r) => r.end)) : null
  return {
    ok: true, model: m.model, blender: m.blender.version, branch: m.branch, head: head?.id ?? null,
    wall_s: end == null ? null : seconds(end - Date.parse(m.created)),
    first_step_s: m.steps.length ? seconds(Date.parse(m.steps[0].t) - Date.parse(m.created)) : null,
    steps: onLine.size, runs: runs.length, amends: m.history.filter((h) => h.op === 'amend').length,
    reruns: runs.filter((r) => r.rerun).length, failures: kinds, killed: runs.filter((r) => r.killed).length,
    agent_ms: spread(counted.map((r) => r.agent_ms)), agent_gaps: runs.filter((r) => r.agent_gap).length,
    blender_ms: spread(runs.map((r) => r.ms)),
    blender_phases_ms: sums(runs.map((r) => r.receipt.timings_ms)), checks_ms: sums(runs.map((r) => r.receipt.checks_ms)),
    script_kb: Math.round(runs.reduce((n, r) => n + r.script_bytes, 0) / 102.4) / 10,
    lib_kb: head?.files.lib ? Math.round(sizeOf(path.join(dir, head.files.lib)) / 102.4) / 10 : 0,
    lib_changes: runs.filter((r) => r.lib_changed).length,
    triangles: head?.triangles ?? 0, budget: m.checks.budget ?? null,
    review: { new: sums(landed.map((r) => r.receipt.review_new)), known: sums(landed.map((r) => r.receipt.review_known)) },
    open_review: (headReceipt.review_full ?? headReceipt.review ?? []).filter((l) => !l.startsWith('Changes:')),
    timeline: runs.map((r) => ({ id: r.id, name: r.name, outcome: r.outcome, agent_ms: r.agent_ms, ms: r.ms, script_bytes: r.script_bytes, triangles: r.receipt.triangles ?? null }))
  }
}

const USAGE = `Usage: modeller.mjs <command> <model> [args] [--data <dir>]
  init <model> [--target unity|godot|web] [--budget <triangles>] [--size <x>x<y>x<z>] [--symmetry x|y|none] [--kind vehicle|building|prop|weapon|character] [--blender 4.2|5.2|<path>] [--repin]
  step <model> <script.py> [--name <name>] [--amend] [--timeout <seconds>]
  batch <model> <folder|batch.json|script.py...> [--every-sheet] [--timeout <seconds per step>]
  revert <model> <step>
  branch <model> <name> [--from <step>]
  switch <model> <branch>
  keep <model> <step> [--off]
  materialize <model> [<step>]
  status <model>
  report <model>`

function parseArgs(argv) {
  const pos = [], opt = {}
  const bools = new Set(['amend', 'repin', 'off', 'every-sheet'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const key = a.slice(2)
    if (bools.has(key)) { opt[key] = true; continue }
    if (!['data', 'target', 'budget', 'size', 'symmetry', 'kind', 'blender', 'name', 'timeout', 'from', 'threads'].includes(key) || argv[i + 1] == null) throw new Error(`Unknown or incomplete option ${a}\n${USAGE}`)
    opt[key] = argv[++i]
  }
  return { pos, opt }
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2))
  const [command, model, arg] = pos
  if (!command || !model) throw new Error(USAGE)
  const dataDir = opt.data ? path.resolve(opt.data) : modellerDataDir()
  const threads = opt.threads ? Number(opt.threads) : undefined
  const common = { dataDir, model }
  let result
  switch (command) {
    case 'init': result = await init({ ...common, target: opt.target, budget: opt.budget, size: opt.size, symmetry: opt.symmetry, kind: opt.kind, blender: opt.blender, repin: opt.repin }); break
    case 'step':
      if (!arg) throw new Error(USAGE)
      result = await step({ ...common, script: arg, name: opt.name, amend: opt.amend, timeout: opt.timeout ? Number(opt.timeout) : STEP_TIMEOUT, threads })
      break
    case 'batch':
      if (!arg) throw new Error(USAGE)
      result = await batch({ ...common, scripts: pos.slice(2), everySheet: opt['every-sheet'], timeout: opt.timeout ? Number(opt.timeout) : STEP_TIMEOUT, threads })
      break
    case 'revert': result = await revert({ ...common, to: arg }); break
    case 'branch': result = await branch({ ...common, name: arg, from: opt.from }); break
    case 'switch': result = await switchBranch({ ...common, name: arg }); break
    case 'keep': result = await keep({ ...common, step: arg, on: !opt.off }); break
    case 'materialize': result = await materialize({ ...common, step: arg, threads }); break
    case 'status': result = await status(common); break
    case 'report': result = await report(common); break
    // Started by init in the background; not for agents.
    case 'warm': result = await warm(common); break
    default: throw new Error(USAGE)
  }
  console.log(JSON.stringify(result, null, 1))
  if (!result.ok) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1 })
}
