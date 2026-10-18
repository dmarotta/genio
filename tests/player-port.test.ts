import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppCtx } from '../src/main/services'
import { validateInput } from '../src/main/play-stream'

const f = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(), ports: [] as any[], frames: [] as ((b: Buffer) => void)[], audio: [] as ((b: Buffer) => void)[],
  detach: vi.fn(async () => {}), stop: vi.fn(async () => {}), input: vi.fn(), play: vi.fn(async () => ({})), resize: vi.fn(async () => ({})), pause: vi.fn(async () => ({}))
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Port extends EventEmitter {
    closed = false; messages: unknown[] = []
    start() {}
    postMessage(data: unknown) { this.messages.push(data) }
    close() { if (!this.closed) { this.closed = true; this.emit('close') } }
  }
  return {
    app: { getAppPath: () => '.' }, BrowserWindow: {}, dialog: {}, shell: {},
    ipcMain: { removeHandler() {}, handle: (name: string, fn: (...args: any[]) => Promise<unknown>) => f.handlers.set(name, fn) },
    MessageChannelMain: class { port1 = new Port(); port2 = new Port(); constructor() { f.ports.push(this) } }
  }
})
vi.mock('../src/main/player-instance', () => ({ playerInstanceService: () => ({
  stream: async (_w: string, _width: number, _height: number, frame: (b: Buffer) => void, _detach: () => void, audio: (b: Buffer) => void) => { f.frames.push(frame); f.audio.push(audio) },
  detach: f.detach, stop: f.stop, play: f.play, input: f.input, enterPlay: f.play, resize: f.resize, pause: f.pause, step: f.pause, stopUnity: f.stop
}) }))
import { registerIpc, AUDIO_BACKLOG, AUDIO_IN_FLIGHT } from '../src/main/ipc'
let sender: EventEmitter & { id: number; isDestroyed(): boolean; postMessage: ReturnType<typeof vi.fn>; mainFrame: object }
beforeEach(() => {
  f.handlers.clear(); f.ports = []; f.frames = []; f.audio = []; vi.clearAllMocks()
  f.input.mockImplementation((_world, input) => validateInput(input))
  sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, postMessage: vi.fn(), mainFrame: { main: true } })
  registerIpc(() => ({} as AppCtx), { binding: id => id === 1 ? { project: 'A', workspace: 'ally' } : { project: 'B', workspace: 'ally' }, list: () => [], close() {}, openHub: async () => {}, openProject: async () => {} })
})
const call = (method: string, ...args: unknown[]) => f.handlers.get(`genio:${method}`)!({ sender }, ...args)
it('transfers only a MessagePort, keeps one latest frame, and sends one frame per credit', async () => {
  await call('playerInstanceStream', 'A', true)
  expect(sender.postMessage).toHaveBeenCalledExactlyOnceWith('genio:play-port', { world: 'A' }, [f.ports[0].port2])
  const port = f.ports[0].port1, frame = f.frames[0]
  frame(Buffer.from('old')); frame(Buffer.from('new'))
  expect(port.messages).toHaveLength(0)
  port.emit('message', { data: { type: 'ready' } })
  expect(port.messages).toEqual([{ type: 'frame', bytes: new Uint8Array(Buffer.from('new')) }])
  frame(Buffer.from('later')); expect(port.messages).toHaveLength(1)
  port.emit('message', { data: { type: 'ready' } }); expect(port.messages).toHaveLength(2)
  port.emit('message', { data: { type: 'input', input: { type: 'release' } } })
  expect(f.input).toHaveBeenCalledWith('A', { type: 'release' })
})
it('fences another project window before it can close or obtain the stream', async () => {
  await call('playerInstanceStream', 'A', true)
  sender.id = 2
  await expect(call('playerInstanceStream', 'A', true)).rejects.toThrow('bound')
  expect(f.ports).toHaveLength(1); expect(f.ports[0].port1.closed).toBe(false)
})
it('stops Play on port closure, malformed input, and renderer destruction', async () => {
  await call('playerInstanceStream', 'A', true)
  f.ports[0].port1.close(); expect(f.detach).toHaveBeenCalledExactlyOnceWith('A')
  await call('playerInstanceStream', 'A', true)
  f.ports[1].port1.emit('message', { data: { type: 'input', input: { type: 'state', x: 5 } } })
  expect(f.detach).toHaveBeenCalledTimes(2)
  await call('playerInstanceStream', 'A', true); sender.emit('destroyed')
  expect(f.detach).toHaveBeenCalledTimes(3)
})
it('replaces a port without queuing a stale Stop against its successor', async () => {
  await call('playerInstanceStream', 'A', true)
  await call('playerInstanceStream', 'A', true)
  expect(f.ports[0].port1.closed).toBe(true); expect(f.detach).not.toHaveBeenCalled()
  await call('playerInstancePlay', 'A', { ref: 'main' })
  expect(f.ports[1].port1.closed).toBe(true); expect(f.detach).not.toHaveBeenCalled()
  expect(f.play).toHaveBeenCalledExactlyOnceWith('A', { ref: 'main' }, undefined)
})
it('keeps the port through resize, pause and step, and closes it without a Stop for Enter Play and Stop Unity', async () => {
  await call('playerInstanceStream', 'A', true)
  await call('playerInstanceResize', 'A', 960, 540); await call('playerInstancePause', 'A'); await call('playerInstanceStep', 'A')
  expect(f.resize).toHaveBeenCalledExactlyOnceWith('A', 960, 540)
  expect(f.ports[0].port1.closed).toBe(false); expect(sender.postMessage).toHaveBeenCalledTimes(1)
  await call('playerInstanceEnterPlay', 'A', { ref: 'main' })
  expect(f.ports[0].port1.closed).toBe(true); expect(f.detach).not.toHaveBeenCalled()
  await call('playerInstanceStream', 'A', true); await call('playerInstanceStopUnity', 'A')
  expect(f.ports[1].port1.closed).toBe(true); expect(f.detach).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalledExactlyOnceWith('A')
})
it('sends audio outside the frame credits, bounded by acks, dropping the oldest backlog', async () => {
  await call('playerInstanceStream', 'A', true)
  const port = f.ports[0].port1, audio = f.audio[0], frame = f.frames[0]
  const sent = () => port.messages.filter((m: { type: string }) => m.type === 'audio').map((m: { bytes: Uint8Array }) => m.bytes[2])
  const packet = (n: number) => Buffer.from([0x47, 0x41, n])
  // No 'ready' credit: audio flows at once, up to the in-flight limit.
  for (let n = 0; n < AUDIO_IN_FLIGHT + AUDIO_BACKLOG + 3; n++) audio(packet(n))
  expect(sent()).toEqual([...Array(AUDIO_IN_FLIGHT).keys()])
  frame(Buffer.from('frame')); expect(port.messages.some((m: { type: string }) => m.type === 'frame')).toBe(false)
  for (const count of [0, -3, 1.5, 'x']) port.emit('message', { data: { type: 'audio-ack', count } })
  expect(sent()).toHaveLength(AUDIO_IN_FLIGHT)
  // The renderer catches up: only the newest AUDIO_BACKLOG queued packets are left to send.
  port.emit('message', { data: { type: 'audio-ack', count: AUDIO_IN_FLIGHT } })
  const newest = [...Array(AUDIO_BACKLOG).keys()].map(k => AUDIO_IN_FLIGHT + 3 + k)
  expect(sent()).toEqual([...Array(AUDIO_IN_FLIGHT).keys(), ...newest])
  audio(packet(99)); expect(sent().at(-1)).toBe(99)
  port.emit('message', { data: { type: 'ready' } }); expect(port.messages.at(-1)).toEqual({ type: 'frame', bytes: new Uint8Array(Buffer.from('frame')) })
  port.close(); const before = port.messages.length; audio(packet(100)); expect(port.messages).toHaveLength(before)
})

/** A fast-path frame as the sink sees it: deliver resolves as the fake texture send does. */
function texture(seq: number, { live = true, sent = true } = {}) {
  let resolve!: (sent: boolean) => void
  const frame = { kind: 'texture' as const, width: 1280, height: 720, seq, live, drop: vi.fn(),
    deliver: vi.fn((_to: unknown, _world: string) => new Promise<boolean>(r => { resolve = r })), finish: () => resolve(sent) }
  return frame
}
it('keeps the newest GPU frame per credit, frees superseded ones, and gets the credit back from the renderer', async () => {
  await call('playerInstanceStream', 'A', true)
  const port = f.ports[0].port1, frame = f.frames[0] as unknown as (t: unknown) => void
  const a = texture(1), b = texture(2), c = texture(3), d = texture(4)
  frame(a); frame(b)
  expect(a.drop).toHaveBeenCalledOnce(); expect(b.deliver).not.toHaveBeenCalled()
  port.emit('message', { data: { type: 'ready' } })
  expect(b.deliver).toHaveBeenCalledExactlyOnceWith(sender.mainFrame, 'A')
  // In flight: newer frames wait for the next credit, superseding each other; nothing goes over the port.
  frame(c); frame(d); expect(c.drop).toHaveBeenCalledOnce(); expect(d.deliver).not.toHaveBeenCalled()
  b.finish(); await Promise.resolve()
  expect(d.deliver).not.toHaveBeenCalled()
  port.emit('message', { data: { type: 'ready' } }); expect(d.deliver).toHaveBeenCalledOnce()
  expect(port.messages).toEqual([])
  expect(b.drop).not.toHaveBeenCalled(); expect(d.drop).not.toHaveBeenCalled()
})
it('returns the credit when a GPU frame did not reach the renderer, drops dead frames, and takes JPEG after a fallback', async () => {
  await call('playerInstanceStream', 'A', true)
  const port = f.ports[0].port1, frame = f.frames[0] as unknown as (t: unknown) => void
  const failed = texture(1, { sent: false }), dead = texture(2, { live: false }), next = texture(3)
  port.emit('message', { data: { type: 'ready' } })
  frame(failed); expect(failed.deliver).toHaveBeenCalledOnce()
  frame(dead); failed.finish(); await new Promise(r => setTimeout(r, 0))
  // The credit came back: the dead frame was freed unseen, and the next one goes at once.
  expect(dead.drop).toHaveBeenCalledOnce(); expect(dead.deliver).not.toHaveBeenCalled()
  frame(next); expect(next.deliver).toHaveBeenCalledOnce(); next.finish(); await Promise.resolve()
  frame(Buffer.from('jpeg')); expect(port.messages).toEqual([])
  port.emit('message', { data: { type: 'ready' } }); expect(port.messages).toEqual([{ type: 'frame', bytes: new Uint8Array(Buffer.from('jpeg')) }])
})
it('frees a waiting GPU frame when the port closes, and every later one', async () => {
  await call('playerInstanceStream', 'A', true)
  const frame = f.frames[0] as unknown as (t: unknown) => void
  const waiting = texture(1), late = texture(2)
  frame(waiting); f.ports[0].port1.close()
  expect(waiting.drop).toHaveBeenCalledOnce()
  frame(late); expect(late.drop).toHaveBeenCalledOnce(); expect(late.deliver).not.toHaveBeenCalled()
})