/**
 * Genio's own Claude Code config folder (<main base>/claude-home). Every Claude
 * process Genio starts (units, Recons, the chat and Bot, the usage probe, model
 * discovery, the Gauntlet review) runs with CLAUDE_CONFIG_DIR pointing here, so
 * its transcripts (projects/), prompt history (history.jsonl), live registry
 * (sessions/) and .claude.json never reach the player's own Claude folder and
 * never show in the player's Claude apps.
 *
 * The login is reused in place, never copied: CLAUDE_SECURESTORAGE_CONFIG_DIR
 * names the player's folder, where Claude keeps its credentials. That variable
 * is undocumented (Agent SDK plumbing), so an `auth status` preflight checks it
 * once per Genio start. If it ever fails, Genio falls back to the player's
 * normal home and says so; a Claude update can never silently break units.
 *
 * Inside this home units do not see the player's own MCP servers or plugins.
 * Genio's unit skills still arrive explicitly through --plugin-dir.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, fwd, readJson, readText, run, runShell, which, writeJson, writeText } from './util'

/** Session markers a parent Claude session leaks; a unit must never inherit them (CHILD_SESSION turns transcripts off). */
export const UNIT_UNSET_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_*']

export const claudeHomeDir = (mainRoot: string): string => path.join(mainRoot, 'claude-home')

/** The player's own Claude folder: their CLAUDE_CONFIG_DIR, else ~/.claude. */
export function playerClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() ? path.resolve(env.CLAUDE_CONFIG_DIR.trim()) : path.join(os.homedir(), '.claude')
}

/** The player's global config: inside their CLAUDE_CONFIG_DIR when set, else ~/.claude.json. */
export function playerClaudeJson(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() ? path.join(playerClaudeDir(env), '.claude.json') : path.join(os.homedir(), '.claude.json')
}

/** The environment that moves a Claude process into `dir` while keeping the player's login. */
export function isolatedEnv(dir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: playerClaudeDir(env) }
}

/** True only when the player already accepted the bypass-permissions warning in their own settings. */
export function playerSkipsBypassPrompt(env: NodeJS.ProcessEnv = process.env): boolean {
  return readJson<{ skipDangerousModePermissionPrompt?: unknown }>(path.join(playerClaudeDir(env), 'settings.json'), {}).skipDangerousModePermissionPrompt === true
}

/**
 * Onboarding done and the player's theme, so a unit TUI opens straight at the
 * prompt. Read-modify-write: Claude's own keys in Genio's files survive. Only
 * the theme is read from the player's settings; no credential is copied.
 */
export function seedClaudeHome(dir: string, version?: string, env: NodeJS.ProcessEnv = process.env): void {
  ensureDir(dir)
  const cfgFile = path.join(dir, '.claude.json')
  const cfg = readJson<Record<string, unknown>>(cfgFile, {})
  const nextCfg = { ...cfg, hasCompletedOnboarding: true, ...(version ? { lastOnboardingVersion: version } : {}) }
  if (JSON.stringify(nextCfg) !== JSON.stringify(cfg)) writeText(cfgFile, JSON.stringify(nextCfg, null, 2))
  const settingsFile = path.join(dir, 'settings.json')
  const settings = readJson<Record<string, unknown>>(settingsFile, {})
  const theme = readJson<{ theme?: unknown }>(path.join(playerClaudeDir(env), 'settings.json'), {}).theme
  const want = typeof theme === 'string' && theme ? theme : settings.theme ?? 'dark'
  if (settings.theme !== want) writeJson(settingsFile, { ...settings, theme: want })
}

/**
 * Pre-accept Claude Code's folder-trust prompt for unit worktrees in `cfgFile`
 * (keys use forward slashes), or drop the entries at despawn so the file does
 * not accumulate dead paths. Read-modify-write, atomic; a missing or empty
 * file is left alone (the on-screen answer covers it).
 */
export function setClaudeTrust(cfgFile: string, dirs: string[], trusted: boolean): void {
  try {
    const raw = readText(cfgFile)
    if (!raw.trim()) return
    const data = JSON.parse(raw) as { projects?: Record<string, Record<string, unknown>> }
    data.projects ??= {}
    let changed = false
    for (const d of dirs) {
      const key = fwd(path.resolve(d))
      if (trusted) {
        const cur = data.projects[key] ?? {}
        if (cur.hasTrustDialogAccepted !== true) {
          data.projects[key] = { ...cur, hasTrustDialogAccepted: true }
          changed = true
        }
      } else if (data.projects[key]) {
        delete data.projects[key]
        changed = true
      }
    }
    if (changed) writeText(cfgFile, JSON.stringify(data, null, 2))
  } catch {
    /* fall back to the on-screen answer in watchConsent */
  }
}

/** The window "Keep auto (1m tokens)" keeps: Claude's own default for 1M-context models. */
const AUTO_COMPACT_KEEP_TOKENS = 1_000_000

/**
 * Answer Claude Code's "We recommend compacting earlier" offer in `cfgFile`
 * before a unit meets it: the offer waits at a turn end for a key, and a unit
 * stuck there reads no pings and never resumes. Claude skips the offer once
 * autoCompactOffer[account][model] holds an answer; "keep" is what the
 * "Keep auto (1m tokens)" choice writes and changes no setting, so the default
 * automatic window stays. Covers `models` for the signed-in account and every
 * offer Claude already recorded unanswered. Read-modify-write, atomic; a
 * missing or empty file is left alone (crew answers the offer on screen too).
 */
export function answerAutoCompactOffer(cfgFile: string, models: string[], now = Date.now()): void {
  try {
    const raw = readText(cfgFile)
    if (!raw.trim()) return
    const data = JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown }; autoCompactOffer?: Record<string, Record<string, Record<string, unknown>>> }
    const offers = (data.autoCompactOffer ??= {})
    const account = data.oauthAccount?.accountUuid
    if (typeof account === 'string' && account) {
      offers[account] ??= {}
      for (const m of models) if (m) offers[account][m] ??= {}
    }
    let changed = false
    for (const byModel of Object.values(offers)) {
      if (!byModel || typeof byModel !== 'object') continue
      for (const [model, offer] of Object.entries(byModel)) {
        if (!offer || typeof offer !== 'object' || (offer.resolved && typeof offer.resolved === 'object')) continue
        byModel[model] = { ...offer, eligibleLoggedAt: typeof offer.eligibleLoggedAt === 'number' ? offer.eligibleLoggedAt : now,
          resolved: { choice: 'keep', tokens: AUTO_COMPACT_KEEP_TOKENS } }
        changed = true
      }
    }
    if (changed) writeText(cfgFile, JSON.stringify(data, null, 2))
  } catch {
    /* crew answers the offer on screen */
  }
}

// ---------------------------------------------------------------- where a conversation lives

/** Claude's projects/ folder name for a cwd (every non-alphanumeric becomes '-'; long names get a hash suffix). */
export function claudeProjectName(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

/** Whether `configDir` holds a transcript for `cwd` (what `--continue` would resume). */
export function hasCwdTranscript(configDir: string, cwd: string): boolean {
  const projects = path.join(configDir, 'projects')
  const name = claudeProjectName(cwd)
  let dirs: string[]
  try {
    dirs = fs.readdirSync(projects)
  } catch {
    return false
  }
  const lower = name.toLowerCase()
  // Windows paths are case-insensitive, and names over 200 characters carry a hash suffix.
  const matches = dirs.filter(d => d.toLowerCase() === lower || (lower.length > 200 && d.toLowerCase().startsWith(lower.slice(0, 200))))
  return matches.some(d => {
    try {
      return fs.readdirSync(path.join(projects, d)).some(f => f.endsWith('.jsonl'))
    } catch {
      return false
    }
  })
}

/** Whether `configDir` holds the transcript of session `id` (what `--resume <id>` would load). */
export function hasSessionTranscript(configDir: string, id: string): boolean {
  const projects = path.join(configDir, 'projects')
  try {
    return fs.readdirSync(projects).some(d => fs.existsSync(path.join(projects, d, `${id}.jsonl`)))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- preflight

export interface PreflightResult { ok: boolean; reason?: string; version?: string }
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string }>

/**
 * `claude auth status` inside Genio's home must report the player's login and
 * Genio's folder as its config directory. Anything else means the isolation
 * no longer works with this Claude version.
 */
export async function preflightClaudeHome(dir: string, runClaude: ClaudeRunner, env: NodeJS.ProcessEnv = process.env): Promise<PreflightResult> {
  const childEnv: NodeJS.ProcessEnv = { ...env, ...isolatedEnv(dir, env) }
  delete childEnv.ELECTRON_RUN_AS_NODE
  let version: string | undefined
  try {
    version = (await runClaude(['--version'], childEnv)).stdout.match(/\d+\.\d+\.\d+/)?.[0]
  } catch {
    /* the status check below decides */
  }
  let status: { loggedIn?: unknown; configDirectory?: unknown }
  try {
    const r = await runClaude(['auth', 'status', '--json'], childEnv)
    const text = r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1)
    status = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'claude auth status gave no readable answer', version }
  }
  if (status.loggedIn !== true) return { ok: false, reason: "Claude does not see the player's login from Genio's folder", version }
  const configDir = typeof status.configDirectory === 'string' ? path.resolve(status.configDirectory) : ''
  if (configDir.toLowerCase() !== path.resolve(dir).toLowerCase()) return { ok: false, reason: "Claude ignored Genio's config folder", version }
  return { ok: true, version }
}

/** Run the Claude CLI the way Genio launches it (an npm .cmd shim goes through the shell). */
export function cliRunner(executable: string): ClaudeRunner {
  return async (args, env) => {
    const r = /\.(cmd|bat)$/i.test(executable)
      ? await runShell(`"${executable}" ${args.join(' ')}`, { env, timeoutMs: 20_000 })
      : await run(executable, args, { env, timeoutMs: 20_000 })
    return { code: r.code, stdout: r.stdout }
  }
}

// ---------------------------------------------------------------- the running app's home

export interface ClaudeHomeOptions {
  /** Genio's folder (claudeHomeDir(main base)). */
  dir: string
  /** The Claude CLI to check with (SYSTEMS' Claude path, else `claude` on PATH). */
  executable(): string | undefined
  /** Shown once if the isolation is unavailable. */
  warn(message: string): void
  /** Test seam; defaults to the real CLI. */
  runner?: ClaudeRunner
}

let configured: (ClaudeHomeOptions & { ready?: Promise<PreflightResult> }) | undefined

export function configureClaudeHome(opts: ClaudeHomeOptions | undefined): void {
  configured = opts
}

/** Seed and preflight once per Genio start; every launch site awaits the same answer. */
export function claudeHomeReady(): Promise<PreflightResult> {
  const c = configured
  if (!c) return Promise.resolve({ ok: false, reason: 'not configured' })
  c.ready ??= (async (): Promise<PreflightResult> => {
    let result: PreflightResult
    try {
      seedClaudeHome(c.dir)
      const exe = c.executable()
      const resolved = exe && which(exe)
      result = resolved ? await preflightClaudeHome(c.dir, c.runner ?? cliRunner(resolved)) : { ok: false, reason: 'the Claude Code CLI was not found' }
      if (result.ok && result.version) seedClaudeHome(c.dir, result.version)
    } catch (e) {
      result = { ok: false, reason: (e as Error).message }
    }
    if (!result.ok) {
      try {
        c.warn(`Genio could not use its own Claude folder (${result.reason}). Claude units and chats run in your normal Claude home for now, so they may show in your Claude apps. They still work.`)
      } catch {
        /* the warning is best effort */
      }
    }
    return result
  })()
  return c.ready
}

export interface ClaudeLaunch {
  /** Merge into the child's environment ({} = the player's normal home). */
  env: Record<string, string>
  /** Genio's own folder is in use. */
  isolated: boolean
  /** The config folder this launch reads and writes. */
  configDir: string
  /** The .claude.json this launch reads (folder trust). */
  configFile: string
}

const playerLaunch = (): ClaudeLaunch => ({ env: {}, isolated: false, configDir: playerClaudeDir(), configFile: playerClaudeJson() })

/**
 * Where a Claude process should run. New work goes to Genio's folder. A resume
 * follows the conversation: one that exists only in the player's folder (it
 * started before Genio had its own) resumes there, so nothing is lost.
 */
export async function claudeLaunch(resume?: { cwd?: string; sessionId?: string }): Promise<ClaudeLaunch> {
  const c = configured
  if (!c) return playerLaunch()
  const legacy = resume?.sessionId
    ? !hasSessionTranscript(c.dir, resume.sessionId) && hasSessionTranscript(playerClaudeDir(), resume.sessionId)
    : resume?.cwd
      ? !hasCwdTranscript(c.dir, resume.cwd) && hasCwdTranscript(playerClaudeDir(), resume.cwd)
      : false
  if (legacy) return playerLaunch()
  if (!(await claudeHomeReady()).ok) return playerLaunch()
  return { env: isolatedEnv(c.dir), isolated: true, configDir: c.dir, configFile: path.join(c.dir, '.claude.json') }
}

/** Shorthand for one-shots (probe, discovery, review) that never resume. */
export async function claudeEnv(): Promise<Record<string, string>> {
  return (await claudeLaunch()).env
}

/** Transcript folders Genio's usage scan reads: its own home, plus the player's for sessions from before it. */
export function claudeProjectRoots(): string[] {
  const roots = [path.join(playerClaudeDir(), 'projects')]
  if (configured) roots.unshift(path.join(configured.dir, 'projects'))
  return [...new Set(roots.map(r => path.resolve(r)))]
}

/** Every .claude.json a unit's trust may have been written to (Genio's and, for older units, the player's). */
export function claudeTrustFiles(): string[] {
  return [...(configured ? [path.join(configured.dir, '.claude.json')] : []), playerClaudeJson()]
}
