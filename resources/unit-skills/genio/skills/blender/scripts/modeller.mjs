#!/usr/bin/env node
/**
 * Genio Modeller kernel: one headless Blender per step through the safe runner.
 *
 * A model is a folder in the unit's data directory (never the worktree):
 *   manifest.json            steps, branches, the pinned Blender, history
 *   steps/<id>/script.py     the agent's step script, as it ran
 *   steps/<id>/model.blend   compressed snapshot (pruned to the last few per branch)
 *   steps/<id>/model.glb     modifier-applied GLB, what the live view loads
 *   steps/<id>/sheet.png     2x2 Workbench review sheet (3/4, front, side, top)
 *   steps/<id>/view.png      the 3/4 view alone, 512 px
 *   steps/<id>/receipt.json  caption, counts, bounds, advisory checks, timings
 *   failed/<id>-<kind>-<t>/  scripts that raised, crashed or hung, with receipts
 *
 * Each step runs on its parent's snapshot and writes into a staging folder that
 * becomes steps/<id> only when everything succeeded, so a crash or a hang leaves
 * the model at its last good snapshot. Snapshots older than the retention window
 * are rebuilt on demand by replaying the scripts that made them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runBlender, assertOutside } from './blender.mjs'
import { blenderVersion, listBlenders, pickModellerBlender } from '../../../lib/blender-path.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const STEP_SCRIPT = path.join(here, 'genio_step.py')
export const SCHEMA = 'genio.modeller.v1'
/** Snapshots kept per branch; older ones replay from their scripts. */
export const KEEP_SNAPSHOTS = 5
/** Watchdog per step, seconds. */
export const STEP_TIMEOUT = 60
const SESSION_WARN_MB = 300
const FAILURES_KEPT = 50
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/** Where models live: GENIO_MODELLER_DATA, else next to the unit's Blender scratch, else temp. */
export function modellerDataDir(env = process.env) {
  if (env.GENIO_MODELLER_DATA) return path.resolve(env.GENIO_MODELLER_DATA)
  if (env.GENIO_BLENDER_SCRATCH) return path.join(path.dirname(path.resolve(env.GENIO_BLENDER_SCRATCH)), 'modeller')
  return path.join(os.tmpdir(), 'genio-modeller')
}

const now = () => new Date().toISOString()
const stepId = (n) => `s${String(n).padStart(3, '0')}`
const rel = (dir, p) => path.relative(dir, p).split(path.sep).join('/')
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function checkName(kind, name) {
  if (!NAME.test(name ?? '')) throw new Error(`${kind} name must be 1-64 letters, digits, - or _ (got ${JSON.stringify(name)})`)
  return name
}

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

function writeManifest(dir, m) {
  m.updated = now()
  const file = path.join(dir, 'manifest.json'), tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1))
  // A viewer reading the manifest can hold it open for a moment on Windows.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      pause(50)
    }
  }
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

async function withLock(dir, fn) {
  const file = path.join(dir, '.lock')
  for (;;) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number(fs.readFileSync(file, 'utf8'))
      if (alive(pid)) throw new Error(`Another Modeller command (pid ${pid}) is working on this model. Wait for it to finish.`)
      fs.rmSync(file, { force: true })
    }
  }
  try { return await fn() } finally { fs.rmSync(file, { force: true }) }
}

const byId = (m, id) => m.steps.find((s) => s.id === id)

/** Steps from the root to a branch's head: the model as that branch sees it. */
export function line(m, branch = m.branch) {
  const out = []
  for (let id = m.branches[branch]?.head; id; id = byId(m, id)?.parent) out.unshift(byId(m, id))
  return out
}

function resolveStep(m, ref) {
  const n = /^s?(\d+)$/i.exec(String(ref ?? ''))
  const s = n && byId(m, stepId(Number(n[1])))
  if (!s) throw new Error(`No step ${ref}. Steps: ${m.steps.map((x) => x.id).join(', ') || 'none'}`)
  return s
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

function dirBytes(dir) {
  let total = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size
  }
  return total
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

async function runPlan(m, dir, plan, base, { timeout, threads, runner }) {
  const planFile = path.join(plan.out, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1))
  const run = await runBlender({ blender: m.blender.path, prefix: runner?.prefix ?? [], script: STEP_SCRIPT, blend: base.blend, args: [planFile], threads, timeout, scratch: path.join(dir, 'logs') })
  return { run, receipt: readJson(path.join(plan.out, 'receipt.json')) }
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

/** Run one step script on the current branch's head (or, with amend, replace the head). */
export async function step({ dataDir = modellerDataDir(), model, script, name, amend = false, timeout = STEP_TIMEOUT, threads, runner } = {}) {
  const dir = modelDir(dataDir, model)
  return withLock(dir, async () => {
    const m = readManifest(dir)
    checkPin(m)
    const source = path.resolve(script)
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`No step script at ${source}`)
    const label = checkName('Step', name ?? stepName(source))
    const head = m.branches[m.branch].head
    if (amend && !head) throw new Error('Nothing to amend: this branch has no steps yet.')
    const parent = amend ? byId(m, head).parent : head
    const n = m.next, id = stepId(n)
    const staging = path.join(dir, 'steps', `.pending-${id}`)
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    fs.copyFileSync(source, path.join(staging, 'script.py'))
    const base = baseFor(m, dir, parent)
    const plan = { out: staging, replay: base.replay, script: path.join(staging, 'script.py'), outputs: ['blend', 'glb', 'sheet'], step: { id, n, name: label, model: m.model }, checks: m.checks, sheet_size: 512 }
    const { run, receipt } = await runPlan(m, dir, plan, base, { timeout, threads, runner })
    const t = now()
    if (run.timedOut || run.code !== 0 || !receipt?.ok) {
      const kind = failureKind(run, receipt)
      const failDir = path.join(dir, 'failed', `${id}-${kind}-${Date.now()}`)
      fs.mkdirSync(path.dirname(failDir), { recursive: true })
      fs.renameSync(staging, failDir)
      for (const f of fs.readdirSync(failDir)) if (!['script.py', 'receipt.json', 'plan.json'].includes(f)) fs.rmSync(path.join(failDir, f), { recursive: true, force: true })
      const recovered = verifySnapshot(m, dir, parent)
      const error = receipt?.error ?? run.tail.split(/\r?\n/).filter(Boolean).slice(-8).join('\n')
      m.failures.push({ id, name: label, kind, parent, branch: m.branch, t, ms: run.ms, log: run.log, error, dir: rel(dir, failDir) })
      m.failures = m.failures.slice(-FAILURES_KEPT)
      writeManifest(dir, m)
      return {
        ok: false, kind, model: m.model, id, name: label, branch: m.branch, head, error, trace: receipt?.trace ?? [], output: receipt?.output ?? '',
        message: failureMessage(kind, { receipt, run, timeout, head }), recovered, log: run.log, script: path.join(failDir, 'script.py')
      }
    }
    const final = path.join(dir, 'steps', id)
    fs.renameSync(staging, final)
    fs.rmSync(path.join(final, 'plan.json'), { force: true })
    const has = (f) => fs.existsSync(path.join(final, f))
    const files = Object.fromEntries([['script', 'script.py'], ['blend', 'model.blend'], ['glb', 'model.glb'], ['sheet', 'sheet.png'], ['view', 'view.png'], ['receipt', 'receipt.json']].map(([k, f]) => [k, has(f) ? `steps/${id}/${f}` : null]))
    const entry = {
      id, n, parent, branch: m.branch, name: label, caption: receipt.caption || label, t, ms: run.ms,
      triangles: receipt.triangles ?? 0, vertices: receipt.vertices ?? 0, objects: receipt.objects ?? 0, warnings: receipt.warnings.length,
      blend_sha256: files.blend ? sha256(path.join(dir, files.blend)) : null, files
    }
    if (amend) {
      byId(m, head).superseded_by = id
      m.history.push({ op: 'amend', t, branch: m.branch, replaced: head, by: id })
    }
    m.steps.push(entry)
    m.next = n + 1
    m.branches[m.branch].head = id
    const pruned = prune(m, dir)
    const mb = dirBytes(dir) / 2 ** 20
    if (mb > SESSION_WARN_MB) receipt.warnings.push(`This model's step data is ${Math.round(mb)} MB; older snapshots are pruned, but GLBs and sheets add up.`)
    const abs = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v && path.join(dir, v)]))
    Object.assign(receipt, { id, parent, branch: m.branch, t, wall_ms: run.ms, log: run.log, files: abs })
    fs.writeFileSync(path.join(final, 'receipt.json'), JSON.stringify(receipt, null, 1))
    writeManifest(dir, m)
    return {
      ok: true, model: m.model, id, n, name: label, caption: entry.caption, branch: m.branch, parent,
      triangles: entry.triangles, vertices: entry.vertices, objects: entry.objects, bounds: receipt.bounds ?? null,
      warnings: receipt.warnings, sheet: abs.sheet, glb: abs.glb, blend: abs.blend, receipt: abs.receipt, ms: run.ms, pruned
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
    const plan = { out: staging, replay: [...base.replay, path.join(dir, s.files.script)], script: null, outputs: ['blend'], step: { id: s.id, n: s.n, name: s.name, model: m.model }, checks: m.checks }
    const { run, receipt } = await runPlan(m, dir, plan, base, { timeout, threads, runner })
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
  return edit(dataDir, model, (m) => {
    const s = resolveStep(m, to)
    if (!line(m).includes(s)) throw new Error(`${s.id} is not on branch ${m.branch}. Branch from it instead: modeller.mjs branch ${m.model} <name> --from ${s.id}`)
    const from = m.branches[m.branch].head
    m.branches[m.branch].head = s.id
    m.history.push({ op: 'revert', t: now(), branch: m.branch, from, to: s.id })
    return { reverted: from }
  })
}

/** Start a new branch at step N (default: the head) and switch to it. */
export function branch({ dataDir = modellerDataDir(), model, name, from } = {}) {
  return edit(dataDir, model, (m) => {
    checkName('Branch', name)
    if (m.branches[name]) throw new Error(`Branch ${name} already exists. Switch to it: modeller.mjs switch ${m.model} ${name}`)
    const at = from != null ? resolveStep(m, from).id : m.branches[m.branch].head
    m.branches[name] = { head: at, from: at }
    m.history.push({ op: 'branch', t: now(), branch: name, from: at, parent: m.branch })
    m.branch = name
  })
}

export function switchBranch({ dataDir = modellerDataDir(), model, name } = {}) {
  return edit(dataDir, model, (m) => {
    if (!m.branches[name]) throw new Error(`No branch ${name}. Branches: ${Object.keys(m.branches).join(', ')}`)
    m.history.push({ op: 'switch', t: now(), from: m.branch, to: name })
    m.branch = name
  })
}

/** Keep (or stop keeping) a step's snapshot regardless of retention, e.g. the accepted step. */
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
  revert <model> <step>
  branch <model> <name> [--from <step>]
  switch <model> <branch>
  keep <model> <step> [--off]
  materialize <model> [<step>]
  status <model>`

function parseArgs(argv) {
  const pos = [], opt = {}
  const bools = new Set(['amend', 'repin', 'off'])
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
  const { pos: [command, model, arg], opt } = parseArgs(process.argv.slice(2))
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
