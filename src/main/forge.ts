/**
 * Forge adapter: GitHub via `gh` (PR merge and check guards),
 * GitLab via `glab` best effort.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpResult } from '@shared/api'
import type { AppCtx, ForgeService } from './services'
import { rid, run, which, type ExecResult } from './util'

type View = Awaited<ReturnType<ForgeService['view']>>

const isGitlab = (url: string): boolean => /\/merge_requests\/\d+/.test(url) || /gitlab/i.test(url)

async function tool(name: 'gh' | 'glab', args: string[], cwd?: string, timeoutMs = 120_000): Promise<ExecResult> {
  const p = which(name)
  if (!p) return { code: 127, stdout: '', stderr: `${name} is not installed` }
  return run(p, args, { cwd, timeoutMs, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GLAB_NO_PROMPT: '1' } })
}

interface CheckRun {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

function rollup(checks: CheckRun[] | undefined): { checks: View['checks']; failing: string[]; pending: string[] } {
  const failing: string[] = []
  const pending: string[] = []
  if (!checks || checks.length === 0) return { checks: 'none', failing, pending }
  for (const c of checks) {
    const name = c.name || c.context || 'check'
    const concl = (c.conclusion || c.state || '').toUpperCase()
    const status = (c.status || '').toUpperCase()
    if (status && status !== 'COMPLETED' && !c.state) pending.push(name)
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl)) continue
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(concl)) pending.push(name)
    else failing.push(name)
  }
  return { checks: failing.length ? 'failing' : pending.length ? 'pending' : 'passing', failing, pending }
}

export function createForgeService(getCtx: () => AppCtx): ForgeService {
  const svc: ForgeService = {
    available: () => getCtx().toolchain.has('gh') || getCtx().toolchain.has('glab'),

    async createPr(cwd, opts) {
      const bodyFile = path.join(os.tmpdir(), `genio-pr-${rid(4)}.md`)
      fs.writeFileSync(bodyFile, opts.body, 'utf8')
      try {
        const remote = (await run('git', ['remote', 'get-url', 'origin'], { cwd })).stdout.trim()
        if (/gitlab/i.test(remote) && which('glab')) {
          const r = await tool('glab', ['mr', 'create', '--title', opts.title, '--description', opts.body, '--target-branch', opts.base, '--source-branch', opts.head, '--yes', ...(opts.draft ? ['--draft'] : [])], cwd)
          const url = (r.stdout + r.stderr).match(/https?:\/\/\S+\/merge_requests\/\d+/)?.[0]
          return url ? { ok: true, url, message: `Opened ${url}` } : { ok: false, message: (r.stderr || r.stdout).trim() || 'glab mr create failed' }
        }
        const r = await tool('gh', ['pr', 'create', '--title', opts.title, '--body-file', bodyFile, '--base', opts.base, '--head', opts.head, ...(opts.draft ? ['--draft'] : [])], cwd)
        const url = (r.stdout + r.stderr).match(/https?:\/\/\S+\/pull\/\d+/)?.[0]
        if (url) return { ok: true, url, message: `Opened ${url}` }
        // PR may already exist for this head
        const existing = await svc.findPrForBranch(cwd, opts.head)
        if (existing) return { ok: true, url: existing, message: `PR already open: ${existing}` }
        return { ok: false, message: (r.stderr || r.stdout).trim() || 'gh pr create failed' }
      } finally {
        try {
          fs.unlinkSync(bodyFile)
        } catch {
          /* ignore */
        }
      }
    },

    async view(url, cwd): Promise<View> {
      if (isGitlab(url)) {
        const r = await tool('glab', ['mr', 'view', url, '--output', 'json'], cwd)
        if (r.code !== 0) return { ok: false, checks: 'none', failing: [], pending: [], message: r.stderr.trim() }
        try {
          const j = JSON.parse(r.stdout) as { state?: string; draft?: boolean; sha?: string; merge_status?: string; head_pipeline?: { status?: string } }
          const pipe = (j.head_pipeline?.status ?? '').toLowerCase()
          return {
            ok: true,
            state: j.state === 'merged' ? 'MERGED' : j.state === 'closed' ? 'CLOSED' : 'OPEN',
            isDraft: Boolean(j.draft),
            headSha: j.sha,
            mergeable: j.merge_status,
            checks: !pipe ? 'none' : pipe === 'success' ? 'passing' : ['failed', 'canceled'].includes(pipe) ? 'failing' : 'pending',
            failing: ['failed', 'canceled'].includes(pipe) ? ['pipeline'] : [],
            pending: pipe && !['success', 'failed', 'canceled'].includes(pipe) ? ['pipeline'] : []
          }
        } catch (e) {
          return { ok: false, checks: 'none', failing: [], pending: [], message: (e as Error).message }
        }
      }
      const r = await tool('gh', ['pr', 'view', url, '--json', 'state,isDraft,mergeable,headRefOid,statusCheckRollup,reviewDecision'], cwd)
      if (r.code !== 0) return { ok: false, checks: 'none', failing: [], pending: [], message: (r.stderr || r.stdout).trim() }
      try {
        const j = JSON.parse(r.stdout) as {
          state: 'OPEN' | 'MERGED' | 'CLOSED'
          isDraft: boolean
          mergeable: string
          headRefOid: string
          statusCheckRollup?: CheckRun[]
          reviewDecision?: string
        }
        const ru = rollup(j.statusCheckRollup)
        return { ok: true, state: j.state, isDraft: j.isDraft, mergeable: j.mergeable, headSha: j.headRefOid, reviewDecision: j.reviewDecision || undefined, ...ru }
      } catch (e) {
        return { ok: false, checks: 'none', failing: [], pending: [], message: (e as Error).message }
      }
    },

    async merge(url, cwd, opts = {}): Promise<OpResult> {
      const v = await svc.view(url, cwd)
      if (!v.ok) return { ok: false, message: `Could not read the PR: ${v.message ?? 'unknown error'}` }
      if (v.state === 'MERGED') return { ok: true, message: `Already merged: ${url}` }
      if (v.state !== 'OPEN') return { ok: false, message: `PR is ${v.state?.toLowerCase()}, not open: ${url}` }
      if (v.isDraft && !opts.override) return { ok: false, message: `PR is a draft; refusing to merge: ${url}` }
      if (v.mergeable === 'CONFLICTING') return { ok: false, message: `PR has merge conflicts; the unit must rebase first: ${url}` }
      if (v.checks === 'failing' && !opts.override) return { ok: false, message: `Refusing to merge a red PR. Failing checks: ${v.failing.join(', ')}` }
      if (v.checks === 'pending' && !opts.override) return { ok: false, message: `Checks still running: ${v.pending.join(', ')}. Merge once they report green.` }
      let r: ExecResult
      // A cleared draft is marked ready first: the forge never squash-merges a draft.
      if (v.isDraft) {
        r = isGitlab(url) ? await tool('glab', ['mr', 'update', url, '--ready'], cwd) : await tool('gh', ['pr', 'ready', url], cwd)
        if (r.code !== 0) return { ok: false, message: `Could not mark the draft ready: ${(r.stderr || r.stdout).trim()}` }
      }
      if (isGitlab(url)) {
        r = await tool('glab', ['mr', 'merge', url, '--squash', '--yes', ...(v.headSha ? ['--sha', v.headSha] : [])], cwd, 300_000)
      } else {
        r = await tool('gh', ['pr', 'merge', url, '--squash', ...(v.headSha ? ['--match-head-commit', v.headSha] : [])], cwd, 300_000)
      }
      if (r.code !== 0) return { ok: false, message: `Merge refused: ${(r.stderr || r.stdout).trim()}` }
      // read back: an unproved merge is never reported as landed
      for (let i = 0; i < 5; i++) {
        const back = await svc.view(url, cwd)
        if (back.state === 'MERGED') return { ok: true, message: `Merged ${url}` }
        await new Promise((res) => setTimeout(res, 2000))
      }
      return { ok: false, message: `Merge command ran but the PR does not read back as merged yet (it may be queued): ${url}` }
    },

    async findPrForBranch(cwd, branch) {
      if (which('gh')) {
        const r = await tool('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url', '--limit', '1'], cwd)
        try {
          const arr = JSON.parse(r.stdout) as { url: string }[]
          if (arr[0]?.url) return arr[0].url
        } catch {
          /* fall through */
        }
      }
      if (which('glab')) {
        const r = await tool('glab', ['mr', 'list', '--source-branch', branch, '--output', 'json'], cwd)
        try {
          const arr = JSON.parse(r.stdout) as { web_url: string }[]
          if (arr[0]?.web_url) return arr[0].web_url
        } catch {
          /* ignore */
        }
      }
      return undefined
    },

    async myOpenPrs() {
      if (!which('gh')) return []
      const r = await tool('gh', ['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'url,title,repository', '--limit', '50'])
      try {
        const arr = JSON.parse(r.stdout) as { url: string; title: string; repository: { nameWithOwner?: string; name?: string } }[]
        const out: { url: string; title: string; repo: string; checks: string }[] = []
        for (const p of arr) {
          const v = await svc.view(p.url)
          out.push({ url: p.url, title: p.title, repo: p.repository?.nameWithOwner ?? p.repository?.name ?? '', checks: v.ok ? v.checks : 'unknown' })
        }
        return out
      } catch {
        return []
      }
    }
  }
  return svc
}
