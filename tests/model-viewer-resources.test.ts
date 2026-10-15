import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectResources, disposeResources, materialTextures } from '../src/renderer/src/viewer3d/resources'

/** Counts dispose events: every resource a model owns must be disposed exactly once. */
function watch<T extends THREE.EventDispatcher<{ dispose: object }>>(x: T, seen: Map<unknown, number>): T {
  seen.set(x, 0)
  x.addEventListener('dispose', () => seen.set(x, (seen.get(x) ?? 0) + 1))
  return x
}

afterEach(() => vi.unstubAllGlobals())

describe('3D viewer resource tracking', () => {
  it('disposes geometries, materials, every texture slot, shader uniforms, skeletons and unattached loader textures', () => {
    const seen = new Map<unknown, number>()
    const tex = (name: string): THREE.Texture => { const t = watch(new THREE.Texture(), seen); t.name = name; return t }
    const shared = tex('shared')
    const root = new THREE.Group()
    const standard = watch(new THREE.MeshStandardMaterial({ map: shared, normalMap: tex('normal'), roughnessMap: tex('rough'), emissiveMap: tex('emissive') }), seen)
    root.add(new THREE.Mesh(watch(new THREE.BoxGeometry(), seen), standard))
    const physical = watch(new THREE.MeshPhysicalMaterial({ map: shared, clearcoatMap: tex('clearcoat'), sheenColorMap: tex('sheen') }), seen)
    const basic = watch(new THREE.MeshBasicMaterial({ alphaMap: tex('alpha') }), seen)
    root.add(new THREE.Mesh(watch(new THREE.BufferGeometry(), seen), [physical, basic]))
    const shader = watch(new THREE.ShaderMaterial({ uniforms: { tDiffuse: { value: tex('uniform') }, tArray: { value: [tex('array-0'), tex('array-1')] } } }), seen)
    root.add(new THREE.Points(watch(new THREE.BufferGeometry(), seen), shader))
    const bone = new THREE.Bone()
    const skeleton = new THREE.Skeleton([bone])
    let skeletonDisposed = 0
    skeleton.dispose = () => { skeletonDisposed++ }
    const skinned = new THREE.SkinnedMesh(watch(new THREE.BufferGeometry(), seen), watch(new THREE.MeshStandardMaterial(), seen))
    skinned.add(bone); skinned.bind(skeleton); root.add(skinned)
    // GLTFLoader keeps textures for maps that never made it onto a material (the 86-texture leak).
    const orphan = tex('orphan')
    const resources = collectResources(root, [orphan, root, 'not a resource'])
    disposeResources(resources)
    expect([...seen].filter(([, n]) => n !== 1).map(([r]) => (r as { name?: string; type?: string }).name || (r as { type?: string }).type)).toEqual([])
    expect(skeletonDisposed).toBe(1)
    expect(seen.size).toBe(resources.size - 1)
  })

  it('lists textures from material slots and uniforms only once each', () => {
    const t = new THREE.Texture()
    expect(materialTextures(new THREE.MeshStandardMaterial({ map: t, emissiveMap: t }))).toEqual([t, t])
    expect(materialTextures(new THREE.ShaderMaterial({ uniforms: { a: { value: t }, b: { value: 3 } } }))).toEqual([t])
    expect(collectResources(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: t, emissiveMap: t }))).size).toBe(3)
  })

  it('closes decoded ImageBitmaps once, even when several textures share one', () => {
    class FakeBitmap { closed = 0; width = 4; height = 4; close(): void { this.closed++ } }
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    const bitmap = new FakeBitmap()
    const a = new THREE.Texture(bitmap as unknown as ImageBitmap), b = a.clone()
    disposeResources(collectResources(new THREE.Mesh(new THREE.BufferGeometry(), [new THREE.MeshBasicMaterial({ map: a }), new THREE.MeshBasicMaterial({ map: b })])))
    expect(bitmap.closed).toBe(1)
  })
})
