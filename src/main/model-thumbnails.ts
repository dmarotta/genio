/**
 * Inventory's model thumbnails: the 3D viewer page (genio-viewer://app/viewer3d.html?thumbnail) in one
 * hidden window that is never shown and never takes focus. Its single WebGL context draws one model at
 * a time into a 256 px WebP; the window is created on demand, destroyed when a model hangs past the
 * timeout (which stops its work) and destroyed again once it has been idle for a while.
 */
import { BrowserWindow } from 'electron'
import { MODEL_PREVIEW_TIMEOUT_MS, VIEWER_THUMBNAIL_URL, readModelFailure, type ModelThumbnailFailure } from '@shared/model-viewer'
import { modelPreviewPriority, type ModelPreviewPriority } from './model-preview-priority'

export type ModelThumbnail = { webp: Buffer } | ModelThumbnailFailure
export interface ModelThumbnailer { render(url: string): Promise<ModelThumbnail>; stop(): void }
export interface ModelThumbnailerOptions {
  pageUrl?: string
  timeoutMs?: number
  /** The window is destroyed after this long without a job. */
  idleMs?: number
  /** Tests substitute the window. */
  createWindow?: () => BrowserWindow
  priority?: ModelPreviewPriority
}
const MAX_WEBP = 1024 * 1024
const IDLE_MS = 20_000
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The page is untrusted (it parses arbitrary files): only a real WebP up to 1 MB or a known failure pass. */
export function readModelThumbnail(value: unknown): ModelThumbnail {
  const webp = (value as { webp?: unknown } | null | undefined)?.webp
  if (typeof webp === 'string' && webp.length <= MAX_WEBP * 4 / 3 + 4) {
    const data = Buffer.from(webp, 'base64')
    if (data.length > 12 && data.length <= MAX_WEBP && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { webp: data }
  }
  return readModelFailure(value) ?? { code: 'unreadable', reason: 'The 3D viewer drew no picture of this model.' }
}

function hiddenWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false, focusable: false, skipTaskbar: true, width: 320, height: 320, title: 'Genio model thumbnails',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  })
}

export function createModelThumbnailer(opts: ModelThumbnailerOptions = {}): ModelThumbnailer {
  const timeoutMs = opts.timeoutMs ?? MODEL_PREVIEW_TIMEOUT_MS
  const priority = opts.priority ?? modelPreviewPriority
  const shutdown = new AbortController()
  let win: BrowserWindow | undefined, loading: Promise<void> | undefined, idle: NodeJS.Timeout | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const close = (): void => {
    clearTimeout(idle); idle = undefined
    const w = win
    win = undefined; loading = undefined
    if (w && !w.isDestroyed()) w.destroy()
  }
  const ready = (): Promise<BrowserWindow> => {
    if (!win || win.isDestroyed() || !loading) {
      const w = win = (opts.createWindow ?? hiddenWindow)()
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      w.webContents.on('will-navigate', e => e.preventDefault())
      w.webContents.on('render-process-gone', () => { if (win === w) close() })
      loading = (async () => {
        await w.loadURL(opts.pageUrl ?? VIEWER_THUMBNAIL_URL)
        for (let i = 0; !await w.webContents.executeJavaScript('typeof window.genioThumbnail === "function"'); i++) {
          if (i > 100) throw new Error('The 3D viewer did not start.')
          await wait(50)
        }
      })()
    }
    const w = win
    return loading.then(() => w, e => { if (win === w) close(); throw e })
  }
  const draw = async (url: string): Promise<ModelThumbnail | 'interrupted'> => {
    clearTimeout(idle)
    let off = (): void => {}
    let abort = (): void => {}
    const interrupted = new Promise<'interrupted'>(resolve => {
      const interrupt = (): void => { close(); resolve('interrupted') }
      off = priority.subscribe(() => { if (priority.active) interrupt() })
      abort = interrupt
      shutdown.signal.addEventListener('abort', abort, { once: true })
    })
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<ModelThumbnail>(resolve => {
      timer = setTimeout(() => {
        // Destroying the window is what stops a model that hangs the page.
        close()
        resolve({ code: 'timeout', reason: `Drawing this model took longer than ${timeoutMs / 1000} s, so it was stopped. Select it to try the full preview, or open it in your 3D app.` })
      }, timeoutMs)
    })
    let used: BrowserWindow | undefined
    const drawn = ready()
      .then(w => { used = w; if (priority.active || shutdown.signal.aborted || w.isDestroyed()) return 'interrupted'; return w.webContents.executeJavaScript(`window.genioThumbnail(${JSON.stringify(url)})`) })
      .then(value => value === 'interrupted' ? value : readModelThumbnail(value), (): ModelThumbnail => {
        // A crashed or broken page is replaced on the next job (never one a later job already made).
        if (used && win === used) close()
        return { code: 'unreadable', reason: 'The 3D viewer stopped while drawing this model.' }
      })
    try { return await Promise.race([drawn, timedOut, interrupted]) } finally {
      clearTimeout(timer)
      off(); shutdown.signal.removeEventListener('abort', abort)
      if (win) idle = setTimeout(close, opts.idleMs ?? IDLE_MS)
    }
  }
  return {
    /** Jobs run one at a time, in order. */
    render(url) {
      const job = queue.then(async (): Promise<ModelThumbnail> => {
        while (!shutdown.signal.aborted) {
          await priority.idle(shutdown.signal)
          if (shutdown.signal.aborted) break
          const result = await draw(url)
          if (result !== 'interrupted') return result
        }
        return { code: 'unreadable', reason: 'The thumbnail viewer was closed.' }
      })
      queue = job.catch(() => undefined)
      return job
    },
    stop() { shutdown.abort(); close() }
  }
}
