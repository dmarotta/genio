/**
 * Inventory's 3D viewer core (runs only inside the sandboxed viewer frame): one WebGL context per
 * frame, every format in formats.ts (glTF/GLB with Draco, meshopt and KTX2; FBX, OBJ, STL, PLY,
 * Collada, BVH, USDA, 3DS), orbit/pan/zoom, framing, view toggles, clips and a full dispose of
 * everything a load created.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { DEFAULT_VIEWER_SETTINGS, MODEL_PREVIEW_MAX_BYTES, MODEL_PREVIEW_MAX_TEXTURE, formatLength, type ModelLoaded, type ModelPlayback, type ModelTexture, type ViewerSettings } from '@shared/model-viewer'
import { collectResources, disposeResources, materialTextures, type Disposable } from './resources'
import { FORMAT_NAMES, ViewerError, loadFormat, sideFileUrl, type Parsed } from './formats'
import { TextureDecoder, flippedBitmaps, hasImage, prepareTextures } from './textures'

export { ViewerError }

const SLOTS: Record<string, string> = {
  map: 'base colour', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metalness', aoMap: 'occlusion', emissiveMap: 'emission',
  alphaMap: 'alpha', bumpMap: 'bump', displacementMap: 'displacement', lightMap: 'light map', clearcoatMap: 'clearcoat',
  clearcoatNormalMap: 'clearcoat normal', clearcoatRoughnessMap: 'clearcoat roughness', sheenColorMap: 'sheen colour', sheenRoughnessMap: 'sheen roughness',
  transmissionMap: 'transmission', thicknessMap: 'thickness', specularColorMap: 'specular colour', specularIntensityMap: 'specular', specularMap: 'specular',
  iridescenceMap: 'iridescence', iridescenceThicknessMap: 'iridescence thickness', anisotropyMap: 'anisotropy'
}
const CLAY = 0x9ea3aa
const ACCENT = 0x00e5ff
const BACKGROUNDS = { dark: 0x0b0f16, light: 0xdfe3e8 }
const GRID_COLORS = { dark: [0x2b6b7a, 0x1a2a33], light: [0x7f8b99, 0xb7c0ca] }

export interface ViewerOptions {
  /** Folder URL holding three's draco_* and basis_* decoder files; omitted, the copies bundled beside the loaders. */
  decoderPath?: string
  maxTexture?: number
  /** Overlay element for the bounds' dimension labels. */
  labels?: HTMLElement
  /** Playback position, a few times a second while playing and on every change. */
  onTime?(clip: number, time: number, playing: boolean): void
}
export interface Viewer {
  readonly renderer: THREE.WebGLRenderer
  open(url: string): Promise<ModelLoaded>
  clear(): void
  set(settings: Partial<ViewerSettings>): void
  playback(patch: Partial<ModelPlayback>): void
  frame(): void
  /** Draw a frame now (uploads textures), without waiting for the next animation frame. */
  render(): void
  texturePreviews(size?: number): { id: number; url: string }[]
  /** GPU resources currently alive (renderer.info.memory). */
  memory(): { textures: number; geometries: number }
  dispose(): void
}

interface SkeletonLines { object: THREE.Group; update(): void; dispose(): void }
interface Loaded {
  pivot: THREE.Group
  root: THREE.Object3D
  resources: Set<Disposable>
  meshes: THREE.Mesh[]
  materials: Map<THREE.Mesh, THREE.Material | THREE.Material[]>
  joints: THREE.Object3D[]
  animationOnly: boolean
  mixer?: THREE.AnimationMixer
  actions: THREE.AnimationAction[]
  playback: ModelPlayback
  followNode?: THREE.Object3D
  followAt?: THREE.Vector3
  textures: { info: ModelTexture; texture: THREE.Texture }[]
  box: THREE.Box3
  grid?: THREE.GridHelper
  bounds?: THREE.Box3Helper
  skeleton?: SkeletonLines
}

const fileName = (url: string): string => {
  if (url.startsWith('blob:') || url.startsWith('data:')) return 'embedded image'
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || url) } catch { return url.split(/[\\/]/).pop() ?? url }
}

/** Why a load failed, in the player's words. `failed` maps each URL the loader could not fetch to its file name. */
async function loadError(e: unknown, failed: Map<string, string>, url: string, model: string, format: string): Promise<ViewerError> {
  if (e instanceof ViewerError) return e
  const status = (e as { response?: { status?: number } } | undefined)?.response?.status
  const sides = [...failed].filter(([u]) => u !== url && !u.startsWith('blob:') && !u.startsWith('data:'))
  // GLTFLoader reports a failed .bin or image without its HTTP status, so ask the server (main answers HEAD).
  const statuses = await Promise.all(sides.map(([u]) => fetch(u, { method: 'HEAD' }).then(r => r.status, () => 0)))
  const big = sides.find((_, i) => statuses[i] === 413)?.[1] ?? (status === 413 ? model : undefined)
  if (big) return new ViewerError('too-large', `${big} is larger than the ${MODEL_PREVIEW_MAX_BYTES / 1024 / 1024} MB preview limit.`)
  if (sides.length) return new ViewerError('unreadable', `A file this model needs did not load: ${sides.slice(0, 3).map(([, n]) => n).join(', ')}. It must sit beside the model or in a folder below it.`)
  if (status) return new ViewerError('unreadable', 'The model file could not be read.')
  const message = (e instanceof Error ? e.message : String(e)).replace(/^(?:THREE\.)?\w+Loader: /, '')
  return new ViewerError('unreadable', `The file could not be read as ${format}: ${message}`)
}

/** Resolves once every request the manager started has ended (loaders fetch textures after parsing). */
function settled(manager: THREE.LoadingManager): () => Promise<void> {
  let active = 0, wake: (() => void) | undefined
  const start = manager.itemStart.bind(manager), end = manager.itemEnd.bind(manager)
  manager.itemStart = (u: string) => { active++; start(u) }
  manager.itemEnd = (u: string) => { active--; end(u); if (active <= 0) wake?.() }
  return () => new Promise<void>(resolve => {
    wake = () => setTimeout(() => { if (active <= 0) resolve() })
    if (active <= 0) wake()
  })
}

/** Lines between each joint and its parent joint, plus joint dots, drawn over the model. */
function skeletonLines(joints: THREE.Object3D[]): SkeletonLines {
  const set = new Set(joints)
  const pairs = joints.filter(j => j.parent && set.has(j.parent)).map(j => [j.parent!, j] as const)
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, pairs.length) * 6), 3))
  const pointGeometry = new THREE.BufferGeometry()
  pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(joints.length * 3), 3))
  const lineMaterial = new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
  const pointMaterial = new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true })
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial)
  const points = new THREE.Points(pointGeometry, pointMaterial)
  const object = new THREE.Group()
  for (const o of [lines, points]) { o.frustumCulled = false; o.renderOrder = 999; object.add(o) }
  const v = new THREE.Vector3()
  return {
    object,
    update() {
      const lp = lineGeometry.attributes.position as THREE.BufferAttribute, pp = pointGeometry.attributes.position as THREE.BufferAttribute
      pairs.forEach(([a, b], i) => { a.getWorldPosition(v); lp.setXYZ(i * 2, v.x, v.y, v.z); b.getWorldPosition(v); lp.setXYZ(i * 2 + 1, v.x, v.y, v.z) })
      joints.forEach((j, i) => { j.getWorldPosition(v); pp.setXYZ(i, v.x, v.y, v.z) })
      lp.needsUpdate = true; pp.needsUpdate = true
    },
    dispose() { lineGeometry.dispose(); pointGeometry.dispose(); lineMaterial.dispose(); pointMaterial.dispose() }
  }
}

export function createViewer(canvas: HTMLCanvasElement, opts: ViewerOptions): Viewer {
  let renderer: THREE.WebGLRenderer
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }) } catch {
    throw new ViewerError('no-webgl', 'WebGL is unavailable here, so the model cannot be drawn.')
  }
  const maxTexture = opts.maxTexture ?? MODEL_PREVIEW_MAX_TEXTURE
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  const scene = new THREE.Scene()
  // Neutral studio lighting made locally (no HDR download): a PMREM of three's room plus a camera key light.
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = pmrem.fromScene(room, 0.04)
  room.dispose(); pmrem.dispose()
  scene.environment = environment.texture
  scene.environmentIntensity = 0.75
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000)
  const key = new THREE.DirectionalLight(0xffffff, 0.9)
  const keyTarget = new THREE.Object3D()
  key.position.set(1, 1.5, 0.5); keyTarget.position.set(0, 0, -1); key.target = keyTarget
  camera.add(key, keyTarget); scene.add(camera)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  const clay = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.85, metalness: 0, name: 'Clay' })
  const background = new THREE.Color()
  let settings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS }
  let model: Loaded | undefined
  let generation = 0
  let draco: DRACOLoader | undefined, ktx2: KTX2Loader | undefined, decoder: TextureDecoder | undefined
  let dirty = true, raf = 0, last = performance.now(), lastReport = 0, width = 0, height = 0
  const labelEls = opts.labels ? (['width', 'height', 'depth'] as const).map(axis => {
    const el = document.createElement('span'); el.dataset.axis = axis; el.hidden = true; opts.labels!.append(el); return el
  }) : []
  controls.addEventListener('change', () => { dirty = true })
  canvas.addEventListener('dblclick', () => frame())

  const report = (): void => {
    if (!model?.mixer) return
    lastReport = performance.now()
    opts.onTime?.(model.playback.clip, model.actions[model.playback.clip]?.time ?? 0, model.playback.playing)
  }

  function applyBackground(): void {
    if (settings.background === 'checker') { scene.background = null; renderer.setClearColor(0x000000, 0) } else { scene.background = background.set(BACKGROUNDS[settings.background]) }
    canvas.dataset.background = settings.background
  }

  function placeGrid(): void {
    if (!model) return
    if (model.grid) { scene.remove(model.grid); model.grid.dispose() }
    const size = model.box.getSize(new THREE.Vector3()), center = model.box.getCenter(new THREE.Vector3())
    const span = Math.max(size.x, size.z, size.y * 0.6, 1e-3) * 3
    const step = 10 ** Math.floor(Math.log10(span))
    const [c1, c2] = GRID_COLORS[settings.background === 'light' ? 'light' : 'dark']
    model.grid = new THREE.GridHelper(Math.ceil(span / step) * step, 20, c1, c2)
    model.grid.position.set(center.x, model.box.min.y, center.z)
    model.grid.visible = settings.grid
    scene.add(model.grid)
  }

  /** World bounds of what is drawn: meshes, or the joints of an animation-only file. */
  function measure(m: Loaded): THREE.Box3 {
    m.pivot.updateMatrixWorld(true)
    const box = new THREE.Box3()
    const action = m.actions[m.playback.clip]
    if (m.animationOnly && m.mixer && action) {
      // A bare rig is framed over its whole clip, so root motion stays in view.
      const time = action.time, duration = action.getClip().duration
      for (let i = 0; i <= 12; i++) {
        action.time = duration * i / 12; m.mixer.update(0); m.pivot.updateMatrixWorld(true)
        for (const j of m.joints) box.expandByPoint(j.getWorldPosition(new THREE.Vector3()))
      }
      action.time = time; m.mixer.update(0); m.pivot.updateMatrixWorld(true)
    } else if (m.animationOnly) for (const j of m.joints) box.expandByPoint(j.getWorldPosition(new THREE.Vector3()))
    else box.setFromObject(m.pivot)
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5))
    const size = box.getSize(new THREE.Vector3())
    // A flat or single-joint result still gets a little volume to orbit around.
    const pad = Math.max(size.x, size.y, size.z) * 0.02 || 0.05
    if (Math.min(size.x, size.y, size.z) < pad) box.expandByScalar(pad)
    return box
  }

  function layout(): void {
    if (!model) return
    model.pivot.rotation.x = settings.upAxis === 'z' ? -Math.PI / 2 : 0
    model.box = measure(model)
    placeGrid()
    if (model.bounds) { scene.remove(model.bounds); model.bounds.dispose() }
    model.bounds = new THREE.Box3Helper(model.box, ACCENT)
    model.bounds.visible = settings.bounds
    scene.add(model.bounds)
    frame()
  }

  function frame(): void {
    if (!model) return
    const size = model.box.getSize(new THREE.Vector3()), center = model.box.getCenter(new THREE.Vector3())
    const radius = Math.max(size.length() / 2, 1e-4)
    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const fov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect))
    const distance = radius / Math.sin(fov / 2) * 1.05
    camera.near = Math.max(radius / 1000, distance - radius * 50, 1e-4)
    camera.far = distance + radius * 50
    camera.position.copy(center).add(new THREE.Vector3(1, 0.62, 1.3).normalize().multiplyScalar(distance))
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.minDistance = radius * 0.02
    controls.maxDistance = distance * 20
    controls.update()
    model.followAt = undefined
    dirty = true
  }

  function applyMaterials(): void {
    if (!model) return
    for (const [mesh, original] of model.materials) mesh.material = settings.clay ? (Array.isArray(original) ? original.map(() => clay) : clay) : original
    const all = new Set<THREE.Material>([clay])
    for (const original of model.materials.values()) for (const m of [original].flat()) all.add(m)
    for (const m of all) if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = settings.wireframe
    dirty = true
  }

  function applySkeleton(): void {
    if (!model || !model.joints.length) return
    const show = settings.skeleton || model.animationOnly
    if (show && !model.skeleton) { model.skeleton = skeletonLines(model.joints); scene.add(model.skeleton.object) }
    if (model.skeleton) model.skeleton.object.visible = show
    dirty = true
  }

  function placeLabels(): void {
    const box = model?.box
    const show = !!model && settings.bounds && !!opts.labels
    if (!show || !box) { for (const el of labelEls) el.hidden = true; return }
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3())
    const anchors = [new THREE.Vector3(c.x, box.min.y, box.max.z), new THREE.Vector3(box.max.x, c.y, box.max.z), new THREE.Vector3(box.min.x, box.min.y, c.z)]
    const values = [size.x, size.y, size.z]
    labelEls.forEach((el, i) => {
      const p = anchors[i].project(camera)
      el.hidden = p.z > 1 || p.z < -1
      el.textContent = `${'WHD'[i]} ${formatLength(values[i])}`
      el.style.left = `${(p.x + 1) / 2 * width}px`
      el.style.top = `${(1 - p.y) / 2 * height}px`
    })
  }

  function follow(): void {
    if (!model?.followNode || !model.playback.follow) return
    const at = model.followNode.getWorldPosition(new THREE.Vector3())
    if (model.followAt) {
      const delta = at.clone().sub(model.followAt).setY(0)
      camera.position.add(delta); controls.target.add(delta)
    }
    model.followAt = at
  }

  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (w && h && (w !== width || h !== height)) {
      width = w; height = h
      renderer.setSize(w, h, false)
      camera.aspect = w / h; camera.updateProjectionMatrix()
      dirty = true
    }
    if (model?.mixer && model.playback.playing) {
      model.mixer.update(dt)
      follow()
      dirty = true
      if (now - lastReport > 150) report()
    }
    if (controls.update()) dirty = true
    if (!dirty || !width || !height) return
    dirty = false
    if (model?.skeleton?.object.visible) model.skeleton.update()
    renderer.render(scene, camera)
    placeLabels()
  }

  /**
   * Clay fallback: a material whose texture did not load drops that slot (an empty texture samples
   * black), and one that lost its base colour shows clay instead of a flat white. Returns how many did.
   */
  function fallBack(parsed: Parsed, materials: Set<THREE.Material>): number {
    let count = 0
    if (parsed.gltf) {
      // GLTFLoader leaves a failed map unassigned, so the file's own record says which had one.
      const json = parsed.gltf.parser.json as { materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[] }
      for (const m of materials) {
        const index = (parsed.gltf.parser.associations.get(m) as { materials?: number } | undefined)?.materials
        const standard = m as THREE.MeshStandardMaterial
        if (index !== undefined && json.materials?.[index]?.pbrMetallicRoughness?.baseColorTexture && !standard.map && standard.color) {
          standard.color.set(CLAY); standard.roughness = 0.85; standard.metalness = 0; count++
        }
      }
      return count
    }
    for (const m of materials) {
      const slots = m as unknown as Record<string, THREE.Texture | null>
      let lostBase = false
      for (const [slot, value] of Object.entries(slots)) {
        if (!value?.isTexture || hasImage(value)) continue
        slots[slot] = null
        m.needsUpdate = true
        if (slot === 'map') lostBase = true
      }
      const coloured = m as THREE.MeshPhongMaterial
      if (lostBase && coloured.color) { coloured.color.set(CLAY); count++ }
    }
    return count
  }

  function clear(): void {
    generation++
    if (!model) return
    const m = model
    model = undefined
    m.mixer?.stopAllAction()
    m.mixer?.uncacheRoot(m.root)
    scene.remove(m.pivot)
    for (const helper of [m.grid, m.bounds]) if (helper) { scene.remove(helper); helper.dispose() }
    if (m.skeleton) { scene.remove(m.skeleton.object); m.skeleton.dispose() }
    disposeResources(m.resources)
    for (const el of labelEls) el.hidden = true
    dirty = true
  }

  function gltfLoader(manager: THREE.LoadingManager): GLTFLoader {
    if (!draco) {
      draco = new DRACOLoader()
      if (opts.decoderPath) draco.setDecoderPath(opts.decoderPath)
    }
    if (!ktx2) {
      ktx2 = new KTX2Loader().detectSupport(renderer)
      if (opts.decoderPath) ktx2.setTranscoderPath(opts.decoderPath)
    }
    return new GLTFLoader(manager).setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder)
  }

  async function open(url: string): Promise<ModelLoaded> {
    clear()
    const gen = generation
    const started = performance.now()
    const name = fileName(url)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const format = FORMAT_NAMES[ext] ?? ext.toUpperCase()
    const folder = url.slice(0, url.lastIndexOf('/') + 1)
    const manager = new THREE.LoadingManager()
    const failed = new Map<string, string>()
    manager.onError = u => { failed.set(u, fileName(u)) }
    manager.setURLModifier(u => sideFileUrl(u, folder))
    const idle = settled(manager)
    const textures = decoder ??= new TextureDecoder(maxTexture)
    const made = new Set<THREE.Texture>()
    let parsed: Parsed
    try {
      parsed = await loadFormat(ext, { url, folder, manager, decoder: textures, made, gltfLoader })
      // Textures and other side files arrive after parsing.
      await idle()
    } catch (e) {
      disposeResources(made)
      throw gen === generation ? await loadError(e, failed, url, name, format) : new ViewerError('cancelled', 'Superseded')
    }
    for (const blob of parsed.blobs ?? []) URL.revokeObjectURL(blob)
    const root = parsed.root
    if (!parsed.gltf) {
      // A file's own lights and cameras would relight or crowd the preview.
      const strays: THREE.Object3D[] = []
      root.traverse(o => { if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) strays.push(o) })
      for (const o of strays) { o.removeFromParent(); (o as THREE.Light).dispose?.() }
    }
    // Everything the load made, attached or not: unreferenced textures leaked 86 per 100 opens otherwise.
    const resources = collectResources(root, [...parsed.extra, ...made])
    const cancelled = (): boolean => {
      if (gen === generation) return false
      disposeResources(resources)
      return true
    }
    if (cancelled()) throw new ViewerError('cancelled', 'Superseded')
    const meshes: THREE.Mesh[] = [], bones = new Set<THREE.Object3D>(), materials = new Set<THREE.Material>()
    let triangles = 0, vertices = 0, drawables = 0
    root.traverse(o => {
      if ((o as THREE.Bone).isBone) bones.add(o)
      if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints) {
        drawables++
        if ((o as THREE.Points).isPoints) vertices += (o as THREE.Points).geometry.attributes.position?.count ?? 0
      }
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      meshes.push(mesh); drawables++
      const position = mesh.geometry.attributes.position
      const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1
      if (position) {
        triangles += Math.floor((mesh.geometry.index?.count ?? position.count) / 3) * instances
        vertices += position.count * instances
      }
      for (const m of [mesh.material].flat()) materials.add(m)
    })
    const animationOnly = !drawables && (bones.size > 0 || parsed.clips.length > 0)
    if (!drawables && !animationOnly) { disposeResources(resources); throw new ViewerError('unreadable', 'The file holds no meshes, skeleton or animation to show.') }
    const textureList = [...new Set([...materials].flatMap(materialTextures))]
    let prepared: Awaited<ReturnType<typeof prepareTextures>>
    try { prepared = await prepareTextures(textureList, maxTexture, textures) } catch (e) { disposeResources(resources); throw e }
    if (cancelled()) throw new ViewerError('cancelled', 'Superseded')
    const { originals } = prepared
    for (const name of prepared.failed) failed.set(`undecoded:${name}`, name)
    const clayFallback = fallBack(parsed, materials)
    const bySource = new Map<THREE.Texture['source'], { info: ModelTexture; texture: THREE.Texture }>()
    for (const m of materials) for (const [slot, value] of Object.entries(m)) {
      const t = value as THREE.Texture
      if (!t?.isTexture) continue
      let entry = bySource.get(t.source)
      if (!entry) {
        const image = t.image as { width?: number; height?: number; src?: string } | undefined
        const mip = (t as THREE.CompressedTexture).mipmaps?.[0] as { width?: number; height?: number } | undefined
        entry = { texture: t, info: {
          id: bySource.size, name: t.name || (t.userData.file as string | undefined) || (image?.src && !image.src.startsWith('blob:') ? fileName(image.src) : '') || `Texture ${bySource.size + 1}`,
          uses: [], width: image?.width ?? mip?.width ?? 0, height: image?.height ?? mip?.height ?? 0,
          compressed: !!(t as THREE.CompressedTexture).isCompressedTexture, ...(originals.get(t.source) ? { original: originals.get(t.source) } : {})
        } }
        bySource.set(t.source, entry)
      }
      const use = `${m.name || 'Material'} · ${SLOTS[slot] ?? slot}`
      if (!entry.info.uses.includes(use) && entry.info.uses.length < 64) entry.info.uses.push(use)
    }
    // pivot (up-axis turn) > units (file units to metres) > the file's root.
    const pivot = new THREE.Group(), units = new THREE.Group()
    units.scale.setScalar(parsed.scale)
    units.add(root)
    pivot.add(units)
    if (parsed.zUp) settings = { ...settings, upAxis: 'z' }
    const joints = bones.size ? [...bones] : animationOnly ? (() => { const all: THREE.Object3D[] = []; root.traverse(o => { if (o !== root) all.push(o) }); return all })() : []
    const loaded: Loaded = {
      pivot, root, resources, meshes, joints, animationOnly,
      materials: new Map(meshes.map(m => [m, m.material])),
      actions: [], textures: [...bySource.values()].slice(0, 512),
      // A bare rig is framed over its whole clip; following its root would only drift the view.
      playback: { clip: 0, playing: true, time: 0, speed: 1, loop: true, follow: !animationOnly },
      box: new THREE.Box3(),
      followNode: joints.find(j => !j.parent || !joints.includes(j.parent))
    }
    if (parsed.clips.length) {
      const mixer = new THREE.AnimationMixer(root)
      loaded.mixer = mixer
      loaded.actions = parsed.clips.map(c => mixer.clipAction(c))
      loaded.actions[0].play()
      mixer.update(0)
      mixer.addEventListener('finished', () => { if (model === loaded) { loaded.playback.playing = false; report() } })
    }
    model = loaded
    scene.add(pivot)
    applyBackground()
    applyMaterials()
    layout()
    applySkeleton()
    // Upload and compile now, so the first visible frame does not stall.
    renderer.compile(scene, camera)
    dirty = true
    report()
    return {
      stats: {
        triangles, vertices, meshes: meshes.length, materials: materials.size, textures: bySource.size,
        bones: bones.size, size: model.box.getSize(new THREE.Vector3()).toArray() as [number, number, number]
      },
      clips: parsed.clips.slice(0, 512).map(c => ({ name: c.name || 'Clip', duration: c.duration })),
      textures: loaded.textures.map(t => t.info),
      missing: [...new Set(failed.values())].slice(0, 64), clayFallback, animationOnly,
      loadMs: Math.round(performance.now() - started),
      format: parsed.format,
      units: `${parsed.units}${parsed.turned ? '; Z-up in the file, turned upright' : parsed.zUp ? '; Z-up by convention, turned upright' : ''}`,
      upAxis: settings.upAxis, unityClips: !!parsed.unityClips
    }
  }

  function set(patch: Partial<ViewerSettings>): void {
    const before = settings
    settings = { ...settings, ...patch }
    applyBackground()
    if (!model) return
    if (before.upAxis !== settings.upAxis) layout()
    else if (before.background !== settings.background) placeGrid()
    if (model.grid) model.grid.visible = settings.grid
    if (model.bounds) model.bounds.visible = settings.bounds
    if (before.clay !== settings.clay || before.wireframe !== settings.wireframe) applyMaterials()
    applySkeleton()
    dirty = true
  }

  function playback(patch: Partial<ModelPlayback>): void {
    const m = model
    if (!m?.mixer) return
    const pb = m.playback
    if (patch.clip !== undefined && patch.clip !== pb.clip && m.actions[patch.clip]) {
      m.actions[pb.clip].stop()
      pb.clip = patch.clip
      m.actions[pb.clip].reset().play()
      m.followAt = undefined
    }
    const action = m.actions[pb.clip]
    if (patch.speed !== undefined) { pb.speed = patch.speed; m.mixer.timeScale = patch.speed }
    if (patch.loop !== undefined) pb.loop = patch.loop
    action.setLoop(pb.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = true
    if (patch.follow !== undefined) { pb.follow = patch.follow; m.followAt = undefined }
    if (patch.time !== undefined) {
      action.enabled = true
      action.time = THREE.MathUtils.clamp(patch.time, 0, action.getClip().duration)
      action.paused = false
      m.mixer.update(0)
    }
    if (patch.playing !== undefined) {
      // Play at the end of a one-shot clip starts it over.
      if (patch.playing && !pb.loop && action.time >= action.getClip().duration) { action.reset().play() }
      pb.playing = patch.playing
    }
    action.paused = !pb.playing
    if (!action.isRunning() && pb.playing) action.play()
    pb.time = action.time
    dirty = true
    report()
  }

  function texturePreviews(size = 96): { id: number; url: string }[] {
    const out: { id: number; url: string }[] = []
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')
    if (!ctx || !model) return out
    for (const { info, texture } of model.textures) {
      const image = texture.image as CanvasImageSource & { width?: number; height?: number }
      if (info.compressed || !image?.width || !image.height) continue
      const k = size / Math.max(image.width, image.height)
      c.width = Math.max(1, Math.round(image.width * k)); c.height = Math.max(1, Math.round(image.height * k))
      // Bitmaps flipped for WebGL are turned back for the preview.
      const flipped = image instanceof ImageBitmap && flippedBitmaps.has(image)
      try {
        ctx.setTransform(1, 0, 0, flipped ? -1 : 1, 0, flipped ? c.height : 0)
        ctx.clearRect(0, 0, c.width, c.height); ctx.drawImage(image, 0, 0, c.width, c.height)
      } catch { continue }
      const url = c.toDataURL('image/webp', 0.85)
      out.push({ id: info.id, url: url.startsWith('data:image/webp') ? url : c.toDataURL('image/png') })
    }
    return out
  }

  applyBackground()
  raf = requestAnimationFrame(tick)
  return {
    renderer, open, clear, set, playback, frame, texturePreviews,
    render: () => { model?.skeleton?.update(); renderer.render(scene, camera); dirty = false },
    memory: () => ({ textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries }),
    dispose() {
      clear()
      cancelAnimationFrame(raf)
      controls.dispose()
      clay.dispose()
      environment.dispose()
      draco?.dispose(); ktx2?.dispose(); decoder?.dispose()
      for (const el of labelEls) el.remove()
      renderer.dispose()
    }
  }
}
