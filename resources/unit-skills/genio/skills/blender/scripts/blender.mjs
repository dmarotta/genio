#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { blenderCacheDir, findBlender } from '../../../lib/blender-path.mjs'
import { openWorld, sha256File, writeProvenance, unitBy } from '../../../lib/genio-world.mjs'
import { assertOutside } from '../../../lib/step-kernel.mjs'

export { assertOutside }

const helperDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Compiled Python shared by every Blender run on this machine, in blenderCacheDir()/pyc. Blender ships
 * little or none for numpy and its add-ons and cannot write into its own install folder, so each run
 * compiled them again: a 4.2 start with the step runner's imports took 1.5 s and takes 1.0 s with it,
 * a 5.2 one 3.9 s and 1.5 s (medians, measured). Python checks every cached file against its source and
 * replaces it atomically, so concurrent runs, upgrades and edited helpers stay correct. On Windows it is
 * off when Blender's deepest module (about 128 characters below blender.exe with its compiled name)
 * would pass the 260-character path limit: writes that fail cost more than they save.
 */
export function bytecodeEnv(blender, dir = path.join(blenderCacheDir(), 'pyc'), platform = process.platform) {
  const fits = platform !== 'win32' || dir.length + blender.length + 128 < 260
  return fits ? { PYTHONPYCACHEPREFIX: dir } : { PYTHONDONTWRITEBYTECODE: '1' }
}

/**
 * One headless Blender run: no autoexec, factory settings, capped threads, a log
 * in scratch and a SIGKILL watchdog. Never throws for a failed run; the caller
 * reads `code` and `timedOut`. `prefix` goes before Blender's own argv (tests run
 * a fake Blender through Node this way). Aborting `signal` kills it like the watchdog.
 */
export async function runBlender({ blender, prefix = [], script, blend = null, args = [], threads = Math.min(4, os.availableParallelism()), timeout = 300, scratch, env = {}, signal }) {
  fs.mkdirSync(scratch, { recursive: true })
  const log = path.join(scratch, `blender-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.log`)
  const fd = fs.openSync(log, 'wx')
  const argv = [...prefix, '-b', '--factory-startup', '--disable-autoexec', '--python-use-system-env', '--python-exit-code', '1', '--threads', String(threads), ...(blend ? [blend] : []), '--python', script, '--', ...args]
  const bytecode = bytecodeEnv(blender)
  const childEnv = { ...process.env, ...env, ...bytecode, PYTHONPATH: [helperDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
  if (bytecode.PYTHONPYCACHEPREFIX) delete childEnv.PYTHONDONTWRITEBYTECODE
  let tail = '', timedOut = false
  const started = performance.now()
  const code = await new Promise((resolve, reject) => {
    const child = spawn(blender, argv, { windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => { timedOut = true; child.kill('SIGKILL') }
    const timer = setTimeout(stop, timeout * 1000)
    signal?.addEventListener('abort', stop, { once: true })
    const collect = chunk => { fs.writeSync(fd, chunk); tail = (tail + chunk.toString()).slice(-16000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('close', c => { clearTimeout(timer); resolve(c) })
  }).finally(() => fs.closeSync(fd))
  return { code, timedOut, log, tail, ms: Math.round(performance.now() - started) }
}

async function main() {
  const raw = process.argv.slice(2), split = raw.indexOf('--')
  const flags = split < 0 ? raw : raw.slice(0, split), args = split < 0 ? [] : raw.slice(split + 1)
  const opts = {}
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]
    if (!['--script', '--blend', '--threads', '--timeout', '--scratch', '--world', '--provenance'].includes(key) || !flags[i + 1]) throw new Error(`Unknown or missing option: ${key}`)
    opts[key.slice(2)] = flags[i + 1]
  }
  if (!opts.script) throw new Error('Usage: blender.mjs --script build.py [--blend source.blend] [--threads 4] [--timeout 300] [--provenance output --world root] -- script args')
  const threads = Number(opts.threads ?? Math.min(4, os.availableParallelism())), timeout = Number(opts.timeout ?? 300)
  if (!Number.isInteger(threads) || threads < 1 || threads > 64 || !Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('threads must be 1..64; timeout must be 0..86400 seconds (exclusive of zero)')
  const world = opts.world ? openWorld(opts.world) : null
  if (opts.provenance && !world) throw new Error('--provenance requires --world')
  const script = path.resolve(opts.script), scriptSha = sha256File(script)
  const blend = opts.blend ? path.resolve(opts.blend) : null
  const blendSha = blend ? sha256File(blend) : null
  const scratch = path.resolve(opts.scratch ?? process.env.GENIO_BLENDER_SCRATCH ?? path.join(os.tmpdir(), 'genio-blender'))
  assertOutside(scratch, [process.cwd(), world?.root], 'Scratch logs must be outside the project/worktree')
  const blender = findBlender()
  if (!blender) throw new Error('Blender not found. Set GENIO_BLENDER to blender.exe (not blender-launcher.exe).')
  const { code, timedOut, log, tail } = await runBlender({ blender, script, blend, args, threads, timeout, scratch })
  if (timedOut || code !== 0) throw new Error(`${timedOut ? 'Blender timed out' : `Blender failed (exit ${code})`}. Log: ${log}\n${tail.split(/\r?\n/).slice(-30).join('\n')}`)
  let provenance = null
  if (opts.provenance) {
    const version = execFileSync(blender, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).split(/\r?\n/)[0]
    provenance = writeProvenance(world, path.resolve(opts.provenance), { provider: 'blender', by: unitBy(), t: new Date().toISOString(), script: { path: script, sha256: scriptSha }, blend: blend ? { path: blend, sha256: blendSha } : null, blender_version: version, args, threads })
    if (!provenance) throw new Error('Provenance output must be an asset inside --world, outside .genio')
  }
  // Only successful runs report through the existing unit status channel.
  if (process.env.GENIO_STATUS_FILE && process.env.GENIO_TASK_ID) {
    try { fs.appendFileSync(process.env.GENIO_STATUS_FILE, `note [key=genio-blender-run]: ${path.basename(log)}\n`) } catch { /* cosmetic */ }
  }
  console.log(JSON.stringify({ ok: true, log, provenance }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1 })
}
