import { afterEach, expect, it, vi } from 'vitest'
import { TextureDecoder } from '../src/renderer/src/viewer3d/textures'

afterEach(() => vi.unstubAllGlobals())

it('holds texture IO until geometry is ready and never starts queued work after cancellation', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const decoder = new TextureDecoder(1024, true)
  const pending = decoder.decode('genio-media://model/t/large.tga').catch(e => e)
  await Promise.resolve()
  expect(fetch).not.toHaveBeenCalled()
  decoder.dispose()
  expect(await pending).toBeInstanceOf(Error)
  expect(fetch).not.toHaveBeenCalled()
})

it('aborts in-flight IO and prevents another texture from starting', async () => {
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    signal = init.signal!
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  })))
  const decoder = new TextureDecoder(1024)
  const first = decoder.decode('genio-media://model/t/a.tga').catch(e => e)
  const second = decoder.decode('genio-media://model/t/b.tga').catch(e => e)
  await new Promise(resolve => setTimeout(resolve, 0))
  decoder.dispose()
  expect(signal.aborted).toBe(true)
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  expect(fetch).toHaveBeenCalledTimes(1)
})
