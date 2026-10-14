import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** The Codex home a unit or probe uses: an explicit one, $CODEX_HOME, or ~/.codex. */
export function codexHomeDir(codexHome?: string): string {
  return codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
}

/** Rollout folders: live threads under sessions/YYYY/MM/DD, archived ones flat in archived_sessions/. */
export const CODEX_SESSION_DIRS = ['sessions', 'archived_sessions'] as const

/** Codex thread ids are UUIDs; anything else (`--last`, a session name) is never passed on. */
export const CODEX_THREAD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

function cwdKey(cwd: string): string {
  // Codex may record Windows paths with either separator and drive casing.
  if (process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(cwd)) {
    return path.win32.resolve(cwd).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  }
  return path.resolve(cwd)
}

export interface CodexSessionFile {
  id: string
  /** creation time from the session metadata (0 when unknown) */
  timestamp: number
  archived: boolean
  file: string
}

/** A rollout's first line (its session_meta), however long. */
export async function readHeader(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const chunks: Buffer[] = []
    // Metadata can include lengthy instructions, so the first line
    // may span several chunks. Stop at its newline, not a fixed size.
    for (;;) {
      const buffer = Buffer.alloc(16 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      const end = chunk.indexOf(10)
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end))
      if (end >= 0) break
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await handle.close() }
}

/** Every session, live or archived, whose metadata identifies this exact worktree.
 * Read only headers, not the potentially huge conversation transcripts.
 * Missing, unreadable or partially written files are skipped.
 */
export async function findCodexSessions(cwd: string, codexHome?: string): Promise<CodexSessionFile[]> {
  const target = cwdKey(cwd)
  const found: CodexSessionFile[] = []

  async function scan(dir: string, archived: boolean): Promise<void> {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await scan(file, archived)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const meta = JSON.parse(await readHeader(file))
          const p = meta?.payload
          if (meta?.type !== 'session_meta' || typeof p?.cwd !== 'string' || cwdKey(p.cwd) !== target) continue
          const id = p.id ?? p.session_id
          if (typeof id !== 'string' || !CODEX_THREAD_ID.test(id)) continue
          const parsed = Date.parse(p.timestamp ?? meta.timestamp)
          found.push({ id, timestamp: Number.isFinite(parsed) ? parsed : 0, archived, file })
        } catch { /* incomplete metadata or an inaccessible session */ }
      }
    }
  }

  const home = codexHomeDir(codexHome)
  for (const dir of CODEX_SESSION_DIRS) await scan(path.join(home, dir), dir === 'archived_sessions')
  return found
}

/** Discover only sessions whose metadata identifies this exact worktree,
 * archived ones included (resume unarchives them first).
 */
export async function discoverCodexSession(
  cwd: string,
  codexHome?: string,
  preferredId?: string
): Promise<string | undefined> {
  let latest: CodexSessionFile | undefined
  for (const s of await findCodexSessions(cwd, codexHome)) {
    // A remembered id is usable only while its cwd can still be verified.
    if (s.id === preferredId) return s.id
    if (!latest || s.timestamp > latest.timestamp || (s.timestamp === latest.timestamp && s.id > latest.id)) latest = s
  }
  return latest?.id
}

/** Where a thread's rollout is now: under sessions/ (live), archived_sessions/, or nowhere. */
export async function codexRolloutState(id: string, codexHome?: string): Promise<'live' | 'archived' | 'missing'> {
  const home = codexHomeDir(codexHome)
  const suffix = `-${id}.jsonl`
  const hit = async (dir: string): Promise<boolean> => {
    try {
      return (await fs.readdir(dir, { recursive: true })).some(rel => String(rel).endsWith(suffix))
    } catch { return false }
  }
  if (await hit(path.join(home, 'archived_sessions'))) return 'archived'
  if (await hit(path.join(home, 'sessions'))) return 'live'
  return 'missing'
}
