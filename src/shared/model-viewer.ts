/**
 * Inventory's 3D preview: the contract between the app window and the sandboxed viewer frame.
 * The frame (genio-viewer://app/viewer3d.html) has an opaque origin, its own CSP and no preload, so
 * it reaches neither IPC nor project files in general; it reads one model and its side files through
 * a per-model token (genio-media://model/<token>/...) that main resolves inside the model's folder.
 */
export const VIEWER_SCHEME = 'genio-viewer'
export const VIEWER_APP_URL = `${VIEWER_SCHEME}://app/viewer3d.html`
/** Files above this are not loaded: a 76 MB FBX with 4K textures froze the renderer for 90+ s. */
export const MODEL_PREVIEW_MAX_BYTES = 64 * 1024 * 1024
/** The frame is removed (stopping its work) when a model has not drawn by then. */
export const MODEL_PREVIEW_TIMEOUT_MS = 30_000
/** Larger textures are downscaled before upload, so 4K maps cannot exhaust GPU memory. */
export const MODEL_PREVIEW_MAX_TEXTURE = 2048
export const MODEL_PREVIEW_EXTS = ['glb', 'gltf'] as const
/** Side files a glTF may reference, beside or below it; nothing else is ever served to the frame. */
export const MODEL_SIDE_FILE_EXTS = ['bin', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'ktx2'] as const
/**
 * Built viewers use the Draco/KTX2 decoders Vite emits from three's own files (out/renderer/assets).
 * Against the dev server, whose prebundled deps lose those relative URLs, main serves these from
 * three's examples/jsm/libs at genio-viewer://app/decoders/. Never a CDN.
 */
export const VIEWER_DECODERS: Record<string, string> = {
  'draco_decoder.wasm': 'draco/gltf/draco_decoder.wasm',
  'draco_wasm_wrapper.js': 'draco/gltf/draco_wasm_wrapper.js',
  'basis_transcoder.wasm': 'basis/basis_transcoder.wasm',
  'basis_transcoder.js': 'basis/basis_transcoder.js'
}

export type ViewerBackground = 'dark' | 'light' | 'checker'
export interface ViewerSettings {
  wireframe: boolean
  grid: boolean
  bounds: boolean
  skeleton: boolean
  clay: boolean
  background: ViewerBackground
  /** Z-up files are turned to the viewer's Y-up. glTF is Y-up by specification. */
  upAxis: 'y' | 'z'
}
export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = { wireframe: false, grid: true, bounds: false, skeleton: false, clay: false, background: 'dark', upAxis: 'y' }

export interface ModelStats {
  triangles: number
  vertices: number
  meshes: number
  materials: number
  textures: number
  bones: number
  /** Bounds in metres (glTF units), after the up-axis turn: width (X), height (Y), depth (Z). */
  size: [number, number, number]
}
export interface ModelClip { name: string; duration: number }
export interface ModelTexture {
  id: number
  name: string
  /** Where it is used: "Body · base colour". */
  uses: string[]
  width: number
  height: number
  /** Size in the file when it was downscaled for the preview. */
  original?: { width: number; height: number }
  compressed: boolean
}
export interface ModelLoaded {
  stats: ModelStats
  clips: ModelClip[]
  textures: ModelTexture[]
  /** Side files that did not resolve (file names only). */
  missing: string[]
  /** Materials drawn in clay because their textures did not resolve. */
  clayFallback: number
  /** No meshes: the skeleton is drawn instead. */
  animationOnly: boolean
  loadMs: number
}
export type ModelFailure = 'too-large' | 'timeout' | 'unreadable' | 'no-webgl'
export interface ModelPlayback { clip: number; playing: boolean; time: number; speed: number; loop: boolean; follow: boolean }

export type ToViewer =
  | { type: 'open'; url: string; name: string }
  | { type: 'settings'; settings: ViewerSettings }
  | { type: 'playback'; playback: Partial<ModelPlayback> }
  | { type: 'frame' }
  | { type: 'texture-previews' }
export type FromViewer =
  | { type: 'ready' }
  | { type: 'loaded'; model: ModelLoaded }
  | { type: 'failed'; code: ModelFailure; reason: string }
  | { type: 'time'; clip: number; time: number; playing: boolean }
  | { type: 'texture-previews'; previews: { id: number; url: string }[] }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length <= max
const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => isStr(s))

/**
 * The frame is untrusted (it parses arbitrary files): the app accepts only well-formed messages, and
 * texture previews only as image data URLs.
 */
export function readViewerMessage(data: unknown): FromViewer | undefined {
  if (!data || typeof data !== 'object') return
  const m = data as Record<string, unknown>
  switch (m.type) {
    case 'ready': return { type: 'ready' }
    case 'failed':
      return ['too-large', 'timeout', 'unreadable', 'no-webgl'].includes(m.code as string) && isStr(m.reason, 600) ? { type: 'failed', code: m.code as ModelFailure, reason: m.reason } : undefined
    case 'time':
      return isNum(m.clip) && isNum(m.time) && typeof m.playing === 'boolean' ? { type: 'time', clip: m.clip, time: m.time, playing: m.playing } : undefined
    case 'texture-previews': {
      if (!Array.isArray(m.previews) || m.previews.length > 256) return
      const previews = m.previews.filter((p): p is { id: number; url: string } => !!p && isNum(p.id) && isStr(p.url, 400_000) && /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.url))
      return { type: 'texture-previews', previews: previews.map(p => ({ id: p.id, url: p.url })) }
    }
    case 'loaded': {
      const model = m.model as Record<string, unknown> | undefined
      const s = model?.stats as Record<string, unknown> | undefined
      if (!model || !s || !['triangles', 'vertices', 'meshes', 'materials', 'textures', 'bones'].every(k => isNum(s[k]))) return
      if (!Array.isArray(s.size) || s.size.length !== 3 || !s.size.every(isNum)) return
      if (!Array.isArray(model.clips) || model.clips.length > 512 || !model.clips.every(c => c && isStr(c.name) && isNum(c.duration))) return
      if (!Array.isArray(model.textures) || model.textures.length > 512 || !model.textures.every(t => t && isNum(t.id) && isStr(t.name) && strings(t.uses, 64) && isNum(t.width) && isNum(t.height) && typeof t.compressed === 'boolean' && (t.original === undefined || isNum(t.original?.width) && isNum(t.original?.height)))) return
      if (!strings(model.missing, 512) || !isNum(model.clayFallback) || typeof model.animationOnly !== 'boolean' || !isNum(model.loadMs)) return
      const stats = s as unknown as ModelStats
      return { type: 'loaded', model: {
        stats: { triangles: stats.triangles, vertices: stats.vertices, meshes: stats.meshes, materials: stats.materials, textures: stats.textures, bones: stats.bones, size: [stats.size[0], stats.size[1], stats.size[2]] },
        clips: (model.clips as ModelClip[]).map(c => ({ name: c.name, duration: c.duration })),
        textures: (model.textures as ModelTexture[]).map(t => ({ id: t.id, name: t.name, uses: [...t.uses], width: t.width, height: t.height, compressed: t.compressed, ...(t.original ? { original: { width: t.original.width, height: t.original.height } } : {}) })),
        missing: [...model.missing as string[]], clayFallback: model.clayFallback, animationOnly: model.animationOnly, loadMs: model.loadMs
      } }
    }
  }
}

/** Lengths in the model's metres, readable at any scale. */
export function formatLength(metres: number): string {
  const m = Math.abs(metres)
  if (m >= 1000) return `${(metres / 1000).toFixed(2)} km`
  if (m >= 1) return `${metres.toFixed(2)} m`
  if (m >= 0.01) return `${(metres * 100).toFixed(1)} cm`
  return `${(metres * 1000).toFixed(1)} mm`
}
