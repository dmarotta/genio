import fs from 'node:fs'
import path from 'node:path'
import type { WebFrameMain } from 'electron'
import type { GpuDevice, ImportedTexture, TextureApi } from './shared-texture'

/**
 * Play's fast path (docs/play-gpu-stream.md): com.genio.play copies each frame on the GPU into a ring of D3D11
 * textures shared into this process, and the socket carries only small messages. The JPEG stream stays the fallback:
 * any doubt or failure switches a session to it once, without stopping the game.
 */

/** A ring of shared textures ('GR' v2): the NT handles are valid in this process only. */
export interface GpuRing { gen: number; slots: number; width: number; height: number; luid: bigint; format: number; flags: number; vendorId: number; deviceId: number; handles: Buffer[] }
/** A finished frame ('GF' v1): its slot holds the picture until Genio frees it. */
export interface GpuFrameMessage { slot: number; gen: number; seq: number; t0: number; done: number }

const DXGI_R8G8B8A8_UNORM = 28
const isG = (b: Buffer, kind: number, version: number): boolean => b[0] === 0x47 && b[1] === kind && b[2] === version

/** 'G' 'R' v2, little-endian: slots u8, gen u32, width u32, height u32, adapter LUID (u32, i32), DXGI format u32,
 * flags u32, PCI vendor u32, device u32, then one u64 NT handle per slot. Undefined when anything is off. */
export function parseRing(b: Buffer): GpuRing | undefined {
  if (b.length < 40 || !isG(b, 0x52, 2)) return undefined
  const slots = b[3]
  if (slots < 1 || slots > 8 || b.length !== 40 + 8 * slots) return undefined
  const gen = b.readUInt32LE(4), width = b.readUInt32LE(8), height = b.readUInt32LE(12), format = b.readUInt32LE(24), flags = b.readUInt32LE(28)
  if (gen < 1 || ![width, height].every(n => n >= 16 && n <= 1920) || format !== DXGI_R8G8B8A8_UNORM || flags !== 0) return undefined
  const handles: Buffer[] = []
  for (let s = 0; s < slots; s++) {
    const value = b.readBigUInt64LE(40 + 8 * s)
    // A kernel handle is a small multiple of 4 that fits in 32 bits.
    if (value === 0n || value >= 2n ** 32n || value % 4n !== 0n) return undefined
    handles.push(Buffer.from(b.subarray(40 + 8 * s, 48 + 8 * s)))
  }
  return { gen, slots, width, height, luid: BigInt(b.readInt32LE(20)) << 32n | BigInt(b.readUInt32LE(16)), format, flags, vendorId: b.readUInt32LE(32), deviceId: b.readUInt32LE(36), handles }
}

/** 'G' 'F' v1: slot u8, gen u32, frame u32, reserved u32, end of frame f64 and GPU done f64 (Unix ms). */
export function parseFrame(b: Buffer): GpuFrameMessage | undefined {
  if (b.length !== 32 || !isG(b, 0x46, 1)) return undefined
  const t0 = b.readDoubleLE(16), done = b.readDoubleLE(24)
  if (!Number.isFinite(t0) || !Number.isFinite(done)) return undefined
  return { slot: b[3], gen: b.readUInt32LE(4), seq: b.readUInt32LE(8), t0, done }
}

/** 'G' 'X' v1: the fast path ended on Unity's side (1 not Direct3D 11, 2 no ring, 3 a copy failed); JPEG follows. */
export function parseEnd(b: Buffer): number | undefined {
  return b.length === 4 && isG(b, 0x58, 1) ? b[3] : undefined
}

/** Chromium and Unity must render on the same GPU, and only one is allowed: a hybrid laptop streams JPEG. */
export function gpuCheck(ring: Pick<GpuRing, 'vendorId' | 'deviceId'>, devices: GpuDevice[]): 'ok' | 'hybrid' | 'mismatch' | 'unknown' {
  if (!devices.length) return 'unknown'
  if (devices.length > 1) return 'hybrid'
  return devices[0].vendorId === ring.vendorId && devices[0].deviceId === ring.deviceId ? 'ok' : 'mismatch'
}

// ---- the project rule: Unity applies -force-d3d11 whatever a project says, so Genio decides from its files

/** Shader Model 6 features Direct3D 11 lacks (`#pragma require`). */
const SM6 = new Set(['wavebasic', 'wavevote', 'waveballot', 'wavemath', 'wavemultiprefix', 'quadshuffle', 'native16bit', 'int64', 'int64bufferatomics',
  'barycentrics', 'meshshader', 'raytracing', 'inlineraytracing', 'setrtarrayindexfromanyshader'])
const SHADERS = new Set(['.shader', '.hlsl', '.cginc', '.compute'])
/** How much of each file the rule reads: an HDRP asset's support flags sit at its top; big generated shaders and
 * scripts are read up to a cap. Files are read 16 at a time, so a 28,000-file project stays a launch detail. */
const HEAD: Record<string, number> = { '.asset': 32 * 1024, '.cs': 512 * 1024 }
const SHADER_HEAD = 1024 * 1024, PARALLEL = 16, MAX_FILES = 100_000

async function head(file: string, cap: number): Promise<string> {
  const handle = await fs.promises.open(file, 'r')
  try {
    const size = Math.min(cap, (await handle.stat()).size), buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally { await handle.close() }
}
/** Why a file means the project needs Direct3D 12, or undefined. */
function needsD3D12(ext: string, text: string): string | undefined {
  if (ext === '.asset') return /^\s*supportRayTracing:\s*1\s*$/m.test(text) ? 'it turns on ray tracing' : undefined
  if (ext === '.cs') {
    if (/\bRayTracing(Shader|AccelerationStructure)\b/.test(text)) return 'its scripts use ray tracing'
    return /\bShadingRate(Image|Info)\b/.test(text) ? 'its scripts use variable-rate shading' : undefined
  }
  for (const m of text.matchAll(/#pragma\s+require\s+([^\r\n]*)/g)) {
    const feature = m[1].split(/\s+/).map(f => f.toLowerCase()).find(f => SM6.has(f))
    if (feature) return `a shader requires ${feature}`
  }
  return undefined
}
/** The Windows graphics API list from ProjectSettings.asset: automatic, or the GraphicsDeviceType values in order. */
export function windowsApis(settings: string): 'automatic' | number[] {
  const lines = settings.split(/\r?\n/)
  const at = lines.findIndex(l => /^\s*m_BuildTargetGraphicsAPIs:/.test(l))
  if (at < 0 || /:\s*\[\]\s*$/.test(lines[at])) return 'automatic'
  const indent = lines[at].search(/\S/)
  const entries: Record<string, string>[] = []
  for (const line of lines.slice(at + 1)) {
    const ind = line.search(/\S/)
    if (ind < 0) continue
    const text = line.trim()
    if (ind < indent || ind === indent && !text.startsWith('-')) break
    if (text.startsWith('-')) entries.push({})
    const m = /^-?\s*(\w+):\s*(.*)$/.exec(text)
    if (m && entries.length) entries[entries.length - 1][m[1]] = m[2].trim()
  }
  const windows = entries.find(e => e.m_BuildTarget === 'WindowsStandaloneSupport')
  if (!windows || windows.m_Automatic !== '0') return 'automatic'
  const hex = windows.m_APIs ?? ''
  if (!/^([0-9a-f]{8})*$/i.test(hex)) return []
  return (hex.match(/.{8}/g) ?? []).map(h => Buffer.from(h, 'hex').readInt32LE(0))
}

/**
 * Whether the project can run its Play editor on Direct3D 11 (the spike's fallback rule): the Windows API list allows
 * it (automatic, or Direct3D11 listed), and nothing needs Direct3D 12 (ray tracing, Shader Model 6 features,
 * variable-rate shading). Reads Assets and the project's own Packages; com.genio.play is Genio's.
 */
export async function d3d11Rule(root: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let settings = ''
  try { settings = await fs.promises.readFile(path.join(root, 'ProjectSettings/ProjectSettings.asset'), 'utf8') } catch { /* automatic */ }
  const apis = windowsApis(settings)
  if (apis !== 'automatic' && !apis.includes(2)) return { ok: false, reason: 'the Windows graphics API list has no Direct3D 11' }
  const files: { file: string; ext: string }[] = []
  let seen = 0
  const walk = async (dir: string): Promise<string | undefined> => {
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return undefined }
    for (const e of entries) {
      if (++seen > MAX_FILES || e.name.startsWith('.') || e.name.endsWith('~') || e.name === 'com.genio.play') continue
      const file = path.join(dir, e.name)
      if (e.isDirectory()) { const found = await walk(file); if (found) return found; continue }
      const ext = path.extname(e.name).toLowerCase()
      if (!e.isFile()) continue
      if (ext === '.raytrace') return 'it has ray tracing shaders'
      if (ext in HEAD || SHADERS.has(ext)) files.push({ file, ext })
    }
    return undefined
  }
  for (const top of ['Assets', 'Packages']) {
    const reason = await walk(path.join(root, top))
    if (reason) return { ok: false, reason }
  }
  let next = 0, found: string | undefined
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (!found && next < files.length) {
      const { file, ext } = files[next++]
      try { found ??= needsD3D12(ext, await head(file, HEAD[ext] ?? SHADER_HEAD)) } catch { /* unreadable: skipped */ }
    }
  }))
  if (found) return { ok: false, reason: found }
  return { ok: true }
}

// ---- a session's fast path, as the frame sink sees it

/** One GPU frame for the sink (newest wins, one per renderer credit). Every frame is freed exactly once: delivered, dropped or failed. */
export interface TextureFrame {
  readonly kind: 'texture'
  readonly width: number
  readonly height: number
  readonly seq: number
  /** False once its ring is gone (fallback, resize, stop): drop it, never import it. */
  readonly live: boolean
  /** Gives the slot back to Unity without showing it (superseded or the sink closed). */
  drop(): void
  /** Imports the slot and sends it to the frame's preload; false when nothing reached the renderer (no credit spent). */
  deliver(to: WebFrameMain, world: string): Promise<boolean>
}

export type GpuFallback = 'unity' | 'ring' | 'hybrid' | 'gpu-mismatch' | 'gpu-unknown' | 'probe' | 'no-ring' | 'no-frames' | 'import' | 'send' | 'gpu-process'
/** Reasons that hold for this machine, not just this session: later Play editors start as today. */
export const MACHINE_FALLBACKS: readonly GpuFallback[] = ['hybrid', 'gpu-mismatch', 'gpu-unknown']
/** The ring must arrive this soon after Unity connects, and the first frame this soon after the ring while the game plays. */
export const RING_MS = 5000, FIRST_FRAME_MS = 3000
/** Consecutive import or send failures that end the fast path. */
export const FAILURES = 3

export interface GpuSessionOptions {
  api: TextureApi
  /** Chromium's GPUs, read before the session started. */
  devices: GpuDevice[]
  /** The size Genio asked Unity for. */
  width: number
  height: number
  /** A text message to Unity on the session's socket. */
  send(message: object): void
  onTexture(frame: TextureFrame): void
  onFallback(reason: GpuFallback, detail?: string): void
  now?: () => number
}

/** One Unity session's fast path: checks the ring, hands out frames, and falls back to JPEG once on the first doubt. */
export class GpuSession {
  private ring?: GpuRing
  private ended?: GpuFallback
  private closed = false
  private held = false
  private framed = false
  private failures = 0
  private connectedAt?: number
  private waitingSince = 0
  private readonly unsubscribe: () => void
  private readonly now: () => number
  constructor(private readonly o: GpuSessionOptions) {
    this.now = o.now ?? Date.now
    this.unsubscribe = o.api.onGpuGone(() => this.fallback('gpu-process'))
  }
  /** Still on the fast path (no fallback, not closed). */
  get active(): boolean { return !this.ended && !this.closed }
  get fallbackReason(): GpuFallback | undefined { return this.ended }
  /** Unity connected: the ring's clock starts. */
  connected(): void { this.connectedAt ??= this.now() }
  /** A binary 'G' message other than audio. False when it is malformed: the caller closes the socket. */
  message(b: Buffer): boolean {
    if (b[1] === 0x52) return this.onRing(b)
    if (b[1] === 0x46) return this.onFrame(b)
    if (b[1] === 0x58) {
      const code = parseEnd(b)
      if (code === undefined) return false
      this.fallback('unity', `code ${code}`); return true
    }
    return false
  }
  private onRing(b: Buffer): boolean {
    const ring = parseRing(b)
    if (!ring) return false
    if (!this.active) return true
    if (ring.width !== this.o.width || ring.height !== this.o.height) { this.fallback('ring', `${ring.width}x${ring.height}`); return true }
    const gpu = gpuCheck(ring, this.o.devices)
    if (gpu !== 'ok') { this.fallback(gpu === 'hybrid' ? 'hybrid' : gpu === 'mismatch' ? 'gpu-mismatch' : 'gpu-unknown'); return true }
    // The start-up probe: every slot imports here before a frame relies on it.
    for (const handle of ring.handles) {
      try { this.o.api.importTexture(handle, ring.width, ring.height, () => {}).release() }
      catch (e) { this.fallback('probe', (e as Error)?.message); return true }
    }
    this.ring = ring; this.waitingSince = this.now()
    return true
  }
  private onFrame(b: Buffer): boolean {
    const f = parseFrame(b)
    if (!f) return false
    const ring = this.ring
    if (!ring || f.gen !== ring.gen || f.slot >= ring.slots) return true
    if (!this.active) return true
    this.framed = true
    this.o.onTexture(this.frame(ring, f))
    return true
  }
  private frame(ring: GpuRing, f: GpuFrameMessage): TextureFrame {
    let freed = false
    const free = (): void => { if (freed) return; freed = true; if (!this.closed) this.o.send({ type: 'free', gen: ring.gen, slot: f.slot }) }
    const live = (): boolean => this.active && !this.held && this.ring === ring
    return {
      kind: 'texture', width: ring.width, height: ring.height, seq: f.seq,
      get live() { return live() },
      drop: free,
      deliver: async (to, world) => {
        if (!live()) { free(); return false }
        let texture: ImportedTexture
        // Unity reuses the slot only after `free`, which runs once main and the renderer both released it.
        try { texture = this.o.api.importTexture(ring.handles[f.slot], ring.width, ring.height, free) }
        catch (e) { free(); this.failed('import', e); return false }
        try { await this.o.api.send(to, texture, { world, seq: f.seq, width: ring.width, height: ring.height }); this.failures = 0; return true }
        catch (e) { this.failed('send', e); return false }
        finally { texture.release() }
      }
    }
  }
  private failed(kind: 'import' | 'send', e: unknown): void {
    if (++this.failures >= FAILURES) this.fallback(kind, (e as Error)?.message)
  }
  /** Periodic. No ring RING_MS after Unity connected, or no first frame FIRST_FRAME_MS into playing with the ring in, falls back. */
  watch(playing: boolean): void {
    if (!this.active || this.framed || this.connectedAt === undefined) return
    const now = this.now()
    if (!this.ring) { if (now - this.connectedAt > RING_MS) this.fallback('no-ring'); return }
    // A paused game renders no frame: only playing time counts.
    if (!playing) { this.waitingSince = now; return }
    if (now - this.waitingSince > FIRST_FRAME_MS) this.fallback('no-frames')
  }
  /** While a resize swaps sessions, frames already handed out stop being live; false brings them back if the swap failed. */
  hold(on: boolean): void { this.held = on }
  /** Once per session: Unity streams JPEG frames from now on (it switched by itself for 'unity'). */
  fallback(reason: GpuFallback, detail?: string): void {
    if (!this.active) return
    this.ended = reason; this.ring = undefined; this.unsubscribe()
    if (reason !== 'unity') this.o.send({ type: 'jpeg' })
    this.o.onFallback(reason, detail)
  }
  /** The socket closed: nothing more is sent to Unity, and no frame of this session is live. */
  close(): void { this.closed = true; this.ring = undefined; this.unsubscribe() }
}
