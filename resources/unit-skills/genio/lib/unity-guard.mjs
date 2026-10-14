#!/usr/bin/env node
/** Shared hook/shim rules. Detection and denial, not a sandbox. No editor control lives here. */
import fs from 'node:fs'
import path from 'node:path'
import { poolDirectory } from '../skills/play/scripts/pool.mjs'
import { volumeMissing } from '../skills/play/scripts/clone.mjs'

export const RULE = 'Use genio-unity for every Unity action; only your own copy and your leased Play slot are allowed.'
export const GUARD_MATCHER = 'Bash|PowerShell|Read|Edit|Write|Glob|Grep|NotebookEdit'
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

/** Resolve existing ancestors too, so a new file behind a junction cannot escape the fence. */
export function canonicalPath(value, cwd = process.cwd()) {
  let p = path.resolve(cwd, value), tail = []
  for (;;) {
    try { p = path.join(fs.realpathSync(p), ...tail.reverse()); break } catch { /* may be a new file */ }
    const parent = path.dirname(p)
    if (parent === p) { p = path.resolve(cwd, value); break }
    tail.push(path.basename(p)); p = parent
  }
  p = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? p.toLowerCase() : p
}
const inside = (p, root) => p === root || p.startsWith(root + '/')

/** Match PlayPool.slots() without constructing a pool or changing shared state. */
export function unityPoolPaths(c) {
  const dir = poolDirectory(c.play.data, c.play.world)
  const placed = read(path.join(dir, 'placement.json'))?.dir
  const copies = typeof placed === 'string' && path.isAbsolute(placed) && !volumeMissing(placed) ? placed : dir
  return { dir, copies }
}

/** All player copies are forbidden to units, including a copy placed on another volume. */
export function playerUnityRoots(c) {
  const dir = path.join(c.play.data, 'player-copies'), out = []
  try {
    for (const name of fs.readdirSync(dir)) {
      const rec = read(path.join(dir, name, 'instance.json'))
      if (rec?.version === 1 && typeof rec.root === 'string') out.push(canonicalPath(rec.root))
    }
  } catch { /* none yet */ }
  return out
}

/** Read-only pool snapshot: no lease renewal, stale cleanup, or editor shutdown. */
export function leasedUnityRoots(c, { now = Date.now(), isAlive = alive } = {}) {
  try {
    const { dir, copies } = unityPoolPaths(c)
    const state = read(path.join(dir, 'state.json'))
    return (state?.slots ?? []).filter(s => Number.isInteger(s.id) && s.id >= 1 && s.id <= 8 &&
      !s.closing && !s.stuck && s.lease?.owner === `unit:${c.task}` && s.lease.expires > now && isAlive(s.lease.pid))
      .map(s => canonicalPath(path.join(copies, `slot-${s.id}`, c.engineRoot))).filter(root => !playerUnityRoots(c).includes(root))
  } catch { return [] }
}

export function loadGuardConfig(file) {
  const c = read(file)
  if (c?.schema !== 'genio.unity-unit.v1' || ![c.task, c.worktree, c.runs, c.play?.data, c.play?.world].every(v => typeof v === 'string' && v) ||
    typeof c.engineRoot !== 'string' || path.isAbsolute(c.engineRoot) || /[:\x00-\x1f]/.test(c.engineRoot) || c.engineRoot.split(/[\\/]/).includes('..')) throw new Error('Missing or invalid Unity guard config')
  return c
}

const tokens = command => [...command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s;&|()]+)/g)].map(m => m[1] ?? m[2] ?? m[3])
const basename = value => value.replace(/\\/g, '/').split('/').pop().toLowerCase()

/** Conservative for hook commands; the audit additionally requires a command-shaped line. */
export function rawUnityReason(command) {
  for (const nested of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) {
    const reason = rawUnityReason(nested[1] ?? nested[2])
    if (reason) return reason
  }
  for (const segment of command.split(/[;|\n]|&&/)) {
    const words = tokens(segment)
    while (/^[A-Za-z_]\w*=/.test(words[0] ?? '')) words.shift()
    const first = basename(words[0] ?? '')
    // Quoted instructional text and searches do not launch an editor.
    if (['echo', 'write-output', 'write-host', 'printf', 'rg', 'grep'].includes(first)) continue
    if (/(?:^|[\s"'])-(?:batchmode|runtests|executemethod)(?=[\s"'=]|$)/i.test(segment)) return 'Raw Unity editor flags are forbidden.'
    if (words.some(w => /^(?:unity\.(?:exe|cmd|bat)|unity hub(?:\.exe)?)$/i.test(basename(w))) || first === 'unity' ||
      ['call', 'exec', 'start', 'start-process', 'env', 'sudo', 'nohup'].includes(first) && words.slice(1).some(w => basename(w) === 'unity') ||
      /(?:-[el]*c|\/c|-command)\s+["']?unity\s+\w+/i.test(segment)) return 'Direct Unity CLI, editor, or Hub invocation is forbidden.'
    // Embedded script calls (spawn/exec/Start-Process) and nested shell commands.
    if (/(?:spawn|exec(?:File|Sync)?|Start-Process)\s*\(?\s*["']?(?:[^"'\n]*[\\/])?Unity(?: Hub)?\.exe\b/i.test(segment)) return 'Direct Unity editor or Hub invocation is forbidden.'
  }
  return undefined
}

export function guardTool(input, c, options = {}) {
  const tool = input?.tool_name, args = input?.tool_input ?? {}, cwd = input?.cwd || c.worktree
  const shell = tool === 'Bash' || tool === 'PowerShell'
  if (!new RegExp(`^(?:${GUARD_MATCHER})$`).test(tool ?? '')) return undefined
  const command = shell && typeof args.command === 'string' ? args.command : ''
  const raw = command && rawUnityReason(command)
  if (raw) return `${raw} ${RULE}`
  const main = canonicalPath(c.play.world), own = canonicalPath(c.worktree)
  const leases = leasedUnityRoots(c, options)
  const players = playerUnityRoots(c)
  function denied(value, at = cwd, git = false) {
    if (typeof value !== 'string' || !value || value.startsWith('-') && !value.includes('=')) return undefined
    const name = value.includes('=') && value.startsWith('-') ? value.slice(value.indexOf('=') + 1) : value
    const p = canonicalPath(name, at)
    if (players.some(root => inside(p, root))) return `The player's Play copy is forbidden to units. ${RULE}`
    if (/(?:^|\/)\.unity-pipeline-port$/i.test(p) && !leases.some(root => p === root + '/library/pipeline/.unity-pipeline-port' || p === root + '/Library/Pipeline/.unity-pipeline-port')) return `Pipeline descriptors may be read only in your live leased slot. ${RULE}`
    if (inside(p, own)) return undefined
    if (inside(p, main) && !(git && inside(p, main + '/.git'))) return `The main project folder is forbidden to units. ${RULE}`
    return undefined
  }
  const cwdDenied = denied(cwd)
  if (cwdDenied) return cwdDenied
  if (shell) {
    for (const segment of command.split(/[;|\n]|&&/)) {
      const words = tokens(segment)
      const git = /^(?:git|git\.exe)$/.test(basename(words[0] ?? ''))
      for (const word of words) { const reason = denied(word, cwd, git); if (reason) return reason }
    }
  } else {
    for (const key of ['file_path', 'path', 'notebook_path']) { const reason = denied(args[key]); if (reason) return reason }
  }
  return undefined
}

/** One atomic append per incident. Stored apart from result.json and editor.log. */
export function recordUnityIncident(c, incident) {
  fs.mkdirSync(c.runs, { recursive: true })
  fs.appendFileSync(path.join(c.runs, 'guard-incidents.jsonl'), JSON.stringify({ schema: 'genio.unity-guard.v1', at: new Date().toISOString(), ...incident }) + '\n')
}

export async function guardMain(argv = process.argv.slice(2), env = process.env) {
  let c
  try {
    c = loadGuardConfig(env.GENIO_UNITY_CONFIG)
    let reason, input
    if (argv[0] === '--shim') reason = `Bare unity is disabled for units. ${RULE}`
    else {
      let body = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('Hook input too large') }
      input = JSON.parse(body)
      if (input?.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string' || !input.tool_input ||
        typeof input.tool_input !== 'object' || Array.isArray(input.tool_input) ||
        ['Bash', 'PowerShell'].includes(input.tool_name) && typeof input.tool_input.command !== 'string') throw new Error('Invalid PreToolUse input')
      reason = guardTool(input, c)
    }
    if (!reason) return 0
    try { recordUnityIncident(c, { layer: argv[0] === '--shim' ? 'shim' : 'hook', reason, tool: input?.tool_name }) } catch { /* denial must survive an unwritable audit file */ }
    process.stderr.write(`[genio] ${reason}\n`)
    return argv[0] === '--shim' ? 21 : 2
  } catch (e) {
    process.stderr.write(`[genio] Unity guard unavailable: ${e.message}. ${RULE}\n`)
    return argv[0] === '--shim' ? 21 : 2
  }
}
