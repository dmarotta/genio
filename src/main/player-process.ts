import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listProcesses } from '../../resources/unit-skills/genio/skills/play/scripts/pool.mjs'
import { unityEditorProject, unityVerifiedKillScript, type UnityProcess } from './unity-guards'
import { inspectDesktop, type DesktopApi, type EditorLaunch } from '../../resources/unit-skills/genio/lib/hidden-desktop.mjs'

const exec = promisify(execFile)
export interface PlayerProcess extends UnityProcess { workingSet?: number }
export interface PlayerSystem {
  list(): Promise<PlayerProcess[]>
  killVerified(p: PlayerProcess): Promise<boolean>
  memory(): { freeBytes: number; totalBytes: number }
  sleep(ms: number): Promise<void>
  now(): number
}
export const playerSystem: PlayerSystem = {
  async list() {
    const procs = await listProcesses()
    if (process.platform !== 'win32') return procs
    const script = 'Get-Process Unity -ErrorAction SilentlyContinue | ForEach-Object { "{0},{1}" -f $_.Id,$_.WorkingSet64 }'
    const sizes = new Map<number, number>()
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }).catch(() => ({ stdout: '' }))
    for (const line of stdout.trim().split(/\r?\n/)) { const [pid, bytes] = line.split(',').map(Number); if (pid && bytes) sizes.set(pid, bytes) }
    return procs.map(p => ({ ...p, workingSet: sizes.get(p.pid) }))
  },
  async killVerified(p) {
    if (process.platform !== 'win32' || !/^\d+$/.test(p.created)) return false
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(unityVerifiedKillScript(p), 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 })
    return stdout.trim() === 'killed'
  },
  memory: () => ({ freeBytes: os.freemem(), totalBytes: os.totalmem() }),
  sleep: ms => new Promise(r => setTimeout(r, ms)), now: Date.now
}
const canonical = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase()
export const sameProcess = (a: PlayerProcess, b: { pid: number; created: string }) => a.pid === b.pid && !!b.created && a.created === b.created
export const opensRoot = (p: PlayerProcess, root: string) => {
  const target = unityEditorProject(p.command)
  return !!target && canonical(target) === canonical(root)
}
/** Licensing clients and an editor opening another project are never adopted. */
export function playerTree(procs: PlayerProcess[], roots: PlayerProcess[], root: string): PlayerProcess[] {
  const out = new Map(roots.map(p => [p.pid, p]))
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs) {
      const parent = out.get(p.ppid)
      if (!parent || out.has(p.pid) || !/^\d+$/.test(p.created) || !/^\d+$/.test(parent.created) || BigInt(p.created) < BigInt(parent.created) ||
        /Unity\.Licensing\.Client/i.test(p.command) || unityEditorProject(p.command) && !opensRoot(p, root)) continue
      out.set(p.pid, p); grew = true
    }
  }
  return [...out.values()]
}
/** Root-based shutdown. Every force kill checks the creation time on the same OS handle used to kill. */
export async function closePlayerRoot(root: string, launch: EditorLaunch, tracked: PlayerProcess[], system: PlayerSystem, desktop: DesktopApi,
  quit: () => Promise<unknown>, graceMs = 30000, forceMs = 5000): Promise<{ closed: boolean; pids: number[]; reason?: string }> {
  const snapshot = await system.list()
  const editor = snapshot.find(p => sameProcess(p, launch) && opensRoot(p, root))
  let targets = playerTree(snapshot, [...tracked.filter(t => snapshot.some(p => sameProcess(p, t))), ...(editor ? [editor] : [])], root)
  const unverified = snapshot.filter(p => opensRoot(p, root) && !targets.some(t => sameProcess(p, t)))
  if (unverified.length) return { closed: false, pids: unverified.map(p => p.pid), reason: 'An editor using this copy could not be verified' }
  if (snapshot.some(p => p.pid === launch.pid && !p.command && sameProcess(p, launch))) return { closed: false, pids: [launch.pid], reason: 'The editor command line is unavailable' }
  if (editor) {
    try { await quit() } catch { /* WM_CLOSE follows */ }
    if (launch.desktop) await desktop.close(launch.desktop, editor.pid).catch(() => false)
  }
  const remaining = async () => {
    const current = await system.list()
    targets = playerTree(current, targets.map(t => current.find(p => sameProcess(p, t))).filter((p): p is PlayerProcess => !!p), root)
    return targets
  }
  const wait = async (ms: number) => {
    const deadline = system.now() + ms
    let nextWatch = system.now() + 2000
    while ((await remaining()).length) {
      if (system.now() >= deadline) return false
      if (system.now() >= nextWatch) { await inspectDesktop(desktop, launch, { benignOnly: true }).catch(() => {}); nextWatch = system.now() + 2000 }
      await system.sleep(250)
    }
    return true
  }
  if (await wait(graceMs)) return { closed: true, pids: [] }
  // Children before the root so import workers cannot outlive a forced editor shutdown.
  for (const p of [...targets].reverse()) await system.killVerified(p).catch(() => false)
  if (await wait(forceMs)) return { closed: true, pids: [] }
  return { closed: false, pids: targets.map(p => p.pid), reason: 'Unity processes survived a forced stop' }
}
