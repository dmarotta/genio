import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertTempPath } from './support/isolated-homes.mjs'

// A fake shell over a fake Start Menu: nothing here reads or writes a real shortcut or the registry.
const f = vi.hoisted(() => ({ links: new Map<string, Record<string, unknown>>(), appData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => f.appData, isPackaged: false, setAppUserModelId: vi.fn() },
  shell: {
    readShortcutLink: (file: string) => { const l = f.links.get(file); if (!l) throw new Error('not a shortcut'); return { ...l } },
    writeShortcutLink: (file: string, _op: string, details: Record<string, unknown>) => { f.links.set(file, details); return true }
  }
}))

import { APP_ID, TOAST_CLSID, afterFirstNotification, genioIcon, relaunchCommand, repairElectronShortcut, startMenuPrograms, windowAppDetails, windowIcon, type ShortcutIo } from '../src/main/win-identity'

const checkout = path.resolve('C:\\work\\genio')
const electronExe = path.join(checkout, 'node_modules', 'electron', 'dist', 'electron.exe')
let programs: string
let lines: string[]
const log = (line: string): void => void lines.push(line)

function io(): ShortcutIo & { removed: string[]; written: string[] } {
  const removed: string[] = []
  const written: string[] = []
  return {
    removed, written,
    read: file => { const l = f.links.get(file); if (!l) throw new Error('not a shortcut'); return { ...l } as never },
    write: (file, details) => { written.push(file); f.links.set(file, details as never); return true },
    remove: file => { removed.push(file); fs.unlinkSync(file); f.links.delete(file) }
  }
}
function link(name: string, details: Record<string, unknown>): string {
  const file = path.join(programs, name)
  fs.writeFileSync(file, '')
  f.links.set(file, details)
  return file
}

beforeEach(() => {
  f.appData = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-start-menu-'))
  assertTempPath(f.appData, 'fake AppData')
  programs = path.join(f.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  fs.mkdirSync(programs, { recursive: true })
  f.links.clear()
  lines = []
})
afterEach(() => fs.rmSync(f.appData, { recursive: true, force: true }))

describe('taskbar identity per window', () => {
  it('resolves the multi-size .ico from the checkout in dev and from the unpacked app when packaged', () => {
    expect(genioIcon(checkout)).toBe(path.join(checkout, 'resources', 'icon.ico'))
    expect(genioIcon(checkout, 'png')).toBe(path.join(checkout, 'resources', 'icon.png'))
    const packaged = path.resolve('C:\\Program Files\\Genio\\resources\\app')
    expect(genioIcon(packaged)).toBe(path.join(packaged, 'resources', 'icon.ico'))
    expect(windowIcon(checkout, 'win32')).toBe(genioIcon(checkout))
    expect(windowIcon(checkout, 'linux')).toBe(genioIcon(checkout, 'png'))
    // The repo assets these paths point at.
    for (const kind of ['ico', 'png'] as const) expect(fs.existsSync(genioIcon(process.cwd(), kind))).toBe(true)
  })

  it('relaunches the Hub as Genio and a project or pop-out window with its folder, quoted', () => {
    const dev = { exe: electronExe, devEntry: checkout }
    const hub = windowAppDetails(checkout, undefined, dev)
    expect(hub).toEqual({ appId: APP_ID, appIconPath: genioIcon(checkout), appIconIndex: 0, relaunchCommand: `"${electronExe}" "${checkout}"`, relaunchDisplayName: 'Genio' })
    const folder = path.resolve('D:\\Games\\Founders of Avalon')
    expect(windowAppDetails(checkout, folder, dev).relaunchCommand).toBe(`"${electronExe}" "${checkout}" -- "${folder}"`)
    const exe = 'C:\\Program Files\\Genio\\Genio.exe'
    const packaged = windowAppDetails('C:\\Program Files\\Genio\\resources\\app', folder, { exe })
    expect(packaged).toMatchObject({ appId: APP_ID, appIconPath: 'C:\\Program Files\\Genio\\resources\\app\\resources\\icon.ico', relaunchCommand: `"${exe}" -- "${folder}"`, relaunchDisplayName: 'Genio' })
  })

  it('keeps a drive root from escaping its closing quote and refuses unquotable paths', () => {
    if (process.platform === 'win32') expect(relaunchCommand('C:\\Genio\\Genio.exe', undefined, 'D:\\')).toBe('"C:\\Genio\\Genio.exe" -- "D:\\."')
    expect(() => relaunchCommand('C:\\Gen"io.exe', undefined)).toThrow(/quote/)
  })
})

describe('Electron.lnk identity repair (fake Start Menu)', () => {
  const genioLnk = { target: electronExe, args: `"${checkout}"`, icon: genioIcon(checkout), iconIndex: 0, appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID }
  const electronLnk = { target: electronExe, args: '', icon: '', iconIndex: 0, appUserModelId: APP_ID }

  it('removes the Electron.lnk that carries Genio\'s AUMID when Genio.lnk owns it, idempotently', () => {
    link('Genio.lnk', genioLnk)
    const electron = link('Electron.lnk', electronLnk)
    const shell = io()
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('removed')
    expect(shell.removed).toEqual([electron])
    expect(fs.existsSync(electron)).toBe(false)
    expect(fs.existsSync(path.join(programs, 'Genio.lnk'))).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/\[win-identity\] removed .*Electron\.lnk/)
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('none')
    expect(lines).toHaveLength(1)
  })

  it('never touches another Electron app\'s shortcut, an unreadable one or any other shortcut', () => {
    link('Genio.lnk', genioLnk)
    link('Electron.lnk', { ...electronLnk, appUserModelId: 'com.other.app' })
    link('Discord.lnk', { target: 'C:\\Discord.exe', appUserModelId: APP_ID })
    const shell = io()
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('none')
    f.links.delete(path.join(programs, 'Electron.lnk'))
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('none')
    fs.rmSync(path.join(programs, 'Electron.lnk'))
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('none')
    expect(shell.removed).toEqual([])
    expect(shell.written).toEqual([])
    expect(fs.readdirSync(programs).sort()).toEqual(['Discord.lnk', 'Genio.lnk'])
  })

  it('rebrands it in place when no Genio.lnk owns the AUMID, so toasts keep a shortcut', () => {
    link('Genio.lnk', { ...genioLnk, appUserModelId: 'com.other.app' })
    const electron = link('Electron.lnk', electronLnk)
    const shell = io()
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('rebranded')
    expect(f.links.get(electron)).toMatchObject({ target: electronExe, icon: genioIcon(checkout), iconIndex: 0, description: 'Genio', appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID })
    expect(lines[0]).toMatch(/rebranded/)
    expect(repairElectronShortcut(programs, checkout, shell, log)).toBe('none')
    expect(shell.written).toEqual([electron])
  })

  it.runIf(process.platform === 'win32')('repairs once after the first notification is shown, in the AppData Start Menu', () => {
    vi.useFakeTimers()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      expect(startMenuPrograms()).toBe(programs)
      link('Genio.lnk', genioLnk)
      let shown: (() => void) | undefined
      afterFirstNotification(checkout, repair => { shown = repair })
      // Electron writes its shortcut while showing the toast.
      const electron = link('Electron.lnk', electronLnk)
      shown!()
      expect(fs.existsSync(electron)).toBe(false)
      link('Electron.lnk', electronLnk)
      vi.advanceTimersByTime(5000)
      expect(fs.existsSync(electron)).toBe(false)
      expect(info).toHaveBeenCalledTimes(2)
      const later = vi.fn()
      afterFirstNotification(checkout, later)
      expect(later).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('Windows packaging', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  it('builds a branded Genio with resources as real files at the dev layout', () => {
    expect(pkg.devDependencies['electron-builder']).toBeTruthy()
    expect(pkg.scripts.dist).toMatch(/electron-builder .*--publish never/)
    const build = pkg.build
    expect(build).toMatchObject({ appId: APP_ID, productName: 'Genio', asar: false, win: { icon: 'resources/icon.ico' } })
    expect(fs.existsSync(build.win.icon)).toBe(true)
    // appRoot()/resources/... must hold when packaged: resources ship inside the app directory.
    expect(build.files).toEqual(expect.arrayContaining(['out/**/*', 'resources/**/*', 'package.json']))
    expect(build.publish).toBeNull()
  })
})
