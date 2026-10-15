#!/usr/bin/env node
/**
 * Genio's FAL.ai helper for units. Node 18+, standard library only.
 *
 * Runs any FAL model through the queue API: submit -> status -> result ->
 * download. The key is read only from the FAL_KEY environment variable and is
 * sent only to FAL's API hosts. It is never printed, never written to receipts
 * and never sent with output downloads. Paid calls are never retried
 * automatically, and an existing receipt is never resubmitted.
 *
 *
 * With --world <worktree root> it follows the world's .genio/ folder: player
 * defaults and recipes from .genio/fal/, a budget gate before every paid call,
 * one spend.jsonl line per paid call and a provenance file per downloaded
 * asset. It never writes .genio/fal/config.json or recipes.json.
 *
 * Every command prints one JSON document on stdout; progress goes to stderr.
 * Exit codes: 0 ok, 2 usage, 3 key missing, 4 FAL/network error, 5 still pending, 6 over budget.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  WorldError, suggestLocation, appendSpend, checkBudget, codexEnabled, findRecipe, folderFor, openWorld, readSpend, spendFile, unitBy, worldRel, writeProvenance
} from '../../../lib/genio-world.mjs'

const EXIT = { usage: 2, nokey: 3, api: 4, pending: 5, budget: 6 }
const MISSING_KEY =
  'FAL key missing: FAL_KEY is not set for this unit. The player sets it in Genio under Settings -> Accounts & keys -> API keys (FAL.ai); units launched after that receive it automatically.'

// Tests only: a loopback base stands in for both FAL hosts. Nothing else is accepted.
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.GENIO_FAL_TEST_BASE ?? '') ? process.env.GENIO_FAL_TEST_BASE : ''
const QUEUE = TEST_BASE ? `${TEST_BASE}/queue` : 'https://queue.fal.run'
const PRICING = TEST_BASE ? `${TEST_BASE}/v1/models/pricing` : 'https://api.fal.ai/v1/models/pricing'
const AUTH_HOSTS = new Set(TEST_BASE ? [new URL(TEST_BASE).host] : ['queue.fal.run', 'api.fal.ai'])

const MAX_INLINE_FILE = 20 * 1024 * 1024
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.obj': 'model/obj', '.txt': 'text/plain'
}
const EXT = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]))

class Fail extends Error {
  constructor(message, code = EXIT.api, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const KEY = (process.env.FAL_KEY ?? '').trim()

function redact(v) {
  if (!KEY) return v
  if (typeof v === 'string') return v.split(KEY).join('[REDACTED]')
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
  return v
}

function needKey() {
  if (!KEY) throw new Fail(MISSING_KEY, EXIT.nokey, { configured: false })
  return KEY
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Fail(`Unexpected argument: ${a}`, EXIT.usage)
    const eq = a.indexOf('=')
    if (eq > 0) {
      opts[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      opts[a.slice(2)] = rest[++i]
    } else {
      opts[a.slice(2)] = true
    }
  }
  return { command, opts }
}

function req(opts, name) {
  const v = opts[name]
  if (typeof v !== 'string' || !v.trim()) throw new Fail(`Missing --${name}.`, EXIT.usage)
  return v
}

function endpointOf(opts) {
  const e = req(opts, 'endpoint').trim().replace(/^\/+|\/+$/g, '')
  if (!/^[A-Za-z0-9][\w.-]*(\/[\w.-]+)+$/.test(e) || e.split('/').some((s) => s === '..' || s === '.')) {
    throw new Fail(`Not a FAL endpoint id: ${e} (expected e.g. fal-ai/flux/dev).`, EXIT.usage)
  }
  return e
}

const nowUtc = () => new Date().toISOString()
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))

function writeJson(p, value, exclusive = false) {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(redact(value), null, 2) + '\n', { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' })
}

/** Derived file next to a receipt: x.job.json -> x.result.json, x.json -> x.result.json. */
function sibling(receipt, suffix) {
  const r = path.resolve(receipt)
  const base = r.endsWith('.job.json') ? r.slice(0, -'.job.json'.length) : r.replace(/\.json$/i, '')
  return `${base}.${suffix}.json`
}

function authAllowed(u) {
  return AUTH_HOSTS.has(u.host) && (TEST_BASE ? u.protocol === 'http:' : u.protocol === 'https:')
}

async function call(url, { method = 'GET', body } = {}) {
  const key = needKey()
  const u = new URL(url)
  if (!authAllowed(u)) throw new Fail(`Refusing to send the FAL key to ${u.host}; only FAL API hosts receive it.`)
  let res
  try {
    res = await fetch(u, {
      method,
      redirect: 'manual', // never follow a redirect with the key attached
      headers: {
        Authorization: `Key ${key}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000)
    })
  } catch {
    throw new Fail('No response from FAL; the outcome is uncertain. No automatic retry was made.', EXIT.api, { uncertain: true })
  }
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 2000) }
  }
  data = redact(data)
  if (res.status >= 300) {
    throw new Fail(`FAL returned HTTP ${res.status}. No automatic retry was made.`, EXIT.api, { http: res.status, detail: data })
  }
  return data
}

/** Model input: --input <file.json> or --json '<object>'. Strings "@file:<path>" become data URIs. */
function readInput(opts) {
  let raw
  if (typeof opts.input === 'string') raw = fs.readFileSync(opts.input, 'utf8').replace(/^﻿/, '')
  else if (typeof opts.json === 'string') raw = opts.json
  else throw new Fail('Give the model input as --input <file.json> or --json \'{...}\'.', EXIT.usage)
  let body
  try {
    body = JSON.parse(raw)
  } catch (e) {
    throw new Fail(`Model input is not valid JSON: ${e.message}`, EXIT.usage)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Fail('Model input must be a JSON object.', EXIT.usage)
  if (body.sync_mode) throw new Fail('Leave sync_mode off: queued output stays recoverable from the receipt.', EXIT.usage)
  return body
}

function inlineFiles(v) {
  if (typeof v === 'string' && v.startsWith('@file:')) {
    const p = path.resolve(v.slice(6))
    const st = fs.statSync(p)
    if (st.size > MAX_INLINE_FILE) throw new Fail(`${p} is larger than 20 MB; host it and pass a URL instead.`, EXIT.usage)
    const mime = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
  }
  if (Array.isArray(v)) return v.map(inlineFiles)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, inlineFiles(x)]))
  return v
}

function queueUrl(record, field) {
  const url = record.submission?.[field]
  if (!record.submission?.request_id || typeof url !== 'string') {
    throw new Fail('The receipt has no request id. Do not resubmit: check the request in the FAL dashboard history.', EXIT.usage)
  }
  if (!authAllowed(new URL(url))) throw new Fail('The receipt holds a URL outside FAL\'s queue host.', EXIT.usage)
  return url
}

/** The world for --world, or null. */
function worldOf(opts) {
  if (opts.world === undefined) return null
  if (typeof opts.world !== 'string' || !opts.world.trim()) throw new Fail('--world needs the path of your worktree root.', EXIT.usage)
  return openWorld(opts.world)
}

function needWorld(opts) {
  const world = worldOf(opts)
  if (!world) throw new Fail('This command needs --world <your worktree root>.', EXIT.usage)
  return world
}

/** Endpoint and recipe for a paid call: --endpoint, or the recipe's endpoint with --recipe <id>. */
function target(opts, world) {
  let recipe = null
  if (opts.recipe !== undefined) {
    if (!world) throw new Fail('--recipe needs --world: recipes live in the project\'s .genio/fal/recipes.json.', EXIT.usage)
    recipe = findRecipe(world, String(opts.recipe))
  }
  const endpoint = endpointOf(opts.endpoint === undefined && recipe ? { endpoint: recipe.endpoint } : opts)
  if (recipe?.endpoint && recipe.endpoint !== endpoint) throw new Fail(`Recipe "${recipe.id}" runs ${recipe.endpoint}, not ${endpoint}.`, EXIT.usage)
  return { endpoint, recipe }
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** Player defaults for the endpoint, then the recipe's input, then yours (yours win). */
function mergedInput(world, endpoint, recipe, body = {}) {
  const defaults = isObj(world?.config.defaults?.[endpoint]) ? world.config.defaults[endpoint] : {}
  return { ...defaults, ...(isObj(recipe?.input) ? recipe.input : {}), ...body }
}

const usd = (n) => Math.round(n * 1e6) / 1e6
const today = () => nowUtc().slice(0, 10)

function positive(opts, name, allowZero = false) {
  const n = Number(opts[name])
  if (opts[name] === true || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Fail(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} number.`, EXIT.usage)
  return n
}

/** The cost estimate for one call: --est-usd as given, or --units priced through FAL's pricing API (free). */
async function estimateFor(opts, endpoint) {
  if (opts['est-usd'] !== undefined) {
    return { price: { unit: null, unit_price_usd: null, estimated_usd: usd(positive(opts, 'est-usd', true)), checked: today() }, units: null }
  }
  if (opts.units === undefined) return null
  const units = positive(opts, 'units')
  const data = await call(`${PRICING}?endpoint_id=${encodeURIComponent(endpoint)}`)
  const rows = Array.isArray(data.prices) ? data.prices : []
  const row = rows.find((r) => r?.endpoint_id === endpoint) ?? rows[0]
  const unitPrice = Number(row?.unit_price)
  if (!row || !Number.isFinite(unitPrice) || (row.currency && row.currency !== 'USD')) {
    throw new Fail(`FAL's pricing API gave no USD unit price for ${endpoint}. Work the cost out from the model page and pass --est-usd <n> instead.`, EXIT.usage, { pricing: data })
  }
  return { price: { unit: row.unit ?? null, unit_price_usd: unitPrice, estimated_usd: usd(unitPrice * units), checked: today() }, units }
}

/** The spend ledger: the world's .genio/spend.jsonl, or --ledger outside world mode. */
function ledgerOf(opts, world) {
  if (world) return spendFile(world)
  if (opts.ledger === undefined) return null
  return path.resolve(req(opts, 'ledger'))
}

async function submit(opts) {
  const world = worldOf(opts)
  const { endpoint, recipe } = target(opts, world)
  const receipt = req(opts, 'receipt')
  const body = mergedInput(world, endpoint, recipe, readInput(opts))
  if (body.sync_mode) throw new Fail('Leave sync_mode off: queued output stays recoverable from the receipt.', EXIT.usage)
  const budget = opts.budget === undefined ? null : positive(opts, 'budget', true)
  const ledger = ledgerOf(opts, world)
  if (budget != null && !ledger) throw new Fail('--budget outside project mode needs --ledger <spend.jsonl> to count what you already spent.', EXIT.usage)
  if (fs.existsSync(receipt)) {
    throw new Fail(`Receipt ${receipt} already exists. It records an earlier call; use status/result on it, or pick a new receipt name for a new paid call.`, EXIT.usage)
  }
  needKey()
  const by = unitBy()
  const est = await estimateFor(opts, endpoint)
  let gate = null
  if (ledger) {
    if (!est) throw new Fail('Price the call first: add --units <billing units> (priced through FAL, free) or --est-usd <n>. It is checked against your budget and logged.', EXIT.usage)
    gate = checkBudget({ lines: readSpend(ledger), by, estUsd: est.price.estimated_usd, unitBudget: budget, config: world?.config })
    if (!gate.ok) {
      throw new Fail(`${gate.reason} Nothing was submitted. Append needs-decision with the plan, the estimate and the budget, then stop.`, EXIT.budget, { budget: gate })
    }
  }
  const payload = inlineFiles(body)
  const record = { state: 'submission_unknown', endpoint, created_utc: nowUtc(), input: body }
  if (est) record.price = est.price
  if (world) record.genio = { by, recipe: recipe?.id ?? null }
  try {
    writeJson(receipt, record, true) // reserve before the paid call; never overwrite
  } catch (e) {
    if (e.code === 'EEXIST') throw new Fail(`Receipt ${receipt} already exists. It records an earlier call; use status/result on it, or pick a new receipt name for a new paid call.`, EXIT.usage)
    throw e
  }
  const spend = (requestId, uncertain) => {
    if (!ledger) return
    appendSpend(ledger, {
      t: nowUtc(), provider: 'fal', endpoint, request_id: requestId, units: est.units, unit: est.price.unit, est_usd: est.price.estimated_usd, by,
      ...(uncertain ? { uncertain: true } : {})
    })
  }
  let sub
  try {
    sub = await call(`${QUEUE}/${endpoint}`, { method: 'POST', body: payload })
  } catch (e) {
    const http = e.extra?.http
    if (http >= 400 && http < 500) {
      record.state = 'rejected' // FAL refused it: no request was created, nothing billed
      record.error = e.extra.detail
    } else {
      spend(null, true) // the outcome is unknown: count it against the budget
    }
    writeJson(receipt, record)
    throw e
  }
  record.submission = {
    request_id: sub.request_id,
    status_url: sub.status_url,
    response_url: sub.response_url,
    cancel_url: sub.cancel_url,
    queue_position: sub.queue_position
  }
  record.state = sub.request_id ? 'submitted' : 'submission_unknown'
  writeJson(receipt, record)
  spend(sub.request_id ?? null, !sub.request_id)
  return {
    receipt: path.resolve(receipt), state: record.state, endpoint, request_id: sub.request_id ?? null,
    ...(est ? { est_usd: est.price.estimated_usd } : {}),
    ...(gate ? { budget: { ...gate, ok: undefined, reason: undefined } } : {})
  }
}

async function status(opts, quiet = false) {
  const receipt = req(opts, 'receipt')
  const record = readJson(receipt)
  const url = queueUrl(record, 'status_url')
  const st = await call(opts.logs ? `${url}${url.includes('?') ? '&' : '?'}logs=1` : url)
  record.last_status = st.status
  record.last_checked_utc = nowUtc()
  if (st.status === 'COMPLETED') {
    record.state = st.error ? 'failed' : 'completed'
    record.completed_utc ??= nowUtc()
    if (st.metrics) record.metrics = st.metrics
    if (st.error) record.error = { error: st.error, error_type: st.error_type }
  }
  writeJson(receipt, record)
  if (!quiet) return { receipt: path.resolve(receipt), request_id: record.submission.request_id, ...st }
  return st
}

async function result(opts) {
  const receipt = req(opts, 'receipt')
  const out = typeof opts.out === 'string' ? opts.out : sibling(receipt, 'result')
  if (fs.existsSync(out)) return { result: path.resolve(out), reused: true }
  const record = readJson(receipt)
  const data = await call(queueUrl(record, 'response_url'))
  writeJson(out, data, true)
  return { result: path.resolve(out), reused: false }
}

async function cancel(opts) {
  const receipt = req(opts, 'receipt')
  const record = readJson(receipt)
  const data = await call(queueUrl(record, 'cancel_url'), { method: 'PUT' })
  record.cancel = { requested_utc: nowUtc(), response: data }
  writeJson(receipt, record)
  return { receipt: path.resolve(receipt), ...data }
}

/** FAL File objects ({url, content_type, file_name}) anywhere in a result. */
function filesIn(v, acc = []) {
  if (Array.isArray(v)) v.forEach((x) => filesIn(x, acc))
  else if (v && typeof v === 'object') {
    if (typeof v.url === 'string' && /^(https?:|data:)/.test(v.url)) acc.push(v)
    else Object.values(v).forEach((x) => filesIn(x, acc))
  }
  return acc
}

const safeName = (s) => s.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 120)

function extFor(f) {
  const fromName = path.extname(f.file_name ?? '')
  if (fromName) return fromName.toLowerCase()
  if (!f.url.startsWith('data:')) {
    const e = path.extname(new URL(f.url).pathname)
    if (e) return e.toLowerCase()
  }
  const mime = (f.content_type ?? (f.url.match(/^data:([^;,]+)/)?.[1] ?? '')).split(';')[0].trim()
  return EXT[mime] ?? '.bin'
}

async function fetchBytes(url) {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const meta = url.slice(5, comma)
    const payload = url.slice(comma + 1)
    return meta.endsWith(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  }
  const u = new URL(url)
  const ok = u.protocol === 'https:' || (TEST_BASE && u.protocol === 'http:' && u.host === new URL(TEST_BASE).host)
  if (!ok) throw new Fail(`Refusing to download from ${u.protocol}//${u.host}.`)
  // Output downloads are deliberately unauthenticated: the key never goes here.
  const res = await fetch(u, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Fail(`Download of ${u.host}${u.pathname} failed with HTTP ${res.status}.`)
  return Buffer.from(await res.arrayBuffer())
}

async function download(opts) {
  const resultFile = req(opts, 'result')
  const dir = path.resolve(req(opts, 'dir'))
  const files = filesIn(readJson(resultFile))
  if (!files.length) throw new Fail('The result holds no output files (no {url} objects). Inspect it directly.', EXIT.api)
  fs.mkdirSync(dir, { recursive: true })
  const base = typeof opts.name === 'string' ? safeName(opts.name) : ''
  const used = new Set()
  const saved = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const ext = extFor(f)
    let stem = base ? (files.length > 1 ? `${base}-${String(i + 1).padStart(2, '0')}` : base) : safeName(path.basename(f.file_name ?? '', ext)) || `output-${i + 1}`
    while (used.has(stem + ext)) stem += '_'
    used.add(stem + ext)
    const dest = path.join(dir, stem + ext)
    if (fs.existsSync(dest) && !opts.overwrite) {
      saved.push({ path: dest, skipped: 'exists' })
      continue
    }
    const bytes = await fetchBytes(f.url)
    const tmp = `${dest}.part`
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, dest)
    process.stderr.write(`[fal] saved ${dest} (${bytes.length} bytes)\n`)
    saved.push({ path: dest, bytes: bytes.length, content_type: f.content_type ?? null, source: f.url.startsWith('data:') ? 'data-uri' : f.url })
  }
  const world = worldOf(opts)
  if (!world) return { dir, files: saved }
  const receipt = typeof opts.receipt === 'string' ? opts.receipt : resultFile.replace(/\.result\.json$/i, '.job.json')
  if (!fs.existsSync(receipt)) throw new Fail(`Project mode needs the receipt for provenance; pass --receipt <x.job.json> (looked for ${receipt}).`, EXIT.usage)
  const record = readJson(receipt)
  const seed = readJson(resultFile).seed
  for (const s of saved) {
    if (s.skipped) continue
    s.provenance = writeFalProvenance(world, s.path, record, seed)
    if (s.provenance) process.stderr.write(`[fal] provenance ${s.provenance}\n`)
  }
  return { dir, files: saved }
}

/** Input as recorded in provenance: local "@file:" inputs become world-relative (or bare names), never personal paths. */
function provenanceInput(world, v, derived) {
  if (typeof v === 'string' && v.startsWith('@file:')) {
    const rel = worldRel(world, v.slice(6))
    if (rel) derived.add(rel)
    return `@file:${rel ?? path.basename(v.slice(6))}`
  }
  if (typeof v === 'string' && v.startsWith('data:')) return `${v.slice(0, v.indexOf(',') + 1)}…`
  if (Array.isArray(v)) return v.map((x) => provenanceInput(world, x, derived))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, provenanceInput(world, x, derived)]))
  return v
}

function writeFalProvenance(world, file, record, seed) {
  const derived = new Set()
  const input = provenanceInput(world, record.input ?? {}, derived)
  return writeProvenance(world, file, {
    provider: 'fal',
    endpoint: record.endpoint,
    request_id: record.submission?.request_id ?? null,
    input,
    ...(seed !== undefined && input.seed === undefined ? { seed } : {}),
    price: record.price ?? null,
    recipe: record.genio?.recipe ?? null,
    derived_from: [...derived],
    by: record.genio?.by ?? unitBy(),
    created: record.completed_utc ?? nowUtc()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Submit (or resume an existing receipt), poll, fetch the result and download the outputs. */
async function run(opts) {
  const receipt = req(opts, 'receipt')
  const world = worldOf(opts)
  let dir = typeof opts.dir === 'string' ? opts.dir : null
  if (!dir && world) {
    const kind = opts.kind ?? (opts.recipe !== undefined ? findRecipe(world, String(opts.recipe)).save_to : undefined)
    dir = folderFor(world, typeof kind === 'string' ? kind : undefined)
  }
  if (!dir) throw new Fail('Missing --dir (in project mode it can come from .genio/fal/config.json folders via --kind <image|audio|model|video> or a recipe\'s save_to).', EXIT.usage)
  needKey()
  let submitted
  if (fs.existsSync(receipt)) {
    const rec = readJson(receipt)
    if (!rec.submission?.request_id) {
      throw new Fail(`Receipt ${receipt} is "${rec.state}" with no request id. Do not resubmit under it: inspect it, then use a new receipt name if a new paid call is warranted.`, EXIT.usage)
    }
    process.stderr.write(`[fal] resuming request ${rec.submission.request_id} from the existing receipt (no new paid call)\n`)
    submitted = { resumed: true, request_id: rec.submission.request_id, endpoint: rec.endpoint }
  } else {
    submitted = await submit(opts)
    process.stderr.write(`[fal] submitted ${submitted.endpoint} as ${submitted.request_id}\n`)
  }
  const timeout = Number(opts.timeout ?? 900) * 1000
  const start = Date.now()
  let wait = 2000
  let last = ''
  for (;;) {
    const st = await status({ receipt }, true)
    const line = st.status + (st.queue_position != null && st.status === 'IN_QUEUE' ? ` (position ${st.queue_position})` : '')
    if (line !== last) process.stderr.write(`[fal] ${line}\n`)
    last = line
    if (st.status === 'COMPLETED') {
      if (st.error) throw new Fail(`FAL reported a failed run: ${st.error}`, EXIT.api, { receipt: path.resolve(receipt) })
      break
    }
    if (Date.now() - start > timeout) {
      throw new Fail(`Still ${st.status} after ${timeout / 1000}s. Run the same command again later to resume; it will not resubmit.`, EXIT.pending, { receipt: path.resolve(receipt) })
    }
    await sleep(wait)
    wait = Math.min(Math.round(wait * 1.5), 10_000)
  }
  const res = await result({ receipt, out: opts.out })
  const dl = await download({ result: res.result, dir, name: opts.name, overwrite: opts.overwrite, world: opts.world, receipt })
  const rec = readJson(receipt)
  return { receipt: path.resolve(receipt), request_id: submitted.request_id, resumed: Boolean(submitted.resumed), result: res.result, metrics: rec.metrics ?? null, ...dl }
}

async function price(opts) {
  const endpoint = endpointOf(opts)
  return call(`${PRICING}?endpoint_id=${encodeURIComponent(endpoint)}`)
}

async function estimate(opts) {
  const endpoint = endpointOf(opts)
  const units = Number(req(opts, 'units'))
  if (!Number.isFinite(units) || units <= 0) throw new Fail('--units must be a positive number of billing units.', EXIT.usage)
  return call(`${PRICING}/estimate`, { method: 'POST', body: { estimate_type: 'unit_price', endpoints: { [endpoint]: { unit_quantity: units } } } })
}

function check() {
  if (!KEY) throw new Fail(MISSING_KEY, EXIT.nokey, { configured: false })
  return { configured: true, source: 'FAL_KEY environment variable', network_checked: false }
}

const folderOf = (world, kind) => (typeof kind === 'string' && typeof world.config.folders?.[kind] === 'string' ? world.config.folders[kind] : null)

/** What the world's .genio/ says: folders, budget and spend so far, defaults, recipes, providers. No network. */
function worldInfo(opts) {
  const world = needWorld(opts)
  const by = unitBy()
  const budget = opts.budget === undefined ? null : positive(opts, 'budget', true)
  const g = checkBudget({ lines: readSpend(spendFile(world)), by, estUsd: 0, unitBudget: budget, config: world.config })
  const b = world.config.budget ?? {}
  return {
    world: world.root,
    config: world.hasConfig,
    folders: world.config.folders ?? {},
    budget: {
      monthly_usd: b.monthly_usd ?? null,
      confirm_over_usd: b.confirm_over_usd ?? null,
      spent_this_month: g.spent_this_month,
      remaining_this_month: b.monthly_usd == null ? null : usd(Math.max(0, b.monthly_usd - g.spent_this_month)),
      you: by,
      spent_by_you: g.spent_by_unit,
      ...(budget == null ? {} : { your_budget_usd: budget, your_remaining_usd: usd(Math.max(0, budget - g.spent_by_unit)) })
    },
    defaults: world.config.defaults ?? {},
    recipes: world.recipes.map((r) => ({ id: r?.id, label: r?.label ?? null, endpoint: r?.endpoint, save_to: r?.save_to ?? null, folder: folderOf(world, r?.save_to) })),
    providers: { codex: codexEnabled(world.config) }
  }
}

/** One recipe, with its prompt template filled (--subject) and the player's defaults merged into its input. No network. */
function recipe(opts) {
  const world = needWorld(opts)
  const r = findRecipe(world, req(opts, 'id'))
  const subject = typeof opts.subject === 'string' ? opts.subject : null
  const prompt = typeof r.prompt_template === 'string' && subject != null ? r.prompt_template.split('{subject}').join(subject) : null
  return { ...r, prompt, input: mergedInput(world, r.endpoint, r), folder: folderOf(world, r.save_to) }
}

const USAGE = `Genio FAL helper (key from FAL_KEY only).
  catalogue [--job <job>] [--query <text>]            bundled model catalogue (no network)
  locate --world <root> --kind <kind> --name <name.ext> [--engine unity] [--engine-root Game] [--hint <folder>]
  check                                              is a key available? (no network)
  price    --endpoint <id>                           unit price for a model (free)
  estimate --endpoint <id> --units <n>               cost estimate for n billing units (free)
  run      --endpoint <id> (--input <f>|--json <s>) --receipt <x.job.json> --dir <out dir> [--name <base>] [--timeout <s>]
  submit   --endpoint <id> (--input <f>|--json <s>) --receipt <x.job.json>
  status   --receipt <x.job.json> [--logs]
  result   --receipt <x.job.json> [--out <x.result.json>]
  download --result <x.result.json> --dir <out dir> [--name <base>] [--overwrite]
  cancel   --receipt <x.job.json>
Project mode (.genio/ in your worktree):
  world    --world <root> [--budget <usd>]           folders, budget and spend, defaults, recipes (no network)
  recipe   --world <root> --id <recipe> [--subject <text>]   a recipe with its prompt filled in (no network)
  run/submit ... --world <root> (--units <n>|--est-usd <n>) [--budget <usd>] [--recipe <id>] [--kind <image|audio|model|video>]
           priced and checked against the budgets first; logs .genio/spend.jsonl and writes .genio/provenance/
  run/submit ... --budget <usd> --ledger <spend.jsonl> (--units <n>|--est-usd <n>)   the same budget stop outside a project`

function catalogue(opts) {
  const file = fileURLToPath(new URL('../references/catalogue.json', import.meta.url))
  const c = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { ...c, entries: c.entries.filter(e => (!opts.job || e.job === opts.job) && (!opts.query || JSON.stringify(e).toLowerCase().includes(String(opts.query).toLowerCase()))) }
}
function locate(opts) {
  const world = needWorld(opts)
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: world.root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).split('\0')
  const kinds = { image: /\.(png|jpg|jpeg|webp|tga|psd|tif|exr)$/i, audio: /\.(wav|ogg|mp3|flac)$/i, model: /\.(fbx|glb|gltf|obj)$/i, animation: /\.(bvh|anim)$/i, video: /\.(mp4|mov|webm)$/i, material: /\.(mat|tres)$/i }
  const assets = [...new Set(files)].filter(Boolean).map(p => ({ path: p, folder: path.posix.dirname(p), kind: Object.keys(kinds).find(k => kinds[k].test(p)), vendor: /(?:^|\/)(?:vendor|third[-_ ]?party|plugins|addons)(?:\/|$)/i.test(p) })).filter(a => a.kind)
  return suggestLocation({ assets, kind: opts.kind ?? 'image', name: opts.name, hint: opts.hint, engine: opts.engine ?? 'other', engineRoot: opts['engine-root'] ?? '', config: world.config, root: world.root })
}
const COMMANDS = { catalogue, locate, check, price, estimate, run, submit, status, result, download, cancel, world: worldInfo, recipe }

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help' || opts.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  const fn = COMMANDS[command]
  if (!fn) throw new Fail(`Unknown command "${command}".\n${USAGE}`, EXIT.usage)
  const out = await fn(opts)
  process.stdout.write(JSON.stringify(redact(out), null, 2) + '\n')
}

main().catch((e) => {
  const code = e instanceof Fail ? e.code : e instanceof WorldError ? EXIT.usage : 1
  const message = e instanceof Fail || e instanceof WorldError ? e.message : `${e?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}`
  process.stderr.write(JSON.stringify(redact({ error: message, ...(e?.extra ?? {}) }), null, 2) + '\n')
  process.exit(code)
})
