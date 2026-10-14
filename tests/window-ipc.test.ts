import { beforeEach, expect, it, vi } from 'vitest'
import { registerIpc, type IpcWindows } from '../src/main/ipc'
import type { AppCtx } from '../src/main/services'

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  app: { getAppPath: () => '.', quit: vi.fn() }, BrowserWindow: {}, dialog: {}, shell: {}, MessageChannelMain: {},
  ipcMain: { removeHandler: (channel: string) => handlers.delete(channel), handle: (channel: string, fn: (...args: any[]) => Promise<unknown>) => handlers.set(channel, fn) }
}))

beforeEach(() => handlers.clear())

const call = (id: number) => handlers.get('genio:windowOpenHub')!({ sender: { id } })
const windows = (bound: boolean): IpcWindows => ({
  binding: vi.fn(() => bound ? { project: 'one', wksp: 'ally-one' } : undefined),
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
