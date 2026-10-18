/** Shared by the installed batch runner, the Modeller and the Systems toolchain probe. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const output = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}
const executable = (p) => p && /^blender(?:\.exe)?$/i.test(path.basename(p)) && fs.statSync(p, { throwIfNoEntry: false })?.isFile()
const version = (p) => (output(p, ['--version']).match(/^Blender ([\d.]+)/m)?.[1] ?? '0').split('.').map(Number)
const newerFirst = (a, b) => {
  for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) {
    const d = (b.v[i] ?? 0) - (a.v[i] ?? 0)
    if (d) return d
  }
  return a.p.localeCompare(b.p)
}
const probe = (candidates) => [...new Set(candidates)].filter(executable).map(p => ({ p, v: version(p) }))
function newest(candidates) {
  return probe(candidates).sort(newerFirst)[0]?.p ?? null
}
/** Version of one executable as [major, minor, patch], or null when it is not Blender. */
export function blenderVersion(p) {
  if (!executable(p)) return null
  const v = version(p)
  return v[0] ? v : null
}
export function findBlender() {
  if (process.env.GENIO_BLENDER) return executable(process.env.GENIO_BLENDER) ? process.env.GENIO_BLENDER : null
  for (const tier of candidateTiers()) {
    const found = newest(tier)
    if (found) return found
  }
  return null
}
/**
 * Genio's machine-wide Blender cache: compiled Python shared by every run (`pyc`, see blender.mjs) and the
 * Modeller's list of installed Blenders (`blenders.json`). GENIO_BLENDER_CACHE moves it. The default is short
 * on purpose: Windows' 260-character path limit applies to every compiled module under it.
 */
export function blenderCacheDir(env = process.env) {
  return env.GENIO_BLENDER_CACHE ? path.resolve(env.GENIO_BLENDER_CACHE) : path.join(os.tmpdir(), 'genio-blender')
}

/** How long listBlenders reuses its answer: the registry search behind it takes about 1.5 s on Windows. */
export const LIST_TTL_MS = 7 * 24 * 3600_000

const stamp = (p) => {
  const st = fs.statSync(p, { throwIfNoEntry: false })
  return st ? { size: st.size, mtimeMs: Math.round(st.mtimeMs) } : null
}
const sameStamp = (a, b) => Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs)
const realKey = (p) => fs.realpathSync(p).toLowerCase()
const readList = (file) => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(j?.list) && Array.isArray(j?.seen) && Number.isFinite(j?.at) ? j : null
  } catch { return null }
}

/**
 * Every installed Blender found in any tier, newest first, with its version. The answer is kept in
 * blenders.json and reused for LIST_TTL_MS unless `fresh`, a listed binary changed or went away, or the
 * quick tiers (Program Files, Steam, PATH) show a Blender the last search did not see. A new search asks
 * `--version` only of binaries that changed since the last one.
 */
export function listBlenders({ fresh = false, env = process.env } = {}) {
  const file = path.join(blenderCacheDir(env), 'blenders.json')
  const last = readList(file)
  const answer = (list) => list.map(b => ({ path: b.path, version: b.version }))
  if (!fresh && last && Date.now() - last.at < LIST_TTL_MS && last.list.every(b => sameStamp(stamp(b.path), b)) &&
    quickTiers().flat().filter(executable).every(p => last.seen.includes(realKey(p)))) return answer(last.list)
  const unique = new Map()
  for (const p of candidateTiers().flat().filter(executable)) {
    const key = realKey(p)
    if (!unique.has(key)) unique.set(key, p)
  }
  const known = new Map((last?.list ?? []).map(b => [b.path, b]))
  const list = [...unique.values()].map(p => {
    const st = stamp(p), was = known.get(p)
    return { p, v: sameStamp(st, was) ? was.version : version(p), ...st }
  }).filter(b => b.v[0]).sort(newerFirst).map(b => ({ path: b.p, version: b.v, size: b.size, mtimeMs: b.mtimeMs }))
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), seen: [...unique.keys()], list }))
    fs.renameSync(tmp, file)
  } catch { /* the next call searches again */ }
  return answer(list)
}
/**
 * The Modeller's choice among installed Blenders: 4.2 LTS when present (a headless
 * start with the step runner's imports takes 1.0 s against 1.5 s for 5.2, both with
 * the bytecode cache, measured), otherwise the newest 4.2-or-later. Older
 * versions miss APIs the Modeller helpers use.
 */
export function pickModellerBlender(found) {
  const usable = found.filter(b => b.version[0] > 4 || (b.version[0] === 4 && b.version[1] >= 2))
  return usable.find(b => b.version[0] === 4 && b.version[1] === 2) ?? usable[0] ?? null
}
function candidateTiers() {
  return process.platform === 'win32' ? [registryTier(), ...quickTiers()] : quickTiers()
}
/** Blenders the Windows Uninstall keys name: the slow tier (about 1.2 s of `reg query /s`). */
function registryTier() {
  const registry = []
  for (const root of ['HKCU\\Software', 'HKLM\\Software', 'HKLM\\Software\\WOW6432Node']) {
    const raw = output('reg.exe', ['query', `${root}\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s'])
    for (const block of raw.split(/\r?\n(?=HKEY_)/)) {
      if (!/DisplayName\s+REG_SZ\s+Blender\b/i.test(block)) continue
      const location = block.match(/InstallLocation\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim()
      if (location) registry.push(path.join(location.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`), 'blender.exe'))
      const icon = block.match(/DisplayIcon\s+REG_SZ\s+"?([^\r\n]+?blender\.exe)/i)?.[1]
      if (icon) registry.push(icon)
    }
  }
  return registry
}
/** Program Files, Steam libraries and PATH: folder listings and one registry value, a few tens of ms. */
function quickTiers() {
  const tiers = []
  if (process.platform === 'win32') {
    const folders = []
    for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const dir = path.join(base, 'Blender Foundation')
      try { for (const entry of fs.readdirSync(dir)) folders.push(path.join(dir, entry, 'blender.exe')) } catch { /* absent */ }
    }
    tiers.push(folders)
    const steamRoots = [path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Steam')]
    const steamPath = output('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']).match(/SteamPath\s+REG_SZ\s+([^\r\n]+)/)?.[1]?.trim()
    if (steamPath) steamRoots.push(steamPath)
    for (const root of [...steamRoots]) {
      try {
        const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) steamRoots.push(m[1].replace(/\\\\/g, '\\'))
      } catch { /* absent */ }
    }
    tiers.push(steamRoots.map(p => path.join(p, 'steamapps', 'common', 'Blender', 'blender.exe')))
  }
  const paths = (process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, process.platform === 'win32' ? 'blender.exe' : 'blender'))
  if (process.platform === 'darwin') paths.unshift('/Applications/Blender.app/Contents/MacOS/Blender')
  tiers.push(paths)
  return tiers
}
