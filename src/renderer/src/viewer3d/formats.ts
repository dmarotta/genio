/**
 * One loader per format the viewer reads, each returning a scene root, its clips and what the file says
 * about units and axes. Side files resolve against the model's folder URL; textures decode off-thread.
 */
import * as THREE from 'three'
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { DecodedTextureLoader, withDecodedTextures, type TextureDecoder } from './textures'
import { applyUnityClips, fbxFrameRate, unityClips } from './unity-meta'
import type { ModelFailure, ModelProgress } from '@shared/model-viewer'

export class ViewerError extends Error {
  constructor(readonly code: ModelFailure | 'cancelled', message: string) { super(message) }
}

/** The format's name in failure messages. */
export const FORMAT_NAMES: Record<string, string> = {
  glb: 'GLB', gltf: 'glTF', fbx: 'FBX', obj: 'OBJ', stl: 'STL', ply: 'PLY', dae: 'Collada', bvh: 'BVH', usda: 'USDA', usd: 'USD', '3ds': '3DS'
}
/** Plain grey for formats that carry no material (STL, PLY): distinct from the clay fallback. */
const PLAIN = 0xc5cad1

export interface Parsed {
  root: THREE.Object3D
  clips: THREE.AnimationClip[]
  /** Loader-made resources the scene may not reference. */
  extra: Iterable<unknown>
  format: string
  /** Metres per file unit, applied by the viewer (the loader has not). */
  scale: number
  /** The file's units in words. */
  units: string
  /** The loader turned a Z-up file upright. */
  turned: boolean
  /** Z-up by convention but not stated in the file (3DS): the viewer starts turned. */
  zUp?: boolean
  unityClips?: boolean
  /** glTF: the loader's own record, which tells which materials had a base colour texture. */
  gltf?: GLTF
  /** Blob URLs to revoke once textures have settled. */
  blobs?: string[]
}

export interface FormatContext {
  url: string
  /** The model's folder URL, ending in "/". */
  folder: string
  manager: THREE.LoadingManager
  decoder: TextureDecoder
  /** Every texture the decoder makes for this load, attached or not. */
  made: Set<THREE.Texture>
  gltfLoader(manager: THREE.LoadingManager): GLTFLoader
  progress?(phase: ModelProgress['phase']): void
}

/** A loader error carrying the HTTP status, as three's FileLoader reports one. */
const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { response: { status } })
async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw httpError(response.status)
  return response.arrayBuffer()
}
const text = (bytes: ArrayBuffer): string => new TextDecoder().decode(bytes)
/** A side file through the manager, so a failure is listed by name like a missing texture. */
const sideText = (manager: THREE.LoadingManager, url: string): Promise<string> => new THREE.FileLoader(manager).loadAsync(url) as Promise<string>

function unitWords(metres: number): string {
  const near = (v: number): boolean => Math.abs(metres - v) < v * 1e-4
  const name = near(1) ? 'Metres' : near(0.01) ? 'Centimetres' : near(0.001) ? 'Millimetres' : near(0.0254) ? 'Inches' : near(0.3048) ? 'Feet' : near(1000) ? 'Kilometres' : `Units of ${+metres.toPrecision(4)} m`
  return name === 'Metres' ? 'Metres' : `${name}, shown in metres`
}
const NO_UNITS = 'No unit in the file, read as metres'

/** Unity's clip names for an FBX, from <model>.meta when there is one. */
async function unityNames(url: string, takes: THREE.AnimationClip[], buffer: ArrayBuffer, signal: AbortSignal): Promise<THREE.AnimationClip[] | undefined> {
  if (!takes.length) return
  let meta: string
  try {
    const response = await fetch(`${url}.meta`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
    if (!response.ok) return
    meta = await response.text()
  } catch { return }
  const entries = unityClips(meta).slice(0, 512)
  return entries.length ? applyUnityClips(takes, entries, fbxFrameRate(buffer) ?? 30) : undefined
}

export async function loadFormat(ext: string, ctx: FormatContext): Promise<Parsed> {
  const { url, folder, manager, decoder, made } = ctx
  const signal = manager.abortController.signal
  const read = async (): Promise<ArrayBuffer> => {
    const bytes = await fetchBytes(url, signal)
    signal.throwIfAborted()
    ctx.progress?.('parsing')
    // Let the host paint the phase before a synchronous format parser runs.
    await new Promise(resolve => setTimeout(resolve, 0))
    signal.throwIfAborted()
    return bytes
  }
  const decoded = <T>(parse: () => T): { value: T; blobs: string[] } => withDecodedTextures(decoder, made, parse)
  // FBXLoader skips embedded TGA images unless a loader is registered for them. Not for glTF, whose
  // textures are not flipped (GLTFLoader also asks the manager for handlers).
  if (ext !== 'glb' && ext !== 'gltf') manager.addHandler(/\.tga$/i, new DecodedTextureLoader(manager, decoder, made))
  switch (ext) {
    case 'glb': case 'gltf': {
      const gltf = await ctx.gltfLoader(manager).parseAsync(await read(), folder)
      return { root: gltf.scene, clips: gltf.animations, extra: gltf.parser.associations.keys(), format: ext === 'glb' ? 'GLB' : 'glTF', scale: 1, units: 'Metres', turned: false, gltf }
    }
    case 'fbx': {
      const buffer = await read()
      const binary = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(18, buffer.byteLength))) === 'Kaydara FBX Binary'
      const { value: root, blobs } = decoded(() => new FBXLoader(manager).parse(buffer, folder))
      const metres = (Number(root.userData.unitScaleFactor) || 1) / 100
      const named = await unityNames(url, root.animations, buffer, signal)
      return {
        root, clips: named ?? root.animations, extra: [], format: binary ? 'FBX binary' : 'FBX ASCII', scale: metres,
        units: unitWords(metres), turned: root.rotation.x !== 0, unityClips: !!named, blobs
      }
    }
    case 'obj': {
      const source = text(await read())
      const loader = new OBJLoader(manager)
      // Blender and most tools name their material library in the file; the first that loads is used.
      for (const lib of [...source.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map(m => m[1]).slice(0, 4)) {
        let mtl: string
        try { mtl = await sideText(manager, folder + lib) } catch { continue }
        const { value: materials } = decoded(() => { const m = new MTLLoader(manager).parse(mtl, folder); m.preload(); return m })
        loader.setMaterials(materials)
        break
      }
      const { value: root } = decoded(() => loader.parse(source))
      return { root, clips: [], extra: [], format: 'OBJ', scale: 1, units: NO_UNITS, turned: false }
    }
    case 'stl': {
      const geometry = new STLLoader(manager).parse(await read())
      if (!geometry.attributes.normal) geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({ color: PLAIN, roughness: 0.6, metalness: 0.05, vertexColors: !!geometry.attributes.color, name: 'STL' })
      return { root: new THREE.Mesh(geometry, material), clips: [], extra: [], format: 'STL', scale: 1, units: NO_UNITS, turned: false }
    }
    case 'ply': {
      const geometry = new PLYLoader(manager).parse(await read())
      const colors = !!geometry.attributes.color
      // A PLY without faces is a point cloud.
      if (!geometry.index) return { root: new THREE.Points(geometry, new THREE.PointsMaterial({ color: colors ? 0xffffff : PLAIN, size: 2, sizeAttenuation: false, vertexColors: colors, name: 'PLY points' })), clips: [], extra: [], format: 'PLY (points)', scale: 1, units: NO_UNITS, turned: false }
      if (!geometry.attributes.normal) geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({ color: colors ? 0xffffff : PLAIN, roughness: 0.6, metalness: 0.05, vertexColors: colors, name: 'PLY' })
      return { root: new THREE.Mesh(geometry, material), clips: [], extra: [], format: 'PLY', scale: 1, units: NO_UNITS, turned: false }
    }
    case 'dae': {
      const source = text(await read())
      const { value: collada, blobs } = decoded(() => new ColladaLoader(manager).parse(source, folder))
      if (!collada?.scene) throw new ViewerError('unreadable', 'The file could not be read as Collada: it is not valid Collada XML.')
      const root = collada.scene
      // ColladaLoader applies the file's <unit> and <up_axis> to the scene itself.
      return { root, clips: root.animations ?? [], extra: [], format: 'Collada', scale: 1, units: unitWords(root.scale.x), turned: root.rotation.x !== 0, blobs }
    }
    case 'bvh': {
      const bvh = new BVHLoader(manager).parse(text(await read()))
      const root = new THREE.Group()
      root.add(bvh.skeleton.bones[0])
      bvh.clip.name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)).replace(/\.bvh$/i, '')
      return { root, clips: [bvh.clip], extra: [], format: 'BVH', scale: 1, units: NO_UNITS, turned: false }
    }
    case 'usda': case 'usd': {
      const buffer = await read()
      if (text(buffer.slice(0, 8)) === 'PXR-USDC') throw new ViewerError('unreadable', 'This .usd file is binary USD (USDC), which Genio\'s 3D viewer cannot read. Open it in your 3D app, or export it as USDA, glTF or FBX to preview it here.')
      const { value: root, blobs } = await new Promise<{ value: THREE.Group; blobs: string[] }>((resolve, reject) => {
        // USDLoader calls back once its own texture images have loaded.
        let parsed: { value: THREE.Group; blobs: string[] } | undefined, ready = false
        try { parsed = decoded(() => new USDLoader(manager).parse(text(buffer), folder, () => { ready = true; if (parsed) resolve(parsed) }, reject)) } catch (e) { reject(e); return }
        if (ready) resolve(parsed)
      })
      // USDLoader applies metersPerUnit and upAxis to the group it returns.
      return { root, clips: root.animations ?? [], extra: [], format: ext === 'usda' ? 'USDA' : 'USD (text)', scale: 1, units: unitWords(root.scale.x), turned: root.rotation.x !== 0, blobs }
    }
    case '3ds': {
      const buffer = await read()
      const { value: root } = decoded(() => new TDSLoader(manager).parse(buffer, folder))
      return { root, clips: [], extra: [], format: '3DS', scale: 1, units: NO_UNITS, turned: false, zUp: true }
    }
  }
  throw new Error(`Genio's 3D viewer cannot read .${ext} files.`)
}

/** Side-file URLs a model stores as the artist's disk path (C:\..., /Users/..., ../) are reduced to the file name, which main looks for below the model. */
export function sideFileUrl(url: string, folder: string): string {
  if (!url.startsWith(folder)) return url
  const segments = url.slice(folder.length).replace(/\\/g, '/').split('/').filter(s => s && s !== '.')
  const outside = /^[a-z]:$/i.test(segments[0] ?? '') || url.slice(folder.length).startsWith('/') || url.slice(folder.length).startsWith('\\') || segments.includes('..')
  const kept = outside ? segments.slice(-1) : segments
  const encode = (s: string): string => { try { return encodeURIComponent(decodeURIComponent(s)) } catch { return encodeURIComponent(s) } }
  return folder + kept.map(encode).join('/')
}
