import { invalidateModelCatalogue, modelCatalogue } from './model-catalogue'
/**
 * Accounts: the login state of the CLIs Genio drives (unit harnesses and the
 * forge CLIs). Status comes only from each tool's own status command; login
 * and logout run the tool's own flow in a visible terminal. Genio never reads,
 * prints or stores their tokens or credential files: parsers keep only the
 * account name / auth method and scrub anything token-shaped.
 */
import { bus } from './bus'
import { GENIO_CODEX, type AccountStatus, type LoginState } from '@shared/api'
import type { TerminalInfo } from '@shared/types'
import type { AppCtx } from './services'
import { toolStatus } from './toolchain'
import { run, runShell, stripAnsi } from './util'
import { codexHomeReady, genioCodexHome, readCodexAccount, resetCodexHome, seedCodexHome } from './codex-home'

export interface AuthParse {
  state: LoginState
  detail?: string
}

interface AccountDef {
  tool: string
  label: string
  /** non-interactive status check; absent → state is always 'unknown' */
  status?: string[]
  login: string[]
  logout?: string[]
  parse?: (out: string, code: number) => AuthParse
  /** commands checked against the installed CLI's --help (else wired from its docs) */
  verified: boolean
  note?: string
  /** the executable, when the row is not named after it */
  cli?: string
  /** extra environment for status, login and logout; undefined hides the row */
  env?(): Record<string, string> | undefined
  /** replaces `status` + `parse`: the row's state, detail and warning */
  check?(): Promise<Pick<AccountStatus, 'state'> & Partial<Pick<AccountStatus, 'detail' | 'warning' | 'stateLabel'>>>
  /** runs before a login (seeding the home it signs in) */
  prepare?(): void
  /** runs when a login or logout terminal ends */
  ended?(): void
  loginLabel?: string
  logoutLabel?: string
}

// Tokens and secrets never leave a parser, even masked ones (gh prints "gho_****").
const TOKENISH = /\b(?:sk|gh[opsur]|glpat|github_pat|xox[abp])[-_][\w*.-]+|\S*\*{3,}\S*|\b[A-Za-z0-9+/_-]{32,}={0,2}/g

/** Keep a short, token-free detail string. */
export function scrubDetail(s: string | undefined): string | undefined {
  if (!s) return undefined
  const v = s.replace(TOKENISH, '').replace(/\s{2,}/g, ' ').replace(/[\s,·:(-]+$/, '').trim()
  return v ? v.slice(0, 120) : undefined
}

const clean = (out: string): string => stripAnsi(out).replace(/\r/g, '')

/** `claude auth status --json` (verified on Claude Code 2.1). */
export function parseClaudeAuth(out: string): AuthParse {
  const txt = clean(out)
  const a = txt.indexOf('{')
  const b = txt.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(txt.slice(a, b + 1)) as Record<string, unknown>
      if (typeof j.loggedIn === 'boolean') {
        if (!j.loggedIn) return { state: 'logged-out' }
        const str = (k: string): string | undefined => (typeof j[k] === 'string' && j[k] ? (j[k] as string) : undefined)
        const plan = str('subscriptionType')
        const method = str('authMethod')
        const detail = [method && plan ? `${method} (${plan})` : method ?? plan, str('email')].filter(Boolean).join(' · ')
        return { state: 'logged-in', detail: scrubDetail(detail) }
      }
    } catch {
      /* fall through to the text form */
    }
  }
  if (/not logged in|logged out|not authenticated/i.test(txt)) return { state: 'logged-out' }
  const method = /Login method:\s*(.+)/i.exec(txt)?.[1]
  const email = /Email:\s*(\S+)/i.exec(txt)?.[1]
  if (method || email) return { state: 'logged-in', detail: scrubDetail([method, email].filter(Boolean).join(' · ')) }
  return { state: 'unknown' }
}

/** `codex login status` (verified on codex-cli 0.162): "Logged in using ChatGPT" / "Not logged in". */
export function parseCodexLogin(out: string): AuthParse {
  const txt = clean(out)
  if (/not logged in/i.test(txt)) return { state: 'logged-out' }
  const m = /Logged in using\s+(.+)/i.exec(txt)
  if (m) {
    // "an API key - sk-proj-***abcd": keep the method, drop the masked key
    const method = m[1].split(/\s+-\s+/)[0].replace(/^an?\s+/i, '').trim()
    return { state: 'logged-in', detail: scrubDetail(method) }
  }
  if (/logged in/i.test(txt)) return { state: 'logged-in' }
  return { state: 'unknown' }
}

/** `gh auth status` (documented; gh not installed here). */
export function parseGhAuth(out: string): AuthParse {
  const txt = clean(out)
  const accounts: string[] = []
  for (const m of txt.matchAll(/Logged in to (\S+?) (?:account|as) ([\w.-]+)/gi)) accounts.push(`${m[2]} @ ${m[1]}`)
  if (accounts.length) return { state: 'logged-in', detail: scrubDetail([...new Set(accounts)].join(', ')) }
  if (/not logged in|not logged into any/i.test(txt)) return { state: 'logged-out' }
  if (/failed to log in|token .* is (?:invalid|expired)/i.test(txt)) return { state: 'logged-out', detail: 'stored login is no longer valid' }
  return { state: 'unknown' }
}

/** `glab auth status` (documented; glab not installed here). */
export function parseGlabAuth(out: string): AuthParse {
  const txt = clean(out)
  const accounts: string[] = []
  for (const m of txt.matchAll(/Logged in to (\S+?) as ([\w.-]+)/gi)) accounts.push(`${m[2]} @ ${m[1]}`)
  if (accounts.length) return { state: 'logged-in', detail: scrubDetail([...new Set(accounts)].join(', ')) }
  if (/has not been authenticated|not logged in|no token (?:provided|found)/i.test(txt)) return { state: 'logged-out' }
  return { state: 'unknown' }
}

/** `cursor-agent status` (documented; not installed here). */
export function parseCursorStatus(out: string): AuthParse {
  const txt = clean(out)
  if (/not logged in|not authenticated|logged out/i.test(txt)) return { state: 'logged-out' }
  const m = /Logged in as\s+(\S+)/i.exec(txt)
  if (m) return { state: 'logged-in', detail: scrubDetail(m[1]) }
  if (/logged in/i.test(txt)) return { state: 'logged-in' }
  return { state: 'unknown' }
}

/** `opencode auth list` (documented; not installed here): provider names only, never the file contents. */
export function parseOpencodeAuth(out: string): AuthParse {
  const txt = clean(out)
  // stored credentials come first; the "Environment" block only names env vars
  const stored = txt.split(/^\W*Environment\b/im)[0]
  const providers: string[] = []
  for (const m of stored.matchAll(/^[\s│|]*[●•]\s+(.+?)\s*$/gm)) providers.push(m[1])
  const n = /(\d+)\s+credentials?\b/i.exec(stored)
  if (providers.length) return { state: 'logged-in', detail: scrubDetail(providers.join(', ')) }
  if (n && Number(n[1]) === 0) return { state: 'logged-out' }
  return { state: 'unknown' }
}

export const ACCOUNTS: AccountDef[] = [
  { tool: 'claude', label: 'Claude Code', status: ['auth', 'status', '--json'], login: ['auth', 'login'], logout: ['auth', 'logout'], parse: parseClaudeAuth, verified: true },
  { tool: 'codex', label: 'Codex CLI', status: ['login', 'status'], login: ['login'], logout: ['logout'], parse: parseCodexLogin, verified: true },
  { tool: 'gh', label: 'GitHub CLI', status: ['auth', 'status'], login: ['auth', 'login'], logout: ['auth', 'logout'], parse: parseGhAuth, verified: false },
  { tool: 'glab', label: 'GitLab CLI', status: ['auth', 'status'], login: ['auth', 'login'], logout: ['auth', 'logout'], parse: parseGlabAuth, verified: false },
  {
    tool: 'gemini',
    label: 'Gemini CLI',
    login: [],
    verified: false,
    note: 'No auth subcommand: Log in opens Gemini CLI, where /auth picks the sign-in method.'
  },
  { tool: 'opencode', label: 'OpenCode', status: ['auth', 'list'], login: ['auth', 'login'], logout: ['auth', 'logout'], parse: parseOpencodeAuth, verified: false },
  { tool: 'cursor-agent', label: 'Cursor Agent', status: ['status'], login: ['login'], logout: ['logout'], parse: parseCursorStatus, verified: false },
  {
    tool: GENIO_CODEX,
    cli: 'codex',
    label: "Genio's Codex",
    login: ['login'],
    logout: ['logout'],
    verified: true,
    env: () => {
      const dir = genioCodexHome()
      return dir ? { CODEX_HOME: dir } : undefined
    },
    check: genioCodexCheck,
    prepare: () => {
      const dir = genioCodexHome()
      if (dir) seedCodexHome(dir)
    },
    ended: () => { genioAccount = undefined; resetCodexHome() },
    loginLabel: "Sign in Genio's Codex (same account)",
    logoutLabel: 'Sign out'
  }
]

const GENIO_CODEX_PURPOSE = "Genio's own Codex home: units, chat and image runs stay out of your Codex app, even while they run. Sign in with your usual ChatGPT account (same plan, no second subscription)."
const GENIO_CODEX_FALLBACK = 'Until then, Codex units and chats use your normal Codex home and can show in your Codex app while they run.'
let genioAccount: { email?: string; plan?: string } | undefined

async function genioCodexCheck(): ReturnType<NonNullable<AccountDef['check']>> {
  const dir = genioCodexHome()
  const s = await codexHomeReady(true)
  if (s.state === 'signed-out') return { state: 'logged-out', stateLabel: 'not signed in', warning: GENIO_CODEX_FALLBACK }
  if (!s.ok || !dir) return { state: 'unknown', stateLabel: 'error', warning: `${s.reason ?? 'Sign-in could not be checked'}. ${GENIO_CODEX_FALLBACK}` }
  genioAccount ??= await readCodexAccount(dir)
  const who = scrubDetail(genioAccount.email)
  return { state: 'logged-in', stateLabel: 'signed in', detail: scrubDetail(['ChatGPT', who ? `signed in as ${who}` : '', genioAccount.plan].filter(Boolean).join(' · ')) }
}

async function runTool(file: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  const r = /\.(cmd|bat)$/i.test(file)
    ? await runShell(`"${file}" ${args.join(' ')}`, { timeoutMs: 20_000, env })
    : await run(file, args, { timeoutMs: 20_000, env })
  // status output stays in memory only: parsed, never logged or stored
  return { code: r.code, out: `${r.stdout}\n${r.stderr}` }
}

async function accountStatus(def: AccountDef): Promise<AccountStatus> {
  const t = await toolStatus(def.cli ?? def.tool)
  const st: AccountStatus = {
    tool: def.tool,
    label: def.label,
    purpose: def.tool === GENIO_CODEX ? GENIO_CODEX_PURPOSE : t?.purpose ?? '',
    installed: Boolean(t?.found),
    version: t?.version,
    install: t?.install,
    state: 'unknown',
    canLogin: true,
    canLogout: Boolean(def.logout),
    verified: def.verified,
    note: def.note,
    loginLabel: def.loginLabel,
    logoutLabel: def.logoutLabel
  }
  if (!t?.found || !t.path) return st
  if (def.check) return { ...st, ...(await def.check()) }
  if (!def.status || !def.parse) return st
  const r = await runTool(t.path, def.status, def.env?.() ?? {})
  const p = def.parse(r.out, r.code)
  st.state = p.state
  st.detail = p.detail
  return st
}

/** Rows whose home Genio has not set up (no env) are left out. */
export function listAccounts(): Promise<AccountStatus[]> {
  return Promise.all(ACCOUNTS.filter(def => !def.env || def.env()).map(accountStatus))
}

/** Run the tool's own login/logout in a visible terminal so the player can finish prompts. */
export async function openAccountSession(ctx: AppCtx, tool: string, action: 'login' | 'logout', cwd = ctx.main.home.root): Promise<TerminalInfo> {
  const def = ACCOUNTS.find((a) => a.tool === tool)
  if (!def) throw new Error(`Unknown account tool: ${tool}`)
  const args = action === 'login' ? def.login : def.logout
  if (!args) throw new Error(`${def.label} has no ${action} command`)
  const t = await toolStatus(def.cli ?? def.tool)
  if (!t?.found || !t.path) throw new Error(`${def.label} is not installed${t?.install ? ` (${t.install})` : ''}`)
  const env = def.env?.()
  if (def.env && !env) throw new Error(`${def.label} is not set up`)
  if (action === 'login') def.prepare?.()
  // A login with its own home (Genio's Codex) signs in only that home: the player's own login is never touched.
  const terminal = ctx.terminals.create({
    kind: 'shell',
    title: `${action === 'login' ? 'Log in' : 'Log out'} · ${def.label}`,
    cwd,
    file: t.path,
    args,
    ...(env ? { env } : {})
  })
  invalidateModelCatalogue()
  ctx.terminals.onExit(terminal.id, () => { def.ended?.(); invalidateModelCatalogue(); void modelCatalogue(ctx.main.home.data, true, ctx.settings.get().claudePath).catch(() => {}) })
  if (action === 'login' && terminal.alive) {
    ctx.terminals.onExit(terminal.id, (code) => {
      if (code !== 0) return
      void accountStatus(def).then((status) => {
        if (status.state === 'logged-in') bus.publish({ type: 'feature-used', feature: 'account-login' })
      }).catch(() => {})
    })
  }
  return terminal
}
