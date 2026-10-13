#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findBlender } from '../../../lib/blender-path.mjs'
import { openWorld, sha256File, writeProvenance, unitBy } from '../../../lib/genio-world.mjs'

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
  // Resolve existing parents as well as symlinks before accepting a scratch location.
  function canonical(p) {
    if (fs.existsSync(p)) return fs.realpathSync(p)
    return path.join(canonical(path.dirname(p)), path.basename(p))
  }
  for (const root of [process.cwd(), world?.root].filter(Boolean)) {
    const rel = path.relative(canonical(root), canonical(scratch))
    if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) throw new Error('Scratch logs must be outside the world/worktree')
  }
  const blender = findBlender()
  if (!blender) throw new Error('Blender not found. Set GENIO_BLENDER to blender.exe (not blender-launcher.exe).')
  fs.mkdirSync(scratch, { recursive: true })
  const log = path.join(scratch, `blender-${Date.now()}-${process.pid}.log`)
  const fd = fs.openSync(log, 'wx')
  const argv = ['-b', '--factory-startup', '--disable-autoexec', '--python-use-system-env', '--python-exit-code', '1', '--threads', String(threads), ...(blend ? [blend] : []), '--python', script, '--', ...args]
  const helperDir = path.dirname(fileURLToPath(import.meta.url))
  let tail = '', timedOut = false
  const code = await new Promise((resolve, reject) => {
    const child = spawn(blender, argv, { windowsHide: true, env: { ...process.env, PYTHONPATH: [helperDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout * 1000)
    const collect = chunk => { fs.writeSync(fd, chunk); tail = (tail + chunk.toString()).slice(-16000) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('close', c => { clearTimeout(timer); resolve(c) })
  }).finally(() => fs.closeSync(fd))
  if (timedOut || code !== 0) throw new Error(`${timedOut ? 'Blender timed out' : `Blender failed (exit ${code})`}. Log: ${log}\n${tail.split(/\r?\n/).slice(-30).join('\n')}`)
  let provenance = null
  if (opts.provenance) {
    const version = execFileSync(blender, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).split(/\r?\n/)[0]
    provenance = writeProvenance(world, path.resolve(opts.provenance), { provider: 'blender', by: unitBy(), t: new Date().toISOString(), script: { path: script, sha256: scriptSha }, blend: blend ? { path: blend, sha256: blendSha } : null, blender_version: version, args, threads })
    if (!provenance) throw new Error('Provenance output must be an asset inside --world, outside .genio')
  }
  console.log(JSON.stringify({ ok: true, log, provenance }))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
