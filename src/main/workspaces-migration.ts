/**
 * Moves an existing base's `wksps/` folder to `workspaces/` (one rename, same volume), then repairs
 * every absolute path that pointed into the old folder. New bases are created as `workspaces/`.
 *
 * Safety rules:
 * - runs only when no unit process is alive, and never when `workspaces/` already exists;
 * - never deletes anything: a refusal leaves both folders and records one quiet warning;
 * - a checkpoint of every small state/data file it may rewrite is copied to
 *   `<base>/backups/workspaces-migration/` first, with a manifest, so `restoreWorkspaces` can undo it;
 * - idempotent: an interrupted run resumes at the repair phase, a finished one does nothing;
 * - Claude transcripts (keyed by working directory) are copied, never moved, inside Genio's own
 *   claude-home. The player's own Claude folder is only read, to count sessions that live there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { claudeHomeDir, claudeProjectName, playerClaudeDir } from './claude-home'
import { ensureDir, exists, nowIso, readJson, writeJson } from './util'

export const LEGACY_WORKSPACES_DIR = 'wksps'
export const WORKSPACES_DIR = 'workspaces'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const BACKUP_DIR = path.join('backups', 'workspaces-migration')
const MANIFEST = 'manifest.json'
/** A unit in these states with a live pid is running. */
const FINISHED = new Set(['done', 'merged', 'failed', 'cleaned', 'exited'])

export interface MigrationManifest {
  version: 1
  phase: 'checkpointed' | 'renamed' | 'done' | 'restored'
  startedAt: string
  completedAt?: string
  restoredAt?: string
  /** Files copied before any change, relative to the base (as they were under wksps/). */
  backedUp: string[]
  rewritten: string[]
  /** Records that could not be rewritten; reads fall back to the old path form for these. */
  unrewritten: string[]
  repos: { repo: string; worktrees: string[]; ok: boolean }[]
  transcriptsCopied: string[]
  /** Claude sessions for the old folder that exist only in the player's own Claude folder (left untouched). */
  playerFolderSessions: string[]
  warnings: string[]
}

export type MigrationResult =
  | { status: 'none' }
  | { status: 'done'; manifest: MigrationManifest }
  | { status: 'deferred'; reason: string }
  | { status: 'blocked'; reason: string }

export interface MigrationOptions {
  warn?: (message: string) => void
  /** Test seam; defaults to process.kill(pid, 0). */
  pidAlive?: (pid: number) => boolean
  /** Test seam for `git worktree repair`; defaults to the git on PATH. */
  gitRepair?: (repo: string, worktrees: string[]) => boolean
  /** The player's Claude folder, only read. Defaults to playerClaudeDir(). */
  playerClaude?: string
}

const stateDir = (root: string): string => path.join(root, BACKUP_DIR)
const manifestFile = (root: string): string => path.join(stateDir(root), MANIFEST)

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SEP = '(?:\\\\\\\\|\\\\|/)'

/** Matches `<base>/wksps` in any slash style (JSON-escaped too), and any `.genio/wksps`, as a whole segment. */
function legacyPattern(root: string): RegExp {
  const segs = path.resolve(root).split(/[\\/]+/).filter(Boolean)
  const base = segs.map(escapeRe).join(SEP)
  const lead = path.resolve(root).startsWith('/') ? '/' : ''
  return new RegExp(`(?:${lead}${base}|\\.genio)${SEP}wksps(?![A-Za-z0-9_-])`, 'gi')
}

/** `…/wksps/…` → `…/workspaces/…` for a base, in the same slash style; text without the old form is returned as is. */
export function rewriteLegacyPaths(text: string, root: string): string {
  return text.replace(legacyPattern(root), (m) => m.slice(0, -LEGACY_WORKSPACES_DIR.length) + WORKSPACES_DIR)
}

/**
 * The transition read: a stored path in the old form is mapped to the new folder when only the new
 * one exists. Anything else is returned unchanged.
 */
export function modernPath<T extends string | undefined>(root: string, p: T): T {
  if (!p) return p
  if (exists(p)) return p
  const next = rewriteLegacyPaths(p, root)
  return (next !== p && exists(next) ? next : p) as T
}

/** The old form of a path under the base's workspaces folder, for finding records a session keyed by the old working directory. */
export function legacyPath(root: string, p: string): string {
  const base = path.resolve(root)
  const rel = path.relative(path.join(base, WORKSPACES_DIR), p)
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : path.join(base, LEGACY_WORKSPACES_DIR, rel)
}

function workspaceNames(root: string, dir: string): string[] {
  try { return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
}

function walk(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const file = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0 && e.name !== 'node_modules' && !e.name.endsWith('.inbox')) walk(file, depth - 1, out)
    } else if (e.isFile() && (e.name.endsWith('.json') || e.name === 'brief.md' || e.name === 'inbox.md')) {
      out.push(file)
    }
  }
}

/** Files that store paths: records in config/, data/ and state/ of the base and each workspace, plus Genio's own Claude and Codex config. */
function recordFiles(root: string, workspacesDir: string): string[] {
  const bases = [root, ...workspaceNames(root, workspacesDir).map(n => path.join(root, workspacesDir, n))]
  const files: string[] = []
  for (const b of bases) for (const d of ['config', 'data', 'state']) walk(path.join(b, d), 3, files)
  for (const f of [path.join(claudeHomeDir(root), '.claude.json'), path.join(claudeHomeDir(root), 'settings.json'), path.join(root, 'codex-home', 'config.toml')]) {
    if (exists(f)) files.push(f)
  }
  return files.filter(f => { try { return fs.statSync(f).size <= MAX_FILE_BYTES } catch { return false } })
}

/** Whether any unit process recorded in the base's task files is still alive. */
function runningUnit(root: string, pidAlive: (pid: number) => boolean): string | undefined {
  const bases = [root, ...workspaceNames(root, LEGACY_WORKSPACES_DIR).map(n => path.join(root, LEGACY_WORKSPACES_DIR, n))]
  for (const b of bases) {
    const tasks = readJson<{ id?: string; pid?: number; state?: string }[]>(path.join(b, 'state', 'tasks.json'), [])
    if (!Array.isArray(tasks)) continue
    for (const t of tasks) if (t && typeof t.pid === 'number' && !FINISHED.has(String(t.state)) && pidAlive(t.pid)) return t.id ?? String(t.pid)
  }
  return undefined
}

function defaultGitRepair(repo: string, worktrees: string[]): boolean {
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'repair', ...worktrees], { stdio: 'pipe', timeout: 60_000, windowsHide: true })
    return true
  } catch { return false }
}

/** Linked worktrees under workspaces/<name>/worktrees/<project>/<id>, grouped by the repository their .git file names. */
function worktreesByRepo(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const name of workspaceNames(root, WORKSPACES_DIR)) {
    const wt = path.join(root, WORKSPACES_DIR, name, 'worktrees')
    for (const project of workspaceNames(path.join(root, WORKSPACES_DIR, name), 'worktrees')) {
      for (const id of workspaceNames(wt, project)) {
        const dir = path.join(wt, project, id)
        try {
          const m = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)
          if (!m) continue
          const gitdir = path.resolve(m[1].trim())
          // <repo>/.git/worktrees/<name>
          const repo = path.dirname(path.dirname(path.dirname(gitdir)))
          out.set(repo, [...(out.get(repo) ?? []), dir])
        } catch { /* not a linked worktree */ }
      }
    }
  }
  return out
}

function registeredRepos(root: string): string[] {
  const dirs = [root, ...workspaceNames(root, WORKSPACES_DIR).map(n => path.join(root, WORKSPACES_DIR, n))]
  const repos = new Set<string>()
  for (const d of dirs) {
    const projects = readJson<{ path?: string }[]>(path.join(d, 'data', 'projects.json'), [])
    if (Array.isArray(projects)) for (const p of projects) if (p?.path && exists(path.join(p.path, '.git'))) repos.add(path.resolve(p.path))
  }
  return [...repos]
}

/** Copy Claude transcript folders keyed by a working directory inside the old folder to the new folder's names. Never overwrites, never deletes. */
function copyTranscripts(root: string, playerClaude: string, manifest: MigrationManifest): void {
  const oldName = claudeProjectName(path.join(root, LEGACY_WORKSPACES_DIR)).toLowerCase()
  const newName = claudeProjectName(path.join(root, WORKSPACES_DIR))
  const own = path.join(claudeHomeDir(root), 'projects')
  const scan = (projects: string): string[] => {
    try {
      return fs.readdirSync(projects).filter(d => { const l = d.toLowerCase(); return l === oldName || l.startsWith(`${oldName}-`) })
    } catch { return [] }
  }
  for (const d of scan(own)) {
    const target = newName + d.slice(oldName.length)
    if (target.length > 200) { manifest.warnings.push(`A long conversation folder was left under its old name: ${d.slice(0, 60)}…`); continue }
    const to = path.join(own, target)
    if (exists(to)) continue
    try { fs.cpSync(path.join(own, d), to, { recursive: true, errorOnExist: true, force: false }); manifest.transcriptsCopied.push(target) } catch (e) {
      manifest.warnings.push(`Could not copy a conversation folder (${(e as Error).message})`)
    }
  }
  // Read only: sessions that exist solely in the player's own Claude folder are reported, never moved.
  for (const d of scan(path.join(playerClaude, 'projects'))) {
    if (!exists(path.join(own, newName + d.slice(oldName.length)))) manifest.playerFolderSessions.push(d)
  }
}

function save(root: string, m: MigrationManifest): void {
  writeJson(manifestFile(root), m)
}

/** The one startup entry point. Safe to call on every start. */
export function migrateWorkspaces(root: string, opts: MigrationOptions = {}): MigrationResult {
  root = path.resolve(root)
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const oldDir = path.join(root, LEGACY_WORKSPACES_DIR), newDir = path.join(root, WORKSPACES_DIR)
  const prior = readJson<MigrationManifest | undefined>(manifestFile(root), undefined)
  if (prior?.phase === 'restored') return { status: 'none' }

  const interrupted = prior && (prior.phase === 'renamed' || prior.phase === 'checkpointed') && !exists(oldDir) && exists(newDir)
  if (!exists(oldDir) && !interrupted) return { status: 'none' }
  if (exists(oldDir) && exists(newDir)) {
    const reason = `Both "${LEGACY_WORKSPACES_DIR}" and "${WORKSPACES_DIR}" exist in ${root}; nothing was moved.`
    if (prior?.warnings?.includes(reason)) return { status: 'blocked', reason }
    warn(reason)
    const m: MigrationManifest = prior ?? { version: 1, phase: 'checkpointed', startedAt: nowIso(), backedUp: [], rewritten: [], unrewritten: [], repos: [], transcriptsCopied: [], playerFolderSessions: [], warnings: [] }
    ensureDir(stateDir(root)); m.warnings.push(reason); save(root, m)
    return { status: 'blocked', reason }
  }

  let manifest: MigrationManifest
  if (interrupted) {
    manifest = prior
  } else {
    const live = runningUnit(root, opts.pidAlive ?? defaultPidAlive)
    if (live) return { status: 'deferred', reason: `unit ${live} is running` }
    manifest = { version: 1, phase: 'checkpointed', startedAt: nowIso(), backedUp: [], rewritten: [], unrewritten: [], repos: [], transcriptsCopied: [], playerFolderSessions: [], warnings: [] }
    // 1. durable checkpoint of every file that may be rewritten
    const backup = path.join(stateDir(root), 'files')
    for (const f of recordFiles(root, LEGACY_WORKSPACES_DIR)) {
      const rel = path.relative(root, f)
      ensureDir(path.dirname(path.join(backup, rel)))
      fs.copyFileSync(f, path.join(backup, rel))
      manifest.backedUp.push(rel)
    }
    save(root, manifest)
    // 2. the move
    try { fs.renameSync(oldDir, newDir) } catch (e) {
      const reason = `Could not move "${LEGACY_WORKSPACES_DIR}" to "${WORKSPACES_DIR}" (${(e as Error).message}); nothing was changed.`
      warn(reason); manifest.warnings.push(reason); save(root, manifest)
      return { status: 'blocked', reason }
    }
    manifest.phase = 'renamed'; save(root, manifest)
  }

  // 3. rewrite stored absolute paths
  manifest.rewritten = []; manifest.unrewritten = []
  for (const f of recordFiles(root, WORKSPACES_DIR)) {
    try {
      const text = fs.readFileSync(f, 'utf8')
      const next = rewriteLegacyPaths(text, root)
      if (next === text) continue
      fs.writeFileSync(f, next, 'utf8')
      manifest.rewritten.push(path.relative(root, f))
    } catch { manifest.unrewritten.push(path.relative(root, f)) }
  }
  // 4. git worktree registrations
  const repair = opts.gitRepair ?? defaultGitRepair
  manifest.repos = []
  const grouped = worktreesByRepo(root)
  for (const repo of registeredRepos(root)) if (!grouped.has(repo)) grouped.set(repo, [])
  for (const [repo, worktrees] of grouped) manifest.repos.push({ repo, worktrees, ok: exists(repo) && repair(repo, worktrees) })
  for (const r of manifest.repos) if (!r.ok) manifest.warnings.push(`git worktree repair did not finish for ${r.repo}`)
  // 5. conversations keyed by the old working directories
  manifest.transcriptsCopied = []; manifest.playerFolderSessions = []
  copyTranscripts(root, opts.playerClaude ?? playerClaudeDir(), manifest)

  manifest.phase = 'done'; manifest.completedAt = nowIso(); save(root, manifest)
  for (const w of manifest.warnings) warn(w)
  return { status: 'done', manifest }
}

/**
 * Undo a finished migration (documented in docs/development.md): moves workspaces/ back to wksps/,
 * puts the checkpointed files back and re-points the git worktrees. Needed only to go back to a Genio
 * build that still uses wksps/. Refuses when wksps/ exists. The transcript copies are left in place.
 */
export function restoreWorkspaces(root: string, opts: Pick<MigrationOptions, 'gitRepair'> = {}): { ok: boolean; message: string } {
  root = path.resolve(root)
  const manifest = readJson<MigrationManifest | undefined>(manifestFile(root), undefined)
  if (!manifest) return { ok: false, message: 'No migration checkpoint found.' }
  const oldDir = path.join(root, LEGACY_WORKSPACES_DIR), newDir = path.join(root, WORKSPACES_DIR)
  if (exists(oldDir)) return { ok: false, message: `"${LEGACY_WORKSPACES_DIR}" already exists; nothing was changed.` }
  if (exists(newDir)) {
    try { fs.renameSync(newDir, oldDir) } catch (e) { return { ok: false, message: `Could not move "${WORKSPACES_DIR}" back (${(e as Error).message}).` } }
  }
  const backup = path.join(stateDir(root), 'files')
  for (const rel of manifest.backedUp) {
    try { fs.copyFileSync(path.join(backup, rel), path.join(root, rel)) } catch { /* the file is gone; the rename already restored the rest */ }
  }
  const repair = opts.gitRepair ?? defaultGitRepair
  for (const r of manifest.repos) {
    const back = r.worktrees.map(w => path.join(root, LEGACY_WORKSPACES_DIR, path.relative(newDir, w)))
    if (exists(r.repo)) repair(r.repo, back)
  }
  manifest.phase = 'restored'; manifest.restoredAt = nowIso(); save(root, manifest)
  return { ok: true, message: `Restored "${LEGACY_WORKSPACES_DIR}" from the checkpoint.` }
}
