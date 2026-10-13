/**
 * A tiny animated .glb for tests: a two-joint chain (root at the origin, child
 * one unit up), optionally a skinned triangle on it, and a one-second clip
 * where the root turns 90° about Z and slides 2 units along X.
 */
export function animatedGlb(opts: { mesh?: boolean; interpolation?: 'LINEAR' | 'STEP' } = {}): Uint8Array<ArrayBuffer> {
  const mesh = opts.mesh ?? true
  const chunks: { bytes: Uint8Array; accessor: Record<string, unknown> }[] = []
  const f32 = (a: number[]): Uint8Array => new Uint8Array(new Float32Array(a).buffer)
  const add = (bytes: Uint8Array, accessor: Record<string, unknown>): number => chunks.push({ bytes, accessor }) - 1

  const s = Math.SQRT1_2
  const times = add(f32([0, 1]), { componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] })
  const rot = add(f32([0, 0, 0, 1, 0, 0, s, s]), { componentType: 5126, count: 2, type: 'VEC4' })
  const tra = add(f32([0, 0, 0, 2, 0, 0]), { componentType: 5126, count: 2, type: 'VEC3' })
  let pos = -1, nrm = -1, jnt = -1, wgt = -1, ibm = -1
  if (mesh) {
    pos = add(f32([0, 0, 0, 0, 1, 0, 0.1, 1, 0]), { componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.1, 1, 0] })
    nrm = add(f32([0, 0, 1, 0, 0, 1, 0, 0, 1]), { componentType: 5126, count: 3, type: 'VEC3' })
    jnt = add(new Uint8Array(new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).buffer), { componentType: 5123, count: 3, type: 'VEC4' })
    wgt = add(f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), { componentType: 5126, count: 3, type: 'VEC4' })
    // inverse bind: identity for the root, a move one unit down for the child
    ibm = add(f32([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]), { componentType: 5126, count: 2, type: 'MAT4' })
  }

  let offset = 0
  const bufferViews: Record<string, unknown>[] = []
  const accessors: Record<string, unknown>[] = []
  for (const c of chunks) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: c.bytes.byteLength })
    accessors.push({ bufferView: bufferViews.length - 1, ...c.accessor })
    offset += Math.ceil(c.bytes.byteLength / 4) * 4
  }
  const bin = new Uint8Array(offset)
  let o = 0
  for (const c of chunks) {
    bin.set(c.bytes, o)
    o += Math.ceil(c.bytes.byteLength / 4) * 4
  }

  const nodes: Record<string, unknown>[] = [{ name: 'root', children: [1] }, { name: 'child', translation: [0, 1, 0] }]
  if (mesh) nodes.push({ name: 'body', mesh: 0, skin: 0 })
  const interp = opts.interpolation ?? 'LINEAR'
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: mesh ? [0, 2] : [0] }],
    nodes,
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    accessors,
    animations: [
      {
        name: 'Turn',
        samplers: [
          { input: times, output: rot, interpolation: interp },
          { input: times, output: tra, interpolation: interp }
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: 'rotation' } },
          { sampler: 1, target: { node: 0, path: 'translation' } }
        ]
      }
    ]
  }
  if (mesh) {
    json.meshes = [{ primitives: [{ attributes: { POSITION: pos, NORMAL: nrm, JOINTS_0: jnt, WEIGHTS_0: wgt } }] }]
    json.skins = [{ joints: [0, 1], inverseBindMatrices: ibm }]
  }

  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.byteLength, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  const b = 20 + jsonBytes.byteLength
  dv.setUint32(b, bin.byteLength, true)
  dv.setUint32(b + 4, 0x004e4942, true)
  out.set(bin, b + 8)
  return out
}
