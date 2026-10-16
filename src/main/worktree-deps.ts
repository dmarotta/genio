/**
 * Unit worktree dependencies on Genio's side (docs/unit-worktrees.md): each unit worktree gets its own real
 * node_modules in the background, npm/npx/pnpm/yarn shims and a PreToolUse rule refuse installs through a
 * linked tree, links left in worktree folders are removed (the link only) and a live unit installing through
 * one is noted. The rules themselves live in node-deps.mjs, shared with the unit-side shim and hook.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEPS_RULE, isLink, linkedNodeModules, packageCommand, removeLinkSafely, setupNodeModules, within, worktreeLinks,
  type DepsReport, type SetupOptions
} from '../../resources/unit-skills/genio/lib/node-deps.mjs'
import { listProcesses } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { waitForQuiet } from '../../resources/unit-skills/genio/lib/quiet-start.mjs'
import { formatStatusLine } from './status'
import { appendLine, fwd, writeJson } from './util'

export const npmGuardScript = (plugin: string): string => path.join(plugin, 'lib', 'npm-guard.mjs')
export const SHIMMED_TOOLS = ['npm', 'npx', 'pnpm', 'yarn']
const shQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"
const batchPath = (s: string): string => s.replace(/%/g, '%%')

/** The real tool on the inherited PATH, never a shim in skip. */
export function findTool(name: string, inheritedPath: string, skip?: string, platform = process.platform): string | undefined {
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat'] : ['']
  for (const dir of inheritedPath.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    if (skip && within(dir, skip) && within(skip, dir)) continue
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try { if (fs.statSync(p).isFile()) return p } catch { /* keep looking */ }
    }
  }
  return undefined
}

/**
 * npm, npx, pnpm and yarn shims in dir (the unit's unit-bin, beside the Unity shims): the guard runs first and
 * a refusal stops the command; otherwise the real tool, resolved now from the inherited PATH, runs.
 * Tools not installed get no shim. Returns the PATH to apply.
 */
export function installNpmShims(dir: string, guard: string, inheritedPath: string, platform = process.platform): Record<string, string> {
  if (!fs.existsSync(guard)) throw new Error(`node_modules guard is missing: ${guard}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const tool of SHIMMED_TOOLS) {
    const real = findTool(tool, inheritedPath, dir, platform)
    if (!real) continue
    fs.writeFileSync(path.join(dir, `${tool}.cmd`),
      `@echo off\r\nnode "${batchPath(guard)}" ${tool} %*\r\nif errorlevel 1 exit /b %errorlevel%\r\ncall "${batchPath(real)}" %*\r\nexit /b %errorlevel%\r\n`)
    // Git Bash on Windows runs the extensionless script beside npm.cmd; elsewhere the tool itself.
    const sh = platform === 'win32' && fs.existsSync(real.replace(/\.(cmd|exe|bat)$/i, '')) ? real.replace(/\.(cmd|exe|bat)$/i, '') : real
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nnode ${shQuote(fwd(guard))} ${tool} "$@" || exit $?\nexec ${shQuote(fwd(sh))} "$@"\n`, { mode: 0o755 })
  }
  return { PATH: dir + (platform === 'win32' ? ';' : ':') + inheritedPath }
}

/** Claude PreToolUse rule for shell tools: deny linking, moving or recursively deleting node_modules through a link. */
export function depsPreToolHook(script: string) {
  return { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node', args: [script, '--hook'], timeout: 10 }] }
}

/** What the shims, hook and `setup` read in a unit's terminal. */
export function depsEnv(o: { worktree: string; main: string; stateFile: string; guard: string }): Record<string, string> {
  return { GENIO_DEPS_WORKTREE: fwd(o.worktree), GENIO_DEPS_MAIN: fwd(o.main), GENIO_DEPS_STATE: fwd(o.stateFile), GENIO_DEPS_SETUP: fwd(o.guard) }
}

/** A unit's setup record, readable by the unit: data/<task>/deps.json. */
export const depsStateFile = (taskDir: string): string => path.join(taskDir, 'deps.json')

const running = new Map<string, Promise<DepsReport>>()
const runKey = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`

/**
 * Start the worktree's private node_modules setup in the background, once. Nothing to do without a
 * package.json or with a real node_modules already there. Progress goes to deps.json and the status log.
 */
export function startWorktreeDeps(o: { worktree: string; main: string; stateFile: string; statusFile: string; log?(record: Record<string, unknown>): void } & SetupOptions): Promise<DepsReport> | undefined {
  if (!fs.existsSync(path.join(o.worktree, 'package.json'))) return undefined
  const nm = path.join(o.worktree, 'node_modules')
  if (fs.existsSync(nm) && !isLink(nm)) {
    if (!fs.existsSync(o.stateFile)) writeJson(o.stateFile, { state: 'ready', method: 'existing', at: new Date().toISOString() })
    return undefined
  }
  const id = runKey(o.worktree)
  const current = running.get(id)
  if (current) return current
  const write = (record: Record<string, unknown>): void => { try { writeJson(o.stateFile, { ...record, by: 'genio', at: new Date().toISOString() }) } catch { /* the status line still reports */ } }
  const note = (text: string): void => { try { appendLine(o.statusFile, formatStatusLine('note', text, { key: 'deps' })) } catch { /* optional */ } }
  write({ state: 'installing', pid: process.pid })
  note(`Genio is setting up this worktree's own node_modules in the background; wait until ${fwd(o.stateFile)} says ready before running node tools.`)
  // Quiet start: the copy waits while a Play starts (docs/play.md); deps.json stays installing meanwhile.
  const quiet = o.quiet ?? (o.data ? (onWait?: () => void) => waitForQuiet(o.data!, { onWait }) : undefined)
  const job = setupNodeModules(o.worktree, o.main, { ...o, quiet, progress: r => write({ ...r, pid: process.pid }) })
    .catch((e: Error): DepsReport => ({ state: 'failed', reason: e.message, elapsedMs: 0 }))
    .then(report => {
      write({ ...report })
      o.log?.({ event: 'deps.setup', worktree: o.worktree, ...report })
      if (report.state === 'ready') note(`node_modules ready (${report.method}${report.from ? ' from the main checkout' : ''}, ${seconds(report.elapsedMs)})${report.repaired ? '; a link left there was removed first' : ''}.`)
      else if (report.state === 'failed') note(`node_modules setup failed: ${report.reason}. Run npm ci in your worktree.`)
      else note(`node_modules not set up: ${report.reason}.`)
      return report
    })
    .finally(() => running.delete(id))
  running.set(id, job)
  return job
}

/** Remove every link inside dir (the links only), then dir itself. Real folders only; never through a link. */
export async function removeTreeSafely(dir: string): Promise<void> {
  if (isLink(dir)) { removeLinkSafely(dir); return }
  const walk = async (at: string): Promise<void> => {
    for (const e of await fs.promises.readdir(at, { withFileTypes: true })) {
      const p = path.join(at, e.name)
      if (e.isSymbolicLink()) removeLinkSafely(p)
      else if (e.isDirectory()) await walk(p)
    }
  }
  await walk(dir)
  await fs.promises.rm(dir, { recursive: true, maxRetries: 2 })
}

export interface SweepUnit { id: string; worktree: string; live: boolean; state: string; stateReason?: string }
export interface SweepResult {
  removedLinks: { path: string; target?: string; targetIntact?: boolean }[]
  toldUnits: { id: string; path: string }[]
  removedFolders: string[]
  untouched: { folder: string; reason: string }[]
}

const sameDir = (a: string, b: string): boolean => within(a, b) && within(b, a)

/**
 * Startup and despawn repair over unit worktree folders (registered or leftover): a node_modules link is
 * removed (the link only) unless its unit is live, which is told through its inbox instead. A leftover
 * folder git no longer knows whose unit was despawned as landed is deleted; every other leftover is listed.
 */
export async function sweepWorktrees(o: {
  roots: string[]
  units: SweepUnit[]
  /** True when git still lists the folder as a worktree of its project; undefined when the project is unknown. */
  registered(folder: string, project: string): Promise<boolean | undefined>
  notify(id: string, message: string): void
  log(record: Record<string, unknown>): void
  told?: Set<string>
  /** npm-guard.mjs, named in the message to a live unit. */
  setup?: string
}): Promise<SweepResult> {
  const result: SweepResult = { removedLinks: [], toldUnits: [], removedFolders: [], untouched: [] }
  const links = worktreeLinks(o.roots)
  // Units placed outside the scanned roots (a Dev Drive volume) are checked by their own path.
  for (const u of o.units) {
    const nm = path.join(u.worktree, 'node_modules')
    if (!links.some(l => sameDir(l.path, nm)) && isLink(nm)) links.push({ worktree: u.worktree, project: path.basename(path.dirname(u.worktree)), unit: path.basename(u.worktree), path: nm })
  }
  for (const link of links) {
    const unit = o.units.find(u => sameDir(u.worktree, link.worktree))
    if (unit?.live) {
      const told = `${unit.id}|${link.path}`
      if (!o.told?.has(told)) {
        o.told?.add(told)
        o.notify(unit.id, linkMessage(link.path, o.setup))
        result.toldUnits.push({ id: unit.id, path: link.path })
        o.log({ event: 'deps.link-live', unit: unit.id, path: link.path, target: link.target })
      }
      continue
    }
    try {
      const r = removeLinkSafely(link.path)
      if (r.removed) result.removedLinks.push({ path: r.path, target: r.target, targetIntact: r.targetIntact })
      o.log({ event: r.removed ? 'deps.link-removed' : 'deps.link-skipped', ...r })
    } catch (e) {
      o.log({ event: 'deps.link-failed', path: link.path, error: (e as Error).message })
    }
  }
  // Leftover folders: git no longer knows them. Only a unit despawned as landed (or a Recon's scratch) may go.
  for (const root of o.roots) {
    let projects: fs.Dirent[] = []
    try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
    for (const project of projects) {
      let folders: fs.Dirent[] = []
      try { folders = fs.readdirSync(path.join(root, project.name), { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
      for (const entry of folders) {
        const folder = path.join(root, project.name, entry.name)
        const registered = await o.registered(folder, project.name).catch(() => undefined)
        if (registered) continue
        const unit = o.units.find(u => sameDir(u.worktree, folder))
        const reason = registered === undefined ? 'its project is not registered'
          : !unit ? 'no unit record owns it'
          : unit.live || unit.state !== 'cleaned' ? `its unit is ${unit.live ? 'live' : unit.state}`
          : !/^despawned: (?:landed|recon)/.test(unit.stateReason ?? '') ? `its unit was despawned without a landed verdict (${unit.stateReason ?? 'unknown'})`
          : undefined
        if (reason) { result.untouched.push({ folder, reason }); continue }
        try {
          await removeTreeSafely(folder)
          result.removedFolders.push(folder)
        } catch (e) {
          result.untouched.push({ folder, reason: `could not delete: ${(e as Error).message}` })
        }
      }
    }
  }
  if (result.removedFolders.length || result.untouched.length) o.log({ event: 'deps.leftovers', removed: result.removedFolders, untouched: result.untouched })
  return result
}

const linkMessage = (p: string, setup = '$GENIO_DEPS_SETUP'): string =>
  `Your worktree's node_modules (${fwd(p)}) is a link to another folder. Running npm install or npm ci through it deletes and rewrites that folder, ` +
  `which broke Genio before. Remove only the link with \`cmd /c rmdir "${p}"\` (never /s, never Remove-Item -Recurse), then run \`node "${fwd(setup)}" setup\` ` +
  `to give your worktree its own copy. ${DEPS_RULE}`

export interface DepsWatchUnit { id: string; worktree: string; pid?: number; statusFile: string }
type ProcessRow = { pid: number; ppid: number; created: string; command: string }

/** A package-manager command that writes node_modules: npm ci, pnpm add, npx (from a process command line). */
export function installCommand(command: string): string | undefined {
  const m = command.match(/(?:^|[\\/\s"'])(npm|npx|pnpm|yarn)(?:-cli)?(?:\.cmd|\.js|\.cjs|\.exe)?["']?((?:\s+\S+)*)\s*$/i)
  if (!m) return undefined
  const args = m[2].trim().split(/\s+/).filter(Boolean).map(a => a.replace(/^["']|["']$/g, ''))
  const parsed = packageCommand(m[1], args)
  return parsed.mutating ? [parsed.tool, parsed.sub].filter(Boolean).join(' ') : undefined
}

/**
 * Process-watch note: a live unit whose worktree has a linked node_modules is told once, and every
 * package-manager install it starts there is noted once (status log and inbox). Notes only; nothing is killed.
 */
export function createDepsWatch(setup?: string, list: () => Promise<ProcessRow[]> = listProcesses) {
  const linked = new Map<string, string>()
  const seen = new Set<string>()
  return {
    async poll(units: DepsWatchUnit[], notify: (id: string, message: string) => void): Promise<void> {
      const flagged: { unit: DepsWatchUnit; path: string }[] = []
      for (const unit of units) {
        const finding = linkedNodeModules(unit.worktree, { worktree: unit.worktree })
        if (!finding) { linked.delete(unit.id); continue }
        flagged.push({ unit, path: finding.path })
        if (linked.get(unit.id) === finding.path) continue
        linked.set(unit.id, finding.path)
        try { appendLine(unit.statusFile, formatStatusLine('note', `node_modules in this worktree is a link (${finding.reason}); installs through it would rewrite the linked folder.`, { key: 'deps-guard' })) } catch { /* inbox below */ }
        notify(unit.id, linkMessage(finding.path, setup))
      }
      if (!flagged.some(f => f.unit.pid)) return
      const snapshot = await list()
      for (const { unit, path: link } of flagged) {
        if (!unit.pid) continue
        const tree = new Set([unit.pid])
        for (let grew = true; grew;) {
          grew = false
          for (const p of snapshot) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true }
        }
        for (const p of snapshot) {
          const install = tree.has(p.pid) && p.pid !== unit.pid ? installCommand(p.command) : undefined
          const id = `${p.pid}|${p.created}`
          if (!install || seen.has(id)) continue
          seen.add(id)
          const text = `${install} (PID ${p.pid}) is running from a unit whose node_modules is a link (${fwd(link)}): it can delete and rewrite the linked folder.`
          try { appendLine(unit.statusFile, formatStatusLine('note', text, { key: 'deps-guard' })) } catch { /* inbox below */ }
          notify(unit.id, `${text} ${linkMessage(link, setup)}`)
        }
      }
    }
  }
}
