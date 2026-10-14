/**
 * Windows toast identity. Windows attributes a toast (name + small icon) from
 * what is registered for the app's AppUserModelID: a Start Menu shortcut
 * carrying that AUMID and/or HKCU\Software\Classes\AppUserModelId\<AUMID>.
 * An unpackaged run (npm run dev / npm start) is electron.exe, so without
 * these it is attributed to Electron. We keep both pointing at Genio.
 *
 * Electron itself also writes Start Menu\Programs\<exe product name>.lnk with
 * the AUMID on the first notification: "Genio.lnk" when packaged, but
 * "Electron.lnk" when unpackaged, which is why the registry identity matters.
 * That Electron.lnk has electron.exe's own icon, and the taskbar may pick it for
 * the AUMID; repairElectronShortcut removes it, and every window carries its own
 * taskbar details (windowAppDetails) so the shell never has to guess.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, shell, type AppDetailsOptions, type ShortcutDetails } from 'electron'

export const APP_ID = 'dev.genio.app'
/** fixed so every shortcut Electron or Genio writes routes toast clicks the same way */
export const TOAST_CLSID = '{E651F47E-95DB-49C7-B18E-7CB03511561E}'

/**
 * Genio's icon on disk. appRoot is the checkout in dev and resources/app when
 * packaged (asar is off in electron-builder.yml), so the shell can read it too.
 */
export function genioIcon(appRoot: string, kind: 'ico' | 'png' = 'ico'): string {
  return path.join(appRoot, 'resources', `icon.${kind}`)
}

/** Windows takes every size (taskbar, Alt-Tab, Task View) from the multi-size .ico. */
export function windowIcon(appRoot: string, platform: NodeJS.Platform = process.platform): string {
  return genioIcon(appRoot, platform === 'win32' ? 'ico' : 'png')
}

function quoteArg(value: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error(`Cannot quote ${JSON.stringify(value)} for a relaunch command`)
  // A trailing backslash would escape the closing quote ("C:\" → C:\.).
  return `"${value.endsWith('\\') ? value + '.' : value}"`
}

/**
 * `genio <folder>` as a shell command: the exe, the app entry when it runs as
 * electron.exe, then the folder after `--` (see projectFromArgv).
 */
export function relaunchCommand(exe: string, devEntry: string | undefined, folder?: string): string {
  return [exe, ...(devEntry ? [devEntry] : [])].map(quoteArg).join(' ') + (folder ? ` -- ${quoteArg(path.resolve(folder))}` : '')
}

export interface Runtime { exe: string; devEntry?: string }
const runtime = (appRoot: string): Runtime => ({ exe: process.execPath, devEntry: process.defaultApp ? appRoot : undefined })

/**
 * Taskbar identity for one window (Hub without a folder, project and pop-out
 * windows with theirs). Without it the shell falls back to whichever Start Menu
 * shortcut carries the AUMID, which may be Electron's.
 */
export function windowAppDetails(appRoot: string, folder?: string, run: Runtime = runtime(appRoot)): AppDetailsOptions {
  return {
    appId: APP_ID,
    appIconPath: genioIcon(appRoot),
    appIconIndex: 0,
    relaunchCommand: relaunchCommand(run.exe, run.devEntry, folder),
    relaunchDisplayName: 'Genio'
  }
}

export const startMenuPrograms = (): string => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')

export interface ShortcutIo {
  read(file: string): ShortcutDetails
  write(file: string, details: ShortcutDetails): boolean
  remove(file: string): void
}
const shellIo: ShortcutIo = {
  read: file => shell.readShortcutLink(file),
  write: (file, details) => shell.writeShortcutLink(file, 'update', details),
  remove: file => fs.unlinkSync(file)
}

/**
 * Electron.lnk (written by Electron for an unpackaged run) is ours only when it
 * carries APP_ID; any other Electron app's shortcut is left alone. With a Genio.lnk
 * owning the AUMID it is removed, otherwise rebranded in place so toasts still work.
 */
export function repairElectronShortcut(programs: string, appRoot: string, io: ShortcutIo = shellIo, log: (line: string) => void = console.info): 'none' | 'removed' | 'rebranded' {
  const lnk = path.join(programs, 'Electron.lnk')
  try {
    if (!fs.existsSync(lnk)) return 'none'
    const have = io.read(lnk)
    if (have.appUserModelId !== APP_ID) return 'none'
    const genio = path.join(programs, 'Genio.lnk')
    let owned = false
    try { owned = fs.existsSync(genio) && io.read(genio).appUserModelId === APP_ID } catch { /* unreadable: not an owner */ }
    if (owned) {
      io.remove(lnk)
      log(`[win-identity] removed ${lnk}: it carried ${APP_ID} with Electron's icon; Genio.lnk owns the identity`)
      return 'removed'
    }
    const icon = genioIcon(appRoot)
    if (have.icon === icon && have.description === 'Genio') return 'none'
    io.write(lnk, { ...have, icon, iconIndex: 0, description: 'Genio', toastActivatorClsid: TOAST_CLSID })
    log(`[win-identity] rebranded ${lnk} with Genio's icon: no Genio.lnk owns ${APP_ID}`)
    return 'rebranded'
  } catch (error) {
    log(`[win-identity] could not repair ${lnk}: ${(error as Error)?.message ?? error}`)
    return 'none'
  }
}

let notified = false
/** Electron writes its Electron.lnk while showing the first notification; repair it once that has happened. */
export function afterFirstNotification(appRoot: string, shown: (done: () => void) => void): void {
  if (notified || process.platform !== 'win32' || process.env.GENIO_CAPTURE_DIR) return
  notified = true
  const repair = (): void => void repairElectronShortcut(startMenuPrograms(), appRoot)
  shown(repair)
  // The shortcut may land after the toast; a second pass is a no-op when nothing is there.
  setTimeout(repair, 5000).unref?.()
}

/** Call before app ready, before any notification is shown. */
export function setWindowsAppId(): void {
  app.setAppUserModelId(APP_ID)
  if (process.platform === 'win32') {
    try {
      app.setToastActivatorCLSID(TOAST_CLSID)
    } catch {
      /* Electron picks a random one per run */
    }
  }
}

export function ensureWindowsToastIdentity(appRoot: string): void {
  if (process.platform !== 'win32') return
  writeShortcut(appRoot)
  registerAumid(appRoot)
  repairElectronShortcut(startMenuPrograms(), appRoot)
}

function writeShortcut(appRoot: string): void {
  try {
    const lnk = path.join(startMenuPrograms(), 'Genio.lnk')
    // packaged: the exe carries the icon; unpackaged: electron.exe runs the project root
    const icon = app.isPackaged ? process.execPath : genioIcon(appRoot)
    if (fs.existsSync(lnk)) {
      // Keep a working shortcut (another checkout may own it): only the AUMID
      // and icon matter for toasts.
      const have = shell.readShortcutLink(lnk)
      const ok = have.appUserModelId === APP_ID && fs.existsSync(have.target) && !!have.icon && fs.existsSync(have.icon)
      if (ok) {
        if (have.toastActivatorClsid !== TOAST_CLSID) shell.writeShortcutLink(lnk, 'update', { target: have.target, toastActivatorClsid: TOAST_CLSID })
        return
      }
    }
    const want: ShortcutDetails = {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${appRoot}"`,
      cwd: app.isPackaged ? path.dirname(process.execPath) : appRoot,
      description: 'Genio',
      icon,
      iconIndex: 0,
      appUserModelId: APP_ID,
      toastActivatorClsid: TOAST_CLSID
    }
    fs.mkdirSync(path.dirname(lnk), { recursive: true })
    shell.writeShortcutLink(lnk, 'create', want)
  } catch {
    /* toasts fall back to whatever else is registered */
  }
}

/** The documented identity for unpackaged apps: display name + icon per AUMID. */
function registerAumid(appRoot: string): void {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`
  const iconFile = genioIcon(appRoot, 'png')
  const values: [string, string][] = [['DisplayName', 'Genio']]
  if (fs.existsSync(iconFile)) values.push(['IconUri', iconFile])
  for (const [name, data] of values) {
    execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_EXPAND_SZ', '/d', data, '/f'], { windowsHide: true }, () => undefined)
  }
}
