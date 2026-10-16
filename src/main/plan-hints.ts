/**
 * Rebase hints for plan steps: the files a landed step changed that another
 * step working at the same time said it would touch. Always-hot files (shared
 * types, the IPC surface, global CSS, tsconfigs, lockfiles) are left out: they
 * appear in most concurrent pairs, so a hint on them would be noise.
 */

const ALWAYS_HOT: RegExp[] = [
  /(^|\/)types\.ts$/i,
  /(^|\/)api\.ts$/i,
  /(^|\/)ipc\.ts$/i,
  /(^|\/)app\.css$/i,
  /(^|\/)tsconfig[^/]*\.json$/i,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|packages-lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/i
]

const norm = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\.\//, '')

export function isAlwaysHot(file: string): boolean {
  const f = norm(file)
  return ALWAYS_HOT.some((re) => re.test(f))
}

function globRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/** A file hint: a path, a folder (everything under it), a bare file name (any folder) or a glob. */
export function matchesHint(file: string, hint: string): boolean {
  const f = norm(file)
  const h = norm(hint).replace(/\/+$/, '')
  if (!h) return false
  if (/[*?]/.test(h)) return globRegExp(h).test(f) || (!h.includes('/') && globRegExp(h).test(f.split('/').pop()!))
  const lf = f.toLowerCase()
  const lh = h.toLowerCase()
  if (lf === lh || lf.startsWith(`${lh}/`)) return true
  return !lh.includes('/') && lf.split('/').pop() === lh
}

/** The landed files another step's hints cover, always-hot files left out. */
export function hintOverlap(landed: string[], hints: string[]): string[] {
  if (!hints.length) return []
  return landed.filter((f) => !isAlwaysHot(f) && hints.some((h) => matchesHint(f, h)))
}
