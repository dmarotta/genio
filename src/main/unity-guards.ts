/** Unit Unity guards: denial at launch/tool use and ancestry-proven editor detection. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { UnityUnitConfig } from './unity-unit'
import { GUARD_MATCHER, RULE, canonicalPath, leasedUnityRoots, loadGuardConfig, playerUnityRoots, rawUnityReason, recordUnityIncident, unityPoolPaths } from '../../resources/unit-skills/genio/lib/unity-guard.mjs'
import { listProcesses } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { stripAnsi } from './util'

const exec = promisify(execFile)
export const unityGuardScript = (plugin: string): string => path.join(plugin, 'lib/unity-guard-hook.mjs')
const shQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

/** The real CLI was resolved before this PATH is applied. Neither shim ever resolves bare unity. */
export function installUnityShims(dir: string, wrapper: string, guard: string, inheritedPath: string): Record<string, string> {
  for (const file of [wrapper, guard]) if (!fs.existsSync(file)) throw new Error(`Unity guard launch file is missing: ${file}`)
  fs.mkdirSync(dir, { recursive: true })
  // A literal % in a batch-file path must not become an environment expansion.
  const batchPath = (s: string): string => s.replace(/%/g, '%%')
  for (const [name, file, args] of [['genio-unity', wrapper, ''], ['unity', guard, '--shim ']]) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\nnode "${batchPath(file)}" ${args}%*\r\nexit /b %errorlevel%\r\n`)
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node ${shQuote(file)} ${args}"$@"\n`, { mode: 0o755 })
  }
  return { PATH: dir + path.delimiter + inheritedPath }
}

export function unityPreToolHook(script: string) {
  return { matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: 'node', args: [script], timeout: 10, onFailure: 'block' }] }
}

export interface UnityProcess { pid: number; ppid: number; created: string; command: string }
export interface UnityWatchRoot { pid: number; startedAt: number; spawnedAt: number; config: UnityUnitConfig; statusFile: string; isLive(): boolean }
export interface UnityWatchSystem {
  list(): Promise<UnityProcess[]>
  /** Must check the process creation identity again using the same OS handle used to kill. Never a tree kill. */
  killVerified(process: UnityProcess): Promise<boolean>
}

/** CIM dates have microsecond precision; StartTime's FILETIME also carries a final 100 ns digit. */
export function unityVerifiedKillScript(p: UnityProcess): string {
  if (!Number.isInteger(p.pid) || p.pid <= 0 || !/^\d+$/.test(p.created)) throw new Error('Invalid process identity')
  const microseconds = BigInt(p.created) / 10n
  // Numeric-only interpolation. Open the handle BEFORE reading StartTime and keep it through Kill.
  return `$ErrorActionPreference='Stop'; try { $target=Get-Process -Id ${p.pid}; $null=$target.Handle; $birth=[decimal]::Floor(([decimal]($target.StartTime.ToFileTimeUtc())) / 10); if ($birth -eq [decimal]'${microseconds}') { $target.Kill(); 'killed' } } catch { }`
}

const windowsSystem: UnityWatchSystem = {
  list: listProcesses,
  async killVerified(p) {
    if (process.platform !== 'win32' || !Number.isInteger(p.pid) || p.pid <= 0 || !/^\d+$/.test(p.created)) return false
    const script = unityVerifiedKillScript(p)
    const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000 })
    return r.stdout.trim() === 'killed'
  }
}
const sameProcess = (a: UnityProcess, b: UnityProcess): boolean => a.pid === b.pid && !!a.created && a.created === b.created
const born = (p: UnityProcess): bigint | undefined => /^\d+$/.test(p.created) ? BigInt(p.created) : undefined
const fileTime = (ms: number): bigint => BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n
const executable = (command: string): string => command.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) ?? ''
// The CLI re-runs its own binary for helpers: --internal-auth-broker-serve (license, test) and --internal-msix-repair.
const cliInvocation = (command: string): boolean => /^(?:\s*"[^"]+"|\s*'[^']+'|\s*\S+)\s+(?:status|license|auth|editors|install|setup|mcp|run|test|build|recompile|open|close|command|list|job|pipeline|--version|--help|--internal-[\w-]+)(?:\s|$)/i.test(command)
/** The Store-installed CLI's real binary, which the WindowsApps alias in the config never names. */
const cliPackaged = (exe: string): boolean => /[\\/]WindowsApps[\\/]UnityTechnologies\.UnityCLI_[^\\/]+[\\/]app[\\/]unity\.exe$/i.test(exe)

export function unityEditorProject(command: string): string | undefined {
  const m = command.match(/(?:^|\s)-projectPath(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i)
  return m?.[1] ?? m?.[2] ?? m?.[3]
}

/** A wrapper-recorded slot editor belongs to the pool after keep/release or a handoff to the player. */
function poolOwnsEditor(c: UnityUnitConfig, target: string | undefined, p: UnityProcess): boolean {
  if (!target) return false
  try {
    const { dir, copies } = unityPoolPaths(c)
    const id = Array.from({ length: 8 }, (_, n) => n + 1).find(n => canonicalPath(path.join(copies, `slot-${n}`, c.engineRoot)) === target)
    if (!id) return false
    let state
    try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) }
    catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT' } // A busy/corrupt pool snapshot cannot justify stopping its editor.
    if (!state || !Array.isArray(state.slots)) return true
    const slot = state.slots?.find((s: { id: number }) => s.id === id)
    if (slot?.editor?.pid !== p.pid) return false
    // A launch recorded with its creation time (hidden-desktop launches) must be that exact process.
    if (typeof slot.editor.created === 'string' && /^\d+$/.test(slot.editor.created)) return slot.editor.created === p.created
    return Number.isFinite(slot.editor.at) && born(p)! <= fileTime(slot.editor.at + 1)
  } catch { return false }
}

/** Ownership is remembered by PID + creation time across detach/reparent, never inferred from a project path. */
export function createUnityProcessWatch(system: UnityWatchSystem = windowsSystem) {
  const owned = new Map<number, { process: UnityProcess; root: UnityWatchRoot }>()
  let busy = false, stopped = false, generation = 0
  return {
    stop(): void { stopped = true; generation++; owned.clear() },
    start(): void { stopped = false; generation++ },
    async poll(roots: UnityWatchRoot[], notify: (task: string, message: string) => void): Promise<void> {
      if (busy || stopped || !roots.length && !owned.size) return
      busy = true
      const current = generation
      try {
        const snapshot = await system.list()
        if (stopped || current !== generation) return
        const byPid = new Map(snapshot.map(p => [p.pid, p]))
        for (const [pid, tracked] of owned) if (!byPid.has(pid) || !sameProcess(byPid.get(pid)!, tracked.process)) owned.delete(pid)
        for (const root of roots) {
          const p = byPid.get(root.pid), created = p && born(p)
          // A terminal PID alone is not proof: it must have been born during that terminal's spawn.
          if (root.isLive() && p && created !== undefined && created >= fileTime(root.startedAt - 1) && created <= fileTime(root.spawnedAt + 1)) owned.set(p.pid, { process: p, root })
        }
        let grew = true
        while (grew) {
          grew = false
          for (const p of snapshot) {
            const parent = owned.get(p.ppid), created = born(p)
            if (owned.has(p.pid) || !parent || created === undefined || created < born(parent.process)!) continue
            owned.set(p.pid, { process: p, root: parent.root }); grew = true
          }
        }
        for (const tracked of owned.values()) {
          const p = byPid.get(tracked.process.pid)!, c = tracked.root.config
          const exe = executable(p.command)
          if (!/(?:^|[\\/])Unity(?:\.exe)?$/i.test(exe) || c.cli && canonicalPath(exe) === canonicalPath(c.cli)) continue
          const project = unityEditorProject(p.command)
          // The WindowsApps alias can report a different executable path. Its CLI verbs are not editor launches.
          if (!project && (cliPackaged(exe) || !/[\\/]Editor[\\/]Unity\.exe$/i.test(exe) && cliInvocation(p.command))) continue
          const target = project && path.isAbsolute(project) ? canonicalPath(project) : undefined
          const main = canonicalPath(path.join(c.play.world, c.engineRoot))
          const own = canonicalPath(path.join(c.worktree, c.engineRoot))
          const player = target && playerUnityRoots(c).includes(target)
          if (!player && target !== main && poolOwnsEditor(c, target, p)) continue
          const allowed = leasedUnityRoots(c, { isAlive: pid => byPid.has(pid) })
          if (!player && target && target !== main && (target === own || allowed.includes(target))) continue
          // Refresh before termination: a moved target or reused PID never inherits a kill decision.
          const refreshed = await system.list()
          const fresh = refreshed.find(q => q.pid === p.pid)
          if (stopped || current !== generation || !fresh || !sameProcess(fresh, p) || fresh.command !== p.command) continue
          const stillPlayer = target && playerUnityRoots(c).includes(target)
          if (!stillPlayer && target !== main && poolOwnsEditor(c, target, fresh)) continue
          if (!stillPlayer && target && target !== main && leasedUnityRoots(c, { isAlive: pid => refreshed.some(q => q.pid === pid) }).includes(target)) continue
          const killed = await system.killVerified(fresh)
          if (!killed) continue
          const reason = `Stopped unit-spawned Unity editor outside your allowed targets (PID ${p.pid}, project ${(project ?? 'unspecified').replace(/[\r\n]/g, ' ')}). ${RULE}`
          // Command line and parent let a later review tell a raw launch from a wrapper's own child.
          try { recordUnityIncident(c, { layer: 'watch', pid: p.pid, ppid: p.ppid, created: p.created, project, command: p.command.slice(0, 1000), parent: byPid.get(p.ppid)?.command.slice(0, 1000), reason }) } catch { /* still notify the unit */ }
          try { fs.appendFileSync(tracked.root.statusFile, `note [key=unity-guard]: ${reason}\n`) } catch { /* inbox remains available */ }
          notify(c.task, reason)
        }
      } finally { busy = false }
    }
  }
}

/** Audit only command-shaped log lines; brief wording and wrapper result records are not attempts. */
export function unityLogAudit(log: string): string[] {
  const findings = new Set<string>()
  for (const line of stripAnsi(log).split(/\r?\n/)) {
    const text = line.trim().replace(/^[●•⏺▶›]\s*/, '')
    const call = text.match(/^(?:Bash|PowerShell)\((.*)\)\s*$/)
    const prompted = /^(?:[$>]\s*|PS [^>]+>\s*|(?:Bash|PowerShell):\s*)/.test(text)
    const command = call?.[1] ?? text.replace(/^(?:[$>]\s*|PS [^>]+>\s*|(?:Bash|PowerShell):\s*)/, '')
    if (!call && !prompted && !/^(?:&\s*|(?:call|exec|start(?:-process)?|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|node(?:\.exe)?)\s+|["']?(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\n]*Unity(?: Hub)?(?:\.exe)?|unity(?:\.exe|\.cmd|\.bat)?\b)/i.test(command)) continue
    const reason = rawUnityReason(command)
    if (reason) findings.add(`Raw Unity command in unit terminal log: ${command.slice(0, 400)}. ${RULE}`)
  }
  return [...findings].slice(0, 20)
}

/** Durable incidents survive terminal trimming and restarts; audit each new incident once per fix round. */
export function unitUnityAudit(configFile: string, terminalLog: string): string[] {
  let c: UnityUnitConfig
  try { c = loadGuardConfig(configFile) } catch { return unityLogAudit(terminalLog) }
  // A repaired unit must not fail every future round for the same historical log line.
  const cursorFile = path.join(c.runs, 'guard-audit-cursor.json')
  const hash = (s: string): string => createHash('sha256').update(s).digest('hex')
  let cursor: { terminal?: { length: number; hash: string }; incidents?: { length: number; hash: string } } = {}
  try { cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')) } catch { /* first round */ }
  const unread = (log: string, previous?: { length: number; hash: string }): number =>
    previous && Number.isInteger(previous.length) && previous.length >= 0 && log.length >= previous.length && hash(log.slice(0, previous.length)) === previous.hash ? previous.length : 0
  const findings = unityLogAudit(terminalLog.slice(unread(terminalLog, cursor.terminal)))
  let incidents = ''
  try {
    incidents = fs.readFileSync(path.join(c.runs, 'guard-incidents.jsonl'), 'utf8')
    // A writer can be mid-append. Keep the last incomplete line for the next audit.
    incidents = incidents.slice(0, incidents.lastIndexOf('\n') + 1)
    for (const line of incidents.slice(unread(incidents, cursor.incidents)).split('\n')) {
      try {
        const incident = JSON.parse(line)
        if (incident.schema === 'genio.unity-guard.v1') findings.push(`Unity ${incident.layer} guard: ${incident.reason}`)
      } catch { /* partial or malformed record */ }
    }
  } catch { /* no incidents */ }
  fs.mkdirSync(c.runs, { recursive: true })
  fs.writeFileSync(cursorFile, JSON.stringify({ terminal: { length: terminalLog.length, hash: hash(terminalLog) }, incidents: { length: incidents.length, hash: hash(incidents) } }))
  return [...new Set(findings)].slice(0, 20)
}
