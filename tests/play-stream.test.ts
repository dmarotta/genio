import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { PlayStream, validateInput, MAX_FRAME } from '../src/main/play-stream'

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
