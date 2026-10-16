import { afterEach, describe, expect, it, vi } from 'vitest'

const made: { options: Record<string, any>; window: FakeWindow }[] = []
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (options: Record<string, any>) { const window = new FakeWindow(script); made.push({ options, window }); return window })
}))
import { createModelThumbnailer, readModelThumbnail } from '../src/main/model-thumbnails'
import { VIEWER_THUMBNAIL_URL } from '../src/shared/model-viewer'
import { ModelPreviewPriority } from '../src/main/model-preview-priority'

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)])
type Draw = (url: string) => Promise<unknown>
let script: Draw = async () => ({ webp: WEBP.toString('base64') })

class FakeWindow {
  destroyed = false
  url = ''
  events: Record<string, () => void> = {}
  draws: string[] = []
  constructor(private draw: Draw) {}
  webContents = {
    setWindowOpenHandler: vi.fn(),
    on: (event: string, fn: () => void) => { this.events[event] = fn },
    executeJavaScript: async (code: string): Promise<unknown> => {
      if (this.destroyed) throw new Error('Object has been destroyed')
      if (code.startsWith('typeof')) return true
      const url = JSON.parse(/genioThumbnail\((.*)\)$/.exec(code)![1]) as string
      this.draws.push(url)
      return this.draw(url)
    }
  }
  loadURL = vi.fn(async (url: string) => { this.url = url })
  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true }
}
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

afterEach(() => { made.length = 0; script = async () => ({ webp: WEBP.toString('base64') }) })

describe('model thumbnail window', () => {
  it('preempts a running thumbnail, pauses queued jobs and retries without caching a failure', async () => {
    const priority = new ModelPreviewPriority()
    let first = true
    script = async () => {
      if (first) { first = false; return new Promise(() => undefined) }
      return { webp: WEBP.toString('base64') }
    }
    const thumbnails = createModelThumbnailer({ priority, timeoutMs: 2000 })
    const a = thumbnails.render('genio-media://model/t/a.fbx')
    const b = thumbnails.render('genio-media://model/t/b.fbx')
    await wait(10)
    priority.begin('interactive')
    expect(made[0].window.destroyed).toBe(true)
    await wait(10)
    expect(made).toHaveLength(1)
    priority.finish('interactive')
    expect(await a).toEqual({ webp: WEBP })
    expect(await b).toEqual({ webp: WEBP })
    expect(made).toHaveLength(2)
    expect(made[1].window.draws).toEqual(['genio-media://model/t/a.fbx', 'genio-media://model/t/b.fbx'])
    thumbnails.stop()
  })

  it('releases a stalled priority lease and cancels a queue waiting behind it', async () => {
    const priority = new ModelPreviewPriority()
    priority.begin('viewer', 20)
    const thumbnails = createModelThumbnailer({ priority })
    const first = thumbnails.render('genio-media://model/t/a.fbx')
    expect(made).toHaveLength(0)
    expect(await first).toEqual({ webp: WEBP })
    priority.begin('viewer')
    const queued = thumbnails.render('genio-media://model/t/b.fbx')
    thumbnails.stop()
    expect(await queued).toMatchObject({ code: 'unreadable' })
    priority.finish('viewer')
  })
  it('accepts only a real WebP up to 1 MB or a known failure from the page', () => {
    expect(readModelThumbnail({ webp: WEBP.toString('base64') })).toEqual({ webp: WEBP })
    expect(readModelThumbnail({ code: 'too-large', reason: 'robot.bin is larger than the 64 MB preview limit.' })).toEqual({ code: 'too-large', reason: 'robot.bin is larger than the 64 MB preview limit.' })
    const unreadable = { code: 'unreadable', reason: 'The 3D viewer drew no picture of this model.' }
    for (const junk of [undefined, null, 'x', { webp: Buffer.from('<svg onload=alert(1)>').toString('base64') }, { webp: Buffer.concat([WEBP, Buffer.alloc(1024 * 1024)]).toString('base64') },
      { code: 'exploded', reason: 'x' }, { code: 'timeout', reason: 'x'.repeat(601) }, { webp: 42 }]) expect(readModelThumbnail(junk)).toEqual(unreadable)
  })

  it('opens one hidden, unfocusable, sandboxed window on demand that is never shown', async () => {
    const thumbnails = createModelThumbnailer()
    expect(made).toHaveLength(0)
    expect(await thumbnails.render('genio-media://model/a/robot.glb')).toEqual({ webp: WEBP })
    expect(made).toHaveLength(1)
    const { options, window } = made[0]
    expect(options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    expect(options.webPreferences.preload).toBeUndefined()
    expect(window.url).toBe(VIEWER_THUMBNAIL_URL)
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalled()
    thumbnails.stop()
    expect(window.destroyed).toBe(true)
  })

  it('draws one model at a time in one shared window, then destroys the window when idle', async () => {
    let active = 0, most = 0
    script = async url => { most = Math.max(most, ++active); await wait(15); active--; return url.includes('bad') ? { code: 'unreadable', reason: 'The file could not be read as FBX: bad header' } : { webp: WEBP.toString('base64') } }
    const thumbnails = createModelThumbnailer({ idleMs: 80 })
    const results = await Promise.all(['a.fbx', 'bad.fbx', 'c.obj'].map(n => thumbnails.render(`genio-media://model/t/${n}`)))
    expect(results).toEqual([{ webp: WEBP }, { code: 'unreadable', reason: 'The file could not be read as FBX: bad header' }, { webp: WEBP }])
    expect(most).toBe(1)
    expect(made).toHaveLength(1)
    expect(made[0].window.draws).toEqual(['genio-media://model/t/a.fbx', 'genio-media://model/t/bad.fbx', 'genio-media://model/t/c.obj'])
    expect(made[0].window.destroyed).toBe(false)
    await wait(150)
    expect(made[0].window.destroyed).toBe(true)
    // The next request makes a fresh window.
    expect(await thumbnails.render('genio-media://model/t/d.glb')).toEqual({ webp: WEBP })
    expect(made).toHaveLength(2)
    thumbnails.stop()
  })

  it('stops a model that hangs by destroying the window, says so, and carries on with the next', async () => {
    script = url => url.includes('hang') ? new Promise(() => undefined) : Promise.resolve({ webp: WEBP.toString('base64') })
    const thumbnails = createModelThumbnailer({ timeoutMs: 60 })
    const [hung, next] = await Promise.all([thumbnails.render('genio-media://model/t/hang.fbx'), thumbnails.render('genio-media://model/t/next.glb')])
    expect(hung).toEqual({ code: 'timeout', reason: 'Drawing this model took longer than 0.06 s, so it was stopped. Select it to try the full preview, or open it in your 3D app.' })
    expect(made[0].window.destroyed).toBe(true)
    expect(next).toEqual({ webp: WEBP })
    expect(made).toHaveLength(2)
    thumbnails.stop()
  })

  it('replaces a window whose page crashed', async () => {
    script = url => url.includes('crash') ? Promise.reject(new Error('Render frame was disposed')) : Promise.resolve({ webp: WEBP.toString('base64') })
    const thumbnails = createModelThumbnailer()
    expect(await thumbnails.render('genio-media://model/t/crash.fbx')).toEqual({ code: 'unreadable', reason: 'The 3D viewer stopped while drawing this model.' })
    expect(made[0].window.destroyed).toBe(true)
    expect(await thumbnails.render('genio-media://model/t/fine.fbx')).toEqual({ webp: WEBP })
    expect(made).toHaveLength(2)
    made[1].window.events['render-process-gone']()
    expect(made[1].window.destroyed).toBe(true)
    thumbnails.stop()
  })
})
