/**
 * Housekeeping, on the player's click only: hide the sessions Genio left in the
 * player's own Codex and Claude homes before it kept them out (codex-archive.ts,
 * claude-home.ts).
 *
 * - Codex: Genio's threads are archived with the official `codex archive`. One
 *   pilot goes first; if it still shows in Codex's thread list, nothing else is
 *   touched and the run reports why.
 * - Claude: Genio's folders in the player's projects/ move into Genio's own
 *   Claude home, where Genio still resumes them.
 *
 * Nothing is deleted. Every archive and move is written to a JSON manifest in
 * Genio's base before the next one starts, and Undo restores everything in it.
 * The shared history.jsonl and session_index.jsonl files are never edited.
 *
 * What counts as Genio's comes from where Genio ran sessions (its bases, unit
 * worktrees and data folders, its e2e temp folders) and from the originator
 * Genio's Codex chat sets, never from titles. Anything live is skipped: running
 * units, the current chat sessions, and Claude sessions in the live registry.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionCleanupItem, SessionCleanupPreview, SessionCleanupProgress, SessionCleanupResult } from '@shared/api'
import { claudeHomeDir, claudeHomeReady, playerClaudeDir } from './claude-home'
import { runCodexCli, type CodexCli } from './codex-archive'
import { spawnCodexChat, type CodexRpc, type CodexWireEvents } from './codex-chat-driver'
import { CODEX_THREAD_ID, codexHomeDir, codexRolloutState, readHeader } from './codex-session'
import type { AppCtx } from './services'
import { ensureDir, exists, nowIso, readJson, writeJsonAtomic } from './util'

/** The Codex chat's app-server client name (codex-chat-driver.ts), recorded as each thread's originator. */
export const GENIO_CHAT_ORIGINATOR = 'genio_chat'

export interface MigrationScope {
  /** Folders Genio ran sessions in: its bases, unit worktrees and data folders */
  genioRoots: string[]
  /** Path prefixes of Genio's temp folders (e2e runs) */
  genioPrefixes: string[]
  /** Exact working folders of sessions running now (units, live Claude registry) */
  liveCwds: string[]
  /** Session ids in use now (chat sessions, running units, live Claude registry) */
  liveSessionIds: string[]
  /** The player's Codex home */
  codexHome: string
  /** The player's Claude folder */
  claudeDir: string
  /** Genio's own Claude folder ('' when it is unavailable: Claude folders then stay) */
  genioClaudeDir: string
  manifestFile: string
}

export interface CodexCandidate { key: string; id: string; cwd: string; file: string }
export interface ClaudeCandidate { key: string; name: string; cwd: string; from: string; to: string; sessions: number }
export interface Skipped { key: string; label: string; reason: string }
export interface MigrationPlan { codex: CodexCandidate[]; claude: ClaudeCandidate[]; skipped: Skipped[] }

export interface ManifestItem {
  kind: 'codex-archive' | 'claude-move'
  /** Codex thread id or Claude folder name */
  id: string
  from: string
  to: string
  codexHome?: string
  /** claude-move: 'folder' renamed whole, 'entries' merged into an existing Genio folder */
  mode?: 'folder' | 'entries'
  entries?: string[]
  at: string
  restoredAt?: string
}
export interface Manifest { version: 1; items: ManifestItem[] }

export interface MigrationDeps {
  cli?: CodexCli
  /** Ids Codex's thread list shows (what the Codex app lists) */
  listVisible?: (codexHome: string) => Promise<string[]>
  onProgress?: (p: Omit<SessionCleanupProgress, 'running' | 'action'>) => void
}

// ---------------------------------------------------------------- paths

const win = process.platform === 'win32'
function key(p: string): string {
  if (win || /^[a-z]:[\\/]|^\\\\/i.test(p)) return path.win32.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return path.resolve(p).replace(/\/$/, '')
}
const under = (child: string, root: string): boolean => {
  const c = key(child), r = key(root)
  return c === r || c.startsWith(r + '/')
}

export function isGenioCwd(cwd: string, scope: Pick<MigrationScope, 'genioRoots' | 'genioPrefixes'>): boolean {
  return scope.genioRoots.some(r => under(cwd, r)) || scope.genioPrefixes.some(p => key(cwd).startsWith(key(p)))
}

/** A short label: the folder relative to the Genio root it is under. */
function label(cwd: string, scope: MigrationScope): string {
  const root = scope.genioRoots.filter(r => under(cwd, r)).sort((a, b) => b.length - a.length)[0]
  const rel = root ? path.relative(root, cwd) : ''
  return (rel || path.basename(cwd) || cwd).replace(/\\/g, '/')
}

// ---------------------------------------------------------------- manifest

export function readManifest(file: string): Manifest {
  const m = readJson<Partial<Manifest>>(file, {})
  return { version: 1, items: Array.isArray(m.items) ? m.items : [] }
}
const pendingItems = (m: Manifest): ManifestItem[] => m.items.filter(i => !i.restoredAt)

function addItem(file: string, item: ManifestItem): void {
  const m = readManifest(file)
  m.items.push(item)
  writeJsonAtomic(file, m)
}

function markRestored(file: string, item: ManifestItem, patch: Partial<ManifestItem> = {}): void {
  const m = readManifest(file)
  const i = m.items.findIndex(x => x.kind === item.kind && x.id === item.id && x.at === item.at)
  if (i >= 0) m.items[i] = { ...m.items[i], ...patch }
  writeJsonAtomic(file, m)
}

// ---------------------------------------------------------------- live sessions

/** Sessions the player's Claude registry lists with a process still running. */
export function liveClaudeSessions(claudeDir: string): { sessionId?: string; cwd?: string }[] {
  const dir = path.join(claudeDir, 'sessions')
  let names: string[]
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return [] }
  const out: { sessionId?: string; cwd?: string }[] = []
  for (const n of names) {
    const e = readJson<{ pid?: unknown; sessionId?: unknown; cwd?: unknown }>(path.join(dir, n), {})
    if (typeof e.pid !== 'number' || !pidAlive(e.pid)) continue
    out.push({ sessionId: typeof e.sessionId === 'string' ? e.sessionId : undefined, cwd: typeof e.cwd === 'string' ? e.cwd : undefined })
  }
  return out
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// ---------------------------------------------------------------- candidates

async function rolloutFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[]
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await rolloutFiles(p, out)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** The working folder a Claude transcript recorded first (lines carry `cwd`). */
function transcriptCwd(file: string): string | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(1024 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    const m = buf.subarray(0, n).toString('utf8').match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/)
    return m ? (JSON.parse(m[1]) as string) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Dry run: what a migration would archive and move now, and what it would leave alone. */
export async function planMigration(scope: MigrationScope): Promise<MigrationPlan> {
  const plan: MigrationPlan = { codex: [], claude: [], skipped: [] }
  const liveIds = new Set(scope.liveSessionIds)
  const liveCwds = new Set(scope.liveCwds.map(key))

  for (const file of await rolloutFiles(path.join(scope.codexHome, 'sessions'))) {
    let p: { id?: unknown; session_id?: unknown; cwd?: unknown; originator?: unknown }
    try {
      const meta = JSON.parse(await readHeader(file))
      if (meta?.type !== 'session_meta') continue
      p = meta.payload ?? {}
    } catch { continue }
    const id = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : ''
    const cwd = typeof p.cwd === 'string' ? p.cwd : ''
    if (!CODEX_THREAD_ID.test(id) || !cwd) continue
    if (!isGenioCwd(cwd, scope) && p.originator !== GENIO_CHAT_ORIGINATOR) continue
    const c = { key: `codex:${id}`, id, cwd, file }
    if (liveIds.has(id) || liveCwds.has(key(cwd))) plan.skipped.push({ key: c.key, label: `Codex · ${label(cwd, scope)}`, reason: 'running now' })
    else plan.codex.push(c)
  }

  const projects = path.join(scope.claudeDir, 'projects')
  let dirs: fs.Dirent[] = []
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()) } catch { /* no projects yet */ }
  for (const d of dirs) {
    const from = path.join(projects, d.name)
    let files: string[]
    try { files = fs.readdirSync(from).filter(f => f.endsWith('.jsonl')) } catch { continue }
    const cwds = files.map(f => transcriptCwd(path.join(from, f))).filter((c): c is string => !!c)
    // Whose it is must be readable from every transcript; a folder with any other cwd is the player's.
    if (!cwds.length || cwds.length !== files.length || !cwds.every(c => isGenioCwd(c, scope))) continue
    const c: ClaudeCandidate = { key: `claude:${d.name}`, name: d.name, cwd: cwds[0], from, to: scope.genioClaudeDir ? path.join(scope.genioClaudeDir, 'projects', d.name) : '', sessions: files.length }
    const lbl = `Claude · ${label(c.cwd, scope)}`
    if (files.some(f => liveIds.has(f.slice(0, -'.jsonl'.length))) || cwds.some(x => liveCwds.has(key(x)))) plan.skipped.push({ key: c.key, label: lbl, reason: 'running now' })
    else if (!scope.genioClaudeDir) plan.skipped.push({ key: c.key, label: lbl, reason: "Genio's own Claude folder is unavailable" })
    else plan.claude.push(c)
  }
  return plan
}

// ---------------------------------------------------------------- run

/** Move a Claude folder into Genio's home: whole when free, else entry by entry next to what Genio already has there. */
function moveFolder(from: string, to: string): { mode: 'folder' | 'entries'; entries?: string[]; conflicts: string[] } {
  if (!exists(to)) {
    ensureDir(path.dirname(to))
    fs.renameSync(from, to)
    return { mode: 'folder', conflicts: [] }
  }
  const entries: string[] = [], conflicts: string[] = []
  for (const e of fs.readdirSync(from)) {
    if (exists(path.join(to, e))) { conflicts.push(e); continue }
    try { fs.renameSync(path.join(from, e), path.join(to, e)); entries.push(e) } catch { conflicts.push(e) }
  }
  return { mode: 'entries', entries, conflicts }
}

function archivedPath(file: string, codexHome: string): string {
  return path.join(codexHome, 'archived_sessions', path.basename(file))
}

const emptyResult = (manifest: string): SessionCleanupResult => ({ ok: true, message: '', archived: 0, moved: 0, restored: 0, skipped: [], manifest })

/**
 * Archive and move the planned items whose keys the player confirmed (all when
 * `keys` is omitted). The plan is taken again first, so anything that went live
 * since the preview is left alone.
 */
export async function runMigration(scope: MigrationScope, keys: string[] | undefined, deps: MigrationDeps = {}): Promise<SessionCleanupResult> {
  const cli = deps.cli ?? runCodexCli
  const listVisible = deps.listVisible ?? listVisibleCodexThreads
  const want = keys ? new Set(keys) : undefined
  const plan = await planMigration(scope)
  const codex = plan.codex.filter(c => !want || want.has(c.key))
  const claude = plan.claude.filter(c => !want || want.has(c.key))
  const result = emptyResult(scope.manifestFile)
  const total = codex.length + claude.length
  let done = 0
  const step = (s: string): void => deps.onProgress?.({ step: s, done, total })

  if (codex.length) {
    let visible: Set<string> | undefined
    step('Reading Codex thread list')
    try { visible = new Set(await listVisible(scope.codexHome)) } catch (e) {
      result.aborted = `Could not read Codex's thread list (${(e as Error).message}), so no Codex thread was archived.`
    }
    if (visible) {
      // The pilot is a thread the Codex app shows now, so its disappearance proves the rest will go too.
      const order = [...codex.filter(c => visible.has(c.id)), ...codex.filter(c => !visible.has(c.id))]
      let piloted = false
      for (const c of order) {
        step(piloted ? `Archiving Codex threads` : 'Archiving one Codex thread first (pilot)')
        const outcome = await archiveThread(c, scope, cli)
        done++
        if (outcome !== 'archived') {
          result.skipped.push({ label: `Codex · ${label(c.cwd, scope)}`, reason: outcome === 'open' ? 'open in Codex' : 'already gone' })
          continue
        }
        result.archived++
        if (piloted) continue
        piloted = true
        step('Checking that the pilot left the Codex app')
        let still = true
        try { still = (await listVisible(scope.codexHome)).includes(c.id) } catch { /* unreadable: treat as not verified */ }
        if (still) {
          result.aborted = 'The pilot thread was archived but Codex still lists it, so no other Codex thread was touched. Undo restores the pilot.'
          done = codex.length
          break
        }
      }
    } else {
      done += codex.length
    }
  }

  for (const c of claude) {
    step('Moving Claude conversations into Genio\'s folder')
    const lbl = `Claude · ${label(c.cwd, scope)}`
    try {
      const moved = moveFolder(c.from, c.to)
      if (moved.mode === 'folder' || moved.entries?.length) {
        addItem(scope.manifestFile, { kind: 'claude-move', id: c.name, from: c.from, to: c.to, mode: moved.mode, entries: moved.entries, at: nowIso() })
        result.moved++
      }
      if (moved.conflicts.length) result.skipped.push({ label: lbl, reason: `${moved.conflicts.length} item(s) already in Genio's folder or in use, left in place` })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      result.skipped.push({ label: lbl, reason: code === 'EXDEV' ? "on another drive than Genio's folder" : 'in use' })
    }
    done++
  }
  step('Done')
  for (const s of plan.skipped) if (!want || want.has(s.key)) result.skipped.push({ label: s.label, reason: s.reason })
  result.ok = !result.aborted
  result.message = summary(result, 'hide')
  return result
}

async function archiveThread(c: CodexCandidate, scope: MigrationScope, cli: CodexCli): Promise<'archived' | 'open' | 'gone'> {
  if (await codexRolloutState(c.id, scope.codexHome) !== 'live') return 'gone'
  await cli(['archive', c.id], scope.codexHome)
  // Exit codes are ambiguous (live, open or unknown): where the rollout is now decides.
  const after = await codexRolloutState(c.id, scope.codexHome)
  if (after === 'archived') {
    addItem(scope.manifestFile, { kind: 'codex-archive', id: c.id, from: c.file, to: archivedPath(c.file, scope.codexHome), codexHome: scope.codexHome, at: nowIso() })
    return 'archived'
  }
  return after === 'live' ? 'open' : 'gone'
}

// ---------------------------------------------------------------- undo

/** Put back everything the manifest lists as archived or moved and not yet restored. */
export async function undoMigration(manifestFile: string, deps: Pick<MigrationDeps, 'cli' | 'onProgress'> = {}): Promise<SessionCleanupResult> {
  const cli = deps.cli ?? runCodexCli
  const items = pendingItems(readManifest(manifestFile)).reverse()
  const result = emptyResult(manifestFile)
  let done = 0
  for (const item of items) {
    deps.onProgress?.({ step: item.kind === 'codex-archive' ? 'Unarchiving Codex threads' : 'Moving Claude conversations back', done, total: items.length })
    const lbl = item.kind === 'codex-archive' ? `Codex thread ${item.id}` : `Claude folder ${item.id}`
    const problem = item.kind === 'codex-archive' ? await restoreThread(item, cli) : restoreFolder(item)
    if (problem) result.skipped.push({ label: lbl, reason: problem })
    else {
      markRestored(manifestFile, item, { restoredAt: nowIso() })
      result.restored++
    }
    done++
  }
  deps.onProgress?.({ step: 'Done', done, total: items.length })
  result.ok = !result.skipped.length
  result.message = summary(result, 'undo')
  return result
}

async function restoreThread(item: ManifestItem, cli: CodexCli): Promise<string | undefined> {
  const home = codexHomeDir(item.codexHome)
  const state = await codexRolloutState(item.id, home)
  if (state === 'live') return undefined // already back (a respawn unarchives its thread)
  if (state === 'missing') return 'its rollout file is gone'
  await cli(['unarchive', item.id], home)
  return (await codexRolloutState(item.id, home)) === 'live' ? undefined : 'Codex refused to unarchive it'
}

function restoreFolder(item: ManifestItem): string | undefined {
  try {
    if (item.mode === 'folder') {
      if (!exists(item.to)) return exists(item.from) ? undefined : 'its folder is gone'
      if (!exists(item.from)) {
        ensureDir(path.dirname(item.from))
        fs.renameSync(item.to, item.from)
        return undefined
      }
    }
    // Merge back entry by entry: what the player's folder already has again is never overwritten.
    const names = item.mode === 'folder' ? fs.readdirSync(item.to) : (item.entries ?? []).filter(e => exists(path.join(item.to, e)))
    ensureDir(item.from)
    const left: string[] = []
    for (const e of names) {
      if (exists(path.join(item.from, e))) { left.push(e); continue }
      try { fs.renameSync(path.join(item.to, e), path.join(item.from, e)) } catch { left.push(e) }
    }
    return left.length ? `${left.length} item(s) could not move back (in use, or the same name is there again)` : undefined
  } catch {
    return 'in use'
  }
}

function summary(r: SessionCleanupResult, action: 'hide' | 'undo'): string {
  const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`
  const parts = action === 'hide'
    ? [`Archived ${n(r.archived, 'Codex thread')}`, `moved ${n(r.moved, 'Claude folder')}`]
    : [`Restored ${n(r.restored, 'item')}`]
  if (r.skipped.length) parts.push(`left ${r.skipped.length} alone`)
  return parts.join(', ') + '.' + (r.aborted ? ` ${r.aborted}` : '')
}

// ---------------------------------------------------------------- Codex thread list

/**
 * The thread ids Codex lists as not archived, read from the state DB the way
 * the Codex app reads it, through a short-lived app-server. No thread is started.
 */
export async function listVisibleCodexThreads(codexHome: string, wire: (events: CodexWireEvents) => CodexRpc = ev => spawnCodexChat(ev, { CODEX_HOME: codexHome })): Promise<string[]> {
  const rpc = wire({ notification() {}, request: () => Promise.reject(new Error('unsupported')), closed() {} })
  try {
    await rpc.request('initialize', { clientInfo: { name: 'genio_housekeeping', version: '1.0' } })
    rpc.notify('initialized', {})
    const ids: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 200; page++) {
      const r = await rpc.request('thread/list', { useStateDbOnly: true, archived: false, modelProviders: [], limit: 100, ...(cursor ? { cursor } : {}) })
      for (const t of Array.isArray(r.data) ? r.data : []) if (typeof t?.id === 'string') ids.push(t.id)
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
      if (!cursor) break
    }
    return ids
  } finally { rpc.close() }
}

// ---------------------------------------------------------------- the running app

interface WkspState { providers?: { ids?: Record<string, string> }; botProviders?: { ids?: Record<string, string> }; sessionId?: string; botSessionId?: string }

/** Where Genio ran sessions and what is live now, from Genio's own registries. */
export function migrationScope(ctx: AppCtx): MigrationScope {
  const main = ctx.main.home
  const homes = [...ctx.homes.values()]
  const tasks = homes.flatMap(h => h.crew.list())
  const roots = new Set<string>([main.root, ...homes.map(h => h.home.root), ...ctx.allies.list().map(a => a.home), ...tasks.map(t => t.worktree).filter(Boolean)])
  const liveTasks = tasks.filter(t => t.state === 'spawning' || (t.terminalId && ctx.terminals.get(t.terminalId)?.alive))
  const liveCwds = liveTasks.map(t => t.worktree).filter(Boolean)
  const liveIds = liveTasks.map(t => t.codexSessionId).filter((x): x is string => !!x)
  for (const h of homes) {
    const m = readJson<WkspState>(h.home.wkspFile, {})
    liveIds.push(...Object.values(m.providers?.ids ?? {}), ...Object.values(m.botProviders?.ids ?? {}))
    if (m.sessionId) liveIds.push(m.sessionId)
    if (m.botSessionId) liveIds.push(m.botSessionId)
  }
  const claudeDir = playerClaudeDir()
  for (const s of liveClaudeSessions(claudeDir)) {
    if (s.sessionId) liveIds.push(s.sessionId)
    if (s.cwd) liveCwds.push(s.cwd)
  }
  return {
    genioRoots: [...roots],
    genioPrefixes: [path.join(os.tmpdir(), 'genio-e2e-')],
    liveCwds,
    liveSessionIds: liveIds.filter(x => typeof x === 'string' && x),
    codexHome: codexHomeDir(),
    claudeDir,
    genioClaudeDir: claudeHomeDir(main.root),
    manifestFile: path.join(main.data, 'session-migration.json')
  }
}

let progress: SessionCleanupProgress = { running: false, step: '', done: 0, total: 0 }

async function appScope(ctx: AppCtx): Promise<MigrationScope> {
  const scope = migrationScope(ctx)
  // Folders only move where Genio can resume them: its own Claude folder must work.
  if (!(await claudeHomeReady()).ok) scope.genioClaudeDir = ''
  return scope
}

function item(app: 'codex' | 'claude', key: string, lbl: string, detail: string): SessionCleanupItem {
  return { key, app, label: lbl, detail }
}

export async function sessionCleanupPreview(ctx: AppCtx): Promise<SessionCleanupPreview> {
  const scope = await appScope(ctx)
  const plan = await planMigration(scope)
  return {
    codex: plan.codex.map(c => item('codex', c.key, label(c.cwd, scope), c.id)),
    claude: plan.claude.map(c => item('claude', c.key, label(c.cwd, scope), `${c.sessions} conversation${c.sessions === 1 ? '' : 's'}`)),
    skipped: plan.skipped.map(s => ({ ...item(s.key.startsWith('codex:') ? 'codex' : 'claude', s.key, s.label, ''), reason: s.reason })),
    undoable: pendingItems(readManifest(scope.manifestFile)).length,
    manifest: scope.manifestFile
  }
}

export const sessionCleanupProgress = (): SessionCleanupProgress => ({ ...progress })

async function exclusive(action: 'hide' | 'undo', fn: (onProgress: MigrationDeps['onProgress']) => Promise<SessionCleanupResult>): Promise<SessionCleanupResult> {
  if (progress.running) throw new Error('Housekeeping is already running.')
  progress = { running: true, action, step: 'Starting', done: 0, total: 0 }
  try {
    return await fn(p => { progress = { running: true, action, ...p } })
  } finally {
    progress = { ...progress, running: false }
  }
}

export function sessionCleanupRun(ctx: AppCtx, keys: string[]): Promise<SessionCleanupResult> {
  return exclusive('hide', async onProgress => runMigration(await appScope(ctx), keys, { onProgress }))
}

export function sessionCleanupUndo(ctx: AppCtx): Promise<SessionCleanupResult> {
  return exclusive('undo', onProgress => undoMigration(migrationScope(ctx).manifestFile, { onProgress }))
}
