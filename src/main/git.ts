import path from 'node:path'
import { run, exists, ensureDir, type ExecResult } from './util'

export async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return run('git', args, { cwd, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

async function out(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args)
  return r.code === 0 ? r.stdout.trim() : ''
}

export async function isRepo(dir: string): Promise<boolean> {
  if (!exists(dir)) return false
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

export async function repoTop(dir: string): Promise<string> {
  return out(dir, ['rev-parse', '--show-toplevel'])
}

export async function defaultBranch(repo: string): Promise<string> {
  const head = await out(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head) return head.replace(/^origin\//, '')
  for (const b of ['main', 'master', 'trunk', 'develop']) {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])
    if (r.code === 0) return b
  }
  return (await out(repo, ['branch', '--show-current'])) || 'main'
}

export async function remoteUrl(repo: string): Promise<string | undefined> {
  const u = await out(repo, ['remote', 'get-url', 'origin'])
  return u || undefined
}

export async function hasRemote(repo: string): Promise<boolean> {
  return Boolean(await remoteUrl(repo))
}

export async function currentBranch(dir: string): Promise<string> {
  return out(dir, ['branch', '--show-current'])
}

export async function headSha(dir: string, ref = 'HEAD'): Promise<string> {
  return out(dir, ['rev-parse', ref])
}

export async function fetch(repo: string): Promise<ExecResult> {
  return git(repo, ['fetch', '--prune', 'origin'], 300_000)
}

/** Base ref to branch from: origin/<base> when a remote exists, else local <base>. */
export async function baseRef(repo: string, base: string): Promise<string> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])
  return r.code === 0 ? `origin/${base}` : base
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
}

/** Create an isolated worktree on a fresh branch. Refuses to reuse the primary checkout. */
export async function addWorktree(repo: string, wtPath: string, branch: string, base: string): Promise<ExecResult> {
  if (path.resolve(wtPath) === path.resolve(repo)) {
    return { code: 1, stdout: '', stderr: 'refusing: worktree path equals the primary checkout' }
  }
  ensureDir(path.dirname(wtPath))
  if (await hasRemote(repo)) await fetch(repo)
  const from = await baseRef(repo, base)
  if (await branchExists(repo, branch)) {
    return git(repo, ['worktree', 'add', wtPath, branch])
  }
  return git(repo, ['worktree', 'add', '-b', branch, wtPath, from])
}

/** Assert that a path is a linked worktree of repo, not the primary checkout. */
export async function assertIsolated(repo: string, wtPath: string): Promise<{ ok: boolean; reason?: string }> {
  if (!exists(wtPath)) return { ok: false, reason: 'worktree path does not exist' }
  const top = path.resolve(await repoTop(wtPath))
  if (top === path.resolve(repo)) return { ok: false, reason: 'path resolves to the primary checkout' }
  const gitDir = await out(wtPath, ['rev-parse', '--git-dir'])
  const common = await out(wtPath, ['rev-parse', '--git-common-dir'])
  if (!gitDir || path.resolve(wtPath, gitDir) === path.resolve(wtPath, common)) {
    return { ok: false, reason: 'not a linked worktree' }
  }
  return { ok: true }
}

export async function removeWorktree(repo: string, wtPath: string, force = false): Promise<ExecResult> {
  const args = ['worktree', 'remove', wtPath]
  if (force) args.push('--force')
  const r = await git(repo, args)
  await git(repo, ['worktree', 'prune'])
  return r
}

export async function statusPorcelain(dir: string): Promise<string[]> {
  const s = await out(dir, ['status', '--porcelain=v1', '--untracked-files=normal'])
  return s ? s.split(/\r?\n/).filter(Boolean) : []
}

export async function aheadBehind(dir: string, a: string, b: string): Promise<{ ahead: number; behind: number }> {
  const s = await out(dir, ['rev-list', '--left-right', '--count', `${a}...${b}`])
  const [ahead, behind] = s.split(/\s+/).map((n) => parseInt(n, 10) || 0)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}

export async function isAncestor(dir: string, maybeAncestor: string, of: string): Promise<boolean> {
  return (await git(dir, ['merge-base', '--is-ancestor', maybeAncestor, of])).code === 0
}

export async function diffStat(dir: string, base: string): Promise<string> {
  return out(dir, ['diff', '--stat', `${base}...HEAD`])
}

export async function diff(dir: string, base: string, maxBytes = 400_000): Promise<string> {
  const r = await git(dir, ['diff', `${base}...HEAD`])
  const unstaged = await git(dir, ['diff', 'HEAD'])
  let s = r.stdout
  if (unstaged.stdout.trim()) s += `\n\n# --- uncommitted changes ---\n${unstaged.stdout}`
  return s.length > maxBytes ? s.slice(0, maxBytes) + '\n… (diff truncated)' : s
}

export async function logOneline(dir: string, range: string, n = 30): Promise<string[]> {
  const s = await out(dir, ['log', '--oneline', `-n${n}`, range])
  return s ? s.split(/\r?\n/) : []
}

export interface LandedVerdict {
  landed: boolean
  reasons: string[]
  uncommitted: number
  unpushedCommits: number
  via?: 'remote' | 'base' | 'patch-equivalent' | 'pr-merged' | 'no-commits'
}

/**
 * Landed-work test (companion bin/fm-teardown.sh). Uncommitted changes are never
 * landed. Committed work counts as landed when its HEAD is reachable from any
 * remote-tracking branch, or it is contained in base (ancestor), or every commit
 * is patch-equivalent to base (`git cherry`, squash merges), or its PR is
 * recorded merged.
 */
export async function landedVerdict(
  repo: string,
  wtPath: string,
  branch: string,
  base: string,
  prMerged: boolean
): Promise<LandedVerdict> {
  const reasons: string[] = []
  let uncommitted = 0
  if (exists(wtPath)) {
    uncommitted = (await statusPorcelain(wtPath)).length
    if (uncommitted) reasons.push(`${uncommitted} uncommitted change(s) in the worktree`)
  }
  const dir = exists(wtPath) ? wtPath : repo
  const head = exists(wtPath) ? await headSha(wtPath) : (await branchExists(repo, branch)) ? await headSha(repo, branch) : ''
  if (!head) {
    return { landed: reasons.length === 0, reasons, uncommitted, unpushedCommits: 0, via: 'no-commits' }
  }
  if (await hasRemote(repo)) await fetch(repo)
  const ref = await baseRef(repo, base)
  const unique = await aheadBehind(dir, head, ref)
  let via: LandedVerdict['via']
  if (unique.ahead === 0) via = 'no-commits'
  else if (await isAncestor(dir, head, ref)) via = 'base'
  else {
    const remotes = await out(dir, ['branch', '-r', '--contains', head])
    if (remotes.trim()) via = 'remote'
    else {
      const cherry = await out(dir, ['cherry', ref, head])
      const lines = cherry.split(/\r?\n/).filter(Boolean)
      if (lines.length && lines.every((l) => l.startsWith('-'))) via = 'patch-equivalent'
      else if (prMerged) via = 'pr-merged'
    }
  }
  if (!via) reasons.push(`${unique.ahead} commit(s) on ${branch} are not pushed, not in ${ref}, and no merged PR is recorded`)
  return { landed: reasons.length === 0, reasons, uncommitted, unpushedCommits: via ? 0 : unique.ahead, via }
}

/** Fast-forward only merge of a ready local branch into base (local-only mode). */
export async function mergeLocalFastForward(repo: string, branch: string, base: string): Promise<ExecResult> {
  const st = await statusPorcelain(repo)
  if (st.length) return { code: 1, stdout: '', stderr: `primary checkout has ${st.length} uncommitted change(s); refusing to merge` }
  const cur = await currentBranch(repo)
  if (cur !== base) {
    const co = await git(repo, ['checkout', base])
    if (co.code !== 0) return co
  }
  if (!(await isAncestor(repo, base, branch))) {
    return { code: 1, stdout: '', stderr: `${branch} is not a fast-forward of ${base}; ask the worker to rebase onto ${base} first` }
  }
  return git(repo, ['merge', '--ff-only', branch])
}

/** Guarded fleet sync: fast-forward the primary checkout's default branch only when clean. */
export async function syncClone(repo: string, base: string): Promise<{ ok: boolean; message: string; pruned: string[] }> {
  if (!(await hasRemote(repo))) return { ok: true, message: 'no remote; nothing to sync', pruned: [] }
  const f = await fetch(repo)
  if (f.code !== 0) return { ok: false, message: `fetch failed: ${f.stderr.trim()}`, pruned: [] }
  const cur = await currentBranch(repo)
  const dirty = (await statusPorcelain(repo)).length
  let message = ''
  if (cur === base && !dirty) {
    const ff = await git(repo, ['merge', '--ff-only', `origin/${base}`])
    message = ff.code === 0 ? `fast-forwarded ${base}` : `could not fast-forward ${base}: ${ff.stderr.trim()}`
  } else if (cur !== base) {
    const up = await git(repo, ['fetch', 'origin', `${base}:${base}`])
    message = up.code === 0 ? `updated ${base} (checked out: ${cur})` : `left ${base} untouched (checked out: ${cur})`
  } else {
    message = `primary checkout has local changes; left ${base} untouched`
  }
  // Guarded safe branch pruning: delete local branches whose upstream is gone
  // AND which are fully contained in base. Never force.
  const pruned: string[] = []
  const gone = await out(repo, ['for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads'])
  for (const line of gone.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+\[gone\]$/)
    if (!m || m[1] === base || m[1] === cur) continue
    if (await isAncestor(repo, m[1], `origin/${base}`)) {
      const d = await git(repo, ['branch', '-d', m[1]])
      if (d.code === 0) pruned.push(m[1])
    }
  }
  return { ok: true, message, pruned }
}

export async function clone(url: string, dest: string): Promise<ExecResult> {
  ensureDir(path.dirname(dest))
  return run('git', ['clone', url, dest], { timeoutMs: 900_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

export async function initRepo(dir: string, branch = 'main'): Promise<ExecResult> {
  ensureDir(dir)
  return git(dir, ['init', '-b', branch])
}

export async function commitAll(dir: string, message: string): Promise<ExecResult> {
  await git(dir, ['add', '-A'])
  return git(dir, ['commit', '-m', message])
}

export async function push(dir: string, branch: string): Promise<ExecResult> {
  return git(dir, ['push', '-u', 'origin', branch], 300_000)
}

export async function deleteBranch(repo: string, branch: string, force = false): Promise<ExecResult> {
  return git(repo, ['branch', force ? '-D' : '-d', branch])
}

/** Parse github owner/repo from a remote url. */
export function githubSlug(url?: string): string | undefined {
  if (!url) return undefined
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(\.git)?$/i)
  return m ? `${m[1]}/${m[2]}` : undefined
}
