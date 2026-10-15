/**
 * Genio — Electron entry. One process, a Hub and one window per project. Everything durable lives in
 * the Base directory; this file only wires the window to the services.
 */
import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, dialog, net, protocol, screen, shell } from 'electron'
import { EVENT_CHANNEL } from '@shared/api'
import { bus } from './bus'
import { createApp, ensureProjectBase, getCtx, startApp, startProjectBase, stopApp, stopProjectBase } from './ctx'
import { MEDIA_SCHEME, mediaResponse } from './fal-service'
import { installModelViewer } from './model-viewer'
import { VIEWER_SCHEME } from '@shared/model-viewer'
import { chatImageDir, chatImagePath } from './chat-images'
import { defaultHomeRoot } from './home'
import { registerIpc } from './ipc'
import { playerInstanceService } from './player-instance'
import type { AppCtx } from './services'
import { nowIso, readJson, writeJson } from './util'
import { afterFirstNotification, ensureWindowsToastIdentity, setWindowsAppId, windowAppDetails, windowIcon } from './win-identity'
import { onNotificationShown } from './notifier'
import { projectFromArgv, projectSnapshot, terminalProject, type WindowBinding } from './project-windows'
import { createEventRouter, type RoutedWindow } from './event-router'
import type { GenioEvent, Task } from '@shared/types'
import { stopUnitsDialog, unitsInPlay } from './usage-policy'
import { fitInto, isChatPopoutUrl, POPOUT_MIN, visiblePopoutBounds, type Rect } from '@shared/chat-popout'
import { WINDOW_MIN } from '@shared/window'
import { captureUserData } from './capture-isolation'
import { windowTitle } from '@shared/window-title'

// Validate before single-instance locking, Base writes, or provider startup.
const captureData = captureUserData()
if (captureData) app.setPath('userData', captureData)

const windows = new Map<BrowserWindow, WindowBinding | undefined>()
const windowLoads = new WeakMap<BrowserWindow, Promise<void>>()
let openQueue: Promise<unknown> = Promise.resolve()
const pendingLaunches: { argv: string[]; cwd: string }[] = []
let ctx: AppCtx | undefined
let quitting = false
let quitConfirmed = false
let startup: Promise<void> | undefined
/** At most one engine rescan per window this often on focus. */
const FOCUS_RESCAN_MS = 30_000

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
// previews and exports; genio-media://chat/<wksp>/<file>: chat images. genio-viewer://app and genio-media://model/<token>/<file>:
// Inventory's sandboxed 3D viewer and the one model it was granted (model-viewer.ts)
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: VIEWER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

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
  // Electron writes Start Menu\Electron.lnk on an unpackaged run's first notification.
  onNotificationShown(shown => afterFirstNotification(appRoot(), shown))
  ctx = createApp(appRoot())
  // Background: finish pending player-copy deletions and remove copies an earlier session left behind.
  const started = ctx
  void playerInstanceService(started).start().catch(e => bus.toast('error', 'Player instance recovery', String(e)))
  const sender = (id: number): BrowserWindow | undefined => [...windows.keys()].find(w => !w.isDestroyed() && w.webContents.id === id)
  registerIpc(getCtx, {
    openProject,
    binding: id => [...windows].find(([w]) => w.webContents.id === id)?.[1],
    list: id => [...windows].filter(([w]) => !w.isDestroyed()).map(([w, b]) => ({ project: b?.project ?? null, current: w.webContents.id === id })),
    openHub,
    close: id => sender(id)?.close()
  })
  registerMedia()
  wireEvents()
  await launch(process.argv, process.cwd())
  for (const pending of pendingLaunches.splice(0)) await launch(pending.argv, pending.cwd)
}

function registerMedia(): void {
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  const viewer = installModelViewer({
    projectRoot: world => getCtx().projects.get(world)?.path,
    rendererDir: path.join(__dirname, '../renderer'),
    decoderLibs: devUrl && path.join(appRoot(), 'node_modules', 'three', 'examples', 'jsm', 'libs'),
    devUrl,
    fetch: url => net.fetch(url)
  })
  protocol.handle(VIEWER_SCHEME, req => viewer.handle(req))
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      if (u.hostname === 'model') return await viewer.handle(req)
      if (u.hostname === 'world' || u.hostname === 'thumb') {
        if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
        const [world, ...parts] = u.pathname.slice(1).split('/').map(decodeURIComponent)
        const asset = parts.join('/')
        const p = u.hostname === 'world' ? await getCtx().inventory.mediaPath(world, asset) : await getCtx().inventory.thumbnail(world, asset, req.signal)
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
  // An explicit window switch must also raise a reused window on Windows.
  if (process.platform === 'win32') win.moveTop()
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
  } else await openHub()
}

async function openHub(): Promise<void> {
  // Register synchronously in createWindow so concurrent requests share the same Hub.
  const hub = [...windows].find(([win, binding]) => !binding && !win.isDestroyed())?.[0] ?? createWindow()
  try {
    await windowLoads.get(hub)
  } catch (error) {
    // A failed hidden Hub must not be reused forever; let the next request retry.
    if (!hub.isDestroyed()) hub.destroy()
    throw error
  }
  if (hub.isDestroyed()) throw new Error('Hub closed before it could be shown. Try opening it again.')
  focusWindow(hub)
}

export function openProject(folder: string): Promise<void> {
  const operation = openQueue.then(async () => {
    const { project, registered } = await ctx!.projects.openFolder(folder)
    const existing = [...windows].find(([, b]) => b?.project === project.name)?.[0]
    if (existing) { focusWindow(existing); return }
    const wksp = await ensureProjectBase(ctx!, project.name)
    const win = createWindow({ project: project.name, wksp }, registered)
    await windowLoads.get(win)
    ctx!.stats.unlock('project-window-open')
    if ([...windows.values()].filter(Boolean).length >= 2) ctx!.stats.unlock('project-windows-two')
    await startup
    await startProjectBase(ctx!, project.name, wksp)
  })
  openQueue = operation.catch(() => undefined)
  return operation
}

// Pop-out chat bounds per project, reopened only where a current display shows its title bar.
const popoutFile = (): string => path.join(defaultHomeRoot(), 'state', 'chat-popout.json')
const workAreas = (): Rect[] => screen.getAllDisplays().map(d => d.workArea)
function savedPopout(project: string): Rect | undefined {
  try { return visiblePopoutBounds(readJson<Record<string, Rect>>(popoutFile(), {})[project], workAreas()) } catch { return undefined }
}
function savePopout(project: string, bounds: Rect): void {
  try { writeJson(popoutFile(), { ...readJson<Record<string, Rect>>(popoutFile(), {}), [project]: bounds }) } catch { /* best effort */ }
}
/** Pull the pop-out back onto a display after a monitor is removed or rearranged. */
function keepPopoutVisible(child: BrowserWindow): void {
  if (child.isDestroyed()) return
  const current = child.getBounds()
  const next = visiblePopoutBounds(current, workAreas()) ?? fitInto(current, screen.getPrimaryDisplay().workArea)
  if ((next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height)) child.setBounds(next)
}

/** Taskbar icon and relaunch target per window, set before it is first shown (relaunching a project window reopens its folder). */
function brandTaskbar(win: BrowserWindow, folder?: string): void {
  if (process.platform === 'win32') win.setAppDetails(windowAppDetails(appRoot(), folder))
}

function createWindow(binding?: WindowBinding, registered = false): BrowserWindow {
  const isWin = process.platform === 'win32'
  const projectPath = binding && ctx?.projects.get(binding.project)?.path
  let projectName = binding && (ctx?.projects.get(binding.project)?.name ?? binding.project)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    title: windowTitle(projectName),
    backgroundColor: '#07090e',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(isWin || process.platform === 'linux'
      ? { titleBarOverlay: { color: '#07090e', symbolColor: '#00e5ff', height: 44 } }
      : { trafficLightPosition: { x: 14, y: 14 } }),
    icon: windowIcon(appRoot()),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  // The renderer owns File; a hidden native menu would keep its old close/quit shortcuts.
  win.setMenu(null)
  brandTaskbar(win, projectPath)
  windows.set(win, binding)
  win.on('ready-to-show', () => win.show())
  // Coming back from the editor or a file manager: re-detect the engine (the Hub covers every project).
  let focusScan: ReturnType<typeof setTimeout> | undefined
  let lastFocusScan = 0
  win.on('focus', () => {
    if (!ctx || focusScan || Date.now() - lastFocusScan < FOCUS_RESCAN_MS) return
    focusScan = setTimeout(() => {
      focusScan = undefined
      lastFocusScan = Date.now()
      void ctx?.projects.rescan(binding?.project).catch(() => undefined)
    }, 500)
  })
  win.on('closed', () => clearTimeout(focusScan))

  // external links open in the OS browser, never inside Genio
  let chatWindow: BrowserWindow | undefined
  // HTML navigation must not replace the native title with the static "Genio".
  win.on('page-title-updated', event => event.preventDefault())
  const offTitles = bus.onEvent(event => {
    if (event.type !== 'projects' || !binding) return
    // The folder is stable even when a project's display name changes.
    const project = event.projects.find(p => projectPath && p.path === projectPath)
      ?? event.projects.find(p => p.name === binding.project)
    if (!project) return
    projectName = project.name
    if (!win.isDestroyed()) win.setTitle(windowTitle(projectName))
    if (chatWindow && !chatWindow.isDestroyed()) chatWindow.setTitle(windowTitle(projectName, true))
  })
  win.on('closed', offTitles)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (binding && isChatPopoutUrl(url, win.webContents.getURL())) {
      if (chatWindow && !chatWindow.isDestroyed()) { focusWindow(chatWindow); return { action: 'deny' } }
      const at = savedPopout(binding.project)
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: at?.width ?? 520, height: at?.height ?? 640, ...(at ? { x: at.x, y: at.y } : {}),
        minWidth: POPOUT_MIN.width, minHeight: POPOUT_MIN.height,
        // Shown inactive once painted, so popping out never steals focus from the game or editor.
        show: false,
        title: windowTitle(projectName, true), alwaysOnTop: true,
        frame: true, titleBarStyle: 'default', titleBarOverlay: false,
        backgroundColor: '#07090e', autoHideMenuBar: true, icon: windowIcon(appRoot()),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      } }
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', child => {
    chatWindow = child
    brandTaskbar(child, projectPath)
    child.on('page-title-updated', event => event.preventDefault())
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // window.open's initial navigation happens after did-create-window.
    let loaded = false
    const reveal = (): void => { if (!child.isDestroyed() && !child.isVisible()) child.showInactive() }
    child.webContents.once('did-finish-load', () => { loaded = true; reveal() })
    child.webContents.on('will-navigate', (e, url) => {
      if (loaded || !isChatPopoutUrl(url, win.webContents.getURL())) e.preventDefault()
    })
    child.once('ready-to-show', reveal)
    const displays = (): void => keepPopoutVisible(child)
    screen.on('display-removed', displays)
    screen.on('display-metrics-changed', displays)
    child.on('close', () => { if (binding) savePopout(binding.project, child.getNormalBounds()) })
    child.on('closed', () => {
      screen.off('display-removed', displays)
      screen.off('display-metrics-changed', displays)
      if (chatWindow === child) chatWindow = undefined
    })
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
    // An Exit the player already confirmed covers every window's units.
    if (!quitConfirmed && !confirmStopUnits(win, liveUnits(binding?.project), 'close')) return
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
        quitConfirmed = false
        reportOpenError(error)
      }
    })()
  })
  win.on('closed', () => {
    chatWindow?.destroy(); windows.delete(win)
    if (binding && ctx) void Promise.resolve().then(() => playerInstanceService(ctx!).quit(binding.project)).catch(() => {})
  })

  const query: Record<string, string> = binding ? { project: binding.project, wksp: binding.wksp, ...(registered ? { registered: '1' } : {}) } : {}
  let loading: Promise<void>
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    loading = win.loadURL(url.toString())
  } else {
    loading = win.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
  }
  windowLoads.set(win, loading)
  // Opening callers await the original promise and report failure in their own UI.
  void loading.catch(() => undefined)
  return win
}

function accountsWindow(): BrowserWindow | undefined {
  const open = [...windows].filter(([w]) => !w.isDestroyed())
  const focused = BrowserWindow.getFocusedWindow()
  return open.find(([w]) => w === focused)?.[0] ?? open.find(([, b]) => b)?.[0] ?? open[0]?.[0]
}

async function navigateNotification(target: Extract<GenioEvent, { type: 'navigate' }>['target']): Promise<void> {
  if (!ctx) return
  const snapshot = ctx.snapshot()
  const decision = target.view === 'move' && target.decisionId ? snapshot.decisions.find(d => d.id === target.decisionId) : undefined
  const wksp = target.view === 'comms' || target.view === 'move' ? target.wksp : undefined
  const project = target.view === 'move' ? decision?.project ?? target.project :
    target.view === 'squad' ? snapshot.tasks.find(t => t.id === target.taskId)?.project : undefined
  const owner = project ?? snapshot.allies.find(a => !a.retiredAt && a.name === (decision?.wksp ?? wksp))?.projects[0]
  if (owner) {
    const p = ctx.projects.get(owner)
    if (!p) throw new Error(`Project ${owner} is unavailable.`)
    await openProject(p.path)
  }
  // Accounts are global: open them in the window the player is in, else a project window, else the Hub (which has Settings too).
  let win = target.view === 'accounts' ? accountsWindow() : [...windows].find(([, b]) => owner ? b?.project === owner : !b)?.[0]
  if (!win && !owner) {
    await openHub()
    win = [...windows].find(([, b]) => !b)?.[0]
  }
  if (!win || win.isDestroyed()) return
  if (win.webContents.isLoadingMainFrame()) await new Promise<void>(resolve => win!.webContents.once('did-finish-load', () => resolve()))
  focusWindow(win)
  win.webContents.send(EVENT_CHANNEL, { type: 'navigate', target })
}

/** Every open window as the router sees it: binding, liveness and a send. */
function routedWindows(): RoutedWindow[] {
  return [...windows].map(([win, binding]) => ({
    binding,
    alive: () => !win.isDestroyed() && !win.webContents.isDestroyed(),
    send: (channel, payload) => win.webContents.send(channel, payload)
  }))
}

function wireEvents(): void {
  const router = createEventRouter({ snapshot: () => ctx!.snapshot(), terminal: (id) => ctx!.terminals.get(id), windows: routedWindows })
  bus.onEvent((ev) => {
    if (ev.type === 'navigate') void navigateNotification(ev.target).catch(reportOpenError)
    else router.publish(ev)
  })
  ctx!.terminals.onAnyData(router.terminalData)
}

async function shutdown(code = 0): Promise<void> {
  try {
    if (ctx) await Promise.race([Promise.allSettled([stopApp(ctx), playerInstanceService(ctx).shutdown()]), new Promise((r) => setTimeout(r, 4000))])
  } catch {
    /* ignore */
  }
  try {
    for (const t of ctx?.terminals.list() ?? []) ctx?.terminals.kill(t.id)
  } catch {
    /* ignore */
  }
  clearLock()
  app.exit(code)
}

/** Units still in play (the unit cap's definition), in one project or (no project) across every window. */
function liveUnits(project?: string): Task[] {
  if (!ctx) return []
  return unitsInPlay(ctx.homes.values(), t => !!t.terminalId && !!ctx!.terminals.get(t.terminalId)?.alive, project)
}

/** The quit-while-units-run warning; true when nothing runs or the player chose to stop them. */
function confirmStopUnits(win: BrowserWindow | null, live: Task[], action: 'close' | 'exit'): boolean {
  if (!live.length) return true
  const options = { type: 'warning' as const, defaultId: 1, cancelId: 1, title: 'Units still in play', ...stopUnitsDialog(live, action) }
  return (win ? dialog.showMessageBoxSync(win, options) : dialog.showMessageBoxSync(options)) === 0
}

// Exit asks once for units in any window, then closes every window without asking again.
app.on('before-quit', (event) => {
  if (quitting || !windows.size) return
  event.preventDefault()
  if (!quitConfirmed) {
    if (!confirmStopUnits(BrowserWindow.getFocusedWindow(), liveUnits(), 'exit')) return
    quitConfirmed = true
  }
  for (const win of windows.keys()) win.close()
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
  // GENIO_CAPTURE_SIZE=<width>x<height> shoots at that window size (never below the window minimum).
  const size = /^(\d+)x(\d+)$/.exec(process.env.GENIO_CAPTURE_SIZE ?? '')
  if (size) win.setSize(Number(size[1]), Number(size[2]))
  await wait(Number(process.env.GENIO_CAPTURE_DELAY ?? 3500))
  // Optional UI scenarios: each renderer script settles its own state before capture.
  // This exercises real IPC/media while keeping fixture setup outside the application.
  const runScenarios = async (file: string): Promise<void> => {
    const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; script: string }[]
    for (const c of cases) {
      try {
        // A scenario may return findings (e.g. layout overflow); they are printed beside its screenshot.
        const found: unknown = await win.webContents.executeJavaScript(`(async () => { ${c.script}\n })()`)
        if (found !== undefined && found !== null) console.log('[capture]', c.name, JSON.stringify(found))
      } catch (e) {
        console.error('[capture] failed', c.name, e)
        fs.writeFileSync(path.join(dir, 'scenario-failure.png'), (await win.webContents.capturePage()).toPNG())
        quitting = true
        await shutdown(1)
        return
      }
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(dir, `${c.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`), img.toPNG())
      console.log('[capture]', c.name)
    }
    quitting = true
    await shutdown()
  }
  const scenarios = process.env.GENIO_CAPTURE_SCENARIOS
  // A project window runs the scenarios when one is opened (Settings live there, not in the Hub).
  if (binding && scenarios && !win.isDestroyed()) return runScenarios(scenarios)
  if (binding) {
    fs.writeFileSync(path.join(dir, `project-${binding.project}.png`), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }))`)
    await wait(700)
    fs.writeFileSync(path.join(dir, `project-${binding.project}-chat.png`), (await win.webContents.capturePage()).toPNG())
    if (![...windows.values()].some(b => !b)) { quitting = true; await shutdown() }
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
  // With a project window open, it runs the scenarios; the Hub only takes its own shot.
  const projectOpen = [...windows.values()].some(Boolean)
  if (scenarios && win && !win.isDestroyed() && !projectOpen) return runScenarios(scenarios)
  if (scenarios && projectOpen) return
  const views = ['comms', 'squad', 'quests', 'yourmove', 'status', 'worlds', 'unbound', 'systems', 'inventory']
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
  await shutdown()
}
