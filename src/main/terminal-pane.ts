/**
 * The player's terminal pane in a project window: one interactive shell, plus the one-shot
 * processes the chat composer's '!' commands run. These are the player's own processes. They are
 * tied to the project window (closing it kills them), never count as units, and no Genio or unit
 * tool writes to them (TerminalService.submit refuses a pane terminal; only the window's own
 * keyboard reaches it through terminalWrite).
 */
import fs from 'node:fs'
import type { ShellRun, TerminalInfo } from '@shared/types'
import { MAIN_CWD, boundOutput, plainTerminalText, type PaneCwd } from '@shared/terminal-pane'
import type { AppCtx } from './services'
import { defaultShell } from './terminals'
import { stripAnsi } from './util'

type PaneCtx = Pick<AppCtx, 'projects' | 'homes' | 'terminals' | 'settings' | 'home'>

/** Finished '!' runs kept as tabs in the pane; older ones close as new ones start. */
export const RUN_TABS_MAX = 5
const CAPTURE_HEAD = 256 * 1024
const CAPTURE_TAIL = 256 * 1024

/**
 * Where the pane can run: the project's main checkout (its repository root), then each unit whose
 * copy is still on disk. A despawned or merged unit's leftover folder is never offered.
 */
export function paneCwds(ctx: Pick<AppCtx, 'projects' | 'homes'>, project: string): PaneCwd[] {
  const p = ctx.projects.get(project)
  if (!p) throw new Error(`Project ${project} is unavailable.`)
  const out: PaneCwd[] = [{ id: MAIN_CWD, label: 'Main checkout', path: p.path }]
  for (const hc of ctx.homes.values()) {
    for (const t of hc.crew.list()) {
      if (t.project !== project || t.state === 'cleaned' || t.state === 'merged' || !t.worktree || out.some((c) => c.path === t.worktree)) continue
      if (!cwdProblem(t.worktree)) out.push({ id: t.id, label: `Unit · ${t.title}`, path: t.worktree, taskId: t.id })
    }
  }
  return out
}

/** Why a shell cannot start in `dir`, checked before spawning; undefined when it can. */
export function cwdProblem(dir: string): string | undefined {
  if (!dir) return 'No folder was given.'
  let st: fs.Stats
  try {
    st = fs.statSync(dir)
  } catch {
    return `${dir} does not exist.`
  }
  if (!st.isDirectory()) return `${dir} is not a folder.`
  try {
    fs.accessSync(dir, fs.constants.R_OK)
  } catch {
    return `${dir} cannot be read.`
  }
  return undefined
}

function resolveCwd(ctx: PaneCtx, project: string, cwdId = MAIN_CWD): PaneCwd {
  const choice = paneCwds(ctx, project).find((c) => c.id === cwdId)
  if (!choice) throw new Error(cwdId === MAIN_CWD ? `${project}'s folder is unavailable.` : "That unit's copy is gone. Pick another folder for the terminal.")
  const problem = cwdProblem(choice.path)
  if (problem) throw new Error(`The terminal cannot start there: ${problem}`)
  return choice
}

export const paneTerminals = (ctx: Pick<AppCtx, 'terminals'>, project: string): TerminalInfo[] =>
  ctx.terminals.list().filter((t) => t.kind === 'pane' && t.project === project)

/** The pane's interactive shell (live or ended), if any. */
export const paneShell = (ctx: Pick<AppCtx, 'terminals'>, project: string): TerminalInfo | undefined =>
  paneTerminals(ctx, project).find((t) => t.run === undefined)

/**
 * Start the pane's shell in the chosen folder, or return the one already running there. Choosing
 * another folder, or `restart`, replaces it.
 */
export function openPane(ctx: PaneCtx, project: string, cwdId?: string, restart = false, size?: { cols: number; rows: number }): TerminalInfo {
  const choice = resolveCwd(ctx, project, cwdId)
  const current = paneShell(ctx, project)
  if (current?.alive && current.cwd === choice.path && !restart) return current
  if (current) ctx.terminals.kill(current.id)
  // The Terminal shell setting (Settings › Advanced › Agent tools), PowerShell by default, with UTF-8 console and pipes.
  return ctx.terminals.create({ kind: 'pane', project, title: 'Terminal', cwd: choice.path, taskId: choice.taskId, ...(size ?? {}) })
}

/** Close the pane: its shell and every '!' run it shows stop. */
export function closePane(ctx: Pick<AppCtx, 'terminals'>, project: string): void {
  for (const t of paneTerminals(ctx, project)) ctx.terminals.kill(t.id)
}

const isPowerShell = (file: string): boolean => /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(file)
const isCmd = (file: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(file)

/** One '!' command in the configured shell, exiting with the command's own exit code. */
export function oneShotShell(configured: string | undefined, command: string): { file: string; args: string[] } {
  const sh = defaultShell(configured)
  if (isPowerShell(sh.file)) {
    // Encoded, so no quoting can change the command; a native command's exit code, else 1 for a failed cmdlet.
    const script = [
      '[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)',
      '$global:LASTEXITCODE=0',
      command,
      'if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }',
      'exit $LASTEXITCODE'
    ].join('\n')
    return { file: sh.file, args: ['-NoLogo', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
  }
  if (isCmd(sh.file)) return { file: sh.file, args: ['/d', '/s', '/c', command] }
  return { file: sh.file, args: ['-lc', command] }
}

/**
 * Run a '!' command from the chat composer in the pane's folder, as a one-shot process the pane
 * shows as a tab (the interactive shell keeps whatever it is doing). When it ends, its result block
 * joins `wksp`'s chat and its bounded output is read with the player's next message.
 */
export function runShell(ctx: PaneCtx, project: string, wksp: string, command: string, cwdId?: string, size?: { cols: number; rows: number }): TerminalInfo {
  const cmd = command.trim()
  if (!cmd) throw new Error('Type a command after !')
  const chat = ctx.home(wksp).wksp
  const choice = resolveCwd(ctx, project, cwdId)
  const finished = paneTerminals(ctx, project).filter((t) => t.run !== undefined && !t.alive)
  for (const old of finished.slice(0, Math.max(0, finished.length - (RUN_TABS_MAX - 1)))) ctx.terminals.kill(old.id)
  const spec = oneShotShell(ctx.settings.get().shell, cmd)
  const started = Date.now()
  const term = ctx.terminals.create({ kind: 'pane', project, title: `! ${cmd}`, run: cmd, cwd: choice.path, taskId: choice.taskId, file: spec.file, args: spec.args, ...(size ?? {}) })
  if (!term.alive) {
    chat.shellRan({ command: cmd, cwd: choice.path, durationMs: 0, output: '', truncated: false, error: term.startError ?? 'the shell did not start' })
    return term
  }
  let head = '', tail = '', dropped = false
  const offData = ctx.terminals.onData(term.id, (d) => {
    if (head.length < CAPTURE_HEAD) head += d
    else {
      tail += d
      if (tail.length > CAPTURE_TAIL) { tail = tail.slice(-CAPTURE_TAIL); dropped = true }
    }
  })
  ctx.terminals.onExit(term.id, (exitCode) => {
    offData()
    const text = plainTerminalText(stripAnsi(head + (dropped ? '\n…\n' : '') + tail))
    const run: ShellRun = { command: cmd, cwd: choice.path, exitCode, durationMs: Date.now() - started, ...boundOutput(text) }
    if (dropped) run.truncated = true
    try {
      chat.shellRan(run)
    } catch {
      /* the chat closed with its window */
    }
  })
  return term
}
