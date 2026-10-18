import { beforeEach, expect, it, vi } from 'vitest'
import { registerIpc, type IpcWindows } from '../src/main/ipc'
import type { AppCtx } from '../src/main/services'
import { bus } from '../src/main/bus'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  app: { getAppPath: () => '.', quit: vi.fn() }, BrowserWindow: {}, dialog: {}, shell: {}, MessageChannelMain: {},
  ipcMain: { removeHandler: (channel: string) => handlers.delete(channel), handle: (channel: string, fn: (...args: any[]) => Promise<unknown>) => handlers.set(channel, fn) }
}))

beforeEach(() => handlers.clear())

const call = (id: number) => handlers.get('genio:windowOpenHub')!({ sender: { id } })
const windows = (bound: boolean): IpcWindows => ({
  binding: vi.fn(() => bound ? { project: 'one', workspace: 'ally-one' } : undefined),
  openHub: vi.fn(async () => {}), openProject: vi.fn(async () => {}), list: () => [], close: vi.fn()
})
const ctx = () => { throw new Error('Opening the Hub must not need project services') }

it.each([false, true])('opens the Hub without a project binding requirement (bound=%s)', async bound => {
  const manager = windows(bound)
  registerIpc(ctx as () => AppCtx, manager)
  await expect(call(1)).resolves.toBeUndefined()
  expect(manager.openHub).toHaveBeenCalledOnce()
})

it('waits for the window manager and propagates load failures to the renderer', async () => {
  const manager = windows(true)
  let fail!: (error: Error) => void
  manager.openHub = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  registerIpc(ctx as () => AppCtx, manager)
  let settled = false
  const result = call(1)
  void result.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  fail(new Error('Hub page unavailable'))
  await expect(result).rejects.toThrow('Hub page unavailable')
})

it('rejects a missing manager instead of silently succeeding', async () => {
  registerIpc(ctx as () => AppCtx)
  await expect(call(1)).rejects.toThrow('Hub window manager is unavailable')
})

it('routes Exit to only the calling window', async () => {
  const manager = windows(true)
  registerIpc(ctx as () => AppCtx, manager)
  await handlers.get('genio:windowClose')!({ sender: { id: 42 } })
  expect(manager.close).toHaveBeenCalledExactlyOnceWith(42)
  expect(handlers.has('genio:appQuit')).toBe(false)
})

it('never sends a ! message to the model as chat text', async () => {
  const send = vi.fn(async () => {})
  const steer = vi.fn(async () => {})
  const hc = { workspace: { send, steer } }
  registerIpc((() => ({ home: () => hc })) as unknown as () => AppCtx, windows(true))
  for (const method of ['sendChat', 'steerChat']) {
    await expect(handlers.get(`genio:${method}`)!({ sender: { id: 1 } }, 'ally-one', '!git status')).rejects.toThrow(/shell commands/)
    await expect(handlers.get(`genio:${method}`)!({ sender: { id: 1 } }, 'ally-one', '  !ls')).rejects.toThrow(/shell commands/)
  }
  expect(send).not.toHaveBeenCalled()
  expect(steer).not.toHaveBeenCalled()
  await handlers.get('genio:sendChat')!({ sender: { id: 1 } }, 'ally-one', 'what does it mean!')
  expect(send).toHaveBeenCalledOnce()
})

it('stops speech when a message, a steer or a ! command is actually sent, not when it is refused', async () => {
  const stops: string[] = []
  const off = bus.onEvent(ev => { if (ev.type === 'speak-stop') stops.push(ev.workspace) })
  try {
    const hc = { workspace: { send: vi.fn(async () => {}), steer: vi.fn(async () => {}) } }
    const runShell = vi.fn()
    registerIpc((() => ({ home: () => hc, terminals: { list: () => [], create: runShell }, projects: { get: () => undefined }, homes: new Map() })) as unknown as () => AppCtx, windows(true))
    await expect(handlers.get('genio:sendChat')!({ sender: { id: 1 } }, 'ally-one', '!git status')).rejects.toThrow(/shell commands/)
    await expect(handlers.get('genio:sendChat')!({ sender: { id: 1 } }, 'other-workspace', 'hello')).rejects.toThrow()
    expect(stops).toEqual([])
    await handlers.get('genio:sendChat')!({ sender: { id: 1 } }, 'ally-one', 'stop and listen')
    await handlers.get('genio:steerChat')!({ sender: { id: 1 } }, 'ally-one', 'do this first')
    await handlers.get('genio:paneRun')!({ sender: { id: 1 } }, 'one', 'ally-one', 'git status').catch(() => undefined)
    expect(stops).toEqual(['ally-one', 'ally-one', 'ally-one'])
  } finally {
    off()
  }
})

it('the terminal pane answers only its own project window, and a ! result goes only to that window\'s chat', async () => {
  const terminals = { list: () => [], create: vi.fn(), kill: vi.fn() }
  const ctx = () => ({ terminals, projects: { get: () => undefined }, homes: new Map() }) as unknown as AppCtx
  registerIpc(ctx, windows(true))
  await expect(handlers.get('genio:paneOpen')!({ sender: { id: 1 } }, 'two')).rejects.toThrow('The terminal belongs to its project window.')
  await expect(handlers.get('genio:paneRun')!({ sender: { id: 1 } }, 'one', 'other-workspace', 'ls')).rejects.toThrow('The terminal belongs to its project window.')
  await expect(handlers.get('genio:paneClose')!({ sender: { id: 1 } }, 'one')).resolves.toBeUndefined()
  registerIpc(ctx, windows(false))
  await expect(handlers.get('genio:paneCwds')!({ sender: { id: 1 } }, 'one')).rejects.toThrow('The terminal belongs to its project window.')
  expect(terminals.create).not.toHaveBeenCalled()
  expect(handlers.has('genio:terminalOpenShell')).toBe(false)
})