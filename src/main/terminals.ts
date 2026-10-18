/**
 * Terminal manager: one real PTY per unit / playtest / login session / terminal pane. Keeps an ANSI scrollback ring so the GUI can re-attach at any time.
 */
import path from 'node:path'
import * as pty from 'node-pty'
import type { TerminalInfo } from '@shared/types'
import { createActivityMeter, type ActivityMeter } from '@shared/unit-activity'
import type { AppCtx, CreateTerminalOpts, TerminalService } from './services'
import { PRIORITY, playIsLive, setProcessPriority } from '../../resources/unit-skills/genio/lib/play-live.mjs'
import { bus } from './bus'
import { rid, stripAnsi, which } from './util'

const SCROLLBACK_MAX = 1_500_000
/** Sustained work-like output republishes the terminal at most this often. */
const WORK_REPUBLISH_MS = 15_000
/** Typed text settles (no new echo for this long, at most SUBMIT_SETTLE_MAX_MS) before the submit key. */
const SUBMIT_SETTLE_MS = 250
const SUBMIT_SETTLE_MAX_MS = 1_500
/** A confirmed submit presses the key once per entry, then waits this long for the TUI to take the line. */
export const SUBMIT_CHECKS_MS = [500, 1_000, 2_000, 4_000]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Term {
  info: TerminalInfo
  proc?: pty.IPty
  buf: string[]
  bufLen: number
  lastOutputAt?: number
  /** a unit's sustained work-like output (idle chrome excluded) */
  meter?: ActivityMeter
  workPublishedAt?: number
  /** this shell's priority was lowered for a live Play (and is restored when it ends) */
  lowered?: boolean
  dataFns: Set<(d: string) => void>
  exitFns: Set<(code: number) => void>
}

export function defaultShell(configured?: string): { file: string; args: string[] } {
  if (configured && configured.trim()) {
    const parts = configured.trim().split(/\s+/)
    return { file: parts[0], args: parts.slice(1) }
  }
  if (process.platform === 'win32') {
    const pwsh = which('pwsh')
    return { file: pwsh ?? 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

/** Quote an argument for a cmd.exe command line. */
function cmdQuote(a: string): string {
  if (a === '') return '""'
  if (!/[\s"&|<>^()%!,;=]/.test(a)) return a
  return '"' + a.replace(/"/g, '""') + '"'
}

/**
 * Resolve how to start `file args` on this platform. Windows .cmd/.bat shims
 * (npm-installed CLIs) must go through cmd.exe /d /s /c.
 */
export function resolveSpawn(file: string, args: string[]): { file: string; args: string[] | string } {
  const resolved = which(file) ?? file
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [cmdQuote(resolved), ...args.map(cmdQuote)].join(' ')
    return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${line}"` }
  }
  return { file: resolved, args }
}

/**
 * A unit's console in UTF-8. Windows consoles start in the OEM code page, so the
 * PowerShell and cmd children a unit's agent runs would print cp437/cp850 into
 * a reader expecting UTF-8. `chcp 65001` switches the whole pseudo console
 * first. A command line cmd would rewrite (`%`, quotes, newlines) starts
 * unwrapped, with only the UTF-8 environment variables.
 */
export function utf8ConsoleSpawn(sp: { file: string; args: string[] | string }, platform = process.platform): { file: string; args: string[] | string } {
  if (platform !== 'win32') return sp
  if (typeof sp.args === 'string') {
    const line = /^\/d \/s \/c "([\s\S]*)"$/.exec(sp.args)?.[1]
    return line === undefined ? sp : { file: sp.file, args: `/d /s /c "chcp 65001 >nul & ${line}"` }
  }
  const parts = [sp.file, ...sp.args]
  if (parts.some((a) => /[\r\n"%]/.test(a))) return sp
  return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "chcp 65001 >nul & ${parts.map(cmdQuote).join(' ')}"` }
}

/** An interactive PowerShell that reads and writes UTF-8 (its console, and `$OutputEncoding` for pipes into native commands). */
export function utf8ShellArgs(file: string, args: string[]): string[] {
  if (!/(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(file) || args.some((a) => /^-(c|command|f|file|encodedcommand|ec)$/i.test(a))) return args
  return [...args, '-NoExit', '-Command', '[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[Text.UTF8Encoding]::new($false)']
}

/** A child's environment: Genio's own, minus `unsetEnv` (a trailing * matches a prefix), plus `env`. */
export function terminalEnv(opts: Pick<CreateTerminalOpts, 'env' | 'unsetEnv'>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v
  // never leak Electron's node-mode flag into children
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of opts.unsetEnv ?? []) {
    const prefix = name.endsWith('*') ? name.slice(0, -1) : undefined
    for (const k of Object.keys(env)) if (prefix === undefined ? k === name : k.startsWith(prefix)) delete env[k]
  }
  // Windows environment names are case-insensitive: a PATH shim must replace inherited Path too.
  // Python writes UTF-8 to pipes and files instead of the ANSI code page.
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (process.platform === 'win32') for (const inherited of Object.keys(env)) if (inherited.toLowerCase() === key.toLowerCase()) delete env[inherited]
    env[key] = value
  }
  return env
}

export function createTerminalService(getCtx: () => AppCtx): TerminalService {
  const terms = new Map<string, Term>()
  const anyData = new Set<(id: string, data: string) => void>()

  const publish = (t: Term): void => bus.publish({ type: 'terminal', terminal: { ...t.info } })

  const push = (t: Term, data: string): void => {
    t.buf.push(data)
    t.bufLen += data.length
    while (t.bufLen > SCROLLBACK_MAX && t.buf.length > 1) {
      t.bufLen -= t.buf.shift()!.length
    }
  }

  const liveNow = (): boolean => { try { return playIsLive(getCtx().main.home.data) } catch { return false } }
  /** Only a unit's shell this service started: its pid is the one node-pty returned. Best effort, never throws. */
  const lower = (t: Term, low: boolean): void => {
    if (!t.proc || (low ? t.lowered : !t.lowered)) return
    if (setProcessPriority(t.proc.pid, low ? PRIORITY.belowNormal : PRIORITY.normal)) t.lowered = low
  }

  const svc: TerminalService = {
    background(low) {
      for (const t of terms.values()) if (t.info.kind === 'worker') lower(t, low)
    },

    create(opts: CreateTerminalOpts): TerminalInfo {
      const id = `${opts.kind}-${rid(4)}`
      const cols = opts.cols ?? 120
      const rows = opts.rows ?? 32
      let file = opts.file
      let args: string[] = opts.args ?? []
      if (!file) {
        const sh = defaultShell(getCtx().settings.get().shell)
        file = sh.file
        args = utf8ShellArgs(sh.file, sh.args)
      }
      const info: TerminalInfo = {
        id,
        taskId: opts.taskId,
        title: opts.title,
        cwd: opts.cwd,
        alive: true,
        cols,
        rows,
        kind: opts.kind,
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.run !== undefined ? { run: opts.run } : {})
      }
      const t: Term = { info, buf: [], bufLen: 0, dataFns: new Set(), exitFns: new Set(),
        meter: opts.kind === 'worker' ? createActivityMeter(opts.harness) : undefined }
      terms.set(id, t)
      const env = terminalEnv(opts)
      try {
        // A unit's agent and the player's pane both get a UTF-8 console (chcp 65001), as the player expects.
        const sp = opts.kind === 'worker' || opts.kind === 'pane' ? utf8ConsoleSpawn(resolveSpawn(file, args)) : resolveSpawn(file, args)
        const processStartedAt = Date.now()
        const proc = pty.spawn(sp.file, sp.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: path.resolve(opts.cwd),
          env,
          ...(process.platform === 'win32' ? { useConpty: true } : {})
        } as pty.IPtyForkOptions)
        t.proc = proc
        // A unit started while a Play is live runs below normal until the Play ends (its children inherit the class).
        if (opts.kind === 'worker' && liveNow()) lower(t, true)
        t.info.pid = proc.pid
        t.info.processStartedAt = processStartedAt
        t.info.processSpawnedAt = Date.now()
        proc.onData((d) => {
          t.lastOutputAt = Date.now()
          t.info.lastOutputAt = new Date(t.lastOutputAt).toISOString()
          if (t.meter?.push(stripAnsi(d), t.lastOutputAt)) {
            t.info.workOutputAt = t.info.lastOutputAt
            // Publish work-like output at a slow cadence, not on every chunk of it.
            if (t.lastOutputAt - (t.workPublishedAt ?? 0) > WORK_REPUBLISH_MS) {
              t.workPublishedAt = t.lastOutputAt
              publish(t)
            }
          }
          push(t, d)
          for (const fn of t.dataFns) {
            try {
              fn(d)
            } catch {
              /* listener errors never break the pty */
            }
          }
          for (const fn of anyData) {
            try {
              fn(id, d)
            } catch {
              /* ignore */
            }
          }
        })
        proc.onExit(({ exitCode }) => {
          t.info.alive = false
          t.info.exitCode = exitCode
          t.info.exitedAt = Date.now()
          t.proc = undefined
          push(t, `\r\n\x1b[2m[genio] process exited with code ${exitCode}\x1b[0m\r\n`)
          publish(t)
          for (const fn of t.exitFns) {
            try {
              fn(exitCode)
            } catch {
              /* ignore */
            }
          }
        })
      } catch (e) {
        t.info.alive = false
        t.info.exitCode = -1
        t.info.exitedAt = Date.now()
        t.info.startError = `${file} did not start: ${(e as Error).message}`
        push(t, `\x1b[31m[genio] failed to start ${file}: ${(e as Error).message}\x1b[0m\r\n`)
      }
      publish(t)
      return { ...t.info }
    },

    list: () => [...terms.values()].map((t) => ({ ...t.info })),
    get: (id) => {
      const t = terms.get(id)
      return t ? { ...t.info } : undefined
    },

    write(id, data) {
      const t = terms.get(id)
      if (t?.proc) t.proc.write(data)
    },

    async submit(id, text, submitKey = '\r', confirm) {
      const t = terms.get(id)
      // Only Genio's own automation submits text (a unit's brief and pings): never into the player's pane.
      if (t?.info.kind === 'pane') throw new Error("The player's terminal pane takes no input from Genio or its units.")
      if (!t?.proc) return false
      t.proc.write(text)
      // An Enter that reaches a TUI while it still takes in the typed burst becomes
      // a newline (Codex) or is dropped: wait until the echo of the text settles.
      const typedAt = Date.now()
      await sleep(SUBMIT_SETTLE_MS)
      while (Date.now() - typedAt < SUBMIT_SETTLE_MAX_MS && Date.now() - (t.lastOutputAt ?? 0) < SUBMIT_SETTLE_MS) await sleep(50)
      if (!t.proc) return false
      if (!confirm) {
        t.proc.write(submitKey)
        // A second Enter on an empty composer is harmless, so retry once if nothing echoed.
        const before = t.lastOutputAt ?? 0
        await sleep(600)
        if (t.proc && (t.lastOutputAt ?? 0) <= before) t.proc.write(submitKey)
        return true
      }
      // Confirmed submit: press the key, then look for the TUI taking the line; retry with backoff.
      let since = ''
      const collect = (d: string): void => { since += d }
      t.dataFns.add(collect)
      try {
        for (const wait of SUBMIT_CHECKS_MS) {
          if (!t.proc) return false
          t.proc.write(submitKey)
          await sleep(wait)
          if (confirm(stripAnsi(since))) return true
        }
        return false
      } finally {
        t.dataFns.delete(collect)
      }
    },

    resize(id, cols, rows) {
      const t = terms.get(id)
      if (!t || cols < 2 || rows < 2) return
      t.info.cols = cols
      t.info.rows = rows
      try {
        t.proc?.resize(cols, rows)
      } catch {
        /* resize on a dying pty */
      }
    },

    kill(id) {
      const t = terms.get(id)
      if (!t) return
      try {
        t.proc?.kill()
      } catch {
        /* already gone */
      }
      terms.delete(id)
      bus.publish({ type: 'terminal-removed', id })
    },

    scrollback: (id) => terms.get(id)?.buf.join('') ?? '',

    tail(id, lines) {
      const t = terms.get(id)
      if (!t) return ''
      // only look at the recent part of the buffer
      let acc = ''
      for (let i = t.buf.length - 1; i >= 0 && acc.length < 200_000; i--) acc = t.buf[i] + acc
      const plain = stripAnsi(acc).replace(/\r(?!\n)/g, '\n')
      const arr = plain.split(/\r?\n/).map((l) => l.trimEnd())
      while (arr.length && !arr[arr.length - 1]) arr.pop()
      return arr.slice(-lines).join('\n')
    },

    lastOutputAt: (id) => terms.get(id)?.lastOutputAt,

    onData(id, fn) {
      const t = terms.get(id)
      if (!t) return () => undefined
      t.dataFns.add(fn)
      return () => t.dataFns.delete(fn)
    },

    onExit(id, fn) {
      const t = terms.get(id)
      if (!t) return () => undefined
      t.exitFns.add(fn)
      return () => t.exitFns.delete(fn)
    },

    onAnyData(fn) {
      anyData.add(fn)
      return () => anyData.delete(fn)
    }
  }
  return svc
}
