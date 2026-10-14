/**
 * Keep finished Codex units out of the player's Codex app: archive their
 * threads with the official `codex archive` once the unit is despawned.
 *
 * Archiving only moves the rollout into $CODEX_HOME/archived_sessions and flags
 * the thread; nothing is ever deleted. Codex refuses a thread that is still
 * live or open (exit 1) and Genio never forces it: such ids wait in a retry
 * list. Every archive and unarchive Genio performs is appended to a manifest,
 * so `codex unarchive <id>` reverses it.
 */
import path from 'node:path'
import { CODEX_THREAD_ID, codexHomeDir, codexRolloutState, findCodexSessions } from './codex-session'
import { appendLine, nowIso, readJson, run, runShell, which, writeJson, type ExecResult } from './util'

/** Runs one Codex CLI command against a Codex home (tests substitute a fake). */
export type CodexCli = (args: string[], codexHome?: string) => Promise<ExecResult>

export interface ArchiveOptions {
  /** Genio's main data folder: manifest and retry list live here */
  dataDir: string
  codexHome?: string
  task?: string
  cwd?: string
  cli?: CodexCli
}

export interface ArchiveEntry {
  at: string
  action: 'archive' | 'unarchive'
  id: string
  codexHome: string
  task?: string
  cwd?: string
}

export interface PendingArchive {
  id: string
  codexHome: string
  task?: string
  cwd?: string
  attempts: number
  since: string
}

export interface ArchiveResult {
  archived: string[]
  /** live or open in Codex: kept in the retry list */
  pending: string[]
  /** already archived elsewhere, or gone */
  skipped: string[]
}

/** Retries happen after these delays; Genio's next start retries whatever is left. */
export const ARCHIVE_DELAYS_MS = [5_000, 60_000, 5 * 60_000, 30 * 60_000]
/** A thread kept open in the Codex app is retried this often before Genio lets it be. */
export const MAX_ARCHIVE_ATTEMPTS = 20

export const manifestFile = (dataDir: string): string => path.join(dataDir, 'codex-archive.jsonl')
export const pendingFile = (dataDir: string): string => path.join(dataDir, 'codex-archive-pending.json')

export const runCodexCli: CodexCli = async (args, codexHome) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  if (codexHome) env.CODEX_HOME = codexHome
  const timeoutMs = 60_000
  // Same override as the image helper: a .js stand-in runs under this Node (or Electron as Node).
  const bin = process.env.GENIO_CODEX_BIN?.trim()
  if (bin && /\.[cm]?js$/i.test(bin)) return run(process.execPath, [bin, ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs, input: '' })
  delete env.ELECTRON_RUN_AS_NODE
  const file = bin || which('codex')
  if (!file) return { code: 127, stdout: '', stderr: 'Codex CLI is not installed' }
  // Arguments are a subcommand and a validated thread id: safe for the npm .cmd shim's shell.
  // stdin closed: Codex never waits for piped input.
  return /\.(cmd|bat)$/i.test(file) ? runShell(`"${file}" ${args.join(' ')}`, { env, timeoutMs, input: '' }) : run(file, args, { env, timeoutMs, input: '' })
}

// One manifest and retry list per data folder, shared by every base in this process.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const sameHome = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const readPending = (dataDir: string): PendingArchive[] => readJson<PendingArchive[]>(pendingFile(dataDir), [])

function record(dataDir: string, e: Omit<ArchiveEntry, 'at'>): void {
  appendLine(manifestFile(dataDir), JSON.stringify({ at: nowIso(), ...e }))
}

async function archiveOne(id: string, home: string, o: ArchiveOptions, cli: CodexCli): Promise<'archived' | 'pending' | 'skipped'> {
  const before = await codexRolloutState(id, home)
  if (before !== 'live') return 'skipped'
  const r = await cli(['archive', id], home)
  // Exit 1 is ambiguous (live, open, unknown or already archived): the rollout's place decides.
  const after = r.code === 0 ? 'archived' : await codexRolloutState(id, home)
  if (after === 'archived') {
    record(o.dataDir, { action: 'archive', id, codexHome: home, task: o.task, cwd: o.cwd })
    return 'archived'
  }
  return after === 'live' ? 'pending' : 'skipped'
}

/** Archive these threads now; the ones Codex refuses (still live or open) join the retry list. */
export function archiveCodexThreads(ids: string[], o: ArchiveOptions): Promise<ArchiveResult> {
  return serial(async () => {
    const home = codexHomeDir(o.codexHome)
    const cli = o.cli ?? runCodexCli
    const result: ArchiveResult = { archived: [], pending: [], skipped: [] }
    const pending = readPending(o.dataDir)
    for (const id of [...new Set(ids)]) {
      if (!CODEX_THREAD_ID.test(id)) continue
      const outcome = await archiveOne(id, home, o, cli)
      result[outcome].push(id)
      const i = pending.findIndex(p => p.id === id && sameHome(p.codexHome, home))
      if (outcome === 'pending') {
        if (i < 0) pending.push({ id, codexHome: home, task: o.task, cwd: o.cwd, attempts: 1, since: nowIso() })
        else pending[i] = { ...pending[i], attempts: pending[i].attempts + 1 }
      } else if (i >= 0) {
        pending.splice(i, 1)
      }
    }
    const kept = pending.filter(p => p.attempts < MAX_ARCHIVE_ATTEMPTS)
    if (JSON.stringify(kept) !== JSON.stringify(readPending(o.dataDir))) writeJson(pendingFile(o.dataDir), kept)
    return result
  })
}

/** Archive every live thread Codex recorded for this unit worktree. */
export async function archiveUnitThreads(cwd: string, o: Omit<ArchiveOptions, 'cwd'>): Promise<ArchiveResult> {
  const live = (await findCodexSessions(cwd, o.codexHome)).filter(s => !s.archived).map(s => s.id)
  return archiveCodexThreads(live, { ...o, cwd })
}

/** Try the retry list again (Genio start, and after a despawn). */
export async function retryPendingArchives(dataDir: string, cli?: CodexCli): Promise<ArchiveResult> {
  const result: ArchiveResult = { archived: [], pending: [], skipped: [] }
  // Entries keep their task and cwd for the manifest.
  for (const p of readPending(dataDir)) {
    const r = await archiveCodexThreads([p.id], { dataDir, codexHome: p.codexHome, task: p.task, cwd: p.cwd, cli })
    for (const k of ['archived', 'pending', 'skipped'] as const) result[k].push(...r[k])
  }
  return result
}

/**
 * Archive a despawned unit's threads once its process has had time to exit,
 * then retry what Codex refused. Timers never keep Genio alive.
 */
export function scheduleUnitArchive(cwd: string, o: Omit<ArchiveOptions, 'cwd'>, delays = ARCHIVE_DELAYS_MS): void {
  const [first, ...rest] = delays
  if (first === undefined) return
  const later = (ms: number, fn: () => Promise<unknown>): void => {
    const timer = setTimeout(() => { void fn().catch(() => undefined) }, ms)
    timer.unref?.()
  }
  const retry = (left: number[]): void => {
    const [ms, ...next] = left
    if (ms === undefined) return
    later(ms, async () => {
      if ((await retryPendingArchives(o.dataDir, o.cli)).pending.length) retry(next)
    })
  }
  later(first, async () => {
    if ((await archiveUnitThreads(cwd, o)).pending.length) retry(rest)
  })
}

/**
 * Before resuming an archived thread: `codex unarchive` it (Codex refuses to
 * resume archived threads) and drop it from the retry list so it stays visible
 * to the unit. Returns false when the thread is still archived.
 */
export function unarchiveCodexThread(id: string, o: ArchiveOptions): Promise<boolean> {
  return serial(async () => {
    if (!CODEX_THREAD_ID.test(id)) return false
    const home = codexHomeDir(o.codexHome)
    const pending = readPending(o.dataDir)
    const kept = pending.filter(p => !(p.id === id && sameHome(p.codexHome, home)))
    if (kept.length !== pending.length) writeJson(pendingFile(o.dataDir), kept)
    if (await codexRolloutState(id, home) !== 'archived') return true
    await (o.cli ?? runCodexCli)(['unarchive', id], home)
    if (await codexRolloutState(id, home) !== 'live') return false
    record(o.dataDir, { action: 'unarchive', id, codexHome: home, task: o.task, cwd: o.cwd })
    return true
  })
}
