import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d3d11Rule, FAILURES, FIRST_FRAME_MS, GpuSession, gpuCheck, parseEnd, parseFrame, parseRing, RING_MS, windowsApis, type GpuFallback, type TextureFrame } from '../src/main/play-gpu'
import type { GpuDevice, TextureApi } from '../src/main/shared-texture'

const NVIDIA: GpuDevice = { vendorId: 0x10de, deviceId: 0x2486, active: true }
const INTEL: GpuDevice = { vendorId: 0x8086, deviceId: 0x9a49, active: false }

/** A 'GR' v2 ring as com.genio.play's GpuFrames writes it. */
function ring({ gen = 1, width = 1280, height = 720, format = 28, flags = 0, vendor = NVIDIA.vendorId, device = NVIDIA.deviceId, handles = [0x1a4n, 0x1a8n, 0x1acn], version = 2 } = {}) {
  const b = Buffer.alloc(40 + 8 * handles.length)
  b.write('GR', 0, 'latin1'); b[2] = version; b[3] = handles.length
  b.writeUInt32LE(gen, 4); b.writeUInt32LE(width, 8); b.writeUInt32LE(height, 12); b.writeUInt32LE(0x11e56, 16); b.writeInt32LE(0, 20)
  b.writeUInt32LE(format, 24); b.writeUInt32LE(flags, 28); b.writeUInt32LE(vendor, 32); b.writeUInt32LE(device, 36)
  handles.forEach((h, s) => b.writeBigUInt64LE(h, 40 + 8 * s))
  return b
}
/** A 'GF' v1 frame. */
function gf({ slot = 0, gen = 1, seq = 10, t0 = 1.7e12, done = 1.7e12 + 1, version = 1 } = {}) {
  const b = Buffer.alloc(32)
  b.write('GF', 0, 'latin1'); b[2] = version; b[3] = slot
  b.writeUInt32LE(gen, 4); b.writeUInt32LE(seq, 8); b.writeDoubleLE(t0, 16); b.writeDoubleLE(done, 24)
  return b
}

describe('fast-path messages', () => {
  it('parses a ring and rejects anything off', () => {
    expect(parseRing(ring())).toMatchObject({ gen: 1, slots: 3, width: 1280, height: 720, luid: 0x11e56n, format: 28, flags: 0, vendorId: 0x10de, deviceId: 0x2486 })
    expect(parseRing(ring())!.handles.map(h => h.readBigUInt64LE(0))).toEqual([0x1a4n, 0x1a8n, 0x1acn])
    for (const bad of [{ version: 1 }, { gen: 0 }, { width: 15 }, { height: 1921 }, { format: 29 }, { flags: 1 }, { handles: [] }, { handles: [0n, 4n, 8n] }, { handles: [6n] }, { handles: [2n ** 32n] }])
      expect(parseRing(ring(bad)), JSON.stringify(bad, (_k, v) => typeof v === 'bigint' ? String(v) : v)).toBeUndefined()
    expect(parseRing(Buffer.concat([ring(), Buffer.alloc(1)]))).toBeUndefined()
    expect(parseRing(ring().subarray(0, 50))).toBeUndefined()
  })
  it('parses frames and Unity\'s end message', () => {
    expect(parseFrame(gf({ slot: 2, seq: 77 }))).toEqual({ slot: 2, gen: 1, seq: 77, t0: 1.7e12, done: 1.7e12 + 1 })
    for (const bad of [gf({ version: 2 }), gf({ t0: NaN }), gf({ done: Infinity }), gf().subarray(0, 31), Buffer.concat([gf(), Buffer.alloc(1)])]) expect(parseFrame(bad)).toBeUndefined()
    expect(parseEnd(Buffer.from([0x47, 0x58, 1, 2]))).toBe(2)
    expect(parseEnd(Buffer.from([0x47, 0x58, 2, 2]))).toBeUndefined()
    expect(parseEnd(Buffer.from([0x47, 0x58, 1]))).toBeUndefined()
  })
  it('matches Unity\'s adapter with Chromium\'s only GPU', () => {
    expect(gpuCheck({ vendorId: 0x10de, deviceId: 0x2486 }, [NVIDIA])).toBe('ok')
    expect(gpuCheck({ vendorId: 0x10de, deviceId: 0x2486 }, [{ ...NVIDIA, deviceId: 1 }])).toBe('mismatch')
    expect(gpuCheck({ vendorId: 0x10de, deviceId: 0x2486 }, [INTEL, NVIDIA])).toBe('hybrid')
    expect(gpuCheck({ vendorId: 0x10de, deviceId: 0x2486 }, [])).toBe('unknown')
  })
})

describe('the project rule for Direct3D 11', () => {
  let root: string
  const write = (rel: string, text: string) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  const settings = (entry: string) => `PlayerSettings:\n  m_BuildTargetGraphicsAPIs:\n  - m_BuildTarget: AndroidPlayer\n    m_APIs: 150000000b000000\n    m_Automatic: 0\n${entry}  m_BuildTargetVRSettings: []\n`
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-play-gpu-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
  it('reads the Windows API list: automatic, or the listed GraphicsDeviceTypes', () => {
    expect(windowsApis('')).toBe('automatic')
    expect(windowsApis('  m_BuildTargetGraphicsAPIs: []\n')).toBe('automatic')
    expect(windowsApis(settings(''))).toBe('automatic')
    expect(windowsApis(settings('  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 12000000\n    m_Automatic: 1\n'))).toBe('automatic')
    expect(windowsApis(settings('  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 12000000\n    m_Automatic: 0\n'))).toEqual([18])
    expect(windowsApis(settings('  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 1200000002000000\n    m_Automatic: 0\n'))).toEqual([18, 2])
  })
  it('allows an automatic or Direct3D 11 project, and refuses one that needs Direct3D 12', async () => {
    expect(await d3d11Rule(root)).toEqual({ ok: true })
    write('ProjectSettings/ProjectSettings.asset', settings('  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 0200000012000000\n    m_Automatic: 0\n'))
    expect(await d3d11Rule(root)).toEqual({ ok: true })
    write('ProjectSettings/ProjectSettings.asset', settings('  - m_BuildTarget: WindowsStandaloneSupport\n    m_APIs: 12000000\n    m_Automatic: 0\n'))
    expect(await d3d11Rule(root)).toEqual({ ok: false, reason: 'the Windows graphics API list has no Direct3D 11' })
  })
  it.each([
    ['Assets/Settings/HDRP.asset', 'm_RenderPipelineSettings:\n    supportRayTracing: 1\n', 'it turns on ray tracing'],
    ['Assets/Shaders/Reflections.raytrace', '#pragma max_recursion_depth 1\n', 'it has ray tracing shaders'],
    ['Assets/Scripts/Rays.cs', 'class A { UnityEngine.Rendering.RayTracingAccelerationStructure s; }', 'its scripts use ray tracing'],
    ['Assets/Scripts/Vrs.cs', 'var info = ShadingRateInfo.supportsPerImageTile;', 'its scripts use variable-rate shading'],
    ['Assets/Shaders/Waves.shader', 'Pass { HLSLPROGRAM\n#pragma require WaveBasic\n ENDHLSL }', 'a shader requires wavebasic'],
    ['Packages/com.studio.fx/Mesh.hlsl', '#pragma require geometry meshshader\n', 'a shader requires meshshader']
  ])('refuses %s', async (file, text, reason) => {
    write(file, text)
    expect(await d3d11Rule(root)).toEqual({ ok: false, reason })
  })
  it('passes ordinary content, the off ray tracing switch and Genio\'s own package', async () => {
    write('Assets/Settings/HDRP.asset', 'supportRayTracing: 0\n')
    write('Assets/Shaders/Lit.shader', '#pragma require geometry tessellation\n#pragma target 5.0\n')
    write('Assets/Scripts/Player.cs', 'class Player { void Update() {} }')
    write('Packages/com.genio.play/Runtime/X.cs', 'RayTracingShader s;')
    write('Assets/Hidden~/Old.raytrace', '')
    expect(await d3d11Rule(root)).toEqual({ ok: true })
  })
})

describe('a fast-path session', () => {
  let now: number, sent: object[], textures: TextureFrame[], fallbacks: [GpuFallback, string | undefined][], gone: (() => void)[]
  let imports: { handle: bigint; released: () => void; release: ReturnType<typeof vi.fn> }[] = [], importFails = 0, sendFails = 0, sends: unknown[] = []
  const api: TextureApi = {
    available: true,
    importTexture: (handle, _w, _h, released) => {
      if (importFails > 0) { importFails--; throw new Error('Unable to duplicate handle') }
      const t = { handle: handle.readBigUInt64LE(0), released, release: vi.fn(() => released()) }
      imports.push(t); return t
    },
    send: async (_to, texture, meta) => { sends.push({ texture, meta }); if (sendFails > 0) { sendFails--; throw new Error('timeout') } },
    gpus: async () => [NVIDIA],
    onGpuGone: fn => { gone.push(fn); return () => { gone = gone.filter(f => f !== fn) } }
  }
  const session = (devices: GpuDevice[] = [NVIDIA]) => {
    const s = new GpuSession({ api, devices, width: 1280, height: 720, send: m => sent.push(m), onTexture: f => textures.push(f), onFallback: (r, d) => fallbacks.push([r, d]), now: () => now })
    s.connected(); return s
  }
  const to = {} as never
  beforeEach(() => { now = 1000; sent = []; textures = []; fallbacks = []; gone = []; imports = []; importFails = 0; sendFails = 0; sends = [] })

  it('probes every slot, hands out frames, and frees each slot once both sides released it', async () => {
    const s = session()
    expect(s.message(ring())).toBe(true)
    expect(imports.map(i => i.handle)).toEqual([0x1a4n, 0x1a8n, 0x1acn]); expect(sent).toEqual([])
    imports.length = 0
    expect(s.message(gf({ slot: 1, seq: 5 }))).toBe(true)
    const [frame] = textures
    expect(frame).toMatchObject({ kind: 'texture', width: 1280, height: 720, seq: 5, live: true })
    expect(await frame.deliver(to, 'game')).toBe(true)
    expect(sends).toEqual([{ texture: imports[0], meta: { world: 'game', seq: 5, width: 1280, height: 720 } }])
    // Main's reference goes once sent; Chromium calls allReferencesReleased when the renderer let go too.
    expect(imports[0].release).toHaveBeenCalledOnce()
    expect(sent).toEqual([{ type: 'free', gen: 1, slot: 1 }])
    imports[0].released(); frame.drop()
    expect(sent).toHaveLength(1)
    s.message(gf({ slot: 2 })); textures[1].drop(); textures[1].drop()
    expect(sent).toEqual([{ type: 'free', gen: 1, slot: 1 }, { type: 'free', gen: 1, slot: 2 }])
    expect(fallbacks).toEqual([])
  })
  it('closes the socket on malformed fast-path messages', () => {
    const s = session()
    expect(s.message(ring({ version: 1 }))).toBe(false)
    expect(s.message(gf().subarray(0, 20))).toBe(false)
    expect(s.message(Buffer.from([0x47, 0x58, 1]))).toBe(false)
    expect(s.message(Buffer.from('GZ!!'))).toBe(false)
  })
  it.each([
    [[{ ...NVIDIA, deviceId: 0x1111 }], 'gpu-mismatch'],
    [[INTEL, NVIDIA], 'hybrid'],
    [[], 'gpu-unknown']
  ] as [GpuDevice[], GpuFallback][])('falls back to JPEG before any frame when the GPUs differ (%#)', (devices, reason) => {
    const s = session(devices)
    s.message(ring()); s.message(gf())
    expect(fallbacks).toEqual([[reason, undefined]]); expect(sent).toEqual([{ type: 'jpeg' }])
    expect(imports).toEqual([]); expect(textures).toEqual([]); expect(s.active).toBe(false)
  })
  it('falls back when the start-up probe cannot import a handle', () => {
    importFails = 2
    const s = session(); s.message(ring())
    expect(fallbacks).toEqual([['probe', 'Unable to duplicate handle']]); expect(sent).toEqual([{ type: 'jpeg' }])
  })
  it('falls back once after repeated import failures, never importing again', async () => {
    const s = session(); s.message(ring()); imports.length = 0
    importFails = FAILURES
    for (let n = 0; n < FAILURES; n++) { s.message(gf({ slot: n % 3, seq: n })); expect(await textures[n].deliver(to, 'game')).toBe(false) }
    expect(fallbacks).toEqual([['import', 'Unable to duplicate handle']])
    // Each failed slot was freed; then the one switch to JPEG.
    expect(sent).toEqual([{ type: 'free', gen: 1, slot: 0 }, { type: 'free', gen: 1, slot: 1 }, { type: 'free', gen: 1, slot: 2 }, { type: 'jpeg' }])
    s.message(gf({ slot: 0, seq: 9 }))
    expect(textures).toHaveLength(FAILURES); expect(imports).toEqual([])
  })
  it('counts send failures and resets on a delivered frame', async () => {
    const s = session(); s.message(ring())
    sendFails = FAILURES - 1
    for (let n = 0; n < FAILURES - 1; n++) { s.message(gf({ seq: n })); expect(await textures.at(-1)!.deliver(to, 'game')).toBe(false) }
    s.message(gf({ seq: 8 })); expect(await textures.at(-1)!.deliver(to, 'game')).toBe(true)
    sendFails = FAILURES - 1
    for (let n = 0; n < FAILURES - 1; n++) { s.message(gf({ seq: n })); await textures.at(-1)!.deliver(to, 'game') }
    expect(fallbacks).toEqual([])
    // A failed send still released main's reference, so the slot came back.
    expect(imports.slice(3).every(i => i.release.mock.calls.length === 1)).toBe(true)
  })
  it('falls back on a GPU process exit (device loss), leaving frames already handed out dead', async () => {
    const s = session(); s.message(ring()); s.message(gf())
    expect(gone).toHaveLength(1)
    gone[0]()
    expect(fallbacks).toEqual([['gpu-process', undefined]]); expect(sent).toEqual([{ type: 'jpeg' }]); expect(gone).toEqual([])
    expect(textures[0].live).toBe(false)
    const before = imports.length
    expect(await textures[0].deliver(to, 'game')).toBe(false); expect(imports).toHaveLength(before)
  })
  it('takes Unity\'s own end without asking it to switch', () => {
    const s = session(); s.message(Buffer.from([0x47, 0x58, 1, 1]))
    expect(fallbacks).toEqual([['unity', 'code 1']]); expect(sent).toEqual([])
    s.fallback('import'); expect(fallbacks).toHaveLength(1)
  })
  it('falls back on a ring of another size (a resize swaps sessions instead)', () => {
    const s = session(); s.message(ring({ width: 1920, height: 1080 }))
    expect(fallbacks).toEqual([['ring', '1920x1080']])
  })
  it('falls back when the ring or the first frame does not arrive, counting only playing time', () => {
    const s = session()
    now += RING_MS; s.watch(true); expect(fallbacks).toEqual([])
    now += 1; s.watch(true); expect(fallbacks).toEqual([['no-ring', undefined]])
    const t = session(); t.message(ring())
    now += FIRST_FRAME_MS * 3; t.watch(false); now += FIRST_FRAME_MS; t.watch(true); expect(fallbacks).toHaveLength(1)
    now += 1; t.watch(true); expect(fallbacks.at(-1)).toEqual(['no-frames', undefined])
    const u = session(); u.message(ring()); u.message(gf())
    now += FIRST_FRAME_MS * 10; u.watch(true); expect(fallbacks).toHaveLength(2)
  })
  it('holds frames during a resize swap and frees them unseen; closed sessions send nothing', async () => {
    const s = session(); s.message(ring()); s.message(gf({ slot: 0 }))
    s.hold(true)
    expect(textures[0].live).toBe(false)
    expect(await textures[0].deliver(to, 'game')).toBe(false); expect(sends).toEqual([])
    expect(sent).toEqual([{ type: 'free', gen: 1, slot: 0 }])
    s.hold(false); s.message(gf({ slot: 1 })); expect(textures[1].live).toBe(true)
    s.close(); textures[1].drop()
    expect(sent).toHaveLength(1); expect(textures[1].live).toBe(false); expect(gone).toEqual([])
  })
})
