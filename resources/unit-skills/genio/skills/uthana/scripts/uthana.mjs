#!/usr/bin/env node
/**
 * Genio's Uthana helper for units. Node 18+, standard library only.
 *
 * Text-to-motion (generate, wait, download one FBX/GLB/BVH export) and
 * character upload or reuse, through Uthana's GraphQL API. The key is read
 * only from the UTHANA_API_KEY environment variable and is sent only to
 * uthana.com (never to a CDN a download redirects to). It is never printed and
 * never written to receipts. Paid calls are never retried automatically, and
 * an existing receipt is never resubmitted.
 *
 * With --world <worktree root> it follows the world's .genio/ folder like the
 * FAL helper: a budget gate before every paid call (your --budget, the
 * project's monthly cap and confirm threshold in .genio/fal/config.json), one
 * spend.jsonl line per paid call and a provenance file for the saved export.
 * The project Art Bible's Animation line follows the prompt (--no-bible turns
 * it off). Characters this helper uploads are remembered in Genio's data
 * (GENIO_UTHANA_DATA/unit-characters.jsonl, next to the characters Genio
 * itself uploaded) and reused by project source and sha256.
 *
 * Every command prints one JSON document on stdout; progress goes to stderr.
 * Exit codes: 0 ok, 2 usage, 3 key missing, 4 Uthana/network error, 5 still pending, 6 over budget.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WorldError, appendSpend, checkBudget, openWorld, readSpend, sha256File, spendFile, unitBy, worldRel, writeProvenance
} from '../../../lib/genio-world.mjs'
import { ArtBibleError, applyToMotion, loadArtBible } from '../../../lib/art-bible.mjs'

const EXIT = { usage: 2, nokey: 3, api: 4, pending: 5, budget: 6 }
const MISSING_KEY =
  'Uthana key missing: UTHANA_API_KEY is not set for this unit. The player sets it in Genio under Settings -> Accounts & keys -> API keys (Uthana); units launched after that receive it automatically.'

// Tests only: a loopback base stands in for uthana.com. Nothing else is accepted.
const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.GENIO_UTHANA_TEST_BASE ?? '') ? process.env.GENIO_UTHANA_TEST_BASE : ''
const ORIGIN = TEST_BASE || 'https://uthana.com'
const GRAPHQL = `${ORIGIN}/graphql`
const POLL_MS = TEST_BASE && Number(process.env.GENIO_UTHANA_POLL_MS) > 0 ? Number(process.env.GENIO_UTHANA_POLL_MS) : 5000

/** Snapshot prices from uthana.com/pricing, as Genio's own Uthana tools use them (src/shared/uthana.ts; a test keeps them in step). */
export const PRICES_CHECKED = '2026-10-13'
export const MODELS = {
  'text-to-motion-3.0': { job: true, unitPrice: 0.1, defaultLength: 8, length: [4, 10, true] },
  'text-to-motion-bucmd': { job: false, unitPrice: 0.03, defaultLength: 10, length: [0.25, 10, false] },
  'text-to-motion': { job: false, unitPrice: 0.02, maxSeconds: 10 }
}
export const AUTO_RIG_USD = 0.15
export const DEFAULT_MODEL = 'text-to-motion-3.0'
/** Uthana's stock characters; Manny is the default, as in Genio's uthana_motion tool. */
export const STOCK = [
  { id: 'cXi2eAP19XwQ', name: 'Tar' },
  { id: 'cmEE2fT4aSaC', name: 'Ava' },
  { id: 'c43tbGks3crJ', name: 'Manny' },
  { id: 'czCjWEMtWxt8', name: 'Quinn' },
  { id: 'cJM4ngRqXg83', name: 'Y Bot' }
]
const DEFAULT_CHARACTER = STOCK[2]
const FORMATS = ['fbx', 'glb', 'bvh']
const CHARACTER_EXTS = ['fbx', 'glb', 'gltf']
const CHARACTER_MAX_BYTES = 30 * 1024 * 1024
const MAX_DOWNLOAD = 512 * 1024 * 1024
const MIME = { fbx: 'application/octet-stream', glb: 'model/gltf-binary', gltf: 'model/gltf+json' }

const CREATE_TEXT_TO_MOTION = `mutation CreateTextToMotion($prompt: String!, $character_id: String, $model: String!, $length: Float) {
  create_text_to_motion(prompt: $prompt, character_id: $character_id, model: $model, length: $length) { motion { id name } }
}`
const CREATE_TEXT_TO_MOTION_JOB = `mutation CreateTextToMotionJob($prompt: String!, $model: String!, $character_id: String, $length: Float, $fast: Boolean) {
  create_text_to_motion_job(prompt: $prompt, model: $model, character_id: $character_id, length: $length, fast: $fast) { job { id status est_processing_time } }
}`
const CREATE_CHARACTER = `mutation CreateCharacter($name: String!, $file: Upload!, $auto_rig: Boolean, $auto_rig_front_facing: Boolean) {
  create_character(name: $name, file: $file, auto_rig: $auto_rig, auto_rig_front_facing: $auto_rig_front_facing) { character { id name } auto_rig_confidence message }
}`
const GET_JOB = 'query GetJob($job_id: String!) { job(job_id: $job_id) { id status result } }'

class Fail extends Error {
  constructor(message, code = EXIT.api, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const KEY = (process.env.UTHANA_API_KEY ?? '').trim()
const SECRETS = KEY ? [KEY, Buffer.from(`${KEY}:`, 'utf8').toString('base64')] : []

function redact(v) {
  if (!SECRETS.length) return v
  if (typeof v === 'string') return SECRETS.reduce((s, k) => s.split(k).join('[REDACTED]'), v)
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
    if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1)
    else if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) opts[a.slice(2)] = rest[++i]
    else opts[a.slice(2)] = true
  }
  return { command, opts }
}

function req(opts, name) {
  const v = opts[name]
  if (typeof v !== 'string' || !v.trim()) throw new Fail(`Missing --${name}.`, EXIT.usage)
  return v
}

const nowUtc = () => new Date().toISOString()
const usd = (n) => Math.round(n * 1e6) / 1e6
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''))

function writeJson(p, value, exclusive = false) {
  fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(redact(value), null, 2) + '\n', { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' })
}

function positive(opts, name, allowZero = false) {
  const n = Number(opts[name])
  if (opts[name] === true || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Fail(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} number.`, EXIT.usage)
  return n
}

const idPart = (v, what = 'id') => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) throw new Fail(`Not an Uthana ${what}: ${v}`, EXIT.usage)
  return v
}

// ---------------------------------------------------------------- pricing

function modelOf(opts) {
  const id = typeof opts.model === 'string' ? opts.model.trim() : DEFAULT_MODEL
  if (/^video-to-motion/.test(id)) throw new Fail('Video-to-motion is not in the unit helper: report the needed motion and its video to Genio.', EXIT.usage)
  const m = MODELS[id]
  if (!m) throw new Fail(`Not an Uthana text-to-motion model: ${id} (have: ${Object.keys(MODELS).join(', ')}).`, EXIT.usage)
  return { id, ...m }
}

/** The length to send (undefined: the model picks it) after the model's checks. */
function lengthOf(m, opts) {
  if (opts.length === undefined) return m.defaultLength
  if (!m.length) throw new Fail(`${m.id} picks its own length; leave --length out (it is quoted up to ${m.maxSeconds} s).`, EXIT.usage)
  const n = Number(opts.length)
  const [lo, hi, int] = m.length
  if (opts.length === true || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) {
    throw new Fail(`--length for ${m.id} must be ${int ? 'a whole number' : 'a number'} from ${lo} to ${hi} seconds.`, EXIT.usage)
  }
  return n
}

/** The same estimate as Genio's own tools: exact for a set length, a ceiling when the model picks it. */
export function estimateMotion(modelId, length) {
  const m = MODELS[modelId]
  if (!m) return null
  if (m.length) {
    const s = length ?? m.defaultLength
    return { usd: usd(s * m.unitPrice), seconds: s, up_to: false, unit: 'seconds', unit_price_usd: m.unitPrice }
  }
  return { usd: usd(m.maxSeconds * m.unitPrice), seconds: null, up_to: true, unit: 'seconds', unit_price_usd: m.unitPrice }
}

// ---------------------------------------------------------------- HTTP

const ownUrl = (u) => (TEST_BASE ? u.origin === TEST_BASE : u.protocol === 'https:' && u.host === 'uthana.com')

/** Uthana's own words for an HTTP failure. */
function httpMessage(status, text) {
  let msg = ''
  try {
    const j = JSON.parse(text)
    msg = j.errors?.[0]?.message ?? j.message ?? j.detail ?? ''
  } catch {
    msg = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  }
  if (status === 401) return `Uthana rejected the key (401)${msg ? `: ${msg}` : ''}. The player checks it in Settings -> Accounts & keys -> API keys.`
  if (status === 403) return `Uthana refused the request (403)${msg ? `: ${msg}` : ''}. Check the plan's quota or credits at uthana.com/app/account.`
  return `Uthana error ${status}${msg ? `: ${msg}` : ''}`
}

/**
 * POST to the GraphQL endpoint. Throws Fail with extra.rejected when Uthana
 * answered and refused (nothing created), extra.uncertain when the outcome is unknown.
 */
async function gql(body, json, timeoutMs) {
  const key = needKey()
  const headers = { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${key}:`, 'utf8').toString('base64')}` }
  if (json) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(GRAPHQL, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new Fail('No response from Uthana; the outcome is uncertain. No automatic retry was made.', EXIT.api, { uncertain: true })
  }
  const text = await res.text()
  if (res.status >= 500 || (res.status >= 300 && res.status < 400)) {
    throw new Fail(`${httpMessage(res.status, text)}. The outcome is uncertain; no automatic retry was made.`, EXIT.api, { http: res.status, uncertain: true })
  }
  if (!res.ok) throw new Fail(`${httpMessage(res.status, text)}. No automatic retry was made.`, EXIT.api, { http: res.status, rejected: true })
  let out
  try {
    out = JSON.parse(text)
  } catch {
    throw new Fail('Uthana returned a response that is not JSON; the outcome is uncertain.', EXIT.api, { http: res.status, uncertain: true })
  }
  if (out.errors?.length) {
    throw new Fail(`Uthana: ${out.errors[0]?.message ?? 'GraphQL error'}. No automatic retry was made.`, EXIT.api, { rejected: true, detail: out.errors.slice(0, 3) })
  }
  return out.data ?? {}
}

const query = (q, variables = {}, timeoutMs = 120_000) => gql(JSON.stringify({ query: q, variables }), true, timeoutMs)

/** A mutation with one file, per the GraphQL multipart request spec (operations / map / 0). */
function upload(q, variables, fileVar, file, timeoutMs = 330_000) {
  const form = new FormData()
  form.append('operations', JSON.stringify({ query: q, variables: { ...variables, [fileVar]: null } }))
  form.append('map', JSON.stringify({ 0: [`variables.${fileVar}`] }))
  form.append('0', new Blob([file.bytes], { type: file.mime }), file.name)
  return gql(form, false, timeoutMs)
}

/** GET a file with the key on uthana.com only; redirects are followed by hand and the next host gets no key. */
async function download(url, timeoutMs = 300_000) {
  let current = new URL(url)
  if (!ownUrl(current)) throw new Fail('Refusing to send the Uthana key outside uthana.com.')
  for (let hop = 0; hop < 6; hop++) {
    const own = ownUrl(current)
    let res
    try {
      const headers = own ? { Authorization: `Basic ${Buffer.from(`${needKey()}:`, 'utf8').toString('base64')}` } : {}
      res = await fetch(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw new Fail('The download did not finish. Run the same command again: it resumes from the receipt without a new paid call.')
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Fail(`Uthana answered ${res.status} without a location.`)
      current = new URL(loc, current)
      const loopback = TEST_BASE && current.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(current.hostname)
      if (current.protocol !== 'https:' && !loopback) throw new Fail('Refusing a download redirect that is not https.')
      continue
    }
    if (!res.ok) throw new Fail(`Download failed: ${httpMessage(res.status, await res.text())}. Run the same command again to retry the download (free).`)
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Fail('The file is larger than 512 MB.')
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Fail('Too many redirects.')
}

// ---------------------------------------------------------------- jobs

function jobResult(v) {
  if (typeof v === 'string') {
    try {
      return jobResult(JSON.parse(v))
    } catch {
      return v.trim() ? { message: v } : undefined
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined
}

/** Motion ids in a finished job: result.result.id (documented), plus lists of motions. */
function jobMotionIds(result) {
  const out = []
  const add = (v) => typeof v === 'string' && v.trim() && !out.includes(v) && out.push(v)
  const visit = (o, depth) => {
    if (!o || depth > 3) return
    add(o.motion_id)
    add(jobResult(o.motion)?.id)
    for (const [k, v] of Object.entries(o)) if (/motion_ids$|^motions$/i.test(k) && Array.isArray(v)) for (const x of v) add(typeof x === 'string' ? x : jobResult(x)?.id)
    const inner = o.result === undefined ? undefined : jobResult(o.result)
    if (inner) {
      add(inner.id)
      visit(inner, depth + 1)
    }
  }
  visit(jobResult(result), 0)
  return out
}

function jobError(result) {
  const r = jobResult(result)
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : undefined)
  return pick(r?.message) ?? pick(r?.error) ?? pick(jobResult(r?.result)?.message) ?? (r ? JSON.stringify(r).slice(0, 400) : 'Uthana reported the job as failed.')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the job (free) until it finishes. Transient failures are retried; this is not a paid call. */
async function waitForJob(receipt, record, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000
  let misses = 0
  let last = ''
  for (;;) {
    let job
    try {
      job = (await query(GET_JOB, { job_id: record.job_id })).job
      misses = 0
    } catch (e) {
      if (e.code === EXIT.nokey || e.extra?.rejected || ++misses >= 5) throw e
      await sleep(POLL_MS)
      continue
    }
    if (!job) throw new Fail(`Uthana has no job ${record.job_id}.`)
    const st = String(job.status ?? '').toUpperCase()
    if (st !== last) process.stderr.write(`[uthana] job ${st || 'unknown'}\n`)
    last = st
    record.job_status = st
    record.last_checked_utc = nowUtc()
    if (st === 'FINISHED') {
      const ids = jobMotionIds(job.result)
      if (!ids.length) throw new Fail('The job finished but its result has no motion id. Do not resubmit: check uthana.com/app.')
      record.motion_id = ids[0]
      record.motion_ids = ids
      record.state = 'completed'
      record.completed_utc = nowUtc()
      writeJson(receipt, record)
      return
    }
    if (st === 'FAILED') {
      record.state = 'failed'
      record.error = jobError(job.result)
      writeJson(receipt, record)
      throw new Fail(`Uthana job failed: ${record.error}`, EXIT.api, { receipt: path.resolve(receipt) })
    }
    writeJson(receipt, record)
    if (Date.now() > deadline) {
      throw new Fail(`Still ${st || 'running'} after ${timeoutS}s. Run the same command again later to resume; it will not resubmit.`, EXIT.pending, { receipt: path.resolve(receipt) })
    }
    await sleep(POLL_MS)
  }
}

// ---------------------------------------------------------------- world, ledger, characters

function worldOf(opts) {
  if (opts.world === undefined) return null
  if (typeof opts.world !== 'string' || !opts.world.trim()) throw new Fail('--world needs the path of your worktree root.', EXIT.usage)
  return openWorld(opts.world)
}

function ledgerOf(opts, world) {
  if (world) return spendFile(world)
  if (opts.ledger === undefined) return null
  return path.resolve(req(opts, 'ledger'))
}

/** Budget gate before a paid call; exit 6 with nothing sent when it fails. */
function gate(opts, world, estUsd) {
  const budget = opts.budget === undefined ? null : positive(opts, 'budget', true)
  const ledger = ledgerOf(opts, world)
  if (budget != null && !ledger) throw new Fail('--budget outside project mode needs --ledger <spend.jsonl> to count what you already spent.', EXIT.usage)
  if (!ledger) return { ledger: null, budget: null }
  const g = checkBudget({ lines: readSpend(ledger), by: unitBy(), estUsd, unitBudget: budget, config: world?.config })
  if (!g.ok) throw new Fail(`${g.reason} Nothing was sent to Uthana. Append needs-decision with the plan, the estimate and the budget, then stop.`, EXIT.budget, { budget: g })
  return { ledger, budget: { ...g, ok: undefined, reason: undefined } }
}

/** Genio's Uthana data folder (characters Genio and units uploaded), or null outside Genio. */
const uthanaData = () => (process.env.GENIO_UTHANA_DATA?.trim() ? path.resolve(process.env.GENIO_UTHANA_DATA.trim()) : null)
const UNIT_CHARACTERS = 'unit-characters.jsonl'

/** Characters Genio and its units uploaded, newest first. Read only; a missing or broken file is no record. */
function knownCharacters() {
  const dir = uthanaData()
  if (!dir) return []
  const out = []
  try {
    const v = readJson(path.join(dir, 'characters.json'))
    if (Array.isArray(v)) out.push(...v)
  } catch {
    /* none yet */
  }
  for (const l of readSpend(path.join(dir, UNIT_CHARACTERS))) out.push(l)
  return out.filter((c) => c && typeof c.id === 'string').sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

function rememberCharacter(rec) {
  const dir = uthanaData()
  if (!dir) return null
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, UNIT_CHARACTERS)
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  return file
}

/** The character to retarget to: --character <id or stock name>, else Manny. */
function characterOf(opts) {
  if (opts.character === undefined) return { id: DEFAULT_CHARACTER.id, name: DEFAULT_CHARACTER.name, stock: true }
  const v = req(opts, 'character').trim()
  const stock = STOCK.find((c) => c.id === v || c.name.toLowerCase() === v.toLowerCase())
  if (stock) return { id: stock.id, name: stock.name, stock: true }
  const known = knownCharacters().find((c) => c.id === v)
  return { id: idPart(v, 'character id'), name: known?.name ?? null, stock: false, source: known?.source ?? null }
}

// ---------------------------------------------------------------- commands

function check() {
  if (!KEY) throw new Fail(MISSING_KEY, EXIT.nokey, { configured: false })
  return { configured: true, source: 'UTHANA_API_KEY environment variable', network_checked: false, characters_store: uthanaData() ? 'GENIO_UTHANA_DATA' : null }
}

function estimate(opts) {
  if (opts.character === true || opts['auto-rig'] !== undefined || opts.kind === 'character') {
    const autoRig = opts['no-auto-rig'] === undefined
    return { kind: 'character', est_usd: autoRig ? AUTO_RIG_USD : 0, up_to: autoRig, note: autoRig ? 'billed only when Uthana auto-rigs the mesh' : 'no auto-rig', checked: PRICES_CHECKED }
  }
  const m = modelOf(opts)
  const e = estimateMotion(m.id, lengthOf(m, opts))
  return { kind: 'motion', model: m.id, est_usd: e.usd, seconds: e.seconds, up_to: e.up_to, unit_price_usd: e.unit_price_usd, unit: 'seconds', checked: PRICES_CHECKED }
}

function characters() {
  return { default: DEFAULT_CHARACTER, stock: STOCK, uploaded: knownCharacters().map(({ id, name, world, source, sha256, createdAt }) => ({ id, name, world: world ?? null, source: source ?? null, sha256: sha256 ?? null, createdAt })) }
}

/** Generate a motion (or resume its receipt), download one export to --out and record provenance. */
async function motion(opts) {
  const receipt = req(opts, 'receipt')
  const world = worldOf(opts)
  const out = path.resolve(req(opts, 'out'))
  const ext = path.extname(out).slice(1).toLowerCase()
  const format = typeof opts.format === 'string' ? opts.format.toLowerCase() : ext
  if (!FORMATS.includes(format)) throw new Fail(`--format must be fbx, glb or bvh (got ${format || 'none'}).`, EXIT.usage)
  if (ext !== format) throw new Fail(`--out must end in .${format} for a ${format.toUpperCase()} export.`, EXIT.usage)
  if (world && !worldRel(world, out)) throw new Fail('--out must be inside --world so the motion lands with its provenance.', EXIT.usage)
  if (world && worldRel(world, out).startsWith('.genio/')) throw new Fail('--out must not be inside .genio/.', EXIT.usage)
  const fps = opts.fps === undefined ? undefined : Number(opts.fps)
  if (fps !== undefined && ![24, 30, 60].includes(fps)) throw new Fail('--fps must be 24, 30 or 60.', EXIT.usage)
  const exportOpts = { ...(fps ? { fps } : {}), ...(opts['in-place'] ? { in_place: true } : {}) }

  let record
  let spent = null
  if (fs.existsSync(receipt)) {
    record = readJson(receipt)
    if (!record.job_id && !record.motion_id) {
      throw new Fail(`Receipt ${receipt} is "${record.state}" with no job or motion id. Do not resubmit under it: inspect it (and uthana.com/app), then use a new receipt name if a new paid call is warranted.`, EXIT.usage)
    }
    process.stderr.write(`[uthana] resuming ${record.motion_id ?? record.job_id} from the existing receipt (no new paid call)\n`)
    needKey()
  } else {
    if (fs.existsSync(out) && !opts.overwrite) throw new Fail(`${out} already exists. Pick a new name (fal.mjs locate) or pass --overwrite; nothing was sent.`, EXIT.usage)
    const m = modelOf(opts)
    const length = lengthOf(m, opts)
    const own = typeof opts.prompt === 'string' ? opts.prompt.trim() : ''
    if (own.length < 3) throw new Fail('Describe the motion with --prompt "<text>".', EXIT.usage)
    const character = characterOf(opts)
    const bible = world && !opts['no-bible'] ? applyToMotion({ bible: loadArtBible(world.root, { file: process.env.GENIO_ART_BIBLE || undefined }), prompt: own }) : null
    const prompt = bible?.prompt ?? own
    const est = estimateMotion(m.id, length)
    const g = gate(opts, world, est.usd)
    needKey()
    const by = unitBy()
    record = {
      state: 'submission_unknown', provider: 'uthana', model: m.id, created_utc: nowUtc(),
      input: { prompt, ...(length !== undefined ? { length } : {}) },
      character_id: character.id, character_name: character.name, ...(character.source ? { character_source: character.source } : {}),
      price: { unit: 'seconds', unit_price_usd: est.unit_price_usd, estimated_usd: est.usd, up_to: est.up_to, checked: PRICES_CHECKED },
      by, ...(bible?.stamp ? { art_bible: bible.stamp } : {})
    }
    try {
      writeJson(receipt, record, true) // reserve before the paid call; never overwrite
    } catch (e) {
      if (e.code === 'EEXIST') throw new Fail(`Receipt ${receipt} already exists; run the same command to resume it, or pick a new receipt name.`, EXIT.usage)
      throw e
    }
    const spend = (id, uncertain) => {
      if (!g.ledger) return
      appendSpend(g.ledger, {
        t: nowUtc(), provider: 'uthana', endpoint: `uthana/${m.id}`, request_id: id ? `uthana:${id}` : null, units: est.seconds, unit: 'seconds', est_usd: est.usd, by,
        ...(uncertain ? { uncertain: true } : {})
      })
    }
    process.stderr.write(`[uthana] ${m.id} for ${character.name ?? character.id}, est. USD ${est.usd}${est.up_to ? ' (ceiling)' : ''}\n`)
    try {
      if (m.job) {
        const d = await query(CREATE_TEXT_TO_MOTION_JOB, { prompt, model: m.id, character_id: character.id, length, fast: false })
        const job = d.create_text_to_motion_job?.job
        if (!job?.id) throw new Fail('Uthana returned no job id; the outcome is uncertain. Do not resubmit: check uthana.com/app.', EXIT.api, { uncertain: true })
        record.job_id = job.id
        record.job_status = job.status ?? null
        record.state = 'submitted'
      } else {
        const d = await query(CREATE_TEXT_TO_MOTION, { prompt, model: m.id, character_id: character.id, ...(length !== undefined ? { length } : {}) }, 300_000)
        const mo = d.create_text_to_motion?.motion
        if (!mo?.id) throw new Fail('Uthana returned no motion id; the motion may exist anyway. Do not resubmit: check uthana.com/app.', EXIT.api, { uncertain: true })
        record.motion_id = mo.id
        record.motion_ids = [mo.id]
        record.motion_name = mo.name ?? null
        record.state = 'completed'
        record.completed_utc = nowUtc()
      }
    } catch (e) {
      if (e.extra?.rejected) {
        record.state = 'rejected' // Uthana refused it: nothing was created or billed
        record.error = e.message
      } else spend(null, true) // the outcome is unknown: count it against the budget
      writeJson(receipt, record)
      throw e
    }
    writeJson(receipt, record)
    spend(record.motion_id ?? record.job_id, false)
    spent = { est_usd: est.usd, ...(g.budget ? { budget: g.budget } : {}) }
  }

  if (!record.motion_id) await waitForJob(receipt, record, Number(opts.timeout ?? 1800))
  if (fs.existsSync(out) && !opts.overwrite && record.saved?.path !== out) {
    throw new Fail(`${out} already exists; the motion ${record.motion_id} is safe in the receipt. Pass a new --out or --overwrite to download it (free).`, EXIT.usage)
  }
  const qs = Object.entries({ ...(record.download ?? exportOpts) }).map(([k, v]) => `${k}=${v}`).join('&')
  const stem = (path.basename(out, path.extname(out)).replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '') || 'motion').slice(0, 60)
  const url = `${ORIGIN}/motion/file/motion_viewer/${idPart(record.character_id, 'character id')}/${idPart(record.motion_id, 'motion id')}/${format}/${encodeURIComponent(stem)}.${format}${qs ? `?${qs}` : ''}`
  const bytes = await download(url)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(`${out}.part`, bytes)
  fs.renameSync(`${out}.part`, out)
  process.stderr.write(`[uthana] saved ${out} (${bytes.length} bytes)\n`)
  record.download = record.download ?? exportOpts
  record.saved = { path: out, format, bytes: bytes.length, utc: nowUtc() }
  writeJson(receipt, record)

  let provenance = null
  if (world) {
    const derived = record.character_source ? [record.character_source] : []
    provenance = writeProvenance(world, out, {
      provider: 'uthana',
      endpoint: `uthana/${record.model}`,
      request_id: record.motion_id,
      input: {
        ...record.input,
        character_id: record.character_id,
        ...(record.character_name ? { character_name: record.character_name } : {}),
        ...(record.job_id ? { job_id: record.job_id } : {}),
        download: { format, ...record.download }
      },
      price: { unit: record.price?.unit ?? 'seconds', unit_price_usd: record.price?.unit_price_usd ?? null, estimated_usd: record.price?.estimated_usd ?? null, checked: record.price?.checked ?? PRICES_CHECKED },
      recipe: null,
      derived_from: derived,
      by: record.by ?? unitBy(),
      created: record.completed_utc ?? nowUtc(),
      ...(record.art_bible ? { art_bible: record.art_bible } : {})
    })
    if (provenance) process.stderr.write(`[uthana] provenance ${provenance}\n`)
  }
  // Only saved motions report through the existing unit status channel.
  if (process.env.GENIO_STATUS_FILE && process.env.GENIO_TASK_ID) {
    try { fs.appendFileSync(process.env.GENIO_STATUS_FILE, `note [key=genio-uthana-run]: ${record.motion_id}\n`) } catch { /* cosmetic */ }
  }
  return {
    receipt: path.resolve(receipt), resumed: spent === null, model: record.model, motion_id: record.motion_id, motion_ids: record.motion_ids ?? [record.motion_id],
    character_id: record.character_id, file: out, format, bytes: bytes.length, provenance,
    ...(spent ? spent : {}),
    ...(record.art_bible ? { art_bible: record.art_bible } : {}),
    ...(format === 'fbx' ? { note: 'Unity imports this FBX as Generic until its import settings are set to Humanoid; Genio never writes .meta files for you.' } : {})
  }
}

/** Reuse a character by project source and sha256, or upload it (auto-rig up to USD 0.15). */
async function character(opts) {
  const world = worldOf(opts)
  const file = path.resolve(req(opts, 'file'))
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Fail(`File not found: ${file}`, EXIT.usage)
  const ext = path.extname(file).slice(1).toLowerCase()
  if (!CHARACTER_EXTS.includes(ext)) throw new Fail(`Uthana takes .fbx, .glb or .gltf characters, not .${ext || '(none)'}.`, EXIT.usage)
  const size = fs.statSync(file).size
  if (size >= CHARACTER_MAX_BYTES) throw new Fail(`${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB; Uthana takes characters under 30 MB.`, EXIT.usage)
  const rel = world ? worldRel(world, file) : null
  if (world && !rel) throw new Fail('--file must be inside --world (the character is recorded by its project path).', EXIT.usage)
  const source = rel ?? `local:${path.basename(file)}`
  const sha256 = sha256File(file)
  const existing = knownCharacters().find((c) => c.source === source && c.sha256 === sha256)
  if (existing) return { reused: true, character: { id: existing.id, name: existing.name, source, sha256 }, est_usd: 0 }

  const receipt = req(opts, 'receipt')
  if (fs.existsSync(receipt)) {
    const r = readJson(receipt)
    if (r.character?.id) return { reused: true, receipt: path.resolve(receipt), character: r.character, est_usd: 0 }
    throw new Fail(`Receipt ${receipt} is "${r.state}" with no character id. Do not upload again under it: check uthana.com/app, then use a new receipt name if a new paid call is warranted.`, EXIT.usage)
  }
  const autoRig = !opts['no-auto-rig']
  const estUsd = autoRig ? AUTO_RIG_USD : 0
  const g = gate(opts, world, estUsd)
  needKey()
  const by = unitBy()
  const name = (typeof opts.name === 'string' && opts.name.trim()) || path.basename(file, path.extname(file))
  const record = { state: 'submission_unknown', provider: 'uthana', model: 'auto-rig', created_utc: nowUtc(), input: { name, source, sha256, auto_rig: autoRig }, price: { unit: 'rig', unit_price_usd: AUTO_RIG_USD, estimated_usd: estUsd, up_to: autoRig, checked: PRICES_CHECKED }, by }
  try {
    writeJson(receipt, record, true)
  } catch (e) {
    if (e.code === 'EEXIST') throw new Fail(`Receipt ${receipt} already exists; pick a new receipt name.`, EXIT.usage)
    throw e
  }
  const spend = (id, cost, uncertain) => {
    if (!g.ledger) return
    appendSpend(g.ledger, { t: nowUtc(), provider: 'uthana', endpoint: 'uthana/auto-rig', request_id: id ? `uthana:${id}` : null, units: 1, unit: 'rig', est_usd: cost, by, ...(uncertain ? { uncertain: true } : {}) })
  }
  let c
  try {
    const d = await upload(CREATE_CHARACTER, { name, auto_rig: autoRig, auto_rig_front_facing: true }, 'file', { bytes: fs.readFileSync(file), name: path.basename(file), mime: MIME[ext] })
    c = d.create_character
    if (!c?.character?.id) throw new Fail('Uthana returned no character id; the outcome is uncertain. Do not upload again: check uthana.com/app.', EXIT.api, { uncertain: true })
  } catch (e) {
    if (e.extra?.rejected) {
      record.state = 'rejected'
      record.error = e.message
    } else spend(null, estUsd, true)
    writeJson(receipt, record)
    throw e
  }
  const confidence = typeof c.auto_rig_confidence === 'number' ? c.auto_rig_confidence : undefined
  // Uthana bills the rig only when it auto-rigged the mesh (it reports a confidence then).
  const cost = autoRig && confidence !== undefined ? AUTO_RIG_USD : 0
  const rec = {
    id: c.character.id, name: c.character.name ?? name, ...(process.env.GENIO_PROJECT ? { world: process.env.GENIO_PROJECT } : {}), source, sha256,
    ...(confidence !== undefined ? { autoRigConfidence: confidence } : {}), ...(c.message ? { message: c.message } : {}), by, createdAt: nowUtc()
  }
  record.state = 'completed'
  record.character = rec
  writeJson(receipt, record)
  spend(rec.id, cost, false)
  const stored = rememberCharacter(rec)
  return { reused: false, receipt: path.resolve(receipt), character: rec, est_usd: cost, remembered: Boolean(stored), ...(g.budget ? { budget: g.budget } : {}) }
}

const USAGE = `Genio Uthana helper (key from UTHANA_API_KEY only).
  check                                              is a key available? (no network)
  estimate [--model <id>] [--length <s>]             motion cost from the price snapshot (no network)
  estimate --kind character [--no-auto-rig]          character upload cost (no network)
  characters                                         stock characters and the ones already uploaded (no network)
  motion   --world <root> --prompt <text> --out <file.fbx|.glb|.bvh> --receipt <x.job.json> --budget <usd>
           [--model text-to-motion-3.0|text-to-motion-bucmd|text-to-motion] [--length <s>] [--character <id|stock name>]
           [--format fbx|glb|bvh] [--fps 24|30|60] [--in-place] [--no-bible] [--timeout <s>] [--overwrite]
           one paid generation, then a free download to --out with provenance; the same command resumes a receipt
  character --world <root> --file <rig.fbx|.glb|.gltf> --receipt <x.job.json> --budget <usd> [--name <name>] [--no-auto-rig]
           reuses an uploaded character with the same project path and sha256 (free), else uploads it
  motion/character ... --budget <usd> --ledger <spend.jsonl>   the same budget stop outside a project`

const COMMANDS = { check, estimate, characters, motion, character }

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

// Tests import the price table; only a direct run executes a command.
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  main().catch((e) => {
    const code = e instanceof Fail ? e.code : e instanceof WorldError || e instanceof ArtBibleError ? EXIT.usage : 1
    const message = e instanceof Fail || e instanceof WorldError ? e.message : e instanceof ArtBibleError ? `${e.message} Fix .genio/art-bible.md, or pass --no-bible.` : `${e?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}`
    process.stderr.write(JSON.stringify(redact({ error: message, ...(e?.extra ?? {}) }), null, 2) + '\n')
    process.exit(code)
  })
}
