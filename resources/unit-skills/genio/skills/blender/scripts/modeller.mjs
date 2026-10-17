#!/usr/bin/env node
/**
 * Genio Modeller kernel: one headless Blender per step, or per batch of steps, through the safe runner.
 *
 * A model is a folder in the unit's data directory (never the worktree):
 *   manifest.json            steps, branches, the pinned Blender, history
 *   steps/<id>/script.py     the agent's step script, as it ran
 *   steps/<id>/model.blend   compressed snapshot (pruned to the last few per branch)
 *   steps/<id>/model.glb     modifier-applied GLB, what the live view loads
 *   steps/<id>/sheet.png     2x2 Workbench review sheet (3/4, front, side, top); a batch's last step only
 *   steps/<id>/view.png      the 3/4 view alone, 512 px (with the sheet)
 *   steps/<id>/receipt.json  caption, counts, bounds, advisory checks, timings
 *   failed/<id>-<kind>-<t>/  scripts that raised, crashed or hung, with receipts
 *
 * Each step runs on its parent's snapshot and writes into a staging folder. Its
 * GLB moves to steps/<id> and the step becomes the head as soon as Blender has
 * exported it (landed.json); the snapshot, sheet and receipt follow when Blender
 * finishes the step. A step that fails before its GLB never lands, so a crash or
 * a hang leaves the model at its last good snapshot; one that stops after landing
 * stays, without its sheet. Snapshots older than the retention window are
 * rebuilt on demand by replaying the scripts that made them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runBlender, assertOutside } from './blender.mjs'
import { blenderVersion, listBlenders, pickModellerBlender } from '../../../lib/blender-path.mjs'
import {
  addBranch, byId, checkName, dirBytes, line, now, readJson, rel, renameRetry, resolveStep, revertHead, sha256, sleep, stepId, switchTo, withLock as lockDir, writeManifest
} from '../../../lib/step-kernel.mjs'

export { line }

const here = path.dirname(fileURLToPath(import.meta.url))
export const STEP_SCRIPT = path.join(here, 'genio_step.py')
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

/** The Blender a model is pinned to: an explicit path or version, GENIO_BLENDER, else 4.2 when installed. */
export function chooseBlender(choice, env = process.env) {
  if (choice && typeof choice === 'object') return describeBlender(choice.path, String(choice.version).split('.').map(Number))
  const wanted = choice ?? env.GENIO_BLENDER
  if (wanted && /[\\/]|\.exe$/i.test(wanted)) {
    const v = blenderVersion(wanted)
    if (!v) throw new Error(`Not a Blender executable: ${wanted}`)
    return describeBlender(wanted, v)
  }
  const found = listBlenders()
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

export async function init({ dataDir = modellerDataDir(), model, blender, target, budget, size, repin = false, cwd = process.cwd(), env = process.env } = {}) {
  assertOutside(dataDir, [cwd], 'Modeller data must live outside the project/worktree (set GENIO_MODELLER_DATA)')
  if (target != null && !['unity', 'godot', 'web'].includes(target)) throw new Error('target is unity, godot or web')
  const dir = modelDir(dataDir, model)
  fs.mkdirSync(path.join(dir, 'steps'), { recursive: true })
  return withLock(dir, async () => {
    let m = readJson(path.join(dir, 'manifest.json'))
    const existing = Boolean(m)
    if (!m) {
      m = { schema: SCHEMA, model, created: now(), blender: chooseBlender(blender, env), target: target ?? null, checks: { budget: null, size: null }, branch: 'main', branches: { main: { head: null, from: null } }, next: 1, steps: [], failures: [], history: [] }
    } else if (repin || blender) {
      const before = m.blender.version
      m.blender = chooseBlender(blender, env)
      m.history.push({ op: 'repin', t: now(), from: before, to: m.blender.version })
    }
    if (target != null) m.target = target
    if (budget != null) m.checks.budget = Number(budget) || null
    if (size != null) m.checks.size = parseSize(size)
    writeManifest(dir, m)
    return { ok: true, existing, ...summary(dir, m) }
  })
}

/** The snapshot to open and the scripts to replay on it to reach `parentId`. */
function baseFor(m, dir, parentId) {
  const chain = []
  for (let s = parentId && byId(m, parentId); s; s = s.parent && byId(m, s.parent)) {
    const blend = s.files.blend && path.join(dir, s.files.blend)
    if (blend && fs.existsSync(blend)) return { blend, replay: chain.reverse().map((x) => path.join(dir, x.files.script)) }
    chain.push(s)
  }
  return { blend: null, replay: chain.reverse().map((x) => path.join(dir, x.files.script)) }
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
 * included) call p.bake_maps runs on every core, others on the runner's default. An explicit
 * `threads` wins.
 */
export function planThreads(plan, threads) {
  if (threads) return threads
  const scripts = [...plan.replay, ...plan.steps.map((s) => s.script)].filter(Boolean)
  return scripts.some((f) => BAKES.test(fs.readFileSync(f, 'utf8'))) ? os.availableParallelism() : undefined
}

/** One Blender for the whole plan; its plan.json goes into the first step's folder. */
function runPlan(m, dir, plan, base, { timeout, threads, runner, signal }) {
  const planFile = path.join(plan.steps[0].out, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1))
  return runBlender({ blender: m.blender.path, prefix: runner?.prefix ?? [], script: STEP_SCRIPT, blend: base.blend, args: [planFile], threads: planThreads(plan, threads), timeout, signal, scratch: path.join(dir, 'logs') })
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

/** A batch's step scripts, in order: one folder of .py files (sorted by name), a batch .json, or several .py files. */
export function batchScripts(args) {
  const raw = Array.isArray(args) ? args : [args]
  if (raw.some((a) => a && typeof a === 'object')) return raw.map((a) => typeof a === 'object' ? { script: path.resolve(String(a.script ?? '')), name: a.name } : { script: path.resolve(String(a)) })
  const list = raw.map((a) => path.resolve(String(a)))
  let items = list.map((script) => ({ script }))
  const one = list.length === 1 ? fs.statSync(list[0], { throwIfNoEntry: false }) : undefined
  if (one?.isDirectory()) {
    items = fs.readdirSync(list[0]).filter((f) => /\.py$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((f) => ({ script: path.join(list[0], f) }))
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
  const items = scripts.map((it) => {
    const source = path.resolve(it.script)
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`No step script at ${source}`)
    return { source, name: checkName('Step', it.name ?? stepName(source)) }
  })
  const head = m.branches[m.branch].head
  if (amend && !head) throw new Error('Nothing to amend: this branch has no steps yet.')
  const parent0 = amend ? byId(m, head).parent : head
  const base = baseFor(m, dir, parent0)
  const plan = { replay: base.replay, steps: [], checks: m.checks, sheet_size: 512 }
  const staged = items.map((it, k) => {
    const n = m.next + k, id = stepId(n), staging = path.join(dir, 'steps', `.pending-${id}`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    fs.copyFileSync(it.source, path.join(staging, 'script.py'))
    const sheet = everySheet || k === items.length - 1
    plan.steps.push({ out: staging, script: path.join(staging, 'script.py'), outputs: ['blend', 'glb', ...(sheet ? ['sheet'] : [])], step: { id, n, name: it.name, model: m.model } })
    return { ...it, id, n, staging }
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
    if (fs.existsSync(path.join(s.staging, 'model.glb'))) renameRetry(path.join(s.staging, 'model.glb'), path.join(final, 'model.glb'))
    const has = (f) => fs.existsSync(path.join(final, f))
    const files = { script: `steps/${s.id}/script.py`, blend: null, glb: has('model.glb') ? `steps/${s.id}/model.glb` : null, sheet: null, view: null, receipt: `steps/${s.id}/receipt.json` }
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
    const receipt = marks[k].done ?? { ...readJson(path.join(final, 'receipt.json')), warnings: [`Blender stopped (${stopped}) after this step reached the live view: ${fs.existsSync(path.join(s.staging, 'model.blend')) ? 'it has no review sheet.' : 'it has no snapshot or review sheet; the next step replays its script.'}`] }
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
    Object.assign(receipt, { id: s.id, parent: entry.parent, branch: m.branch, t: entry.t, wall_ms: ms, files: abs })
    delete receipt.stage
    fs.writeFileSync(path.join(final, 'receipt.json'), JSON.stringify(receipt, null, 1))
    writeManifest(dir, m)
    published[k] = {
      ok: true, model: m.model, id: s.id, n: s.n, name: s.name, caption: entry.caption, branch: m.branch, parent: entry.parent,
      triangles: entry.triangles, vertices: entry.vertices, objects: entry.objects, bounds: receipt.bounds ?? null,
      warnings: fresh, known_warnings: known, sheet: abs.sheet, glb: abs.glb, blend: abs.blend, receipt: abs.receipt, ms, pruned,
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
  if (published.length === staged.length) return { published, failure: null, notRun: [] }

  // The first step without a good receipt failed; the ones after it never ran.
  const s = staged[published.length]
  const receipt = readJson(path.join(s.staging, 'receipt.json'))
  const kind = failureKind(run, receipt)
  const failDir = path.join(dir, 'failed', `${s.id}-${kind}-${Date.now()}`)
  fs.mkdirSync(path.dirname(failDir), { recursive: true })
  renameRetry(s.staging, failDir)
  for (const f of fs.readdirSync(failDir)) if (!['script.py', 'receipt.json', 'plan.json'].includes(f)) fs.rmSync(path.join(failDir, f), { recursive: true, force: true })
  const notRun = staged.slice(published.length + 1)
  for (const x of notRun) fs.rmSync(x.staging, { recursive: true, force: true })
  const at = m.branches[m.branch].head
  const recovered = verifySnapshot(m, dir, parent)
  const error = receipt?.error ?? run.tail.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
  const ms = Math.round(Date.now() - prevAt)
  m.failures.push({ id: s.id, name: s.name, kind, parent, branch: m.branch, t: now(), ms, log: run.log, error, dir: rel(dir, failDir) })
  m.failures = m.failures.slice(-FAILURES_KEPT)
  writeManifest(dir, m)
  return {
    published, notRun: notRun.map((x) => ({ name: x.name, script: x.source })),
    failure: {
      ok: false, kind, model: m.model, id: s.id, name: s.name, branch: m.branch, head: at, error, trace: receipt?.trace ?? [], output: receipt?.output ?? '',
      message: failureMessage(kind, { receipt, run, timeout, head: at }), recovered, log: run.log, script: path.join(failDir, 'script.py')
    }
  }
}

/** Run one step script on the current branch's head (or, with amend, replace the head). */
export async function step({ dataDir = modellerDataDir(), model, script, name, amend = false, timeout = STEP_TIMEOUT, threads, runner } = {}) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const r = await runSteps(dir, readManifest(dir), [{ script, name }], { amend, timeout, threads, runner })
    return r.failure ?? r.published[0]
  })
}

/**
 * Run several step scripts as one batch (see runSteps): each lands in the live view as Blender
 * finishes it. The result lists the steps, the last review sheet, and on a failure the failed step
 * and the scripts that did not run.
 */
export async function batch({ dataDir = modellerDataDir(), model, scripts, everySheet = false, timeout = STEP_TIMEOUT, threads, runner, gapMs = PUBLISH_GAP_MS } = {}) {
  const dir = modelDir(dataDir, model)
  const items = batchScripts(scripts)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const { published, failure, notRun } = await runSteps(dir, m, items, { everySheet, timeout, threads, runner, gapMs })
    const last = published.at(-1)
    const brief = (s) => ({ id: s.id, n: s.n, name: s.name, caption: s.caption, triangles: s.triangles, objects: s.objects, warnings: s.warnings, known_warnings: s.known_warnings, glb: s.glb, sheet: s.sheet, ms: s.ms })
    const did = `${published.length} of ${items.length} steps landed`
    return {
      ok: !failure, model: m.model, branch: m.branch, head: m.branches[m.branch].head, steps: published.map(brief),
      sheet: last?.sheet ?? null, receipt: last?.receipt ?? null, warnings: last?.warnings ?? [], known_warnings: last?.known_warnings ?? 0, failure, not_run: notRun,
      message: failure
        ? `${did}; ${failure.id} (${failure.name}) failed. ${failure.message}${notRun.length ? ` Not run: ${notRun.map((x) => x.name).join(', ')}.` : ''}`
        : `${did}. Review ${last.sheet ? `the sheet of ${last.id}` : last.id} before the next batch.`
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

/** Make sure a step has its .blend (rebuilding a pruned one by replay) and return its path. */
export async function materialize({ dataDir = modellerDataDir(), model, step: ref, timeout = STEP_TIMEOUT * 4, threads, runner } = {}) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    const s = ref ? resolveStep(m, ref) : byId(m, m.branches[m.branch].head)
    if (!s) throw new Error('This branch has no steps yet.')
    if (s.files.blend && fs.existsSync(path.join(dir, s.files.blend))) return { ok: true, id: s.id, blend: path.join(dir, s.files.blend), replayed: 0 }
    checkPin(m)
    const base = baseFor(m, dir, s.parent)
    const staging = path.join(dir, 'steps', `.rebuild-${s.id}`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    const plan = { replay: [...base.replay, path.join(dir, s.files.script)], steps: [{ out: staging, script: null, outputs: ['blend'], step: { id: s.id, n: s.n, name: s.name, model: m.model } }], checks: m.checks }
    const run = await runPlan(m, dir, plan, base, { timeout, threads, runner })
    const receipt = readJson(path.join(staging, 'receipt.json'))
    if (run.timedOut || run.code !== 0 || !receipt?.ok) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw new Error(`Rebuilding ${s.id} failed (${failureKind(run, receipt)}): ${receipt?.error ?? run.tail.slice(-800)}`)
    }
    const blend = path.join(dir, 'steps', s.id, 'model.blend')
    fs.renameSync(path.join(staging, 'model.blend'), blend)
    fs.rmSync(staging, { recursive: true, force: true })
    s.files.blend = `steps/${s.id}/model.blend`
    s.blend_sha256 = sha256(blend)
    writeManifest(dir, m)
    return { ok: true, id: s.id, blend, replayed: plan.replay.length }
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

const USAGE = `Usage: modeller.mjs <command> <model> [args] [--data <dir>]
  init <model> [--target unity|godot|web] [--budget <triangles>] [--size <x>x<y>x<z>] [--blender 4.2|5.2|<path>] [--repin]
  step <model> <script.py> [--name <name>] [--amend] [--timeout <seconds>]
  batch <model> <folder|batch.json|script.py...> [--every-sheet] [--timeout <seconds per step>]
  revert <model> <step>
  branch <model> <name> [--from <step>]
  switch <model> <branch>
  keep <model> <step> [--off]
  materialize <model> [<step>]
  status <model>`

function parseArgs(argv) {
  const pos = [], opt = {}
  const bools = new Set(['amend', 'repin', 'off', 'every-sheet'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const key = a.slice(2)
    if (bools.has(key)) { opt[key] = true; continue }
    if (!['data', 'target', 'budget', 'size', 'blender', 'name', 'timeout', 'from', 'threads'].includes(key) || argv[i + 1] == null) throw new Error(`Unknown or incomplete option ${a}\n${USAGE}`)
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
    case 'init': result = await init({ ...common, target: opt.target, budget: opt.budget, size: opt.size, blender: opt.blender, repin: opt.repin }); break
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
    default: throw new Error(USAGE)
  }
  console.log(JSON.stringify(result, null, 1))
  if (!result.ok) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1 })
}
