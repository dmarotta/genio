/**
 * Per-task git hooks for unit commits: chain the world's own hooks, strip other
 * AI co-author trailers, and add Genio's own trailer. Installed through env
 * (GIT_CONFIG_COUNT / core.hooksPath), so world repos' hooks and config stay untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as git from './git'
import { ensureDir, fwd, writeText } from './util'

export const DEFAULT_GENIO_CO_AUTHOR = 'Genio <noreply@genio.invalid>'

export const TRAILER_FILTER = /^(Co-Authored-By:.*(Claude|Anthropic|OpenAI|GPT|Codex|Gemini|Copilot|Cursor|Grok|Aider|noreply@anthropic\.com).*|.*Generated with \[?Claude Code.*|.*🤖 Generated with.*)$/i

export interface UnitHookOptions {
  stripAiTrailers: boolean
  genioCoAuthor: boolean
  /** trailer identity, `Name <email>` */
  genioCoAuthorIdentity?: string
}

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/** The commit-msg hook body: world hook first, then strip, then Genio's trailer (once). */
export function commitMsgHook(orig: string, o: UnitHookOptions): string {
  let s = `#!/bin/sh\nif [ -x "${orig}/commit-msg" ]; then "${orig}/commit-msg" "$@" || exit $?; fi\n`
  if (o.stripAiTrailers) {
    s += `tmp="$1.genio"\ngrep -Eiv ${sq(TRAILER_FILTER.source)} "$1" > "$tmp" || true\nmv "$tmp" "$1"\n`
  }
  if (o.genioCoAuthor) {
    const who = (o.genioCoAuthorIdentity ?? '').trim() || DEFAULT_GENIO_CO_AUTHOR
    // an empty message must stay empty so git still aborts the commit
    s +=
      `if grep -qv -e '^#' -e '^[[:space:]]*$' "$1"; then\n` +
      `  git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${sq(`Co-authored-by: ${who}`)} "$1" || exit $?\n` +
      `fi\n`
  }
  return s + 'exit 0\n'
}

/** Write the hooks into `dir` and return the env that points git at them; {} when nothing is on. */
export async function installUnitHooks(dir: string, repo: string, o: UnitHookOptions): Promise<Record<string, string>> {
  if (!o.stripAiTrailers && !o.genioCoAuthor) return {}
  ensureDir(dir)
  const configured = (await git.git(repo, ['config', '--get', 'core.hooksPath'])).stdout.trim()
  const original = configured
    ? path.resolve(repo, configured)
    : path.resolve(repo, (await git.git(repo, ['rev-parse', '--git-path', 'hooks'])).stdout.trim() || '.git/hooks')
  const orig = fwd(original)
  const names = ['pre-commit', 'prepare-commit-msg', 'post-commit', 'pre-push', 'post-checkout', 'post-merge', 'pre-rebase']
  for (const n of names) {
    writeText(path.join(dir, n), `#!/bin/sh\n[ -x "${orig}/${n}" ] && exec "${orig}/${n}" "$@"\nexit 0\n`)
  }
  writeText(path.join(dir, 'commit-msg'), commitMsgHook(orig, o))
  for (const n of [...names, 'commit-msg']) {
    try {
      fs.chmodSync(path.join(dir, n), 0o755)
    } catch {
      /* windows */
    }
  }
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: fwd(dir) }
}
