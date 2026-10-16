/**
 * A .glb of named boxes, like a Modeller step's export: each part is a node with its own mesh and
 * material, placed by translation and sized by scale (a unit cube from -0.5 to 0.5).
 */
export interface Part { name: string; at: [number, number, number]; size: [number, number, number]; color?: [number, number, number] }

export function partsGlb(parts: Part[]): Uint8Array<ArrayBuffer> {
  const positions = new Float32Array([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5])
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5])
  const bin = new Uint8Array(positions.byteLength + indices.byteLength + 0)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), positions.byteLength)
  const padded = new Uint8Array(Math.ceil(bin.byteLength / 4) * 4)
  padded.set(bin)
  const json = {
    asset: { version: '2.0', generator: 'Genio test parts' },
    scene: 0,
    scenes: [{ nodes: parts.map((_, i) => i) }],
    nodes: parts.map((p, i) => ({ name: p.name, mesh: i, translation: p.at, scale: p.size })),
    meshes: parts.map((p, i) => ({ name: p.name, primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: i }] })),
    materials: parts.map(p => ({ name: `${p.name}_mat`, pbrMetallicRoughness: { baseColorFactor: [...(p.color ?? [0.6, 0.45, 0.3]), 1], metallicFactor: 0, roughnessFactor: 0.8 } })),
    buffers: [{ byteLength: padded.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }
    ]
  }
  let text = JSON.stringify(json)
  while (text.length % 4) text += ' '
  const jsonBytes = new TextEncoder().encode(text)
  const total = 12 + 8 + jsonBytes.byteLength + 8 + padded.byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.byteLength, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  const b = 20 + jsonBytes.byteLength
  dv.setUint32(b, padded.byteLength, true)
  dv.setUint32(b + 4, 0x004e4942, true)
  out.set(padded, b + 8)
  return out
}

const legs = [[-0.9, -0.9], [0.9, -0.9], [0.9, 0.9], [-0.9, 0.9]].map(([x, z], i): Part => ({ name: `leg_${i + 1}`, at: [x, 1, z], size: [0.2, 2, 0.2] }))
const deck: Part = { name: 'deck', at: [0, 2.1, 0], size: [2.2, 0.2, 2.2] }
const roof: Part = { name: 'roof', at: [0, 4, 0], size: [2.4, 3, 2.4], color: [0.5, 0.2, 0.15] }
/** A watchtower in five steps: legs; + deck; deck recoloured; + a tall roof; roof removed. */
export const TOWER_STEPS: Part[][] = [
  legs,
  [...legs, deck],
  [...legs, { ...deck, color: [0.3, 0.3, 0.35] }],
  [...legs, { ...deck, color: [0.3, 0.3, 0.35] }, roof],
  [...legs, { ...deck, color: [0.3, 0.3, 0.35] }]
]
