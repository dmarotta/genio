import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Capture tours are test runs, including tours started directly by visual-check units. */
export function captureUserData(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.GENIO_CAPTURE_DIR) return undefined
  const fail = (): never => { throw new Error('Capture requires isolated temp homes. Launch with npm run capture -- <output-dir> (see docs/performance.md).') }
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child)
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  if (!rootValid(env.GENIO_CAPTURE_ROOT, env.GENIO_TEST_SYSTEM_TMP || os.tmpdir(), inside)) fail()
  const root = fs.realpathSync(env.GENIO_CAPTURE_ROOT!)
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'GENIO_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = env[key]
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value) || !inside(root, fs.realpathSync(value))) fail()
  }
  return path.join(root, 'electron-user-data')
}

function rootValid(root: string | undefined, systemTmp: string, inside: (parent: string, child: string) => boolean): boolean {
  return !!root && path.isAbsolute(root) && fs.existsSync(root) && inside(fs.realpathSync(systemTmp), fs.realpathSync(root))
}
