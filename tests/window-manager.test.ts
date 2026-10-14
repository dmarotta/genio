import { beforeAll, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'
import type { GenioEvent } from '../src/shared/types'

const f = vi.hoisted(() => ({ windows: [] as any[], ctx: undefined as any, app: undefined as any, screen: undefined as any, popouts: undefined as any, choice: 1, prompts: 0, ipc: undefined as any, stop: vi.fn(async () => {}), start: vi.fn(async () => {}), terminalData: undefined as any, loadError: undefined as Error | undefined, loadGate: undefined as Promise<void> | undefined }))
vi.mock('../src/main/ctx', () => ({
  createApp: () => f.ctx, getCtx: () => f.ctx, startApp: async () => {}, stopApp: async () => {},
  ensureProjectBase: async (_ctx: unknown, project: string) => `ally-${project}`, startProjectBase: f.start, stopProjectBase: f.stop
}))
vi.mock('../src/main/ipc', () => ({ registerIpc: (_ctx: unknown, windows: unknown) => { f.ipc = windows } }))
vi.mock('../src/main/win-identity', () => ({ ensureWindowsToastIdentity: () => {}, setWindowsAppId: () => {} }))
vi.mock('../src/main/fal-service', () => ({ MEDIA_SCHEME: 'genio-media', mediaResponse: () => {} }))
vi.mock('../src/main/chat-images', () => ({ chatImageDir: () => '', chatImagePath: () => undefined }))
vi.mock('../src/main/util', () => ({ nowIso: () => '', writeJson: (p: string, data: unknown) => { if (p.endsWith('chat-popout.json')) f.popouts = data }, readJson: () => f.popouts ?? {} }))
vi.mock('node:fs', () => ({ default: { mkdirSync: () => {}, unlinkSync: () => {} } }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  f.app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, whenReady: async () => {}, isPackaged: true, getAppPath: () => '.', quit: vi.fn(), exit: vi.fn() })
  class Window extends EventEmitter {
    openHandler: any
    webContents = Object.assign(new EventEmitter(), { id: f.windows.length + 1, send: vi.fn(), isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => 'file:///genio/index.html?project=one&wksp=ally-one', setWindowOpenHandler: (fn: any) => { this.openHandler = fn } })
    destroyed = false
    minimized = false
    visible = false
    menu: unknown
    query: any
    focus = vi.fn()
    show = vi.fn(() => { this.visible = true })
    moveTop = vi.fn()
    setMenu = vi.fn((menu: unknown) => { this.menu = menu })
    restore = vi.fn(() => { this.minimized = false })
    destroy() { this.destroyed = true; this.emit('closed') }
    isMinimized = () => this.minimized
    isDestroyed = () => this.destroyed
    static getFocusedWindow() { return null }
    constructor(_options: unknown) { super(); f.windows.push(this) }
    async loadFile(_file: string, options: any) {
      this.query = options.query
      if (f.loadError) throw f.loadError
      if (f.loadGate) await f.loadGate
      this.webContents.emit('did-finish-load')
    }
    close() {
      let prevented = false
      this.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) { this.destroyed = true; this.emit('closed') }
    }
  }
  f.screen = Object.assign(new EventEmitter(), {
    displays: [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }, { workArea: { x: 1920, y: 0, width: 1280, height: 984 } }],
    getAllDisplays() { return this.displays }, getPrimaryDisplay() { return this.displays[0] }
  })
  return { app: f.app, BrowserWindow: Window, screen: f.screen, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, shell: {}, dialog: { showMessageBoxSync: () => { f.prompts++; return f.choice }, showErrorBox: vi.fn() } }
})

let openProject: (folder: string) => Promise<void>
beforeAll(async () => {
  const snapshot = { tasks: [], projects: [], wksps: [], allies: [], backlog: [], decisions: [] }
  f.ctx = {
    snapshot: () => snapshot, settings: { get: () => ({}) }, permissions: { pending: () => [] },
    projects: { get: (name: string) => ({ name, path: name }), openFolder: async (name: string) => ({ project: { name, path: name }, registered: true }) },
    stats: { unlock: vi.fn() }, homes: new Map(),
    terminals: { get: (id: string) => ({ id, alive: true }), list: () => [], onAnyData: (fn: unknown) => { f.terminalData = fn } }
  }
  const argv = process.argv
  process.argv = ['Genio.exe']
  try {
    ;({ openProject } = await import('../src/main/index'))
    await vi.waitFor(() => expect(f.windows).toHaveLength(1))
  } finally { process.argv = argv }
})

describe('project window lifecycle', () => {
  it('opens a Hub and reuses one project window for concurrent opens', async () => {
    expect(f.windows[0].query).toEqual({})
    expect(f.windows[0].menu).toBeNull()
    await Promise.all([openProject('one'), openProject('one')])
    expect(f.windows).toHaveLength(2)
    expect(f.windows[1].query).toEqual({ project: 'one', wksp: 'ally-one', registered: '1' })
    expect(f.windows[1].setMenu).toHaveBeenCalledExactlyOnceWith(null)
    expect(f.windows[1].focus).toHaveBeenCalledOnce()
    expect(f.ctx.stats.unlock).toHaveBeenCalledWith('project-window-open')
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.ctx, 'one', 'ally-one')
    expect(f.ctx.stats.unlock).not.toHaveBeenCalledWith('project-windows-two')
  })
  it('coalesces a chat stream for its project window and keeps chat traffic off the Hub and other projects', async () => {
    await openProject('two')
    expect(f.ctx.stats.unlock).toHaveBeenCalledWith('project-windows-two')
    for (const w of f.windows) w.webContents.send.mockClear()
    bus.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'chat', text: 'one ' })
    bus.publish({ type: 'chat-delta', wksp: 'ally-one', id: 'chat', text: 'only' })
    expect(f.windows[1].webContents.send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(f.windows[1].webContents.send).toHaveBeenCalledWith('genio:event', { type: 'chat-delta', wksp: 'ally-one', id: 'chat', text: 'one only' }))
    expect(f.windows[1].webContents.send).toHaveBeenCalledTimes(1)
    expect(f.windows[0].webContents.send).not.toHaveBeenCalled()
    expect(f.windows[2].webContents.send).not.toHaveBeenCalled()
    const global = { type: 'settings', settings: {} } as GenioEvent
    bus.publish(global)
    for (const w of f.windows) expect(w.webContents.send).toHaveBeenCalledWith('genio:event', global)
  })
  it('allows only the bound same-page chat popup and closes it with its owner', async () => {
    const owner = f.windows[1]
    const handler = owner.openHandler
    const url = owner.webContents.getURL() + '#genio-chat-panel'
    expect(handler({ url })).toMatchObject({ action: 'allow', overrideBrowserWindowOptions: {
      alwaysOnTop: true, show: false, minWidth: 360, webPreferences: { nodeIntegration: false, contextIsolation: true }
    } })
    expect(handler({ url: 'file:///other.html#genio-chat-panel' })).toEqual({ action: 'deny' })
    let bounds = { x: 2000, y: 100, width: 500, height: 600 }
    const child = Object.assign(new (await import('node:events')).EventEmitter(), {
      isDestroyed: () => false, isMinimized: () => false, isVisible: vi.fn(() => false), show: vi.fn(), showInactive: vi.fn(), moveTop: vi.fn(), focus: vi.fn(), destroy: vi.fn(),
      getBounds: () => bounds, getNormalBounds: () => bounds, setBounds: vi.fn((b: typeof bounds) => { bounds = b }),
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn() } })
    owner.webContents.emit('did-create-window', child)
    const navigate = child.webContents.on.mock.calls[0][1]
    const prevented = vi.fn()
    navigate({ preventDefault: prevented }, url)
    expect(prevented).not.toHaveBeenCalled()
    child.webContents.once.mock.calls[0][1]()
    // Shown without taking focus from the game or editor.
    expect(child.showInactive).toHaveBeenCalledOnce()
    expect(child.focus).not.toHaveBeenCalled()
    navigate({ preventDefault: prevented }, url)
    expect(prevented).toHaveBeenCalledOnce()
    // Unplugging the right monitor pulls the window back onto the remaining display.
    f.screen.displays = f.screen.displays.slice(0, 1)
    f.screen.emit('display-removed')
    expect(bounds).toEqual({ x: 1420, y: 100, width: 500, height: 600 })
    // Closing remembers the window position per project, and reopening restores it on screen.
    child.emit('close')
    expect(f.popouts).toEqual({ one: bounds })
    expect(handler({ url })).toEqual({ action: 'deny' })
    expect(child.focus).toHaveBeenCalledOnce()
    // The following confirmed-close case must destroy this child, without stopping extra units.
    owner.chatChild = child
  })
  it('guards File Exit for its project and stops only that project after confirmation', async () => {
    f.ctx.homes.set('main', { crew: { list: () => [{ project: 'one', terminalId: 'term' }] } })
    f.ipc.close(f.windows[1].webContents.id)
    expect(f.windows[1].destroyed).toBe(false)
    expect(f.stop).not.toHaveBeenCalled()
    f.choice = 0
    f.ipc.close(f.windows[1].webContents.id)
    await vi.waitFor(() => expect(f.windows[1].destroyed).toBe(true))
    expect(f.stop).toHaveBeenCalledWith(f.ctx, 'one', 'ally-one')
    expect(f.windows[1].chatChild.destroy).toHaveBeenCalledOnce()
    expect(f.windows[2].destroyed).toBe(false)
    expect(f.windows[0].destroyed).toBe(false)
    f.windows[0].close()
    expect(f.windows[0].destroyed).toBe(true)
    expect(f.windows[2].destroyed).toBe(false)
    expect(f.app.exit).not.toHaveBeenCalled()
  })
})


describe('notification click routing', () => {
  it('reopens a closed owning project and reveals exactly its decision without navigating other windows', async () => {
    const snapshot = f.ctx.snapshot()
    snapshot.decisions = [{ id: 'choice-one', project: 'one', wksp: 'ally-one' }]
    const target = { view: 'move', project: 'one', wksp: 'ally-one', decisionId: 'choice-one' } as const
    for (const w of f.windows) { w.webContents.send.mockClear(); w.focus.mockClear() }
    bus.publish({ type: 'navigate', target })
    await vi.waitFor(() => expect(f.windows.find(w => !w.destroyed && w.query.project === 'one')?.webContents.send).toHaveBeenCalledWith('genio:event', { type: 'navigate', target }))
    const owner = f.windows.find(w => !w.destroyed && w.query.project === 'one')
    expect(owner.focus).toHaveBeenCalled()
    expect(f.windows[2].focus).not.toHaveBeenCalled()
    expect(f.windows[2].webContents.send).not.toHaveBeenCalledWith('genio:event', { type: 'navigate', target })
    const count = f.windows.length
    bus.publish({ type: 'navigate', target })
    await vi.waitFor(() => expect(owner.webContents.send.mock.calls.filter((c: any[]) => c[1].type === 'navigate')).toHaveLength(2))
    expect(f.windows).toHaveLength(count)
    snapshot.decisions = []
  })
})

describe('File menu window controls', () => {
  const open = () => f.windows.filter(w => !w.destroyed)
  it('lists open windows for the caller, opens or focuses the Hub and closes only the calling window', async () => {
    const [two, one] = open()
    expect(f.ipc.list(two.webContents.id)).toEqual([{ project: 'two', current: true }, { project: 'one', current: false }])
    await f.ipc.openHub()
    const hub = f.windows.at(-1)
    expect(hub.query).toEqual({})
    const count = f.windows.length
    hub.focus.mockClear()
    await f.ipc.openHub()
    expect(f.windows).toHaveLength(count)
    expect(hub.focus).toHaveBeenCalledOnce()
    expect(f.ipc.list(hub.webContents.id)).toEqual([{ project: 'two', current: false }, { project: 'one', current: false }, { project: null, current: true }])
    f.ipc.close(hub.webContents.id)
    expect(hub.destroyed).toBe(true)
    expect(open()).toEqual([two, one])
  })
  it('waits for a new Hub to load and focuses a single instance for concurrent requests', async () => {
    let ready!: () => void
    f.loadGate = new Promise<void>(resolve => { ready = resolve })
    try {
      const count = f.windows.length
      const first = f.ipc.openHub()
      const second = f.ipc.openHub()
      expect(f.windows).toHaveLength(count + 1)
      const hub = f.windows.at(-1)
      expect(hub.query).toEqual({})
      expect(hub.focus).not.toHaveBeenCalled()
      ready()
      await Promise.all([first, second])
      expect(hub.show).toHaveBeenCalled()
      expect(hub.focus).toHaveBeenCalled()
      expect(open().filter(w => !w.query.project)).toEqual([hub])
      hub.destroy()
    } finally { f.loadGate = undefined }
  })
  it('shows and raises a reused Hub and restores it before focusing when minimized', async () => {
    await f.ipc.openHub()
    const hub = f.windows.at(-1)
    const count = f.windows.length
    for (const minimized of [false, true]) {
      hub.visible = false
      hub.minimized = minimized
      for (const fn of [hub.restore, hub.show, hub.moveTop, hub.focus]) fn.mockClear()
      await f.ipc.openHub()
      expect(f.windows).toHaveLength(count)
      expect(hub.visible).toBe(true)
      expect(hub.minimized).toBe(false)
      expect(hub.show).toHaveBeenCalledOnce()
      expect(hub.focus).toHaveBeenCalledOnce()
      expect(hub.restore).toHaveBeenCalledTimes(minimized ? 1 : 0)
      expect(hub.show.mock.invocationCallOrder[0]).toBeLessThan(hub.focus.mock.invocationCallOrder[0])
      if (minimized) expect(hub.restore.mock.invocationCallOrder[0]).toBeLessThan(hub.show.mock.invocationCallOrder[0])
      if (process.platform === 'win32') {
        expect(hub.moveTop).toHaveBeenCalledOnce()
        expect(hub.moveTop.mock.invocationCallOrder[0]).toBeLessThan(hub.focus.mock.invocationCallOrder[0])
      }
    }
    hub.destroy()
  })
  it('rejects a failed Hub load, removes its hidden window and allows a retry', async () => {
    f.loadError = new Error('Hub page unavailable')
    try {
      await expect(f.ipc.openHub()).rejects.toThrow('Hub page unavailable')
      expect(f.windows.at(-1).destroyed).toBe(true)
    } finally { f.loadError = undefined }
    await f.ipc.openHub()
    const hub = f.windows.at(-1)
    expect(hub.destroyed).toBe(false)
    expect(hub.visible).toBe(true)
    expect(hub.focus).toHaveBeenCalledOnce()
    hub.destroy()
  })
  it('asks once before application quit stops units, then closes every window without asking again', async () => {
    f.stop.mockClear()
    f.prompts = 0
    f.choice = 1
    const cancelled = { preventDefault: vi.fn() }
    f.app.emit('before-quit', cancelled)
    expect(cancelled.preventDefault).toHaveBeenCalledOnce()
    expect(f.prompts).toBe(1)
    expect(open()).toHaveLength(2)
    expect(f.stop).not.toHaveBeenCalled()
    f.choice = 0
    f.app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(open()).toEqual([]))
    expect(f.prompts).toBe(2)
    expect(f.stop).toHaveBeenCalledWith(f.ctx, 'one', 'ally-one')
    expect(f.stop).toHaveBeenCalledWith(f.ctx, 'two', 'ally-two')
  })
  it('reuses the Hub when it is the only window', async () => {
    await f.ipc.openHub()
    const hub = f.windows.at(-1)
    const count = f.windows.length
    await f.ipc.openHub()
    expect(f.windows).toHaveLength(count)
    expect(open()).toEqual([hub])
    expect(hub.visible).toBe(true)
    expect(hub.focus).toHaveBeenCalledTimes(2)
    hub.destroy()
  })
})
