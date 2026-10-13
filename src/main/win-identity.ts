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
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app, shell, type ShortcutDetails } from 'electron'

export const APP_ID = 'dev.genio.app'
/** fixed so every shortcut Electron or Genio writes routes toast clicks the same way */
export const TOAST_CLSID = '{E651F47E-95DB-49C7-B18E-7CB03511561E}'

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
}

function writeShortcut(appRoot: string): void {
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Genio.lnk')
    // packaged: the exe carries the icon; unpackaged: electron.exe runs the project root
    const icon = app.isPackaged ? process.execPath : path.join(appRoot, 'resources', 'icon.ico')
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
  const iconFile = path.join(app.isPackaged ? process.resourcesPath : appRoot, 'resources', 'icon.png')
  const values: [string, string][] = [['DisplayName', 'Genio']]
  if (fs.existsSync(iconFile)) values.push(['IconUri', iconFile])
  for (const [name, data] of values) {
    execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_EXPAND_SZ', '/d', data, '/f'], { windowsHide: true }, () => undefined)
  }
}
