import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { PlayStream, validateInput, validateAudio, MAX_FRAME, AUDIO_HEADER, type PlayStreamGpu } from '../src/main/play-stream'
import type { TextureFrame } from '../src/main/play-gpu'

/** A 'GA' v1 packet as com.genio.play's AudioTap writes it; `extra` pads or (negative) truncates the samples. */
function ga({ seq = 0, rate = 48000, channels = 2, frames = 1024, time = 1.7e12, version = 1, extra = 0 } = {}) {
  const b = Buffer.alloc(Math.max(0, AUDIO_HEADER + frames * channels * 2 + extra))
  b.write('GA', 0, 'latin1'); b[2] = version; b[3] = channels
  b.writeUInt32LE(seq, 4); b.writeUInt32LE(rate, 8); b.writeUInt16LE(frames, 12); b.writeDoubleLE(time, 16)
  return b
}

const streams: PlayStream[] = []
const clients: WebSocket[] = []
afterEach(() => { for (const c of clients.splice(0)) c.terminate(); for (const s of streams.splice(0)) s.close() })
async function setup() { const stream = new PlayStream(); streams.push(stream); const {port,token} = await stream.listen(); return {stream,port,token} }
function client(port: number, token: string, headers = {}) { const c = new WebSocket(`ws://127.0.0.1:${port}/play`, { headers: { Authorization: `Bearer ${token}`, ...headers } }); clients.push(c); return c }
it('authenticates one Unity client, retains the latest JPEG and returns input', async () => {
  const {stream,port,token} = await setup()
  const c = client(port,token); await once(c,'open')
  const jpeg = Buffer.from([255,216,1,2,255,217])
  const frame = new Promise<Buffer>(r => { stream.onFrame = r }); c.send(jpeg)
  expect(await frame).toEqual(jpeg); expect(stream.latest).toEqual(jpeg)
  const input = once(c,'message'); stream.input({type:'release'})
  expect(JSON.parse((await input)[0].toString())).toEqual({type:'release'})
  const second = client(port,token); expect((await once(second,'error'))[0].message).toContain('403')
  const closed = new Promise<void>(r => { stream.onDisconnect = r }); c.close(); await closed
  expect(stream.latest).toBeUndefined()
})
it.each([{Origin:'https://evil.example'}, {Host:'localhost:1234'}, {Authorization:'Bearer wrong'}])('rejects unauthorized upgrades %j', async headers => {
  const {port,token} = await setup(); const c = client(port,token,headers)
  expect((await once(c,'error'))[0].message).toContain('403')
})
it('closes non-JPEG and oversized payloads without retaining them', async () => {
  for (const bytes of [Buffer.from('not an image'), Buffer.alloc(MAX_FRAME+1)]) {
    const {stream,port,token} = await setup(); const c = client(port,token); await once(c,'open')
    const closed = once(c,'close'); c.send(bytes); await closed; expect(stream.latest).toBeUndefined()
  }
})
it('validates whole input states and always accepts neutral release', () => {
  const valid = {type:'state' as const,keys:['W'],x:0,y:1,buttons:1,axes:[0,0,0,0,0,0],gamepadButtons:0}
  expect(() => validateInput(valid)).not.toThrow()
  for (const patch of [{x:NaN},{buttons:8},{axes:[0]},{keys:['bad/key']},{gamepadButtons:-1}]) expect(() => validateInput({...valid,...patch})).toThrow('Invalid')
  expect(() => validateInput({type:'release'})).not.toThrow()
})
it('accepts an optional wheel scroll, clamps it and rejects NaN or huge values', () => {
  const state = (scroll?: unknown) => ({type:'state' as const,keys:[],x:0.5,y:0.5,buttons:0,axes:[0,0,0,0,0,0],gamepadButtons:0,...(scroll === undefined ? {} : {scroll})}) as Parameters<typeof validateInput>[0] & {scroll?: number}
  const old = state(); expect(() => validateInput(old)).not.toThrow(); expect(old.scroll).toBeUndefined()
  for (const [given, kept] of [[1.5,1.5],[-3,-3],[0,0],[80,50],[-900,-50]]) { const s = state(given); validateInput(s); expect(s.scroll).toBe(kept) }
  for (const bad of [NaN, Infinity, -Infinity, 1e6, '2']) expect(() => validateInput(state(bad))).toThrow('Invalid')
})
it('carries the scroll of a superseded state packet into the next one', async () => {
  const {stream,port,token} = await setup()
  const c = client(port,token); await once(c,'open')
  const got: unknown[] = []; c.on('message', d => got.push(JSON.parse(d.toString())))
  const state = (scroll: number) => ({type:'state' as const,keys:[],x:0.5,y:0.5,buttons:0,axes:[0,0,0,0,0,0],gamepadButtons:0,scroll})
  stream.input(state(1)); stream.input(state(2))
  await new Promise(r => setTimeout(r, 20)); stream.input(state(0.5))
  await new Promise(r => setTimeout(r, 50))
  expect(got.map(m => (m as {scroll:number}).scroll)).toEqual([1, 2.5])
})
it('validates audio headers and sizes', () => {
  expect(validateAudio(ga({ seq: 7, frames: 512 }))).toEqual({ seq: 7, rate: 48000, channels: 2, frames: 512, time: 1.7e12 })
  for (const ok of [{ channels: 1 }, { rate: 8000 }, { rate: 192000 }, { frames: 1 }, { frames: 4096 }]) expect(validateAudio(ga(ok))).toBeDefined()
  for (const bad of [{ version: 2 }, { channels: 0 }, { channels: 3 }, { rate: 7999 }, { rate: 192001 }, { frames: 0 }, { frames: 4097 }, { time: NaN }, { time: Infinity }, { extra: 1 }, { extra: -2 }])
    expect(validateAudio(ga(bad)), JSON.stringify(bad)).toBeUndefined()
  const wrongMagic = ga(); wrongMagic[1] = 0x42; expect(validateAudio(wrongMagic)).toBeUndefined()
  expect(validateAudio(Buffer.from('GA'))).toBeUndefined()
})
it('passes interleaved JPEG and audio, never throttling audio or letting it reset the frame throttle', async () => {
  const {stream,port,token} = await setup()
  const c = client(port,token); await once(c,'open')
  const frames: Buffer[] = [], audio: number[] = []
  stream.onFrame = f => frames.push(f); stream.onAudio = a => audio.push(a.readUInt32LE(4))
  const jpeg = (n: number) => Buffer.from([255,216,n,255,217])
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  // Back to back, far inside the 25 ms frame throttle: every audio packet still arrives, in order.
  c.send(jpeg(1)); for (let seq = 0; seq < 10; seq++) c.send(ga({ seq, frames: 256 }))
  // Audio 20 ms after a frame, then a frame 20 ms later: had audio restarted the throttle, that frame would drop.
  await wait(20); c.send(ga({ seq: 10, frames: 256 })); await wait(20); c.send(jpeg(2))
  await wait(30)
  expect(audio).toEqual([0,1,2,3,4,5,6,7,8,9,10])
  expect(frames.map(f => f[2])).toEqual([1,2]); expect(stream.latest?.[2]).toBe(2)
})
it('closes a malformed audio packet with 1003', async () => {
  for (const bad of [ga({ extra: 1 }), ga({ channels: 6 }), Buffer.from('GA nonsense')]) {
    const {stream,port,token} = await setup(); const c = client(port,token); await once(c,'open')
    let heard = false; stream.onAudio = () => { heard = true }
    const closed = once(c,'close'); c.send(bad)
    expect((await closed)[0]).toBe(1003); expect(heard).toBe(false)
  }
})

/** The fast path over the real socket: a fake texture API, Unity's ring and frame messages, and Genio's answers. */
function gpuOptions(fallbacks: string[] = []): PlayStreamGpu {
  return { api: { available: true, importTexture: () => ({ release() {} }), send: async () => {}, gpus: async () => [], onGpuGone: () => () => {} },
    devices: [{ vendorId: 0x10de, deviceId: 0x2486, active: true }], width: 1280, height: 720, playing: () => true, onFallback: reason => fallbacks.push(reason) }
}
function ringMessage() {
  const b = Buffer.alloc(64); b.write('GR', 0, 'latin1'); b[2] = 2; b[3] = 3
  b.writeUInt32LE(1, 4); b.writeUInt32LE(1280, 8); b.writeUInt32LE(720, 12); b.writeUInt32LE(28, 24); b.writeUInt32LE(0x10de, 32); b.writeUInt32LE(0x2486, 36)
  for (let s = 0; s < 3; s++) b.writeBigUInt64LE(BigInt(0x100 + 4 * s), 40 + 8 * s)
  return b
}
function frameMessage(slot: number, seq: number) {
  const b = Buffer.alloc(32); b.write('GF', 0, 'latin1'); b[2] = 1; b[3] = slot; b.writeUInt32LE(1, 4); b.writeUInt32LE(seq, 8); b.writeDoubleLE(1, 16); b.writeDoubleLE(2, 24)
  return b
}
it('takes the fast path\'s ring and frames, frees slots and asks for JPEG over the same socket, and still takes JPEG', async () => {
  const fallbacks: string[] = []
  const stream = new PlayStream(gpuOptions(fallbacks)); streams.push(stream)
  const {port,token} = await stream.listen()
  const c = client(port,token); await once(c,'open')
  const textures: TextureFrame[] = [], jpegs: Buffer[] = [], texts: unknown[] = []
  stream.onTexture = f => textures.push(f); stream.onFrame = f => jpegs.push(f); c.on('message', d => texts.push(JSON.parse(d.toString())))
  expect(stream.gpuActive).toBe(true)
  c.send(ringMessage()); c.send(frameMessage(2, 41))
  await new Promise(r => setTimeout(r, 30))
  expect(textures.map(f => [f.seq, f.live])).toEqual([[41, true]])
  textures[0].drop()
  c.send(Buffer.from([0x47, 0x58, 1, 3]))
  c.send(Buffer.from([255,216,9,255,217]))
  await new Promise(r => setTimeout(r, 30))
  expect(texts).toEqual([{ type: 'free', gen: 1, slot: 2 }])
  expect(fallbacks).toEqual(['unity']); expect(stream.gpuActive).toBe(false)
  expect(jpegs.map(f => f[2])).toEqual([9])
})
it('closes fast-path messages from a session that did not ask for them, or malformed ones, with 1003', async () => {
  const plain = await setup(); const a = client(plain.port, plain.token); await once(a,'open')
  const closedA = once(a,'close'); a.send(ringMessage()); expect((await closedA)[0]).toBe(1003)
  const stream = new PlayStream(gpuOptions()); streams.push(stream)
  const {port,token} = await stream.listen(); const b = client(port,token); await once(b,'open')
  const closedB = once(b,'close'); b.send(ringMessage().subarray(0, 60)); expect((await closedB)[0]).toBe(1003)
})