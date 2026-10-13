import { execFile } from 'node:child_process'
import path from 'node:path'
import type { ExplorerStatus } from '@shared/api'

export const EXPLORER_KEYS = [
  'HKCU\\Software\\Classes\\Directory\\shell\\Genio',
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Genio'
]
export type RegistryRunner = (args: string[]) => Promise<string>
const runRegistry: RegistryRunner = args => new Promise((resolve, reject) => {
  execFile(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), args,
    { windowsHide: true, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

/** No shell interpolation: these strings are stored as registry data. */
export function explorerCommand(exe: string, developmentEntry?: string): string {
  const quote = (value: string): string => {
    if (/["\r\n\0]/.test(value)) throw new Error('Invalid application path')
    return `"${value}"`
  }
  // The dot suffix keeps a drive root's trailing backslash away from the closing quote.
  return `${quote(exe)}${developmentEntry ? ' ' + quote(developmentEntry) : ''} -- "%V\\."`
}

/** Construction and status reads never write. Only the explicit Settings action calls set(). */
export function createExplorerIntegration(command: string, platform = process.platform, run: RegistryRunner = runRegistry) {
  let queue: Promise<unknown> = Promise.resolve()
  async function query(key: string, defaultValue = false): Promise<string | undefined> {
    try { return await run(['query', key, ...(defaultValue ? ['/ve'] : [])]) }
    catch (error) {
      if ((error as { code?: number }).code === 1) return undefined
      throw error
    }
  }
  async function status(): Promise<ExplorerStatus> {
    if (platform !== 'win32') return { available: false, installed: false, present: false }
    const values = await Promise.all(EXPLORER_KEYS.map(key => query(key + '\\command', true)))
    const roots = await Promise.all(EXPLORER_KEYS.map(key => query(key)))
    return { available: true, installed: values.every(value => value?.split(/\r?\n/).some(line => line.match(/\bREG_SZ\s+(.*)$/)?.[1] === command)), present: roots.some(value => value !== undefined) }
  }
  function set(enabled: boolean): Promise<ExplorerStatus> {
    const operation = queue.then(async () => {
      if (platform !== 'win32') throw new Error('Explorer integration requires Windows')
      if (typeof enabled !== 'boolean') throw new Error('Expected an install or uninstall action')
      for (const key of EXPLORER_KEYS) {
        if (enabled) {
          await run(['add', key, '/ve', '/t', 'REG_SZ', '/d', 'Open with Genio', '/f'])
          await run(['add', key + '\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f'])
        } else if (await query(key) !== undefined) {
          await run(['delete', key, '/f'])
        }
      }
      return status()
    })
    queue = operation.catch(() => undefined)
    return operation
  }
  return { status, set }
}
