/**
 * Genio — Electron entry. One process, a Hub and one window per project. Everything durable lives in
 * the Base directory; this file only wires the window to the services.
 */
import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { EVENT_CHANNEL } from '@shared/api'
import { bus } from './bus'
import { createApp, ensureProjectBase, getCtx, startApp, startProjectBase, stopApp, stopProjectBase } from './ctx'
import { MEDIA_SCHEME, mediaResponse } from './fal-service'
import { chatImageDir, chatImagePath } from './chat-images'
import { defaultHomeRoot } from './home'
import { registerIpc } from './ipc'
import type { AppCtx } from './services'
import { nowIso, writeJson } from './util'
import { ensureWindowsToastIdentity, setWindowsAppId } from './win-identity'
import { projectFromArgv, projectSnapshot, routeProjectEvent, terminalProject, type WindowBinding } from './project-windows'
import type { GenioEvent } from '@shared/types'

const TERM_CHANNEL = 'genio:term-data'

const windows = new Map<BrowserWindow, WindowBinding | undefined>()
const terminalOwners = new Map<string, string | undefined>()
let openQueue: Promise<unknown> = Promise.resolve()
const pendingLaunches: { argv: string[]; cwd: string }[] = []
let ctx: AppCtx | undefined
let quitting = false
let startup: Promise<void> | undefined

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    if (!ctx) { pendingLaunches.push({ argv, cwd }); return }
    void launch(argv, cwd).catch(reportOpenError)
  })
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Genio failed to start', String((e as Error)?.stack ?? e))
    app.exit(1)
  })
}

setWindowsAppId()

// genio-media://fal/<run>/<file>: FAL outputs from Genio's data dir (streamable, seekable); genio-media://uthana/<run>/<file>: Animation
// previews and exports; genio-media://chat/<wksp>/<file>: chat images
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
  if (!process.env.GENIO_CAPTURE_DIR) ensureWindowsToastIdentity(appRoot())
  ctx = createApp(appRoot())
  registerIpc(getCtx, {
    openProject,
    binding: id => [...windows].find(([w]) => w.webContents.id === id)?.[1]
  })
  registerMedia()
  wireEvents()
  await launch(process.argv, process.cwd())
  for (const pending of pendingLaunches.splice(0)) await launch(pending.argv, pending.cwd)
}

function registerMedia(): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname === 'world' || u.hostname === 'thumb') {
        if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
        const [world, ...parts] = u.pathname.slice(1).split('/').map(decodeURIComponent)
        const asset = parts.join('/')
        const p = u.hostname === 'world' ? await getCtx().inventory.mediaPath(world, asset) : await getCtx().inventory.thumbnail(world, asset)
        if (!p) return new Response('not found', { status: 404 })
        const response = mediaResponse(p, req.headers.get('range'))
        response.headers.set('X-Content-Type-Options', 'nosniff')
        response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
        return response
      }
      const [id, file] = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const p =
        !id || !file
          ? undefined
          : u.hostname === 'fal'
            ? getCtx().fal.mediaPath(id, file)
            : u.hostname === 'uthana'
              ? getCtx().uthana.mediaPath(id, file)
              : u.hostname === 'chat'
                ? chatMediaPath(id, file)
                : undefined
      if (!p) return new Response('not found', { status: 404 })
      return mediaResponse(p, req.headers.get('range'))
    } catch { return new Response('not found', { status: 404 }) }
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

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function reportOpenError(error: unknown): void {
  dialog.showErrorBox('Could not open project', String((error as Error)?.message ?? error))
}

async function launch(argv: string[], cwd: string): Promise<void> {
  const folder = projectFromArgv(argv, cwd, !!process.defaultApp)
  if (folder) {
    await openProject(folder)
    ctx!.stats.unlock('project-cli-open')
  } else {
    const hub = [...windows].find(([, binding]) => !binding)?.[0]
    if (hub) focusWindow(hub)
    else createWindow()
  }
}

export function openProject(folder: string): Promise<void> {
  const operation = openQueue.then(async () => {
    const { project, registered } = await ctx!.projects.openFolder(folder)
    const existing = [...windows].find(([, b]) => b?.project === project.name)?.[0]
    if (existing) { focusWindow(existing); return }
    const wksp = await ensureProjectBase(ctx!, project.name)
    const win = createWindow({ project: project.name, wksp }, registered)
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_e, _code, message) => reject(new Error(message)))
    })
    ctx!.stats.unlock('project-window-open')
    await startup
    await startProjectBase(ctx!, project.name, wksp)
  })
  openQueue = operation.catch(() => undefined)
  return operation
}

function createWindow(binding?: WindowBinding, registered = false): BrowserWindow {
  const isWin = process.platform === 'win32'
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: binding ? `${binding.project} · Genio` : 'Genio',
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

  windows.set(win, binding)
  win.on('ready-to-show', () => win.show())

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
    win.webContents.send(EVENT_CHANNEL, { type: 'snapshot', data: projectSnapshot(ctx.snapshot(), binding) })
    win.webContents.send(EVENT_CHANNEL, { type: 'settings', settings: ctx.settings.get() })
    for (const p of ctx.permissions.pending()) if (!binding || p.wksp === binding.wksp) win.webContents.send(EVENT_CHANNEL, { type: 'permission', request: p })
    if (!startup) {
      startup = startApp(ctx)
      void startup.catch((e) => bus.toast('error', 'Startup problem', String((e as Error)?.message ?? e)))
    }
    if (process.env.GENIO_CAPTURE_DIR) void captureTour(process.env.GENIO_CAPTURE_DIR, win, binding)
  })

  let closing = false
  let allowClose = false
  win.on('close', (e) => {
    if (quitting || allowClose || !ctx) return
    const last = windows.size === 1
    if (!binding && !last) return
    e.preventDefault()
    if (closing) return
    const live = [...ctx.homes.values()].flatMap(h => h.crew.list()).filter(t =>
      (!binding || t.project === binding.project) && (t.state === 'spawning' || t.terminalId && ctx!.terminals.get(t.terminalId)?.alive))
    if (live.length) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Stop units and close', 'Cancel'], defaultId: 1, cancelId: 1,
        title: 'Units still in play', message: `${live.length} unit${live.length === 1 ? ' is' : 's are'} still running.`,
        detail: 'Closing stops their terminals; worktrees are kept for respawn.'
      })
      if (choice !== 0) return
    }
    closing = true
    void (async () => {
      try {
        if (binding) {
          await stopProjectBase(ctx!, binding.project, binding.wksp)
          for (const t of ctx!.terminals.list()) if (terminalProject(t, ctx!.snapshot()) === binding.project && t.alive) ctx!.terminals.kill(t.id)
        }
        allowClose = true
        win.close()
      } catch (error) {
        closing = false
        reportOpenError(error)
      }
    })()
  })
  win.on('closed', () => windows.delete(win))

  const query: Record<string, string> = binding ? { project: binding.project, wksp: binding.wksp, ...(registered ? { registered: '1' } : {}) } : {}
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
  }
  return win
}

function sendEvent(ev: GenioEvent): void {
  const snapshot = ctx!.snapshot()
  if (ev.type === 'terminal') terminalOwners.set(ev.terminal.id, terminalProject(ev.terminal, snapshot))
  const owner = ev.type === 'terminal' ? terminalOwners.get(ev.terminal.id) : ev.type === 'terminal-removed' ? terminalOwners.get(ev.id) : undefined
  for (const [win, binding] of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    const routed = routeProjectEvent(ev, binding, snapshot, owner)
    if (routed) win.webContents.send(EVENT_CHANNEL, routed)
  }
  // Retain ownership for terminal data already queued in the 16ms batch.
}

function wireEvents(): void {
  bus.onEvent(sendEvent)

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
    const snapshot = ctx!.snapshot()
    for (const [win, binding] of windows) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      const chunks = [...merged.entries()].filter(([id]) => {
        const t = ctx!.terminals.get(id)
        const project = t ? terminalProject(t, snapshot) : terminalOwners.get(id)
        return !binding || project === binding.project
      }).map(([id, data]) => ({ id, data }))
      if (chunks.length) win.webContents.send(TERM_CHANNEL, chunks)
    }
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

app.on('before-quit', (event) => {
  if (!quitting && windows.size) {
    event.preventDefault()
    for (const win of windows.keys()) win.close()
  }
})

app.on('window-all-closed', () => {
  if (!quitting) { quitting = true; void shutdown() }
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
async function captureTour(dir: string, win: BrowserWindow, binding?: WindowBinding): Promise<void> {
  const fs = await import('node:fs')
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  fs.mkdirSync(dir, { recursive: true })
  await wait(Number(process.env.GENIO_CAPTURE_DELAY ?? 3500))
  if (binding) {
    fs.writeFileSync(path.join(dir, `project-${binding.project}.png`), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }))`)
    await wait(700)
    fs.writeFileSync(path.join(dir, `project-${binding.project}-chat.png`), (await win.webContents.capturePage()).toPNG())
    if (![...windows.values()].some(b => !b)) { quitting = true; app.exit(0) }
    return
  }
  fs.writeFileSync(path.join(dir, 'hub.png'), (await win.webContents.capturePage()).toPNG())
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
  // Optional UI scenarios: each renderer script settles its own state before capture.
  // This exercises real IPC/media while keeping fixture setup outside the application.
  const scenarios = process.env.GENIO_CAPTURE_SCENARIOS
  if (scenarios && win && !win.isDestroyed()) {
    const cases = JSON.parse(fs.readFileSync(scenarios, 'utf8')) as { name: string; script: string }[]
    for (const c of cases) {
      try {
        await win.webContents.executeJavaScript(`(async () => { ${c.script}\n })()`)
      } catch (e) {
        console.error('[capture] failed', c.name, e)
        fs.writeFileSync(path.join(dir, 'scenario-failure.png'), (await win.webContents.capturePage()).toPNG())
        quitting = true
        app.exit(1)
        return
      }
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(dir, `${c.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`), img.toPNG())
      console.log('[capture]', c.name)
    }
    quitting = true
    app.exit(0)
    return
  }
  const views = ['comms', 'squad', 'quests', 'yourmove', 'status', 'worlds', 'lore', 'systems', 'inventory']
  focusWindow(win)
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
