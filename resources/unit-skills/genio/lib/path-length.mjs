/**
 * Windows path length. Unity's Mono runtime ignores Windows' long-path support, so a file whose full path reaches
 * 260 characters (MAX_PATH, its terminating NUL included) cannot be opened: Unity hangs or fails while it loads
 * packages. Before a Play copy's or slot's editor starts, Genio estimates the project's longest path and warns.
 * Information only: nothing is blocked or changed. Node standard library only.
 */
import fs from 'node:fs'
import path from 'node:path'

export const WINDOWS_MAX_PATH = 260
/** Warn this many characters before the limit. */
export const PATH_MARGIN = 20
const TREES = ['Library/PackageCache', 'Packages', 'Assets']

/**
 * The longest path under root's Library/PackageCache, Packages and Assets: { length (absolute), rel, partial }.
 * packageCache: the Library/PackageCache to read when root has none yet (the main checkout's: a first start
 * unpacks the same packages). Bounded: stops after maxEntries entries or budgetMs and reports what it saw.
 */
export async function longestProjectPath(root, { packageCache, maxEntries = 400000, budgetMs = 5000, now = Date.now } = {}) {
  const base = path.resolve(root), started = now()
  let rel = '', seen = 0, partial = false
  const visit = async (dir, at) => {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++seen > maxEntries || now() - started > budgetMs) { partial = true; return }
      const r = `${at}${path.sep}${e.name}`
      if (r.length > rel.length) rel = r
      // Links are never followed (a Unity copy refuses them anyway).
      if (e.isDirectory()) await visit(path.join(dir, e.name), r)
      if (partial) return
    }
  }
  for (const tree of TREES) {
    const own = path.join(base, tree)
    const from = tree === 'Library/PackageCache' && packageCache && !fs.existsSync(own) ? packageCache : own
    if (!partial) await visit(from, tree.split('/').join(path.sep))
  }
  return { length: rel ? base.length + 1 + rel.length : base.length, rel, partial }
}

/** The one-line warning when the longest path is within PATH_MARGIN of the limit or over it; Windows only. */
export function pathWarning(longest, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !longest?.rel || longest.length < WINDOWS_MAX_PATH - PATH_MARGIN) return undefined
  const parts = longest.rel.split(/[\\/]/)
  // Library/PackageCache/<name>@<hash>/... or Packages/<name>/... names the package; else the top folder.
  const pkg = parts[0] === 'Library' ? parts[2]?.replace(/@[^@]*$/, '') : parts[0] === 'Packages' && parts.length > 2 ? parts[1] : undefined
  // The folder (prefix) and what is inside it, so the player sees what shortening the folder name can win.
  const inside = longest.rel.length, folder = longest.length - inside - 1, margin = WINDOWS_MAX_PATH - longest.length
  return `Paths in ${pkg ?? parts[0]} reach ${longest.length} characters (${folder} for the project's folder, ${inside} inside it), ${margin > 0 ? `close to Windows' 260 limit (${margin} to spare), so Unity may fail to load them if it adds to them` : `${-margin} over Windows' 260 limit, so Unity may fail to load them`}. ${pkg ? 'Remove that package or shorten the Unity folder name.' : `Shorten the folder names in ${parts[0]} or the Unity folder name.`}`
}

/** The pre-start check: the warning for root, or undefined (also on other platforms and on any scan error). */
export async function longPathWarning(root, { platform = process.platform, ...options } = {}) {
  if (platform !== 'win32') return undefined
  try { return pathWarning(await longestProjectPath(root, options), { platform }) } catch { return undefined }
}
