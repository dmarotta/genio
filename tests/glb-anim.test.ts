import { describe, expect, it } from 'vitest'
import { nodeMatrices, parseGlb, poseModel, sampleChannel, type GlbChannel } from '../src/renderer/src/lib/glb'
import { glbAnimationSeconds } from '@shared/uthana'
import { animatedGlb } from './helpers/anim-glb'

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
const near = (a: ArrayLike<number>, b: number[], eps = 1e-5): void => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, -Math.log10(eps)))

describe('GLB viewer: animation', () => {
  it('reads the rig and clip of an animated file', async () => {
    const m = await parseGlb(buf(animatedGlb()))
    expect(m.rig?.clips).toHaveLength(1)
    expect(m.rig!.clips[0]).toMatchObject({ name: 'Turn', duration: 1 })
    expect(m.rig!.skins[0].joints).toEqual([0, 1])
    expect(m.rig!.root).toBe(0)
    expect(m.prims).toHaveLength(1)
    expect(m.prims[0].rest?.skin).toBe(0)
    // posed at t=0 (the bind pose): the triangle sits where the file put it
    near(m.prims[0].positions, [0, 0, 0, 0, 1, 0, 0.1, 1, 0])
  })

  it('skins the mesh through the clip: slerped rotation and lerped translation', async () => {
    const m = await parseGlb(buf(animatedGlb()))
    poseModel(m, 0, 1)
    // root turned 90° about Z and moved to x=2: the child-bound vertex (0,1,0) lands at (1,0,0)
    near(m.prims[0].positions, [2, 0, 0, 1, 0, 0])
    poseModel(m, 0, 0.5)
    const h = Math.SQRT1_2
    near(m.prims[0].positions.slice(3, 6), [1 - h, h, 0])
    // normals follow the joint rotation and stay unit length
    near(m.prims[0].normals.slice(0, 3), [0, 0, 1])
  })

  it('clamps outside the keys and honours STEP', async () => {
    const m = await parseGlb(buf(animatedGlb({ interpolation: 'STEP' })))
    poseModel(m, 0, 0.99)
    near(m.prims[0].positions.slice(3, 6), [0, 1, 0])
    poseModel(m, 0, 5)
    near(m.prims[0].positions.slice(3, 6), [1, 0, 0])
  })

  it('samples cubic splines with tangents', () => {
    // a 0 → 1 ramp with zero tangents eases in and out: halfway is 0.5, a quarter in is below linear
    const ch: GlbChannel = { node: 0, path: 'translation', interp: 'CUBICSPLINE', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]) }
    expect(sampleChannel(ch, 0.5)[0]).toBeCloseTo(0.5)
    expect(sampleChannel(ch, 0.25)[0]).toBeLessThan(0.25)
  })

  it('draws a motion-only file as its skeleton', async () => {
    const m = await parseGlb(buf(animatedGlb({ mesh: false })))
    expect(m.prims).toHaveLength(1)
    expect(m.prims[0].bones).toEqual([[0, 1]])
    expect(m.prims[0].positions).toHaveLength(72)
    const w = nodeMatrices(m.rig!, 0, 1)
    near([w[1][12], w[1][13], w[1][14]], [1, 0, 0])
  })

  it('measures the clip length from the file header (main uses it for cost)', () => {
    expect(glbAnimationSeconds(animatedGlb())).toBe(1)
    expect(glbAnimationSeconds(new Uint8Array(8))).toBeUndefined()
  })
})
