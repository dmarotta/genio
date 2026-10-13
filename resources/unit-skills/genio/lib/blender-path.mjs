/** Shared by the installed batch runner and the Systems toolchain probe. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const output = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}
const executable = (p) => p && /^blender(?:\.exe)?$/i.test(path.basename(p)) && fs.statSync(p, { throwIfNoEntry: false })?.isFile()
const version = (p) => (output(p, ['--version']).match(/^Blender ([\d.]+)/m)?.[1] ?? '0').split('.').map(Number)
function newest(candidates) {
  const found = [...new Set(candidates)].filter(executable).map(p => ({ p, v: version(p) }))
  found.sort((a, b) => {
    for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) {
      const d = (b.v[i] ?? 0) - (a.v[i] ?? 0)
      if (d) return d
    }
    return a.p.localeCompare(b.p)
  })
  return found[0]?.p ?? null
}
export function findBlender() {
  if (process.env.GENIO_BLENDER) return executable(process.env.GENIO_BLENDER) ? process.env.GENIO_BLENDER : null
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
    const registered = newest(registry)
    if (registered) return registered
    const folders = []
    for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const dir = path.join(base, 'Blender Foundation')
      try { for (const entry of fs.readdirSync(dir)) folders.push(path.join(dir, entry, 'blender.exe')) } catch { /* absent */ }
    }
    const installed = newest(folders)
    if (installed) return installed
    const steamRoots = [path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Steam')]
    const steamPath = output('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']).match(/SteamPath\s+REG_SZ\s+([^\r\n]+)/)?.[1]?.trim()
    if (steamPath) steamRoots.push(steamPath)
    for (const root of [...steamRoots]) {
      try {
        const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) steamRoots.push(m[1].replace(/\\\\/g, '\\'))
      } catch { /* absent */ }
    }
    const steam = newest(steamRoots.map(p => path.join(p, 'steamapps', 'common', 'Blender', 'blender.exe')))
    if (steam) return steam
  }
  const paths = (process.env.PATH ?? '').split(path.delimiter).map(p => path.join(p, process.platform === 'win32' ? 'blender.exe' : 'blender'))
  if (process.platform === 'darwin') paths.unshift('/Applications/Blender.app/Contents/MacOS/Blender')
  return newest(paths)
}
