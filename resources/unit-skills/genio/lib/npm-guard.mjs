#!/usr/bin/env node
/**
 * node_modules safety for units. Three entries:
 *   node npm-guard.mjs <npm|npx|pnpm|yarn> [args…]  PATH shim check: exit 0 lets the real tool run, 23 refuses.
 *   node npm-guard.mjs --hook                        Claude PreToolUse hook (JSON on stdin): exit 2 denies.
 *   node npm-guard.mjs setup                         Give this worktree its own node_modules (removes a link first).
 * Context comes from GENIO_DEPS_WORKTREE, GENIO_DEPS_MAIN and GENIO_DEPS_STATE. Detection and denial, not a sandbox.
 */
import fs from 'node:fs'
import { depsToolReason, npmGuardReason, setupNodeModules } from './node-deps.mjs'

const env = process.env
const context = { worktree: env.GENIO_DEPS_WORKTREE || undefined, main: env.GENIO_DEPS_MAIN || undefined, state: env.GENIO_DEPS_STATE || undefined }
const writeState = record => {
  if (!context.state) return
  try { fs.writeFileSync(context.state, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)) } catch { /* the report below still prints */ }
}

async function main(argv) {
  if (argv[0] === '--hook') {
    let body = ''
    process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('Hook input too large') }
    const input = JSON.parse(body)
    const reason = input?.hook_event_name === 'PreToolUse' ? depsToolReason(input, context) : undefined
    if (!reason) return 0
    process.stderr.write(`[genio] ${reason}\n`)
    return 2
  }
  if (argv[0] === 'setup') {
    if (!context.worktree || !context.main) { process.stderr.write('[genio] setup needs GENIO_DEPS_WORKTREE and GENIO_DEPS_MAIN (set in every unit terminal).\n'); return 1 }
    const report = await setupNodeModules(context.worktree, context.main, { progress: r => writeState({ ...r, pid: process.pid, by: 'unit' }) })
    writeState({ ...report, by: 'unit' })
    process.stdout.write(`[genio] node_modules: ${report.state}${report.method ? ` (${report.method})` : ''}${report.reason ? ` ${report.reason}` : ''}\n`)
    return report.state === 'failed' ? 1 : 0
  }
  const [tool, ...args] = argv
  const reason = tool ? npmGuardReason(tool, args, { cwd: process.cwd(), ...context }) : undefined
  if (!reason) return 0
  process.stderr.write(`[genio] ${reason}\n`)
  return 23
}

try { process.exitCode = await main(process.argv.slice(2)) }
catch (e) {
  // A broken guard never stops a shim'd tool or a hooked shell command; it says so instead.
  process.stderr.write(`[genio] node_modules guard unavailable: ${e.message}\n`)
  process.exitCode = process.argv[2] === 'setup' ? 1 : 0
}
