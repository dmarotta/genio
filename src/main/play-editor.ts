import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function unityVersion(root: string): string | undefined {
  try { return fs.readFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*([\w.]+)\s*$/m)?.[1] } catch { return undefined }
}
export function unityEditor(root: string, bases?: string[]): string | undefined {
  const version = unityVersion(root)
  if (!version) return undefined
  if (!bases) {
    bases = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor')] : process.platform === 'darwin' ? ['/Applications/Unity/Hub/Editor'] : [path.join(os.homedir(), 'Unity/Hub/Editor')]
    try {
      const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'UnityHub/secondaryInstallPath.json'), 'utf8'))
      const secondary = typeof config === 'string' ? config : config.secondaryInstallPath
      if (typeof secondary === 'string') bases.unshift(secondary)
    } catch { /* Hub custom install path is optional. */ }
  }
  return bases.map(base => path.join(base, version, process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : process.platform === 'win32' ? 'Editor/Unity.exe' : 'Editor/Unity')).find(p => fs.existsSync(p))
}
/** Marker for the Gauntlet's managed test step; target and executable come from its config. */
export function unityTestCommand(_root: string, _relativeRoot = '.'): string {
  return 'genio-unity test --mode EditMode'
}
export function isLegacyUnityTest(command?: string): boolean {
  return !!command && /^Unity -batchmode -projectPath (?:\.|"[^"\r\n]+") -runTests -testPlatform EditMode -logFile -$/i.test(command)
}
export function isDefaultUnityTest(command?: string): boolean {
  if (command === unityTestCommand('')) return true
  return isLegacyUnityTest(command) || !!command && /^(?:"[^"\r\n]+[\\/]Editor[\\/]Unity\.exe"|'[^'\r\n]+[\\/](?:Editor[\\/]Unity|Unity\.app[\\/]Contents[\\/]MacOS[\\/]Unity)') -batchmode -projectPath (?:\.|"[^"\r\n]+"|'[^'\r\n]+') -runTests -testPlatform EditMode -logFile -$/.test(command)
}
