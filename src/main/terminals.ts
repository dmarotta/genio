/**
 * Terminal manager: one real PTY per unit / playtest / shell (companion's tmux
 * windows). Keeps an ANSI scrollback ring so the GUI can re-attach at any time.
 */
import path from 'node:path'
import * as pty from 'node-pty'
import type { TerminalInfo } from '@shared/types'
import type { AppCtx, CreateTerminalOpts, TerminalService } from './services'
import { bus } from './bus'
import { rid, stripAnsi, which } from './util'

const SCROLLBACK_MAX = 1_500_000

interface Term {
  info: TerminalInfo
  proc?: pty.IPty
  buf: string[]
  bufLen: number
  lastOutputAt?: number
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

  const svc: TerminalService = {
    create(opts: CreateTerminalOpts): TerminalInfo {
      const id = `${opts.kind}-${rid(4)}`
      const cols = opts.cols ?? 120
      const rows = opts.rows ?? 32
      let file = opts.file
      let args: string[] = opts.args ?? []
      if (!file) {
        const sh = defaultShell(getCtx().settings.get().shell)
        file = sh.file
        args = sh.args
      }
      const info: TerminalInfo = {
        id,
        taskId: opts.taskId,
        title: opts.title,
        cwd: opts.cwd,
        alive: true,
        cols,
        rows,
        kind: opts.kind
      }
      const t: Term = { info, buf: [], bufLen: 0, dataFns: new Set(), exitFns: new Set() }
      terms.set(id, t)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
      // never leak Electron's node-mode flag into children
      delete env.ELECTRON_RUN_AS_NODE
      Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' }, opts.env ?? {})
      try {
        const sp = resolveSpawn(file, args)
        const proc = pty.spawn(sp.file, sp.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: path.resolve(opts.cwd),
          env,
          ...(process.platform === 'win32' ? { useConpty: true } : {})
        } as pty.IPtyForkOptions)
        t.proc = proc
        proc.onData((d) => {
          t.lastOutputAt = Date.now()
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

    async submit(id, text, submitKey = '\r') {
      const t = terms.get(id)
      if (!t?.proc) return
      t.proc.write(text)
      await new Promise((r) => setTimeout(r, 150))
      if (!t.proc) return
      t.proc.write(submitKey)
      // Some TUIs swallow the first Enter right after a paste burst; a second
      // Enter on an empty composer is harmless, so retry once if nothing echoed.
      const before = t.lastOutputAt ?? 0
      await new Promise((r) => setTimeout(r, 600))
      if (t.proc && (t.lastOutputAt ?? 0) <= before) t.proc.write(submitKey)
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
