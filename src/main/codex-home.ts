/**
 * Genio's own Codex home (<main base>/codex-home). Every Codex process Genio
 * starts (units, Recons, the Codex chat, the usage probe, model discovery and
 * image generation) runs with CODEX_HOME pointing here, so its threads never
 * list in the player's Codex or ChatGPT apps, not even while they run.
 *
 * The player signs this home in once with their usual ChatGPT account (like a
 * second computer: same plan, no second subscription). It is an independent
 * login: Genio never copies or links the player's auth.json. Until it is
 * signed in with ChatGPT (an API-key login does not count), Codex is "needs
 * sign-in": no Codex process starts, and nothing ever runs against the
 * player's own ~/.codex login.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { settingsPath } from '@shared/settings-pages'
import { runCodexCli, type CodexCli } from './codex-archive'
import { spawnCodexChat, type CodexRpc, type CodexWireEvents } from './codex-chat-driver'
import { codexHomeDir, findCodexSessions } from './codex-session'
import { ensureDir, readText, stripAnsi, writeText } from './util'

/** The model a bare `codex` uses in Genio's home; units always pass their own. */
export const GENIO_CODEX_MODEL = 'gpt-6.1-sol'

export const genioCodexHomeDir = (mainRoot: string): string => path.join(mainRoot, 'codex-home')

// Units turn off by name every MCP server declared here or in a repository (unit-mcp.ts).
const SEED_HEADER = "# Genio's own Codex home. Sandbox and approvals come from Genio's launch flags;\n# no MCP servers or plugins. Sign-in: SYSTEMS > Accounts.\n"

const sameHome = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** True when config.toml sets `key` before its first table. */
function topLevelHas(toml: string, key: string): boolean {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return false
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) return true
  }
  return false
}

/**
 * The minimal config Codex needs here: a default model. Read-modify-write, so
 * whatever Codex itself adds (trust, notices) survives. No credential is ever
 * written or copied: the login comes only from the player signing in.
 */
export function seedCodexHome(dir: string): void {
  ensureDir(dir)
  const file = path.join(dir, 'config.toml')
  const raw = readText(file)
  if (topLevelHas(raw, 'model')) return
  writeText(file, `${raw.includes(SEED_HEADER) ? '' : SEED_HEADER}model = "${GENIO_CODEX_MODEL}"\n${raw ? `\n${raw}` : ''}`)
}

// ---------------------------------------------------------------- folder trust

const PROJECT_HEADER = /^\s*\[projects\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\]\s*$/

function headerPath(line: string): string | undefined {
  const m = PROJECT_HEADER.exec(line)
  if (!m) return undefined
  return m[1] ?? (JSON.parse(`"${m[2]}"`) as string)
}

const tomlKey = (p: string): string => (p.includes("'") || /[\r\n]/.test(p) ? JSON.stringify(p) : `'${p}'`)

/**
 * A folder as Codex keys its trust (verified on codex-cli 0.162.1: the match
 * ignores case, but a `\\?\` prefix or forward slashes never match): absolute,
 * no extended-length prefix, native separators, no trailing separator.
 */
export function codexTrustKey(p: string): string {
  let s = p.trim()
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) s = `\\\\${s.slice(8)}`
  else if (/^[\\/]{2}[?.][\\/]/.test(s)) s = s.slice(4)
  return path.resolve(s)
}

const sameFolder = (a: string, b: string): boolean => {
  const real = (p: string): string => { try { return fs.realpathSync.native(codexTrustKey(p)) } catch { return codexTrustKey(p) } }
  return sameHome(real(a), real(b))
}

/** The main checkout a git worktree belongs to, read the way Codex does (.git file, gitdir, commondir). */
function worktreeRepoRoot(worktree: string): string | undefined {
  try {
    const dotGit = path.join(worktree, '.git')
    if (fs.statSync(dotGit).isDirectory()) return worktree
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
    if (!m) return undefined
    const gitDir = path.resolve(worktree, m[1])
    const common = path.resolve(gitDir, readText(path.join(gitDir, 'commondir')).trim() || '.')
    return path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : undefined
  } catch {
    return undefined
  }
}

/**
 * The folders a Codex unit may be asked to trust: its own worktree and its
 * registered project's repository root (Codex applies trust to the root). The
 * root named by the worktree's own git link counts only when it is that same
 * registered folder (another spelling of it, a link to it); nothing else ever.
 */
export function codexUnitFolders(worktree: string, projectRoot?: string): string[] {
  const out = [worktree, projectRoot ?? ''].filter(Boolean).map(codexTrustKey)
  const linked = worktree && projectRoot ? worktreeRepoRoot(worktree) : undefined
  if (linked && sameFolder(linked, projectRoot!)) out.push(codexTrustKey(linked))
  return out.filter((p, i) => out.findIndex(x => sameHome(x, p)) === i)
}

/**
 * True when the folder Codex's trust dialog shows (whitespace-squashed, lower
 * case, maybe `~`-shortened) is one of `folders`: any separator, drive case,
 * `\\?\` prefix or trailing separator.
 */
export function isCodexUnitFolder(shown: string, folders: string[], home = os.homedir()): boolean {
  const norm = (p: string): string => p.replace(/\s+/g, '').toLowerCase().replace(/^[\\/]{2}[?.][\\/]/, '').replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const s = norm(shown.replace(/^~(?=[\\/]|$)/, () => home))
  return !!s && folders.some(f => norm(codexTrustKey(f)) === s)
}

/**
 * Pre-trust unit folders in Genio's config.toml (`[projects.'<path>'] trust_level`),
 * or drop them at despawn. A missing file is seeded first; a write failure
 * leaves the on-screen trust answer to watchConsent.
 */
export function setCodexTrust(dir: string, dirs: string[], trusted: boolean): void {
  try {
    const file = path.join(dir, 'config.toml')
    let lines = readText(file).split(/\r?\n/)
    let changed = false
    for (const d of dirs.filter(Boolean)) {
      const target = codexTrustKey(d)
      const start = lines.findIndex(l => { const p = headerPath(l); return p !== undefined && sameHome(codexTrustKey(p), target) })
      let end = start + 1
      while (start >= 0 && end < lines.length && !/^\s*\[/.test(lines[end])) end++
      if (trusted) {
        if (start < 0) {
          while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
          lines.push('', `[projects.${tomlKey(target)}]`, 'trust_level = "trusted"', '')
          changed = true
        } else {
          const body = lines.slice(start + 1, end)
          const at = body.findIndex(l => /^\s*trust_level\s*=/.test(l))
          if (at >= 0 && /"trusted"/.test(body[at])) continue
          if (at >= 0) body[at] = 'trust_level = "trusted"'
          else body.unshift('trust_level = "trusted"')
          lines = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)]
          changed = true
        }
      } else if (start >= 0) {
        lines.splice(start, end - start)
        changed = true
      }
    }
    if (changed) writeText(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'))
  } catch {
    /* the trust prompt is answered on screen */
  }
}

// ---------------------------------------------------------------- sign-in state

export interface CodexHomeState {
  /** Genio's home is signed in with ChatGPT and in use */
  ok: boolean
  state: 'signed-in' | 'signed-out' | 'error'
  /** why it is not in use (safe to show: never provider output) */
  reason?: string
  /** the Codex CLI itself is missing: nothing to warn about */
  missing?: boolean
}

/** `codex login status` output (verified on codex-cli 0.162: "Logged in using ChatGPT" / "Not logged in"). */
export function parseCodexHomeLogin(out: string, code: number | null): CodexHomeState {
  const txt = stripAnsi(out)
  if (code === 127) return { ok: false, state: 'error', reason: 'the Codex CLI was not found', missing: true }
  if (/not logged in/i.test(txt)) return { ok: false, state: 'signed-out', reason: "Genio's Codex is not signed in yet" }
  const m = /Logged in using\s+(.+)/i.exec(txt)
  if (m && /chatgpt/i.test(m[1])) return { ok: true, state: 'signed-in' }
  // An API key would bill credits instead of the plan: never used for Genio's home.
  if (m) return { ok: false, state: 'error', reason: "Genio's Codex is signed in with an API key, not a ChatGPT account" }
  return { ok: false, state: 'error', reason: 'codex login status gave no readable answer' }
}

/** `codex login status` inside `dir`. */
export async function preflightCodexHome(dir: string, cli: CodexCli = runCodexCli): Promise<CodexHomeState> {
  try {
    const r = await cli(['login', 'status'], dir)
    return parseCodexHomeLogin(`${r.stdout}\n${r.stderr}`, r.code)
  } catch {
    return { ok: false, state: 'error', reason: 'the Codex CLI could not run' }
  }
}

/** The signed-in account's email and plan through app-server account/read (no refresh, no thread). */
export async function readCodexAccount(dir: string, wire: (events: CodexWireEvents) => CodexRpc = ev => spawnCodexChat(ev, { CODEX_HOME: dir })): Promise<{ email?: string; plan?: string }> {
  let rpc: CodexRpc
  try {
    rpc = wire({ notification() {}, request: () => Promise.reject(new Error('unsupported')), closed() {} })
  } catch {
    return {}
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await rpc.request('initialize', { clientInfo: { name: 'genio_accounts', version: '1.0' } })
        rpc.notify('initialized', {})
        const account = (await rpc.request('account/read', { refreshToken: false })).account
        const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
        return { email: str(account?.email), plan: str(account?.planType) }
      })(),
      new Promise<{ email?: string; plan?: string }>(resolve => { timer = setTimeout(() => resolve({}), 15_000) })
    ])
  } catch {
    return {}
  } finally { clearTimeout(timer); rpc.close() }
}

// ---------------------------------------------------------------- the running app's home

export interface CodexHomeOptions {
  /** Genio's folder (genioCodexHomeDir(main base)). */
  dir: string
  /** Test seam; defaults to the real CLI. */
  cli?: CodexCli
}

let configured: (CodexHomeOptions & { ready?: Promise<CodexHomeState>; last?: CodexHomeState }) | undefined

export function configureCodexHome(opts: CodexHomeOptions | undefined): void {
  configured = opts && { ...opts }
}

/** Genio's Codex folder, when the app has one. */
export const genioCodexHome = (): string | undefined => configured?.dir

/** Forget the last answer (after a sign-in or sign-out). */
export function resetCodexHome(): void {
  if (!configured) return
  configured.ready = undefined
  configured.last = undefined
}

/**
 * Seed and check Genio's home once; the answer stands (no repeated probes)
 * until a sign-in or sign-out resets it, or a caller asks for a `fresh` check
 * (Accounts, the sign-in watch).
 */
export function codexHomeReady(fresh = false): Promise<CodexHomeState> {
  const c = configured
  if (!c) return Promise.resolve({ ok: false, state: 'error', reason: 'not configured' })
  if (fresh) c.ready = undefined
  c.ready ??= (async (): Promise<CodexHomeState> => {
    let result: CodexHomeState
    try {
      seedCodexHome(c.dir)
      result = await preflightCodexHome(c.dir, c.cli)
    } catch (e) {
      result = { ok: false, state: 'error', reason: (e as Error).message }
    }
    c.last = result
    return result
  })()
  return c.ready
}

/**
 * Genio's own Codex home is checked and is not signed in with ChatGPT (signed
 * out, or an API-key login). False while unchecked, with no Codex CLI, or when
 * the app has no Codex home: nothing can be signed in then.
 */
export const codexSignedOut = (): boolean => !!configured?.last && !configured.last.ok && !configured.last.missing

/** Why a Codex process was not started: Genio's own Codex home is not usable, so Codex is "needs sign-in". */
export class CodexNeedsSignIn extends Error {}

export interface CodexLaunch {
  /** Merge into the child's environment. */
  env: Record<string, string>
  /** Genio's own home is in use. */
  isolated: boolean
  /** The Codex home this launch reads and writes. */
  codexHome: string
}

const NEEDS_SIGN_IN = `Codex is not signed in. Open ${settingsPath('accounts')} and choose "Sign in Genio's Codex (same account)".`

/**
 * Where a Codex process should run: only Genio's own home, and only once it is
 * signed in with ChatGPT. Genio never falls back to the player's own Codex
 * login (it may be a dummy or API key, and its threads would show in the
 * player's Codex app): an unsigned home throws CodexNeedsSignIn before anything
 * starts. A unit resume follows its conversation: a thread that lives only in
 * another home (a unit from before Genio's home existed) resumes there, but
 * still only while Genio's home is signed in.
 */
export async function codexLaunch(o: { resume?: { cwd: string; home?: string } } = {}): Promise<CodexLaunch> {
  const c = configured
  if (!c) return { env: {}, isolated: false, codexHome: codexHomeDir() }
  const state = await codexHomeReady()
  if (!state.ok) throw new CodexNeedsSignIn(state.missing ? 'The Codex CLI was not found.' : NEEDS_SIGN_IN)
  if (o.resume) {
    const { cwd, home } = o.resume
    const elsewhere = home && !sameHome(home, c.dir) ? home
      : !home && !(await findCodexSessions(cwd, c.dir)).length ? codexHomeDir() : undefined
    if (elsewhere && (await findCodexSessions(cwd, elsewhere)).length) {
      return sameHome(elsewhere, codexHomeDir()) ? { env: {}, isolated: false, codexHome: elsewhere } : { env: { CODEX_HOME: elsewhere }, isolated: false, codexHome: elsewhere }
    }
  }
  return { env: { CODEX_HOME: c.dir }, isolated: true, codexHome: c.dir }
}

/** Shorthand for one-shots (usage probe, discovery, image generation) that never resume. */
export async function codexEnv(): Promise<Record<string, string>> {
  return (await codexLaunch()).env
}

/** Session folders Genio's usage scan reads: its own home, plus the player's for Genio threads from before it. */
export function codexHomes(): string[] {
  const homes = [codexHomeDir()]
  if (configured) homes.unshift(configured.dir)
  return homes.filter((h, i) => homes.findIndex(x => sameHome(x, h)) === i)
}
