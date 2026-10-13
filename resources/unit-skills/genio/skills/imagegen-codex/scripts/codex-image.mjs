#!/usr/bin/env node
/**
 * Genio's Codex image helper for units: images from Codex's built-in image_gen
 * tool, which uses the player's ChatGPT plan instead of a paid API. Node 18+,
 * standard library only.
 *
 * It runs `codex exec` in a fresh scratch folder under Genio's data (never in a
 * world) with a fixed minimal prompt, takes the thread id from `--json`, reads
 * each generation's savedPath from the session rollout and copies the files to
 * --out itself: it never relies on the Codex agent to copy them. It reads
 * session rollouts and generated images only, never Codex's auth files.
 *
 * With --world it runs unless the world opted out (.genio/fal/config.json
 * "providers": {"codex": {"enabled": false}}) and writes a provenance file per
 * image plus a spend.jsonl line (est_usd 0, plan chatgpt). Without a world it
 * needs an explicit --no-world.
 *
 * Prints one JSON document on stdout; progress goes to stderr.
 * Exit codes: 0 ok, 2 usage, 3 this world opted out, 4 Codex error or missing image, 5 timed out.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorldError, appendSpend, codexEnabled, openWorld, spendFile, unitBy, worldRel, writeProvenance } from '../../../lib/genio-world.mjs'
import { findRollout, imageBytes, parseRollout, planMeter, threadIdFromEvents } from './rollout.mjs'

const EXIT = { usage: 2, disabled: 3, codex: 4, timeout: 5 }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const MAX_BATCH = 8

class Fail extends Error {
  constructor(message, code = EXIT.codex, extra = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

const REPEATABLE = new Set(['prompt', 'out', 'ref'])
const FLAGS = new Set(['transparent', 'no-world', 'overwrite', 'help'])

function parseArgs(argv) {
  const opts = { prompt: [], out: [], ref: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Fail(`Unexpected argument: ${a}`, EXIT.usage)
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
    let value
    if (eq > 0) value = a.slice(eq + 1)
    else if (FLAGS.has(name)) value = true
    else if (i + 1 < argv.length) value = argv[++i]
    else throw new Fail(`--${name} needs a value.`, EXIT.usage)
    if (REPEATABLE.has(name)) opts[name].push(String(value))
    else opts[name] = value
  }
  return opts
}

/** Items to generate: repeated --prompt/--out pairs (sharing --transparent), or a --batch JSON file. */
function itemsOf(opts) {
  let items
  if (typeof opts.batch === 'string') {
    if (opts.prompt.length || opts.out.length) throw new Fail('Use either --batch or --prompt/--out, not both.', EXIT.usage)
    let list
    try {
      list = JSON.parse(fs.readFileSync(opts.batch, 'utf8').replace(/^﻿/, ''))
    } catch (e) {
      throw new Fail(`--batch must be a JSON file: [{"prompt", "out", "transparent"?}, ...] (${e.message}).`, EXIT.usage)
    }
    if (!Array.isArray(list)) throw new Fail('--batch must hold a JSON array.', EXIT.usage)
    items = list.map((x) => ({ prompt: x?.prompt, out: x?.out, transparent: x?.transparent === undefined ? opts.transparent === true : x.transparent === true }))
  } else {
    if (opts.prompt.length !== opts.out.length) throw new Fail('Give one --out per --prompt, in the same order.', EXIT.usage)
    items = opts.prompt.map((prompt, i) => ({ prompt, out: opts.out[i], transparent: opts.transparent === true }))
  }
  if (!items.length) throw new Fail('Nothing to generate: give --prompt <text> --out <file.png>.', EXIT.usage)
  if (items.length > MAX_BATCH) throw new Fail(`At most ${MAX_BATCH} images per run.`, EXIT.usage)
  const outs = new Set()
  return items.map((it, i) => {
    if (typeof it.prompt !== 'string' || !it.prompt.trim()) throw new Fail(`Item ${i + 1} has no prompt.`, EXIT.usage)
    if (typeof it.out !== 'string' || !it.out.trim()) throw new Fail(`Item ${i + 1} has no out path.`, EXIT.usage)
    const out = path.resolve(it.out)
    if (path.extname(out).toLowerCase() !== '.png') throw new Fail(`${it.out}: Codex images are PNG; use a .png out path.`, EXIT.usage)
    if (outs.has(out)) throw new Fail(`${it.out} is used twice.`, EXIT.usage)
    outs.add(out)
    if (fs.existsSync(out) && !opts.overwrite) throw new Fail(`${out} already exists; pick a new name or pass --overwrite.`, EXIT.usage)
    return { prompt: it.prompt.trim(), out, transparent: it.transparent }
  })
}

const isUnder = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function gitAncestor(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    if (path.dirname(d) === d) return null
  }
}

/** Genio's data folder for Codex scratch runs; refused when it lies inside the world or any git checkout. */
function scratchRoot(opts, world) {
  const genioHome = process.env.GENIO_HOME ? path.resolve(process.env.GENIO_HOME) : path.join(os.homedir(), '.genio')
  const root = path.resolve(typeof opts.scratch === 'string' ? opts.scratch : process.env.GENIO_CODEX_IMAGE_SCRATCH || path.join(genioHome, 'data', 'codex-image'))
  if (world && (isUnder(root, world.root) || isUnder(world.root, root))) throw new Fail(`Refusing scratch folder ${root}: it overlaps the project. Codex runs only under Genio's data.`, EXIT.usage)
  const repo = gitAncestor(root)
  if (repo) throw new Fail(`Refusing scratch folder ${root}: it is inside the git checkout ${repo}. Codex runs only under Genio's data.`, EXIT.usage)
  return root
}

function promptFor(items, refs) {
  const head = [
    'You are an image generation step run by a script. Use the built-in image_gen tool exactly once per item below, in order, and do nothing else:',
    'do not read skills or files, do not run commands, do not copy, move or edit any file, and do not make variants or retries.',
    refs.length ? `The ${refs.length} attached image(s) are references for the items.` : '',
    'When every item is done, reply with the single word: done.'
  ].filter(Boolean)
  const body = items.map((it, i) => `Item ${i + 1} (transparent background: ${it.transparent ? 'yes' : 'no'}):\n${it.prompt}`)
  return `${head.join(' ')}\n\n${body.join('\n\n')}\n`
}

/** How to start Codex without a shell: GENIO_CODEX_BIN (a .js runs under node), or codex on PATH (npm shims resolved to their codex.js). */
function codexCommand() {
  const bin = process.env.GENIO_CODEX_BIN || 'codex'
  if (/\.[cm]?js$/i.test(bin)) return { file: process.execPath, pre: [path.resolve(bin)] }
  const fromShim = (cmd) => {
    const dir = path.dirname(cmd)
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (!fs.existsSync(js)) throw new Fail(`Cannot start ${cmd} without a shell. Set GENIO_CODEX_BIN to Codex's codex.js or codex.exe.`, EXIT.codex)
    const node = path.join(dir, 'node.exe')
    return { file: fs.existsSync(node) ? node : process.execPath, pre: [js] }
  }
  if (process.platform !== 'win32') return { file: bin, pre: [] }
  if (/\.(cmd|bat)$/i.test(bin)) return fromShim(bin)
  if (path.extname(bin)) return { file: bin, pre: [] }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, `${bin}.exe`)
    if (fs.existsSync(exe)) return { file: exe, pre: [] }
    const cmd = path.join(dir, `${bin}.cmd`)
    if (fs.existsSync(cmd)) return fromShim(cmd)
  }
  throw new Fail('Codex CLI not found on PATH. Install it and log in with ChatGPT, or set GENIO_CODEX_BIN.', EXIT.codex)
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

function runCodex(runDir, prompt, refs, timeoutMs) {
  const { file, pre } = codexCommand()
  const args = [...pre, 'exec', '--skip-git-repo-check', '-C', runDir, '-s', 'workspace-write', '-c', 'model_reasoning_effort="low"', '--json', '-', ...refs.flatMap((r) => ['-i', r])]
  const env = { ...process.env }
  delete env.FAL_KEY // Codex needs no Genio secrets
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: runDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Fail(`Could not start Codex (${e.code ?? e.message}).`, EXIT.codex))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      fs.writeFileSync(path.join(runDir, 'events.jsonl'), stdout)
      resolve({ code, stdout, stderr: stderr.slice(-4000), timedOut })
    })
    child.stdin.end(prompt)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readRollout(threadId, started) {
  const home = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')
  const sessions = path.join(home, 'sessions')
  for (let i = 0; i < 10; i++) {
    const file = findRollout(sessions, threadId, [started, new Date()])
    if (file) return { file, text: fs.readFileSync(file, 'utf8') }
    await sleep(500) // the rollout is flushed as the session closes
  }
  return null
}

function copyImage(gen, rolloutText, dest) {
  let bytes = null
  if (gen.savedPath && fs.existsSync(gen.savedPath)) bytes = fs.readFileSync(gen.savedPath)
  else if (gen.hasInlineResult) bytes = imageBytes(rolloutText, gen.id)
  if (!bytes) throw new Error('the generated file is missing and the rollout holds no inline copy')
  if (!bytes.subarray(0, 4).equals(PNG)) throw new Error('the generated file is not a PNG')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, dest)
  return bytes.length
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  const items = itemsOf(opts)
  const refs = opts.ref.map((r) => {
    const p = path.resolve(r)
    if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) throw new Fail(`Reference image not found: ${p}`, EXIT.usage)
    if (!IMAGE_EXT.has(path.extname(p).toLowerCase())) throw new Fail(`${p}: references must be PNG, JPEG, WebP or GIF images.`, EXIT.usage)
    return p
  })
  let world = null
  if (opts.world !== undefined) {
    if (opts['no-world']) throw new Fail('Use either --world or --no-world.', EXIT.usage)
    world = openWorld(String(opts.world))
    if (!codexEnabled(world.config)) {
      throw new Fail(
        'This project opted out of Codex images (.genio/fal/config.json "providers": {"codex": {"enabled": false}}); units never edit that file. Use FAL, or append needs-decision and stop.',
        EXIT.disabled
      )
    }
    for (const it of items) {
      const rel = worldRel(world, it.out)
      if (rel === '.genio' || rel?.startsWith('.genio/')) throw new Fail(`${it.out}: images never go inside .genio/.`, EXIT.usage)
    }
  } else if (!opts['no-world']) {
    throw new Fail('Pass --world <your worktree root> or, outside any project, an explicit --no-world.', EXIT.usage)
  }
  const warnAt = opts['warn-at'] === undefined ? 80 : Number(opts['warn-at'])
  if (!Number.isFinite(warnAt)) throw new Fail('--warn-at must be a percentage.', EXIT.usage)
  const timeoutS = opts.timeout === undefined ? Math.max(600, 180 * items.length) : Number(opts.timeout)
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Fail('--timeout must be a positive number of seconds.', EXIT.usage)

  const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(3).toString('hex')}`
  const runDir = path.join(scratchRoot(opts, world), runId)
  fs.mkdirSync(runDir, { recursive: true })
  const prompt = promptFor(items, refs)
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt)
  process.stderr.write(`[codex-image] ${items.length} image(s) on your ChatGPT plan, about a minute each; scratch ${runDir}\n`)

  const started = new Date()
  const res = await runCodex(runDir, prompt, refs, timeoutS * 1000)
  const threadId = threadIdFromEvents(res.stdout)
  if (!threadId) {
    throw new Fail(`Codex gave no thread id (exit ${res.code}${res.timedOut ? ', timed out' : ''}).`, res.timedOut ? EXIT.timeout : EXIT.codex, { stderr: res.stderr, run_dir: runDir })
  }
  const rollout = await readRollout(threadId, started)
  if (!rollout) throw new Fail(`No session rollout found for thread ${threadId}.`, EXIT.codex, { thread_id: threadId, run_dir: runDir })
  const parsed = parseRollout(rollout.text)
  const meter = planMeter(parsed.rateLimits, warnAt, parsed.rateLimitsFirst)
  if (meter.warning) process.stderr.write(`[codex-image] WARNING: ${meter.warning}\n`)

  const by = unitBy()
  const results = []
  items.forEach((it, i) => {
    const gen = parsed.images[i]
    const r = { out: it.out, prompt: it.prompt, transparent: it.transparent }
    if (!gen) return results.push({ ...r, ok: false, error: 'Codex made no image for this item.' })
    Object.assign(r, { call_id: gen.id, revised_prompt: gen.revisedPrompt })
    if (gen.status !== 'completed') return results.push({ ...r, ok: false, error: `image_gen ${gen.status ?? 'unknown'}${gen.failure ? `: ${JSON.stringify(gen.failure)}` : ''}` })
    try {
      r.bytes = copyImage(gen, rollout.text, it.out)
    } catch (e) {
      return results.push({ ...r, ok: false, error: `Could not copy the image: ${e.message}.` })
    }
    process.stderr.write(`[codex-image] saved ${it.out} (${r.bytes} bytes)\n`)
    if (world) {
      const derived = refs.map((p) => worldRel(world, p)).filter(Boolean)
      r.provenance = writeProvenance(world, it.out, {
        provider: 'codex',
        endpoint: 'codex/image_gen',
        request_id: gen.id,
        thread_id: threadId,
        input: { prompt: it.prompt, transparent_background: it.transparent, refs: refs.map((p) => worldRel(world, p) ?? path.basename(p)) },
        revised_prompt: gen.revisedPrompt,
        price: { unit: 'image', unit_price_usd: 0, estimated_usd: 0, plan: 'chatgpt', checked: new Date().toISOString().slice(0, 10) },
        recipe: null,
        derived_from: derived,
        by,
        created: gen.completedAt ?? new Date().toISOString()
      })
    }
    results.push({ ...r, ok: true })
  })
  // One spend line per image_gen call made, so the world's ledger shows plan use too.
  if (world) {
    for (const gen of parsed.images) {
      appendSpend(spendFile(world), {
        t: gen.completedAt ?? new Date().toISOString(), provider: 'codex', what: 'image_gen', request_id: gen.id, thread_id: threadId, est_usd: 0, plan: 'chatgpt', by,
        ...(gen.status === 'completed' ? {} : { status: gen.status })
      })
    }
  }
  // Successful unit outputs reach Genio through its existing status channel.
  if (process.env.GENIO_STATUS_FILE && process.env.GENIO_TASK_ID) {
    for (const r of results.filter((r) => r.ok)) {
      try { fs.appendFileSync(process.env.GENIO_STATUS_FILE, `note [key=genio-codex-image]: ${threadId}/${r.call_id}\n`) } catch { /* cosmetic */ }
    }
  }
  const ok = results.every((r) => r.ok)
  const out = {
    provider: 'codex',
    plan: 'chatgpt',
    thread_id: threadId,
    images: results,
    plan_meter: meter,
    warning: meter.warning,
    spend_lines: world ? parsed.images.length : 0,
    elapsed_s: Math.round((Date.now() - started.getTime()) / 100) / 10,
    run_dir: runDir,
    codex_exit: res.code,
    ...(res.timedOut ? { timed_out: true } : {})
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (!ok) process.exitCode = res.timedOut ? EXIT.timeout : EXIT.codex
}

const USAGE = `Genio Codex image helper (uses your ChatGPT plan through Codex's built-in image_gen; no API key).
  --prompt <text> --out <file.png> [--prompt <text> --out <file.png> ...]   one or more images in one Codex run (max ${MAX_BATCH})
  --batch <items.json>          instead of pairs: [{"prompt", "out", "transparent"?}, ...]
  --transparent                 transparent background for every --prompt item
  --ref <image> [--ref ...]     reference images attached to the run (for edits or consistency)
  --world <worktree root>       project mode (on unless .genio/fal/config.json sets providers.codex.enabled false); writes provenance + spend
  --no-world                    explicit run outside any project (no provenance, no spend line)
  [--overwrite] [--timeout <s>] [--warn-at <plan %, default 80>] [--scratch <dir under Genio's data>]`

main().catch((e) => {
  const code = e instanceof Fail ? e.code : e instanceof WorldError ? EXIT.usage : 1
  const message = e instanceof Fail || e instanceof WorldError ? e.message : `${e?.code ?? e?.name ?? 'Error'}: ${e?.message ?? e}`
  process.stderr.write(JSON.stringify({ error: message, ...(e?.extra ?? {}) }, null, 2) + '\n')
  process.exit(code)
})
