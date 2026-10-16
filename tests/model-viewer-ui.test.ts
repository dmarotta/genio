// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InventoryInfo } from '../src/shared/inventory'
import { MODEL_PREVIEW_TIMEOUT_MS, VIEWER_APP_URL, type ModelLoaded } from '../src/shared/model-viewer'
const f = vi.hoisted(() => ({ grant: vi.fn(), release: vi.fn(), openPath: vi.fn(), revealPath: vi.fn() }))
vi.mock('../src/renderer/src/store', () => ({
  api: () => ({ inventoryModelUrl: f.grant, inventoryModelRelease: f.release, openPath: f.openPath, revealPath: f.revealPath }),
  op: async (_: string, fn: () => unknown) => fn(), errText: (e: unknown) => String((e as Error)?.message ?? e)
}))
import { ModelViewer } from '../src/renderer/src/components/ModelViewer'

const asset = (name: string, extra: Partial<InventoryInfo> = {}): InventoryInfo => {
  const ext = name.split('.').pop()!
  const kind = ['glb', 'gltf', 'fbx', 'blend', 'obj'].includes(ext) ? 'model' : ext === 'anim' ? 'animation' : ext === 'mat' ? 'material' : ['wav', 'aiff'].includes(ext) ? 'audio' : 'image'
  return { path: `Assets/${name}`, folder: 'Assets', name, ext, kind, size: 40_000, mtimeMs: 1, tracked: true, lfs: false, vendor: false, generated: false, tags: [], mediaUrl: `genio-media://world/zoo/Assets/${name}`, ...extra }
}
const model: ModelLoaded = {
  stats: { triangles: 348, vertices: 219, meshes: 1, materials: 1, textures: 1, bones: 3, size: [0.6, 2, 0.6] },
  clips: [{ name: 'Bend', duration: 1.71 }, { name: 'Wave', duration: 1.71 }],
  textures: [{ id: 0, name: 'robot_checker.png', uses: ['Robot · base colour'], width: 2048, height: 2048, original: { width: 4096, height: 4096 }, compressed: false }],
  missing: [], clayFallback: 0, animationOnly: false, loadMs: 24,
  format: 'GLB', units: 'Metres', upAxis: 'y', unityClips: false
}
const TOKEN_URL = `genio-media://model/${'a'.repeat(32)}/robot.glb`
let root: Root, host: HTMLDivElement
const text = (): string => host.textContent ?? ''
const frame = (): HTMLIFrameElement | null => host.querySelector('iframe')
async function render(info: InventoryInfo) {
  await act(async () => root.render(React.createElement(ModelViewer, { world: 'zoo', info, path: `C:/zoo/${info.path}` })))
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}
/** A message as the viewer frame would post it (or, with `source`, as anything else would). */
async function fromFrame(data: unknown, source: MessageEventSource | null = frame()!.contentWindow) {
  const message = data && typeof data === 'object' ? { requestId: f.grant.mock.calls.length, ...data } : data
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: message, source })) })
}
const button = (label: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  f.grant.mockResolvedValue(TOKEN_URL)
  f.release.mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks() })

describe('Inventory 3D preview (app side of the sandboxed frame)', () => {
  it('hosts the viewer in a script-only sandboxed frame and opens the granted model once it is ready', async () => {
    await render(asset('robot.glb'))
    expect(f.grant).toHaveBeenCalledWith('zoo', 'Assets/robot.glb')
    const iframe = frame()!
    expect(iframe.getAttribute('src')).toBe(VIEWER_APP_URL)
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    const posted = vi.spyOn(iframe.contentWindow!, 'postMessage')
    await fromFrame({ type: 'ready' })
    expect(posted.mock.calls.map(c => (c[0] as { type: string }).type)).toEqual(['settings', 'open'])
    expect(posted.mock.calls[1][0]).toMatchObject({ type: 'open', url: TOKEN_URL })
    expect(text()).toContain('Loading model…')
    await fromFrame({ type: 'loaded', model })
    expect(text()).not.toContain('Loading model…')
    for (const s of ['Triangles348', 'Vertices219', 'Bones3', '60.0 cm × 2.00 m × 60.0 cm', 'Bend (1.71 s), Wave (1.71 s)']) expect(text()).toContain(s)
    await fromFrame({ type: 'time', clip: 1, time: 0.5, playing: true })
    expect(text()).toContain('0.50 / 1.71 s')
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Animation clip"]')!.value).toBe('1')
  })

  it('ignores messages from anything but its own frame, and malformed ones from it', async () => {
    await render(asset('robot.glb'))
    await fromFrame({ type: 'loaded', model }, window)
    await fromFrame({ type: 'failed', code: 'unreadable', reason: 'spoofed' }, null)
    await fromFrame({ type: 'loaded', model: { ...model, stats: { triangles: '348' } } })
    expect(text()).toContain('Loading model…')
    expect(text()).not.toContain('spoofed')
  })

  it('sends view settings and playback to the frame, and pops out without reloading it', async () => {
    await render(asset('robot.glb'))
    const iframe = frame()!
    await fromFrame({ type: 'ready' }); await fromFrame({ type: 'loaded', model })
    const posted = vi.spyOn(iframe.contentWindow!, 'postMessage')
    await act(async () => button('Wireframe').click())
    expect(posted.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'settings', settings: { wireframe: true, grid: true } })
    expect(button('Wireframe').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button('Pause').click())
    expect(posted.mock.calls.at(-1)?.[0]).toEqual({ type: 'playback', playback: { playing: false } })
    await act(async () => button('Pop out a larger view').click())
    expect(host.querySelector('.model-viewer.popped [role="dialog"]')).not.toBeNull()
    expect(frame()).toBe(iframe)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(host.querySelector('.model-viewer.popped')).toBeNull()
    expect(frame()).toBe(iframe)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1].click())
    expect(posted.mock.calls.at(-1)?.[0]).toEqual({ type: 'texture-previews' })
    await fromFrame({ type: 'texture-previews', previews: [{ id: 0, url: 'data:image/png;base64,iVBORw0KGgo=' }] })
    expect(host.querySelector('.model-viewer-textures img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(text()).toContain('2048 × 2048 · downscaled from 4096 × 4096')
  })

  it('says why a model did not load, removes the frame and offers actions that work', async () => {
    await render(asset('robot.gltf'))
    await fromFrame({ type: 'ready' })
    await fromFrame({ type: 'failed', code: 'unreadable', reason: 'A file this model needs did not load: robot.bin.' })
    expect(frame()).toBeNull()
    expect(text()).toContain('This model can\'t be previewed')
    expect(text()).toContain('A file this model needs did not load: robot.bin.')
    await act(async () => button('Open in default app').click())
    await act(async () => button('Reveal').click())
    expect(f.openPath).toHaveBeenCalledWith('C:/zoo/Assets/robot.gltf')
    expect(f.revealPath).toHaveBeenCalledWith('C:/zoo/Assets/robot.gltf')
  })

  it('cancels a load that runs past the timeout by removing the frame', async () => {
    await render(asset('robot.glb'))
    await fromFrame({ type: 'ready' })
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_PREVIEW_TIMEOUT_MS + 10) })
    expect(frame()).toBeNull()
    expect(text()).toContain(`Preview stopped after ${MODEL_PREVIEW_TIMEOUT_MS / 1000} s`)
  })

  it('never loads a model over the size cap and shows its size and the limit', async () => {
    await render(asset('rubble.glb', { size: 76.2 * 1024 * 1024 }))
    expect(f.grant).not.toHaveBeenCalled()
    expect(frame()).toBeNull()
    expect(text()).toContain('Too large to preview: 76.2 MB (limit 64.0 MB)')
    expect(button('Open in default app')).toBeTruthy()
    expect(button('Reveal')).toBeTruthy()
  })

  it('shows the format, the file\'s units and axis, Unity clip names and why each texture is missing', async () => {
    await render(asset('robot.fbx'))
    await fromFrame({ type: 'ready' })
    await fromFrame({ type: 'loaded', model: { ...model, format: 'FBX binary', units: 'Centimetres, shown in metres; Z-up in the file, turned upright', unityClips: true, missing: ['wood.psd', 'bark.png'], clayFallback: 2 } })
    for (const s of ['FormatFBX binary', 'UnitsCentimetres, shown in metres; Z-up in the file, turned upright', 'Clip names and frame ranges come from the model\'s Unity .meta.', '2 materials shown in clay']) expect(text()).toContain(s)
    await act(async () => button('Z-up').click())
    expect(text()).toContain('turned upright; turned from Z-up')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1].click())
    expect(text()).toContain('wood.psdGenio\'s viewer cannot decode .psd images')
    expect(text()).toContain('bark.pngNot found beside or below the model')
  })

  it('takes the up axis the viewer chose for a file (3DS is Z-up by convention)', async () => {
    await render(asset('crate.3ds'))
    await fromFrame({ type: 'ready' })
    const posted = vi.spyOn(frame()!.contentWindow!, 'postMessage')
    await fromFrame({ type: 'loaded', model: { ...model, format: '3DS', units: 'No unit in the file, read as metres; Z-up by convention, turned upright', upAxis: 'z', clips: [] } })
    expect(button('Z-up').getAttribute('aria-pressed')).toBe('true')
    expect(text()).not.toContain('turned from Z-up')
    await act(async () => button('Z-up').click())
    expect(posted.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'settings', settings: { upAxis: 'y' } })
    expect(text()).toContain('turned upright; shown as stored')
  })

  it('reports a grant failure in plain words', async () => {
    f.grant.mockRejectedValueOnce(new Error('This asset is no longer available.'))
    await render(asset('robot.glb'))
    expect(frame()).toBeNull()
    expect(text()).toContain('This asset is no longer available.')
  })

  it('covers a missing ready handshake and a stalled IPC grant with the watchdog', async () => {
    let resolve!: (url: string) => void
    f.grant.mockReturnValueOnce(new Promise<string>(done => { resolve = done }))
    await render(asset('robot.fbx'))
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_PREVIEW_TIMEOUT_MS) })
    expect(frame()).toBeNull()
    expect(text()).toContain('requesting access to the file')
    await act(async () => resolve(TOKEN_URL))
    expect(f.release).toHaveBeenCalledWith(TOKEN_URL, false)
    await act(async () => button('Retry').click())
    expect(frame()).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(MODEL_PREVIEW_TIMEOUT_MS) })
    expect(text()).toContain('starting the viewer')
    expect(frame()).toBeNull()
  })

  it('shows geometry before textures, cancels, and retries with a fresh frame', async () => {
    await render(asset('robot.fbx'))
    const oldFrame = frame()!
    const posted = vi.spyOn(oldFrame.contentWindow!, 'postMessage')
    await fromFrame({ type: 'ready' })
    await fromFrame({ type: 'progress', progress: { phase: 'geometry', completed: 0, total: 0, elapsedMs: 40 } })
    await fromFrame({ type: 'progress', progress: { phase: 'textures', completed: 2, total: 5, elapsedMs: 60 } })
    expect(text()).not.toContain('Loading model…')
    expect(text()).toContain('Textures 2 of 5')
    await act(async () => button('Cancel').click())
    expect(frame()).toBeNull()
    expect(text()).toContain('Preview cancelled')
    expect(posted.mock.calls.at(-1)?.[0]).toEqual({ type: 'cancel' })
    await act(async () => button('Retry').click())
    expect(frame()).not.toBe(oldFrame)
    await fromFrame({ type: 'ready' })
    await fromFrame({ type: 'loaded', model })
    expect(text()).toContain('Triangles348')
    expect(f.release).toHaveBeenCalledWith(TOKEN_URL, true)
  })

  it('reuses one warm frame on reselection, opens once, and ignores stale results', async () => {
    await render(asset('robot.fbx'))
    const iframe = frame()!
    const posted = vi.spyOn(iframe.contentWindow!, 'postMessage')
    await fromFrame({ type: 'ready' }); await fromFrame({ type: 'ready' })
    expect(posted.mock.calls.filter(c => (c[0] as { type: string }).type === 'open')).toHaveLength(1)
    await render(asset('crate.fbx'))
    expect(frame()).toBe(iframe)
    expect(posted.mock.calls.filter(c => (c[0] as { type: string }).type === 'open')).toHaveLength(2)
    await fromFrame({ type: 'loaded', requestId: 1, model })
    await fromFrame({ type: 'failed', requestId: 1, code: 'timeout', reason: 'stale' })
    expect(text()).toContain('Loading model…')
    expect(text()).not.toContain('stale')
    await fromFrame({ type: 'loaded', model })
    expect(text()).toContain('Triangles348')
  })
})
