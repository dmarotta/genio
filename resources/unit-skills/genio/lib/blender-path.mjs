/** Shared by the installed batch runner and the Systems toolchain probe. */
import fs from 'node:fs'
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
/** Every installed Blender found in any tier, newest first, with its version. */
export function listBlenders() {
  const unique = new Map()
  for (const p of candidateTiers().flat().filter(executable)) {
    const key = fs.realpathSync(p).toLowerCase()
    if (!unique.has(key)) unique.set(key, p)
  }
  return probe([...unique.values()]).filter(b => b.v[0]).sort(newerFirst).map(b => ({ path: b.p, version: b.v }))
}
/**
 * The Modeller's choice among installed Blenders: 4.2 LTS when present (it starts
 * 2-4x faster than 5.x, measured), otherwise the newest 4.2-or-later. Older
 * versions miss APIs the Modeller helpers use.
 */
export function pickModellerBlender(found) {
  const usable = found.filter(b => b.version[0] > 4 || (b.version[0] === 4 && b.version[1] >= 2))
  return usable.find(b => b.version[0] === 4 && b.version[1] === 2) ?? usable[0] ?? null
}
function candidateTiers() {
  const tiers = []
  if (process.platform === 'win32') {
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
    tiers.push(registry)
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
