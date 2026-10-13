import { beforeAll, describe, expect, it, vi } from 'vitest'
import { bus } from '../src/main/bus'

const f = vi.hoisted(() => ({ windows: [] as any[], ctx: undefined as any, app: undefined as any, choice: 1, stop: vi.fn(async () => {}), start: vi.fn(async () => {}), terminalData: undefined as any }))
vi.mock('../src/main/ctx', () => ({
  createApp: () => f.ctx, getCtx: () => f.ctx, startApp: async () => {}, stopApp: async () => {},
  ensureProjectBase: async (_ctx: unknown, project: string) => `ally-${project}`, startProjectBase: f.start, stopProjectBase: f.stop
}))
vi.mock('../src/main/ipc', () => ({ registerIpc: () => {} }))
vi.mock('../src/main/win-identity', () => ({ ensureWindowsToastIdentity: () => {}, setWindowsAppId: () => {} }))
vi.mock('../src/main/fal-service', () => ({ MEDIA_SCHEME: 'genio-media', mediaResponse: () => {} }))
vi.mock('../src/main/chat-images', () => ({ chatImageDir: () => '', chatImagePath: () => undefined }))
vi.mock('../src/main/home', () => ({ defaultHomeRoot: () => '/nonexistent-test-home' }))
vi.mock('../src/main/util', () => ({ nowIso: () => '', writeJson: () => {} }))
vi.mock('node:fs', () => ({ default: { mkdirSync: () => {}, unlinkSync: () => {} } }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  f.app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, whenReady: async () => {}, isPackaged: true, getAppPath: () => '.', quit: vi.fn(), exit: vi.fn() })
  class Window extends EventEmitter {
    openHandler: any
    webContents = Object.assign(new EventEmitter(), { id: f.windows.length + 1, send: vi.fn(), isDestroyed: () => false, isLoadingMainFrame: () => false, getURL: () => 'file:///genio/index.html?project=one&wksp=ally-one', setWindowOpenHandler: (fn: any) => { this.openHandler = fn } })
    destroyed = false
    query: any
    focus = vi.fn()
    show = vi.fn()
    restore = vi.fn()
    destroy() { this.destroyed = true; this.emit('closed') }
    isMinimized = () => false
    isDestroyed = () => this.destroyed
    constructor(_options: unknown) { super(); f.windows.push(this) }
    async loadFile(_file: string, options: any) { this.query = options.query; queueMicrotask(() => this.webContents.emit('did-finish-load')) }
    close() {
      let prevented = false
      this.emit('close', { preventDefault: () => { prevented = true } })
      if (!prevented) { this.destroyed = true; this.emit('closed') }
    }
  }
  return { app: f.app, BrowserWindow: Window, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, shell: {}, dialog: { showMessageBoxSync: () => f.choice, showErrorBox: vi.fn() } }
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
    await Promise.all([openProject('one'), openProject('one')])
    expect(f.windows).toHaveLength(2)
    expect(f.windows[1].query).toEqual({ project: 'one', wksp: 'ally-one', registered: '1' })
    expect(f.windows[1].focus).toHaveBeenCalledOnce()
    expect(f.ctx.stats.unlock).toHaveBeenCalledWith('project-window-open')
    expect(f.start).toHaveBeenCalledExactlyOnceWith(f.ctx, 'one', 'ally-one')
  })
  it('broadcasts globals while keeping another project chat out', async () => {
    await openProject('two')
    for (const w of f.windows) w.webContents.send.mockClear()
    const event = { type: 'chat-delta', wksp: 'ally-one', id: 'chat', text: 'one only' } as const
    bus.publish(event)
    expect(f.windows[0].webContents.send).toHaveBeenCalledWith('genio:event', event)
    expect(f.windows[1].webContents.send).toHaveBeenCalledWith('genio:event', event)
    expect(f.windows[2].webContents.send).not.toHaveBeenCalled()
  })
  it('allows only the bound same-page chat popup and closes it with its owner', async () => {
    const owner = f.windows[1]
    const handler = owner.openHandler
    const url = owner.webContents.getURL() + '#genio-inventory-chat'
    expect(handler({ url })).toMatchObject({ action: 'allow', overrideBrowserWindowOptions: {
      alwaysOnTop: true, minWidth: 360, webPreferences: { nodeIntegration: false, contextIsolation: true }
    } })
    expect(handler({ url: 'file:///other.html#genio-inventory-chat' })).toEqual({ action: 'deny' })
    const child = { isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn(), destroy: vi.fn(),
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn() }, on: vi.fn() }
    owner.webContents.emit('did-create-window', child)
    const navigate = child.webContents.on.mock.calls[0][1]
    const prevented = vi.fn()
    navigate({ preventDefault: prevented }, url)
    expect(prevented).not.toHaveBeenCalled()
    child.webContents.once.mock.calls[0][1]()
    navigate({ preventDefault: prevented }, url)
    expect(prevented).toHaveBeenCalledOnce()
    expect(handler({ url })).toEqual({ action: 'deny' })
    expect(child.focus).toHaveBeenCalledOnce()
    // The following confirmed-close case must destroy this child, without stopping extra units.
    owner.chatChild = child
  })
  it('cancels close without stopping units, then stops only the confirmed project', async () => {
    f.ctx.homes.set('main', { crew: { list: () => [{ project: 'one', terminalId: 'term' }] } })
    f.windows[1].close()
    expect(f.windows[1].destroyed).toBe(false)
    expect(f.stop).not.toHaveBeenCalled()
    f.choice = 0
    f.windows[1].close()
    await vi.waitFor(() => expect(f.windows[1].destroyed).toBe(true))
    expect(f.stop).toHaveBeenCalledWith(f.ctx, 'one', 'ally-one')
    expect(f.windows[1].chatChild.destroy).toHaveBeenCalledOnce()
    expect(f.windows[2].destroyed).toBe(false)
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
