import fs from 'node:fs'
import path from 'node:path'

/** Large meshes are generated at test time; no downloaded or committed large assets. */
export function writeLargeModels(dir: string, triangles = 200_000): { fbx: string; gltf: string; vertices: number } {
  fs.mkdirSync(dir, { recursive: true })
  const vertices = triangles * 3
  const positions = new Float32Array(vertices * 3)
  const indices: string[] = new Array(vertices)
  for (let i = 0; i < vertices; i++) {
    const corner = i % 3, triangle = Math.floor(i / 3)
    positions[i * 3] = triangle % 500 + (corner === 1 ? 1 : 0)
    positions[i * 3 + 1] = Math.floor(triangle / 500) + (corner === 2 ? 1 : 0)
    positions[i * 3 + 2] = triangle % 7
    indices[i] = String(corner === 2 ? -i - 1 : i)
  }
  const template = fs.readFileSync('tests/fixtures/models/crate_ascii.fbx', 'utf8')
  const fbx = path.join(dir, 'large.fbx'), gltf = path.join(dir, 'large.gltf')
  fs.writeFileSync(fbx, template
    .replace(/Vertices: \*24\s*\{\s*a: [^}]+\}/, `Vertices: *${positions.length} {\n\t\t\ta: ${positions.join(',')}\n\t\t}`)
    .replace(/PolygonVertexIndex: \*24\s*\{\s*a: [^}]+\}/, `PolygonVertexIndex: *${vertices} {\n\t\t\ta: ${indices.join(',')}\n\t\t}`))
  fs.writeFileSync(path.join(dir, 'large.bin'), new Uint8Array(positions.buffer))
  fs.writeFileSync(gltf, JSON.stringify({
    asset: { version: '2.0', generator: 'Genio generated performance fixture' },
    buffers: [{ uri: 'large.bin', byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min: [0, 0, 0], max: [500, Math.ceil(triangles / 500), 6] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
  }))
  return { fbx, gltf, vertices }
}
