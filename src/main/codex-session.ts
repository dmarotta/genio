import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function cwdKey(cwd: string): string {
  // Codex may record Windows paths with either separator and drive casing.
  if (process.platform === 'win32' || /^[a-z]:[\\/]|^\\\\/i.test(cwd)) {
    return path.win32.resolve(cwd).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  }
  return path.resolve(cwd)
}

/** Discover only sessions whose metadata identifies this exact worktree.
 * Read only headers, not the potentially huge conversation transcripts.
 * Missing, unreadable or partially written files simply mean a fresh launch.
 */
export async function discoverCodexSession(
  cwd: string,
  codexHome?: string,
  preferredId?: string
): Promise<string | undefined> {
  const target = cwdKey(cwd)
  let latest: { id: string; timestamp: number } | undefined
  let preferred: string | undefined

  async function scan(dir: string): Promise<void> {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await scan(file)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const handle = await fs.open(file, 'r')
          let header: string
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
            header = Buffer.concat(chunks).toString('utf8')
          } finally { await handle.close() }
          const meta = JSON.parse(header)
          const p = meta?.payload
          if (meta?.type !== 'session_meta' || typeof p?.cwd !== 'string' || cwdKey(p.cwd) !== target) continue
          const id = p.id ?? p.session_id
          if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) continue
          // A remembered id is usable only while its cwd can still be verified.
          if (id === preferredId) preferred = id
          const parsed = Date.parse(p.timestamp ?? meta.timestamp)
          const timestamp = Number.isFinite(parsed) ? parsed : 0
          if (!latest || timestamp > latest.timestamp || (timestamp === latest.timestamp && id > latest.id)) {
            latest = { id, timestamp }
          }
        } catch { /* incomplete metadata or an inaccessible session */ }
      }
    }
  }

  await scan(path.join(codexHome?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions'))
  return preferred ?? latest?.id
}
