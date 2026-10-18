import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createExplorerIntegration, explorerCommand, EXPLORER_KEYS } from '../src/main/explorer'
import { projectFromArgv } from '../src/main/project-windows'
import { ACHIEVEMENTS } from '../src/main/stats'

function registry() {
  const values = new Map<string, string>()
  const run = vi.fn(async (args: string[]) => {
    const [action, key] = args
    if (action === 'query') {
      if (!values.has(key)) throw Object.assign(new Error('missing'), { code: 1 })
      return `REG_SZ    ${values.get(key)}`
    }
    if (action === 'add') values.set(key, args[args.indexOf('/d') + 1])
    if (action === 'delete') for (const stored of values.keys()) if (stored === key || stored.startsWith(key + '\\')) values.delete(stored)
    return ''
  })
  return { run, values }
}

describe('Explorer integration (mock registry only)', () => {
  const command = explorerCommand('C:\\Program Files\\Genio\\Genio.exe')
  it('does not write at construction or on status reads, and disables other platforms', async () => {
    const { run } = registry()
    const service = createExplorerIntegration(command, 'win32', run)
    expect(run).not.toHaveBeenCalled()
    expect(await service.status()).toEqual({ available: true, installed: false, present: false })
    expect(run.mock.calls.every(([args]) => args[0] === 'query')).toBe(true)
    run.mockClear()
    const other = createExplorerIntegration(command, 'linux', run)
    expect((await other.status()).available).toBe(false)
    await expect(other.set(true)).rejects.toThrow('Windows')
    expect(run).not.toHaveBeenCalled()
  })
  it('installs both per-user menus with literal quoted data and removes only its keys', async () => {
    const { run, values } = registry()
    values.set('HKCU\\Software\\Classes\\Directory\\shell\\Other', 'Other')
    const service = createExplorerIntegration(command, 'win32', run)
    expect((await service.set(true)).installed).toBe(true)
    for (const key of EXPLORER_KEYS) {
      expect(values.get(key)).toBe('Open with Genio')
      expect(values.get(key + '\\command')).toBe('"C:\\Program Files\\Genio\\Genio.exe" -- "%V\\."')
    }
    expect((await service.set(false)).present).toBe(false)
    expect(values.size).toBe(1)
    await service.set(false)
    expect(run.mock.calls.filter(([args]) => args[0] === 'delete')).toHaveLength(2)
  })
  it('detects old and partial installs and repairs or removes them', async () => {
    const { run, values } = registry()
    values.set(EXPLORER_KEYS[0], 'Open with Genio')
    values.set(EXPLORER_KEYS[0] + '\\command', 'old.exe')
    const service = createExplorerIntegration(command, 'win32', run)
    expect(await service.status()).toMatchObject({ installed: false, present: true })
    expect((await service.set(true)).installed).toBe(true)
    expect((await service.set(false)).present).toBe(false)
  })
  it('surfaces write failures and allows removal of a failed partial install', async () => {
    const { run, values } = registry()
    const failing = vi.fn(async (args: string[]) => {
      if (args[0] === 'add' && args[1].endsWith('command')) throw new Error('access denied')
      return run(args)
    })
    const service = createExplorerIntegration(command, 'win32', failing)
    await expect(service.set(true)).rejects.toThrow('access denied')
    expect(await service.status()).toMatchObject({ installed: false, present: true })
    await service.set(false)
    expect(values.size).toBe(0)
  })
  it('serializes explicit actions and propagates unexpected query failures', async () => {
    const { run } = registry()
    const service = createExplorerIntegration(command, 'win32', run)
    await Promise.all([service.set(true), service.set(false)])
    expect((await service.status()).present).toBe(false)
    const denied = createExplorerIntegration(command, 'win32', async () => { throw new Error('cannot execute registry tool') })
    await expect(denied.status()).rejects.toThrow('cannot execute')
  })
  it('supports packaged and dev argv through the existing project entry and guards the achievement', () => {
    expect(explorerCommand('electron.exe', 'C:\\Apps\\Genio & friends')).toBe('"electron.exe" "C:\\Apps\\Genio & friends" -- "%V\\."')
    expect(projectFromArgv(['Genio.exe', '--', 'game'], process.cwd(), false)).toBeTruthy()
    expect(projectFromArgv(['electron.exe', 'app', '--', 'game'], process.cwd(), true)).toBeTruthy()
    expect(() => explorerCommand('bad"path')).toThrow('Invalid')
    expect(ACHIEVEMENTS.find(a => a.id === 'explorer-install')?.feature).toBe('explorer')
    const ipc = readFileSync('src/main/ipc.ts', 'utf8')
    expect(ipc).toContain("if (enabled && state.installed) ctx().stats.unlock('explorer-install')")
    const systems = readFileSync('src/renderer/src/views/Systems.tsx', 'utf8')
    expect(systems).toContain('api().explorerSet(!remove)')
    // One button: Install, or Remove in the danger style once installed.
    expect(systems).toContain("{remove ? 'Remove' : 'Install'}")
    expect(systems).toContain("cx('btn sm', remove && 'alert')")
  })
})
