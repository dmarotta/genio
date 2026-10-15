import type { Material, Object3D, Texture } from 'three'

export interface Disposable { dispose(): void }

const isTexture = (v: unknown): v is Texture => !!v && typeof v === 'object' && (v as Texture).isTexture === true

/** Textures in any material slot or shader uniform (single, array, or struct values). */
export function materialTextures(material: Material): Texture[] {
  const found: Texture[] = []
  const visit = (v: unknown, depth: number): void => {
    if (isTexture(v)) found.push(v)
    else if (depth > 0 && Array.isArray(v)) v.forEach(x => visit(x, depth - 1))
  }
  for (const value of Object.values(material)) visit(value, 1)
  const uniforms = (material as { uniforms?: Record<string, { value?: unknown }> }).uniforms
  if (uniforms) for (const u of Object.values(uniforms)) visit(u?.value, 1)
  return found
}

/**
 * Everything GPU-backed that a loaded model owns: geometries, materials, every texture they hold and
 * skinned meshes' skeletons (bone textures). `extra` takes what the loader made but did not attach
 * (e.g. textures a material dropped), which a scene walk alone misses.
 */
export function collectResources(root: Object3D, extra: Iterable<unknown> = []): Set<Disposable> {
  const out = new Set<Disposable>()
  const addMaterial = (m: Material): void => { out.add(m); for (const t of materialTextures(m)) out.add(t) }
  root.traverse(o => {
    const node = o as Object3D & { geometry?: Disposable & { isBufferGeometry?: boolean }; material?: Material | Material[]; isSkinnedMesh?: boolean; skeleton?: Disposable }
    if (node.geometry?.isBufferGeometry) out.add(node.geometry)
    if (node.material) for (const m of [node.material].flat()) addMaterial(m)
    if (node.isSkinnedMesh && node.skeleton) out.add(node.skeleton)
  })
  for (const x of extra) {
    if (isTexture(x)) out.add(x)
    else if (x && typeof x === 'object' && (x as Material).isMaterial) addMaterial(x as Material)
  }
  return out
}

/** Dispose each resource once and release decoded ImageBitmaps (texture.dispose frees only the GPU copy). */
export function disposeResources(resources: Iterable<Disposable>): void {
  const bitmaps = new Set<ImageBitmap>()
  for (const r of resources) {
    r.dispose()
    if (isTexture(r) && typeof ImageBitmap !== 'undefined' && r.image instanceof ImageBitmap) bitmaps.add(r.image)
  }
  for (const b of bitmaps) b.close()
}
