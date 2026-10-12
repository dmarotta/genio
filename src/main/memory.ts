import path from 'node:path'
import type { MemoryFile } from '@shared/api'
import type { Home } from './home'
import type { AppCtx, MemoryService } from './services'
import { readText, todayStamp, writeText, exists } from './util'

/**
 * Memory (companion /stow, Genio /save). Three human-editable files:
 *   player.md         Player Profile (base-local)
 *   player-shared.md  inherited by allies (main base only; read-only to allies)
 *   lore.md           curated squad knowledge
 * Tier markers on entries: <!--P--> pinned, <!--a:DATE--> aging (stale after
 * 30 days), <!--p:DATE--> perishable (stale after 7 days). Unmarked entries in
 * player files count as pinned.
 */

export const AGING_DAYS = 30
export const PERISHABLE_DAYS = 7
export const DEFAULT_BUDGET = 7500

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4)

const MARKER = /<!--\s*(a|p):\s*(\d{4}-\d{2}-\d{2})\s*-->/i

/** Entries (non-empty, non-heading lines) whose aging/perishable marker has expired. */
export function findStale(text: string, now = new Date()): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(MARKER)
    if (!m) continue
    const kind = m[1].toLowerCase()
    const when = new Date(`${m[2]}T00:00:00Z`)
    if (Number.isNaN(when.getTime())) continue
    const ageDays = (now.getTime() - when.getTime()) / 86_400_000
    if ((kind === 'a' && ageDays > AGING_DAYS) || (kind === 'p' && ageDays > PERISHABLE_DAYS)) out.push(line.trim())
  }
  return out
}

/** Remove the given entries (matched by trimmed line) from text. Returns [newText, removed]. */
export function removeEntries(text: string, entries: string[]): [string, string[]] {
  const want = new Set(entries.map((e) => e.trim()).filter(Boolean))
  const removed: string[] = []
  const kept = text.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    if (t && want.has(t)) {
      removed.push(t)
      return false
    }
    return true
  })
  return [kept.join('\n'), removed]
}

function fileFor(home: Home, which: MemoryFile): string {
  switch (which) {
    case 'player':
      return home.playerFile
    case 'player-shared':
      return home.playerSharedFile
    case 'lore':
      return home.loreFile
  }
}

export function createMemoryService(getCtx: () => AppCtx): MemoryService {
  const defaultHome = (): Home => getCtx().main.home
  const budget = (): number => {
    try {
      return getCtx().settings.get().memoryBudgetTokens || DEFAULT_BUDGET
    } catch {
      return DEFAULT_BUDGET
    }
  }
  const archiveFile = (home: Home): string => path.join(home.data, 'memory-archive.md')

  const svc: MemoryService = {
    read(which, home = defaultHome()) {
      return readText(fileFor(home, which))
    },
    write(which, content, home = defaultHome()) {
      if (which === 'player-shared' && !home.isMain) {
        throw new Error('player-shared.md belongs to the main base; allies can only read it')
      }
      writeText(fileFor(home, which), content.endsWith('\n') ? content : content + '\n')
    },
    report(home = defaultHome()) {
      const files: { file: string; tokens: number }[] = []
      const stale: string[] = []
      const list: MemoryFile[] = ['player', 'player-shared', 'lore']
      for (const which of list) {
        const p = fileFor(home, which)
        if (!exists(p)) continue
        const txt = readText(p)
        files.push({ file: path.basename(p), tokens: estimateTokens(txt) })
        for (const s of findStale(txt)) stale.push(`${path.basename(p)}: ${s}`)
      }
      const tokens = files.reduce((a, f) => a + f.tokens, 0)
      const b = budget()
      return { tokens, budget: b, overBudget: tokens > b, stale, files }
    },
    archive(entries, reason, home = defaultHome()) {
      if (!entries.length) return
      const sections: string[] = []
      const editable: MemoryFile[] = home.isMain ? ['player', 'player-shared', 'lore'] : ['player', 'lore']
      let remaining = entries.map((e) => e.replace(/^[^:]+\.md:\s*/, '').trim())
      for (const which of editable) {
        const p = fileFor(home, which)
        if (!exists(p) || !remaining.length) continue
        const [next, removed] = removeEntries(readText(p), remaining)
        if (removed.length) {
          writeText(p, next)
          sections.push(...removed.map((r) => `- ${r.replace(/^[-*]\s*/, '')}  _(from ${path.basename(p)})_`))
          remaining = remaining.filter((e) => !removed.includes(e))
        }
      }
      for (const r of remaining) sections.push(`- ${r.replace(/^[-*]\s*/, '')}  _(not found in source files)_`)
      const prev = readText(archiveFile(home), '# Memory archive\n\nCold entries removed by /save, with provenance.\n')
      writeText(archiveFile(home), `${prev.trimEnd()}\n\n## ${todayStamp()} save\n\nReason: ${reason}\n\n${sections.join('\n')}\n`)
    }
  }
  return svc
}
