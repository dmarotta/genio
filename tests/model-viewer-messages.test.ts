import { describe, expect, it } from 'vitest'
import { formatLength, readViewerMessage, type ModelLoaded } from '../src/shared/model-viewer'

const loaded: ModelLoaded = {
  stats: { triangles: 348, vertices: 219, meshes: 1, materials: 1, textures: 1, bones: 3, size: [0.6, 2, 0.6] },
  clips: [{ name: 'Wave', duration: 1.71 }],
  textures: [{ id: 0, name: 'robot_checker.png', uses: ['Body · base colour'], width: 4096, height: 4096, original: { width: 8192, height: 8192 }, compressed: false }],
  missing: [], clayFallback: 0, animationOnly: false, loadMs: 24,
  format: 'FBX binary', units: 'Centimetres, shown in metres', upAxis: 'y', unityClips: true
}

describe('viewer frame messages', () => {
  it('preserves validated request IDs and bounds progress from the sandbox', () => {
    const progress = { phase: 'textures', completed: 2, total: 5, elapsedMs: 100 }
    expect(readViewerMessage({ type: 'progress', requestId: 7, progress: { ...progress, extra: 'ignored' } })).toEqual({ type: 'progress', requestId: 7, progress })
    for (const requestId of [-1, NaN, 1.5, '7']) expect(readViewerMessage({ type: 'ready', requestId })).toBeUndefined()
    for (const patch of [{ phase: 'unknown' }, { completed: 6 }, { total: -1 }, { elapsedMs: Infinity }]) {
      expect(readViewerMessage({ type: 'progress', progress: { ...progress, ...patch } })).toBeUndefined()
    }
  })
  it('accepts well-formed messages and copies only known fields', () => {
    expect(readViewerMessage({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' })
    expect(readViewerMessage({ type: 'loaded', model: { ...loaded, script: 'x', stats: { ...loaded.stats, html: '<b>' } } })).toEqual({ type: 'loaded', model: loaded })
    expect(readViewerMessage({ type: 'failed', code: 'too-large', reason: 'robot.bin is larger than the 64 MB preview limit.' })).toMatchObject({ code: 'too-large' })
    expect(readViewerMessage({ type: 'time', clip: 0, time: 0.5, playing: true })).toEqual({ type: 'time', clip: 0, time: 0.5, playing: true })
  })

  it('rejects malformed or unknown messages from the untrusted frame', () => {
    for (const bad of [null, 'ready', { type: 'open', url: 'x' }, { type: 'failed', code: 'pwned', reason: 'x' }, { type: 'failed', code: 'timeout', reason: 'x'.repeat(601) },
      { type: 'time', clip: '0', time: 1, playing: true }, { type: 'loaded', model: { ...loaded, stats: { ...loaded.stats, size: [1, 2] } } },
      { type: 'loaded', model: { ...loaded, clips: [{ name: 3, duration: 1 }] } }, { type: 'loaded', model: { ...loaded, missing: 'a.png' } },
      { type: 'loaded', model: { ...loaded, stats: { ...loaded.stats, triangles: Infinity } } },
      { type: 'loaded', model: { ...loaded, upAxis: 'x' } }, { type: 'loaded', model: { ...loaded, format: 7 } }, { type: 'loaded', model: { ...loaded, units: 'u'.repeat(201) } },
      { type: 'loaded', model: { ...loaded, unityClips: 'yes' } }]) expect(readViewerMessage(bad)).toBeUndefined()
  })

  it('passes a hot swap diff through only when it is well-formed', () => {
    const diff = { added: 1, changed: 2, removed: 0, names: ['deck', 'leg_1', 'leg_2'], swapMs: 0.4 }
    expect(readViewerMessage({ type: 'loaded', model: { ...loaded, diff: { ...diff, extra: 1 } } })).toEqual({ type: 'loaded', model: { ...loaded, diff } })
    for (const bad of [{ ...diff, added: -1 }, { ...diff, names: 'deck' }, { ...diff, names: Array(65).fill('x') }, { ...diff, names: ['x'.repeat(513)] }, { ...diff, swapMs: NaN }, null]) {
      expect(readViewerMessage({ type: 'loaded', model: { ...loaded, diff: bad } })).toBeUndefined()
    }
  })

  it('keeps only image data URLs as texture previews', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    expect(readViewerMessage({ type: 'texture-previews', previews: [{ id: 0, url: png }, { id: 1, url: 'javascript:alert(1)' }, { id: 2, url: 'data:text/html;base64,PGI+' }, { id: 3, url: 'genio-media://world/a/b.png' }] }))
      .toEqual({ type: 'texture-previews', previews: [{ id: 0, url: png }] })
  })

  it('formats lengths in readable units', () => {
    expect([formatLength(2), formatLength(0.6), formatLength(0.004), formatLength(1500)]).toEqual(['2.00 m', '60.0 cm', '4.0 mm', '1.50 km'])
  })
})
