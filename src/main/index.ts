/**
 * Genio — Electron entry. One window, one Base. Everything durable lives in
 * the Base directory; this file only wires the window to the services.
 */
import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { EVENT_CHANNEL } from '@shared/api'
import { bus } from './bus'
import { createApp, getCtx, startApp, stopApp } from './ctx'
import { MEDIA_SCHEME, mediaResponse } from './fal-service'
import { chatImageDir, chatImagePath } from './chat-images'
import { defaultHomeRoot } from './home'
import { registerIpc } from './ipc'
import type { AppCtx } from './services'
import { nowIso, writeJson } from './util'
import { ensureWindowsToastIdentity, setWindowsAppId } from './win-identity'

const TERM_CHANNEL = 'genio:term-data'
const LIVE_STATES = new Set(['spawning', 'working', 'paused', 'blocked', 'needs-decision', 'validating', 'stale'])

let win: BrowserWindow | null = null
let ctx: AppCtx | undefined
let quitting = false
let started = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Genio failed to start', String((e as Error)?.stack ?? e))
    app.exit(1)
  })
}

setWindowsAppId()

// genio-media://fal/<run>/<file>: FAL outputs from Genio's data dir (streamable, seekable); genio-media://chat/<wksp>/<file>: chat images
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }])

function appRoot(): string {
  // out/main/index.js → project root in dev/preview; app path when packaged
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..', '..')
}

function writeLock(): void {
  try {
    const lock = path.join(defaultHomeRoot(), 'state', 'session.lock')
    fs.mkdirSync(path.dirname(lock), { recursive: true })
    writeJson(lock, { pid: process.pid, startedAt: nowIso(), app: 'genio' })
  } catch {
    /* non-fatal */
  }
}

function clearLock(): void {
  try {
    fs.unlinkSync(path.join(defaultHomeRoot(), 'state', 'session.lock'))
  } catch {
    /* ignore */
  }
}

async function boot(): Promise<void> {
  writeLock()
  ensureWindowsToastIdentity(appRoot())
  ctx = createApp(appRoot())
  registerIpc(getCtx)
  registerMedia()
  createWindow()
  wireEvents()
}

function registerMedia(): void {
  protocol.handle(MEDIA_SCHEME, (req) => {
    const u = new URL(req.url)
    const [id, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const p = !id || !file ? undefined : u.hostname === 'fal' ? getCtx().fal.mediaPath(id, file) : u.hostname === 'chat' ? chatMediaPath(id, file) : undefined
    if (!p) return new Response('not found', { status: 404 })
    return mediaResponse(p, req.headers.get('range'))
  })
}

/** genio-media://chat/<wksp>/<file>: an image attached in that chat */
function chatMediaPath(wksp: string, file: string): string | undefined {
  try {
    return chatImagePath(chatImageDir(getCtx().home(wksp).home.data), file)
  } catch {
    return undefined
  }
}

function createWindow(): void {
  const isWin = process.platform === 'win32'
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Genio',
    backgroundColor: '#07090e',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(isWin || process.platform === 'linux'
      ? { titleBarOverlay: { color: '#07090e', symbolColor: '#00e5ff', height: 44 } }
      : { trafficLightPosition: { x: 14, y: 14 } }),
    icon: path.join(appRoot(), 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  // external links open in the OS browser, never inside Genio
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  win.webContents.on('did-finish-load', () => {
    if (!ctx) return
    send(EVENT_CHANNEL, { type: 'snapshot', data: ctx.snapshot() })
    send(EVENT_CHANNEL, { type: 'settings', settings: ctx.settings.get() })
    for (const p of ctx.permissions.pending()) send(EVENT_CHANNEL, { type: 'permission', request: p })
    if (!started) {
      started = true
      startApp(ctx).catch((e) => bus.toast('error', 'Startup problem', String((e as Error)?.message ?? e)))
    }
    if (process.env.GENIO_CAPTURE_DIR) void captureTour(process.env.GENIO_CAPTURE_DIR)
  })

  win.on('close', (e) => {
    if (quitting || !ctx) return
    const live = [...ctx.homes.values()].flatMap((h) => h.crew.list()).filter((t) => LIVE_STATES.has(t.state) && t.terminalId)
    if (live.length) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        buttons: ['Quit anyway', 'Keep playing'],
        defaultId: 1,
        cancelId: 1,
        title: 'Units still in play',
        message: `${live.length} unit${live.length === 1 ? ' is' : 's are'} still running.`,
        detail: 'Quitting stops their terminals; worktrees are kept and you can respawn them next session.'
      })
      if (choice !== 0) {
        e.preventDefault()
        return
      }
    }
    e.preventDefault()
    quitting = true
    void shutdown()
  })
  win.on('closed', () => {
    win = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
}

function wireEvents(): void {
  bus.onEvent((ev) => send(EVENT_CHANNEL, ev))

  // terminal output: batch every 16ms so a chatty unit can't flood IPC
  let batch: { id: string; data: string }[] = []
  let timer: NodeJS.Timeout | undefined
  const flush = (): void => {
    timer = undefined
    if (!batch.length) return
    // merge consecutive chunks per terminal
    const merged = new Map<string, string>()
    for (const b of batch) merged.set(b.id, (merged.get(b.id) ?? '') + b.data)
    batch = []
    send(TERM_CHANNEL, [...merged.entries()].map(([id, data]) => ({ id, data })))
  }
  ctx!.terminals.onAnyData((id, data) => {
    batch.push({ id, data })
    if (!timer) timer = setTimeout(flush, 16)
  })
}

async function shutdown(): Promise<void> {
  try {
    if (ctx) await Promise.race([stopApp(ctx), new Promise((r) => setTimeout(r, 4000))])
  } catch {
    /* ignore */
  }
  try {
    for (const t of ctx?.terminals.list() ?? []) ctx?.terminals.kill(t.id)
  } catch {
    /* ignore */
  }
  clearLock()
  app.exit(0)
}

app.on('before-quit', () => {
  if (!quitting && win) {
    // route through the window close handler so the live-unit warning shows
    return
  }
})

app.on('window-all-closed', () => {
  if (!quitting) void shutdown()
})

process.on('uncaughtException', (e) => {
  try {
    bus.toast('error', 'Internal error', String(e?.message ?? e))
  } catch {
    /* ignore */
  }
})
process.on('unhandledRejection', (e) => {
  try {
    bus.toast('error', 'Internal error', String((e as Error)?.message ?? e))
  } catch {
    /* ignore */
  }
})

/**
 * Dev-only visual check: GENIO_CAPTURE_DIR=<dir> makes Genio screenshot its own
 * window on every view (Ctrl+1..9) and quit. Captures only Genio's own pixels.
 */
async function captureTour(dir: string): Promise<void> {
  const fs = await import('node:fs')
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  fs.mkdirSync(dir, { recursive: true })
  await wait(Number(process.env.GENIO_CAPTURE_DELAY ?? 3500))
  const prompt = process.env.GENIO_CAPTURE_PROMPT
  if (prompt && win && !win.isDestroyed()) {
    // exercise the real IPC path: renderer → main → Genio agent
    await win.webContents.executeJavaScript(`window.genio.api.sendChat('main', ${JSON.stringify(prompt)})`)
    const ctx = getCtx()
    const until = Date.now() + 120_000
    await wait(1500)
    while (Date.now() < until && ['starting', 'thinking', 'tool'].includes(ctx.main.wksp.info().activity)) await wait(1000)
    await wait(1200)
  }
  const script = process.env.GENIO_CAPTURE_SCRIPT
  if (script && win && !win.isDestroyed()) {
    // dev-only: run a setup scenario in the renderer (uses window.genio.api)
    const body = fs.readFileSync(script, 'utf8')
    await win.webContents.executeJavaScript(`(async () => { ${body}
 })()`).catch((e) => console.error('[capture] script failed', e))
  }
  const views = ['comms', 'squad', 'quests', 'yourmove', 'status', 'worlds', 'lore', 'systems', 'fal']
  for (let i = 0; i < views.length; i++) {
    if (!win || win.isDestroyed()) return
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${i + 1}', code: 'Digit${i + 1}', ctrlKey: true, bubbles: true }))`
    )
    await wait(900)
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(dir, `${i + 1}-${views[i]}.png`), img.toPNG())
  }
  console.log('[capture] tour complete')
  quitting = true
  app.exit(0)
}
