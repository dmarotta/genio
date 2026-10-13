// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/store', () => ({ PROJECT_WINDOW: 'game', PROJECT_WKSP:'game-wksp' }))
vi.mock('../src/renderer/src/views/Comms', () => ({ ChatPanel: () => null }))
import { Play } from '../src/renderer/src/views/Play'
import { PlayLive } from '../src/renderer/src/views/PlayLive'
let root: Root; let host: HTMLDivElement
const status = { connected:true, state:'playing', scenes:[{name:'Game',path:'Assets/Game.unity',isActive:true,isDirty:false}], capabilities:{input:true,resolution:false} }
const api = { playStatus:vi.fn(), playFrame:vi.fn(), playStats:vi.fn(), playConsole:vi.fn(), playScenes:vi.fn(), playAction:vi.fn(), playScreenshot:vi.fn(), playOpenUnity:vi.fn(), playDetach:vi.fn().mockResolvedValue(undefined), playStream:vi.fn().mockResolvedValue(undefined), playPool:vi.fn().mockResolvedValue({cap:1,slots:[],queue:[]}) }
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
  Object.assign(window,{genio:{api}})
  api.playStatus.mockResolvedValue(status)
  api.playFrame.mockResolvedValue({base64:'aGVsbG8=',width:640,height:360,capturedAt:'now',latencyMs:800})
  api.playStats.mockResolvedValue({}); api.playConsole.mockResolvedValue({entries:[],cursor:1,session:'a'}); api.playScenes.mockResolvedValue(status.scenes)
  api.playAction.mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root=createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); vi.useRealTimers() })
it('polls only the bound world and stops scheduling when the view closes', async () => {
  await act(async () => root.render(React.createElement(Play)))
  expect(api.playFrame).toHaveBeenCalledWith('game',1280,720)
  expect(host.textContent).toContain('Snapshot mode')
  expect(host.querySelectorAll('select')).toHaveLength(2) // scenes and size, no world picker
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(api.playFrame).toHaveBeenCalledTimes(2)
  await act(async () => root.render(null))
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(api.playFrame).toHaveBeenCalledTimes(2)
})
it('requires explicit input capture and sends a discrete key only to its project', async () => {
  await act(async () => root.render(React.createElement(Play)))
  const img=host.querySelector('img')!
  await act(async () => img.dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',bubbles:true})))
  expect(api.playAction).not.toHaveBeenCalled()
  await act(async () => (host.querySelector('input[type=checkbox]') as HTMLInputElement).click())
  await act(async () => img.dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',bubbles:true})))
  expect(api.playAction).toHaveBeenCalledWith('game',{type:'key',key:'W'})
})
it('does not overlap slow captures or keep showing a disconnected frame', async () => {
  let finish!: (frame: unknown) => void
  api.playFrame.mockImplementationOnce(() => new Promise(r => { finish=r }))
  await act(async () => root.render(React.createElement(Play)))
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(api.playFrame).toHaveBeenCalledTimes(1)
  await act(async () => finish({base64:'aGVsbG8=',width:640,height:360,capturedAt:'now',latencyMs:3000}))
  api.playFrame.mockRejectedValueOnce(new Error('Editor closed'))
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  expect(host.querySelector('img')).toBeNull()
})
it('decodes one live frame per credit, forwards held input only while focused, and releases on close', async () => {
  const bitmap = { close: vi.fn() }
  const drawImage = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({drawImage} as unknown as CanvasRenderingContext2D)
  const channel = { postMessage:vi.fn(), start:vi.fn(), close:vi.fn(), onmessage:null as ((e: {data:unknown}) => Promise<void>) | null }
  try {
    await act(async () => root.render(React.createElement(PlayLive,{world:'game',width:640,height:360,input:true,onError:vi.fn()})))
    expect(api.playStream).toHaveBeenCalledWith('game',true,640,360)
    await act(async () => window.dispatchEvent(new MessageEvent('message',{source:window,data:{type:'genio:play-port',world:'game'},ports:[channel as unknown as MessagePort]})))
    expect(channel.postMessage).toHaveBeenCalledWith({type:'ready'})
    await act(async () => channel.onmessage!({data:{type:'frame',bytes:new Uint8Array([255,216,255,217])}}))
    expect(drawImage).toHaveBeenCalledWith(bitmap,0,0,640,360)
    expect(bitmap.close).toHaveBeenCalledOnce()
    const canvas=host.querySelector('canvas')!
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true})); await vi.advanceTimersByTimeAsync(33) })
    expect(channel.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'input',input:expect.objectContaining({type:'state',keys:['W']})}))
    await act(async () => canvas.blur())
    expect(channel.postMessage).toHaveBeenCalledWith({type:'input',input:{type:'release'}})
    await act(async () => root.render(null))
    expect(channel.close).toHaveBeenCalledOnce()
    expect(api.playStream).toHaveBeenLastCalledWith('game',false)
  } finally { context.mockRestore();vi.unstubAllGlobals() }
})
