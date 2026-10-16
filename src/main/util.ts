import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { decodeBytes, TextStream } from '@shared/encoding'

export const nowIso = (): string => new Date().toISOString()

export function rid(n = 4): string {
  return randomBytes(n).toString('hex').slice(0, n * 2)
}

export function slugify(s: string, max = 32): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/-$/, '')
  return slug || 'task'
}

/** Forward-slash path for use inside prompts and shell snippets on Windows. */
export const fwd = (p: string): string => p.replace(/\\/g, '/')

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command without a shell. Never throws; inspect `code`. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0
        resolve({ code: err && code === 0 ? 1 : code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) })
      }
    )
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input)
    }
  })
}

/** Run a command line through the platform shell (needed for .cmd shims and user-authored commands). */
export function runShell(
  commandLine: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onData?: (s: string) => void; input?: string } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', commandLine] : ['-c', commandLine], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
      windowsVerbatimArguments: isWin
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n[genio] timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`
          killTree(child.pid)
        }, opts.timeoutMs)
      : undefined
    // A character split between two chunks, or a line in the OEM/ANSI code page, still decodes whole.
    const out = new TextStream()
    const err = new TextStream()
    const emit = (s: string, to: 'out' | 'err'): void => {
      if (!s) return
      if (to === 'out') stdout += s
      else stderr += s
      opts.onData?.(s)
    }
    child.stdout.on('data', (d: Buffer) => emit(out.write(d), 'out'))
    child.stderr.on('data', (d: Buffer) => emit(err.write(d), 'err'))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + e.message })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      emit(out.end(), 'out')
      emit(err.end(), 'err')
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export function killTree(pid?: number): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    /* already gone */
  }
}

const whichCache = new Map<string, string | null>()

/** Resolve an executable on PATH (Windows aware: honours PATHEXT). */
export function which(cmd: string): string | null {
  if (whichCache.has(cmd)) return whichCache.get(cmd) ?? null
  let found: string | null = null
  if (path.isAbsolute(cmd)) {
    found = fs.existsSync(cmd) ? cmd : null
  } else {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : ['']
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    const extra = process.platform === 'win32' ? [path.join(process.env.USERPROFILE ?? '', '.local', 'bin'), path.join(process.env.APPDATA ?? '', 'npm')] : [path.join(process.env.HOME ?? '', '.local', 'bin')]
    outer: for (const dir of [...dirs, ...extra]) {
      for (const ext of process.platform === 'win32' ? ['', ...exts] : ['']) {
        const p = path.join(dir, cmd + ext)
        try {
          if (fs.statSync(p).isFile()) {
            if (process.platform === 'win32' && ext === '' && !/\.(exe|cmd|bat|com)$/i.test(p)) continue
            found = p
            break outer
          }
        } catch {
          /* keep looking */
        }
      }
    }
  }
  whichCache.set(cmd, found)
  return found
}

export function clearWhichCache(): void {
  whichCache.clear()
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

/** A text file whatever wrote it: UTF-8, a PowerShell UTF-16 or ANSI file, or a log mixing them (see decodeBytes). */
export function readText(p: string, fallback = ''): string {
  try {
    return decodeBytes(fs.readFileSync(p))
  } catch {
    return fallback
  }
}

/** Atomic write: write temp then rename, so a crash never leaves half a record. */
export function writeText(p: string, content: string): void {
  ensureDir(path.dirname(p))
  const tmp = `${p}.${process.pid}.${rid(3)}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, p)
  } catch {
    // Windows can refuse rename over a file held open by a reader; fall back.
    fs.writeFileSync(p, content, 'utf8')
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p))
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf8')
}

export function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(decodeBytes(fs.readFileSync(p))) as T
  } catch {
    return fallback
  }
}

export function writeJson(p: string, data: unknown): void {
  writeText(p, JSON.stringify(data, null, 2) + '\n')
}

/** Replace a durable checkpoint without exposing a partially written JSON file. */
export function writeJsonAtomic(p: string, data: unknown): void {
  const temp = `${p}.tmp`
  writeJson(temp, data)
  fs.renameSync(temp, p)
}

export function readJsonl<T>(p: string): T[] {
  const txt = readText(p)
  const out: T[] = []
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      /* skip corrupt line, keep the rest */
    }
  }
  return out
}

export function appendJsonl(p: string, rec: unknown): void {
  appendLine(p, JSON.stringify(rec))
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function isSubPath(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function todayStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function minutesSince(iso?: string): number {
  if (!iso) return Infinity
  return (Date.now() - new Date(iso).getTime()) / 60_000
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

/** Strip ANSI escape sequences from terminal output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g, '')
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined
  return ((...a: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }) as T
}

export function wordCount(s: string): number {
  return (s.match(/\S+/g) ?? []).length
}

/**
 * Session markers a parent Claude Code process leaks to its children. If Genio
 * is launched from inside a Claude Code terminal these would make Genio's own
 * agent and every unit think they are nested child sessions (e.g. transcript
 * saving off, which breaks Respawn's resume). Auth/provider variables
 * (ANTHROPIC_*, CLAUDE_CODE_USE_*, CLAUDE_CODE_OAUTH_TOKEN...) are kept.
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT'
]

export function scrubInheritedSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = []
  for (const k of INHERITED_SESSION_VARS) {
    if (k in env) {
      delete env[k]
      removed.push(k)
    }
  }
  return removed
}
