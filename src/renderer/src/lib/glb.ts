/**
 * Minimal binary glTF (.glb) preview: parses triangle meshes (positions,
 * normals, UVs, vertex colours, base colour factor/texture) with node
 * transforms baked in, and draws them with WebGL2. No dependencies. Compressed
 * meshes (Draco, meshopt) and external buffers are reported as unsupported.
 *
 * Animated files (glTF animations, optionally on a skin) keep their rig: each
 * frame samples the clip (STEP / LINEAR / CUBICSPLINE), rebuilds the node
 * matrices and skins the meshes on the CPU (a preview-sized mesh skins in a
 * millisecond or two, and it keeps the shader and the math testable). A file
 * with animation but no mesh (a motion-only export) is drawn as its skeleton.
 */

type Mat4 = number[]

export interface GlbPrim {
  positions: Float32Array
  normals: Float32Array
  uvs?: Float32Array
  colors?: Float32Array
  indices?: Uint32Array
  color: [number, number, number, number]
  image?: ImageBitmap
  /** animated files: the mesh-local data posing starts from */
  rest?: { node: number; skin?: number; positions: Float32Array; normals: Float32Array; joints?: Float32Array; weights?: Float32Array }
  /** the skeleton drawn for files without a mesh (rebuilt every frame) */
  bones?: [number, number][]
}

export interface GlbNode {
  parent: number
  t: number[]
  r: number[]
  s: number[]
  /** a node given as a matrix (glTF forbids animating those) */
  matrix?: Mat4
  name?: string
}

export interface GlbChannel {
  node: number
  path: 'translation' | 'rotation' | 'scale'
  interp: 'STEP' | 'LINEAR' | 'CUBICSPLINE'
  times: Float32Array
  values: Float32Array
}

export interface GlbClip {
  name: string
  duration: number
  channels: GlbChannel[]
}

export interface GlbRig {
  nodes: GlbNode[]
  /** per skin: joint node indices and inverse bind matrices (16 floats per joint) */
  skins: { joints: number[]; ibm: Float32Array }[]
  clips: GlbClip[]
  /** the node the camera follows (the skeleton's root joint) */
  root: number
}

export interface GlbModel {
  prims: GlbPrim[]
  min: [number, number, number]
  max: [number, number, number]
  triangles: number
  rig?: GlbRig
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const CSIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const UNSUPPORTED = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression']

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}

function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ]
}

function base64Bytes(uri: string): Uint8Array {
  const b64 = uri.slice(uri.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function parseGlb(buf: ArrayBuffer): Promise<GlbModel> {
  const dv = new DataView(buf)
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a binary glTF (.glb) file.')
  let json: Json
  let bin: Uint8Array | undefined
  for (let off = 12; off + 8 <= buf.byteLength; ) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const data = new Uint8Array(buf, off + 8, Math.min(len, buf.byteLength - off - 8))
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data))
    else if (type === 0x004e4942) bin = data
    off += 8 + len
  }
  if (!json) throw new Error('The .glb has no JSON chunk.')
  const blocked = ((json.extensionsRequired ?? []) as string[]).filter((e) => UNSUPPORTED.includes(e))
  if (blocked.length) throw new Error(`Compressed mesh (${blocked.join(', ')}): preview not supported.`)

  const view = (i: number): Uint8Array => {
    const bv = json.bufferViews[i]
    if ((bv.buffer ?? 0) !== 0 || !bin) throw new Error('External buffers are not supported.')
    return new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength)
  }

  const read = (i: number, asIndex = false): { data: Float32Array | Uint32Array; n: number } => {
    const a = json.accessors[i]
    const n = NCOMP[a.type] ?? 1
    const out = asIndex ? new Uint32Array(a.count * n) : new Float32Array(a.count * n)
    if (a.bufferView === undefined) return { data: out, n }
    const bv = json.bufferViews[a.bufferView]
    const bytes = view(a.bufferView)
    const size = CSIZE[a.componentType]
    if (!size) throw new Error(`Unsupported component type ${a.componentType}.`)
    const stride = bv.byteStride || size * n
    const d = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0))
    const norm = Boolean(a.normalized)
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < n; c++) {
        const p = k * stride + c * size
        let v: number
        switch (a.componentType) {
          case 5126: v = d.getFloat32(p, true); break
          case 5125: v = d.getUint32(p, true); break
          case 5123: v = d.getUint16(p, true); if (norm) v /= 65535; break
          case 5122: v = d.getInt16(p, true); if (norm) v = Math.max(v / 32767, -1); break
          case 5121: v = d.getUint8(p); if (norm) v /= 255; break
          default: v = d.getInt8(p); if (norm) v = Math.max(v / 127, -1)
        }
        out[k * n + c] = v
      }
    }
    return { data: out, n }
  }

  const images = new Map<number, Promise<ImageBitmap | undefined>>()
  const image = (texIndex: number | undefined): Promise<ImageBitmap | undefined> => {
    const src = texIndex === undefined ? undefined : json.textures?.[texIndex]?.source
    if (src === undefined) return Promise.resolve(undefined)
    if (!images.has(src)) {
      const img = json.images[src]
      const bytes = img.bufferView !== undefined ? view(img.bufferView) : typeof img.uri === 'string' && img.uri.startsWith('data:') ? base64Bytes(img.uri) : undefined
      images.set(
        src,
        bytes ? createImageBitmap(new Blob([bytes.slice()], { type: img.mimeType ?? 'image/png' })).catch(() => undefined) : Promise.resolve(undefined)
      )
    }
    return images.get(src)!
  }

  const prims: GlbPrim[] = []
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let triangles = 0
  const rig = readRig(json, read)

  const addMesh = async (meshIndex: number, m: Mat4, nodeIndex = -1): Promise<void> => {
    for (const p of json.meshes[meshIndex].primitives ?? []) {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue
      const pos = read(p.attributes.POSITION).data as Float32Array
      if (rig && nodeIndex >= 0) {
        // animated: keep the mesh-local data; poseModel() places it every frame
        const skin = json.nodes[nodeIndex].skin as number | undefined
        const skinned = skin !== undefined && p.attributes.JOINTS_0 !== undefined && p.attributes.WEIGHTS_0 !== undefined
        const idx = p.indices !== undefined ? (read(p.indices, true).data as Uint32Array) : undefined
        const rest = {
          node: nodeIndex,
          skin: skinned ? skin : undefined,
          positions: pos,
          normals: p.attributes.NORMAL !== undefined ? (read(p.attributes.NORMAL).data as Float32Array) : computeNormals(pos, idx),
          joints: skinned ? (read(p.attributes.JOINTS_0).data as Float32Array) : undefined,
          weights: skinned ? (read(p.attributes.WEIGHTS_0).data as Float32Array) : undefined
        }
        const uvs = p.attributes.TEXCOORD_0 !== undefined ? (read(p.attributes.TEXCOORD_0).data as Float32Array) : undefined
        const pbr = p.material !== undefined ? json.materials?.[p.material]?.pbrMetallicRoughness : undefined
        prims.push({
          positions: new Float32Array(pos.length),
          normals: new Float32Array(pos.length),
          uvs,
          indices: idx,
          color: (pbr?.baseColorFactor ?? [0.82, 0.86, 0.92, 1]) as [number, number, number, number],
          image: uvs ? await image(pbr?.baseColorTexture?.index) : undefined,
          rest
        })
        triangles += (idx ? idx.length : pos.length / 3) / 3
        continue
      }
      const count = pos.length / 3
      const positions = new Float32Array(pos.length)
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
        for (let c = 0; c < 3; c++) {
          const v = m[c] * x + m[4 + c] * y + m[8 + c] * z + m[12 + c]
          positions[i * 3 + c] = v
          if (v < min[c]) min[c] = v
          if (v > max[c]) max[c] = v
        }
      }
      const indices = p.indices !== undefined ? (read(p.indices, true).data as Uint32Array) : undefined
      let normals: Float32Array
      if (p.attributes.NORMAL !== undefined) {
        const nr = read(p.attributes.NORMAL).data as Float32Array
        normals = new Float32Array(nr.length)
        for (let i = 0; i < count; i++) {
          const x = nr[i * 3], y = nr[i * 3 + 1], z = nr[i * 3 + 2]
          const v = [0, 1, 2].map((c) => m[c] * x + m[4 + c] * y + m[8 + c] * z)
          const l = Math.hypot(v[0], v[1], v[2]) || 1
          normals.set([v[0] / l, v[1] / l, v[2] / l], i * 3)
        }
      } else normals = computeNormals(positions, indices)
      const uvs = p.attributes.TEXCOORD_0 !== undefined ? (read(p.attributes.TEXCOORD_0).data as Float32Array) : undefined
      let colors: Float32Array | undefined
      if (p.attributes.COLOR_0 !== undefined) {
        const r = read(p.attributes.COLOR_0)
        colors = new Float32Array(count * 4)
        for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) colors[i * 4 + c] = c < r.n ? r.data[i * r.n + c] : 1
      }
      const pbr = p.material !== undefined ? json.materials?.[p.material]?.pbrMetallicRoughness : undefined
      const color = (pbr?.baseColorFactor ?? [0.82, 0.86, 0.92, 1]) as [number, number, number, number]
      const img = uvs ? await image(pbr?.baseColorTexture?.index) : undefined
      prims.push({ positions, normals, uvs, colors, indices, color, image: img })
      triangles += (indices ? indices.length : count) / 3
    }
  }

  const visit = async (nodeIndex: number, parent: Mat4, depth: number): Promise<void> => {
    if (depth > 64) return
    const node = json.nodes[nodeIndex]
    const local: Mat4 = node.matrix ?? trs(node.translation, node.rotation, node.scale)
    const m = mul(parent, local)
    if (node.mesh !== undefined) await addMesh(node.mesh, m, nodeIndex)
    for (const c of node.children ?? []) await visit(c, m, depth + 1)
  }

  const scene = json.scenes?.[json.scene ?? 0]
  if (scene?.nodes?.length) for (const n of scene.nodes) await visit(n, IDENTITY, 0)
  else for (let i = 0; i < (json.meshes?.length ?? 0); i++) await addMesh(i, IDENTITY)
  if (rig) {
    if (!prims.length) {
      const bones = bonePairs(rig)
      if (!bones.length) throw new Error('No triangle meshes or skeleton to preview.')
      prims.push({ positions: new Float32Array(bones.length * 72), normals: new Float32Array(bones.length * 72), color: [0.35, 0.9, 1, 1], bones })
      triangles = bones.length * 8
    }
    const model: GlbModel = { prims, min, max, triangles, rig }
    poseModel(model, 0, 0)
    for (const p of prims) {
      for (let i = 0; i < p.positions.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = p.positions[i + c]
          if (v < min[c]) min[c] = v
          if (v > max[c]) max[c] = v
        }
      }
    }
    return model
  }
  if (!prims.length) throw new Error('No triangle meshes to preview.')
  return { prims, min, max, triangles }
}

// ---------------------------------------------------------------- animation

type Reader = (i: number, asIndex?: boolean) => { data: Float32Array | Uint32Array; n: number }

/** Nodes, skins and clips of an animated file; undefined when it has no animation. */
function readRig(json: Json, read: Reader): GlbRig | undefined {
  const anims = (json.animations ?? []) as Json[]
  if (!anims.length || !json.nodes?.length) return undefined
  const nodes: GlbNode[] = (json.nodes as Json[]).map((n) => ({
    parent: -1,
    t: n.translation ?? [0, 0, 0],
    r: n.rotation ?? [0, 0, 0, 1],
    s: n.scale ?? [1, 1, 1],
    matrix: n.matrix,
    name: n.name
  }))
  ;(json.nodes as Json[]).forEach((n, i) => {
    for (const c of n.children ?? []) if (nodes[c]) nodes[c].parent = i
  })
  const skins = ((json.skins ?? []) as Json[]).map((s) => {
    const joints = (s.joints ?? []) as number[]
    const ibm = new Float32Array(joints.length * 16)
    if (s.inverseBindMatrices !== undefined) ibm.set((read(s.inverseBindMatrices).data as Float32Array).subarray(0, ibm.length))
    else for (let j = 0; j < joints.length; j++) ibm.set(IDENTITY, j * 16)
    return { joints, ibm }
  })
  const clips: GlbClip[] = anims.map((a, i) => {
    const channels: GlbChannel[] = []
    let duration = 0
    for (const ch of a.channels ?? []) {
      const path = ch.target?.path
      const sampler = a.samplers?.[ch.sampler]
      if (ch.target?.node === undefined || !sampler || !['translation', 'rotation', 'scale'].includes(path)) continue
      const times = read(sampler.input).data as Float32Array
      if (!times.length) continue
      duration = Math.max(duration, times[times.length - 1])
      channels.push({ node: ch.target.node, path, interp: sampler.interpolation ?? 'LINEAR', times, values: read(sampler.output).data as Float32Array })
    }
    return { name: a.name || `clip ${i + 1}`, duration, channels }
  })
  // follow the skeleton's root joint, else the first animated node
  const joints = new Set(skins.flatMap((s) => s.joints))
  const root = skins[0]?.joints.find((j) => !joints.has(nodes[j]?.parent)) ?? clips[0]?.channels[0]?.node ?? 0
  return { nodes, skins, clips, root }
}

function slerp(out: number[], a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, s: number): void {
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3]
  let dot = a[ai] * bx + a[ai + 1] * by + a[ai + 2] * bz + a[ai + 3] * bw
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let k0 = 1 - s
  let k1 = s
  if (dot < 0.9995) {
    const th = Math.acos(Math.min(1, dot))
    const sin = Math.sin(th)
    k0 = Math.sin((1 - s) * th) / sin
    k1 = Math.sin(s * th) / sin
  }
  out[0] = k0 * a[ai] + k1 * bx
  out[1] = k0 * a[ai + 1] + k1 * by
  out[2] = k0 * a[ai + 2] + k1 * bz
  out[3] = k0 * a[ai + 3] + k1 * bw
}

/** The channel's value at time t (clamped to its keys). */
export function sampleChannel(ch: GlbChannel, t: number): number[] {
  const n = ch.path === 'rotation' ? 4 : 3
  const T = ch.times
  const last = T.length - 1
  const cubic = ch.interp === 'CUBICSPLINE'
  // CUBICSPLINE stores [in-tangent, value, out-tangent] per key
  const at = (k: number, part = 1): number => (cubic ? (k * 3 + part) * n : k * n)
  const out = new Array<number>(n)
  if (t <= T[0] || last === 0) {
    for (let c = 0; c < n; c++) out[c] = ch.values[at(0) + c]
    return out
  }
  if (t >= T[last]) {
    for (let c = 0; c < n; c++) out[c] = ch.values[at(last) + c]
    return out
  }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (T[mid] <= t) lo = mid
    else hi = mid
  }
  const dt = T[hi] - T[lo]
  const s = dt > 0 ? (t - T[lo]) / dt : 0
  const v = ch.values
  if (ch.interp === 'STEP') for (let c = 0; c < n; c++) out[c] = v[at(lo) + c]
  else if (cubic) {
    const s2 = s * s
    const s3 = s2 * s
    for (let c = 0; c < n; c++) {
      out[c] = (2 * s3 - 3 * s2 + 1) * v[at(lo) + c] + (s3 - 2 * s2 + s) * dt * v[at(lo, 2) + c] + (-2 * s3 + 3 * s2) * v[at(hi) + c] + (s3 - s2) * dt * v[at(hi, 0) + c]
    }
  } else if (n === 4) slerp(out, v, lo * 4, v, hi * 4, s)
  else for (let c = 0; c < n; c++) out[c] = v[lo * n + c] + (v[hi * n + c] - v[lo * n + c]) * s
  if (n === 4) {
    const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1
    for (let c = 0; c < 4; c++) out[c] /= l
  }
  return out
}

/** World matrix of every node at time t of a clip (no clip: the rest pose). */
export function nodeMatrices(rig: GlbRig, clipIndex: number, t: number): Mat4[] {
  const pose = rig.nodes.map((n) => ({ t: n.t, r: n.r, s: n.s, animated: false }))
  const clip = rig.clips[clipIndex]
  for (const ch of clip?.channels ?? []) {
    const p = pose[ch.node]
    if (!p) continue
    p[ch.path === 'translation' ? 't' : ch.path === 'rotation' ? 'r' : 's'] = sampleChannel(ch, t)
    p.animated = true
  }
  const world: (Mat4 | undefined)[] = new Array(rig.nodes.length)
  const resolve = (i: number, depth: number): Mat4 => {
    const done = world[i]
    if (done) return done
    const n = rig.nodes[i]
    const p = pose[i]
    const local = n.matrix && !p.animated ? n.matrix : trs(p.t, p.r, p.s)
    const m = n.parent >= 0 && depth < 128 ? mul(resolve(n.parent, depth + 1), local) : local
    world[i] = m
    return m
  }
  return rig.nodes.map((_, i) => resolve(i, 0))
}

/** Joint pairs drawn as bones when the file has no mesh. */
function bonePairs(rig: GlbRig): [number, number][] {
  const set = rig.skins.length ? new Set(rig.skins.flatMap((s) => s.joints)) : undefined
  const out: [number, number][] = []
  rig.nodes.forEach((n, i) => {
    if (n.parent < 0) return
    if (set && !(set.has(i) && set.has(n.parent))) return
    out.push([n.parent, i])
  })
  return out
}

/** Pose every primitive at time t of a clip: positions and normals are rewritten in place. */
export function poseModel(model: GlbModel, clipIndex: number, t: number): Mat4[] {
  const rig = model.rig
  if (!rig) return []
  const world = nodeMatrices(rig, clipIndex, t)
  const jointMats = rig.skins.map((s) => {
    const out = new Float32Array(s.joints.length * 16)
    s.joints.forEach((j, k) => out.set(mul(world[j] ?? IDENTITY, Array.from(s.ibm.subarray(k * 16, k * 16 + 16))), k * 16))
    return out
  })
  for (const p of model.prims) {
    if (p.bones) {
      boneMesh(p, world, model)
      continue
    }
    const r = p.rest
    if (!r) continue
    const count = r.positions.length / 3
    const J = r.skin !== undefined ? jointMats[r.skin] : undefined
    const M = new Float32Array(16)
    const node = world[r.node] ?? IDENTITY
    for (let v = 0; v < count; v++) {
      if (J && r.joints && r.weights) {
        M.fill(0)
        let sum = 0
        for (let k = 0; k < 4; k++) {
          const w = r.weights[v * 4 + k]
          if (!w) continue
          sum += w
          const o = r.joints[v * 4 + k] * 16
          for (let e = 0; e < 16; e++) M[e] += w * J[o + e]
        }
        if (sum === 0) M.set(node)
      } else M.set(node)
      const x = r.positions[v * 3], y = r.positions[v * 3 + 1], z = r.positions[v * 3 + 2]
      p.positions[v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12]
      p.positions[v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]
      p.positions[v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
      const nx = r.normals[v * 3], ny = r.normals[v * 3 + 1], nz = r.normals[v * 3 + 2]
      const ox = M[0] * nx + M[4] * ny + M[8] * nz
      const oy = M[1] * nx + M[5] * ny + M[9] * nz
      const oz = M[2] * nx + M[6] * ny + M[10] * nz
      const l = Math.hypot(ox, oy, oz) || 1
      p.normals[v * 3] = ox / l
      p.normals[v * 3 + 1] = oy / l
      p.normals[v * 3 + 2] = oz / l
    }
  }
  return world
}

/** Rebuild the skeleton prim: one flat-shaded octahedron per bone (24 vertices). */
function boneMesh(p: GlbPrim, world: Mat4[], model: GlbModel): void {
  const size = Math.max(1e-3, Math.hypot(model.max[0] - model.min[0], model.max[1] - model.min[1], model.max[2] - model.min[2]))
  const pos = (i: number): number[] => [world[i][12], world[i][13], world[i][14]]
  let o = 0
  const put = (a: number[], b: number[], c: number[]): void => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    for (const q of [a, b, c]) {
      p.positions.set(q, o)
      p.normals.set([nx, ny, nz], o)
      o += 3
    }
  }
  for (const [pa, ch] of p.bones!) {
    const a = pos(pa)
    const b = pos(ch)
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    // bone width: a share of its length, capped by the figure's size (sizes are unknown until posed once)
    const w = Number.isFinite(size) && size > 1e-3 && size < 1e6 ? Math.min(len * 0.12, size * 0.02) : len * 0.12
    const dn = len > 0 ? d.map((x) => x / len) : [0, 1, 0]
    const ref = Math.abs(dn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    let u = [dn[1] * ref[2] - dn[2] * ref[1], dn[2] * ref[0] - dn[0] * ref[2], dn[0] * ref[1] - dn[1] * ref[0]]
    const ul = Math.hypot(u[0], u[1], u[2]) || 1
    u = u.map((x) => (x / ul) * w)
    const v = [dn[1] * u[2] - dn[2] * u[1], dn[2] * u[0] - dn[0] * u[2], dn[0] * u[1] - dn[1] * u[0]]
    const m = [a[0] + d[0] * 0.2, a[1] + d[1] * 0.2, a[2] + d[2] * 0.2]
    const P = (s: number, q: number[]): number[] => [m[0] + s * q[0], m[1] + s * q[1], m[2] + s * q[2]]
    const pu = P(1, u), nu = P(-1, u), pv = P(1, v), nv = P(-1, v)
    put(a, pu, pv)
    put(a, pv, nu)
    put(a, nu, nv)
    put(a, nv, pu)
    put(b, pv, pu)
    put(b, nu, pv)
    put(b, nv, nu)
    put(b, pu, nv)
  }
}

function computeNormals(pos: Float32Array, idx?: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length)
  const tri = idx ? idx.length / 3 : pos.length / 9
  for (let t = 0; t < tri; t++) {
    const [a, b, c] = idx ? [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2]
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2]
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    for (const v of [a, b, c]) {
      n[v * 3] += fx
      n[v * 3 + 1] += fy
      n[v * 3 + 2] += fz
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l
    n[i + 1] /= l
    n[i + 2] /= l
  }
  return n
}

// ---------------------------------------------------------------- render

const VS = `#version 300 es
in vec3 aPos; in vec3 aNrm; in vec2 aUv; in vec4 aCol;
uniform mat4 uMvp; uniform mat4 uRot;
out vec3 vN; out vec2 vUv; out vec4 vCol;
void main() { vN = mat3(uRot) * aNrm; vUv = aUv; vCol = aCol; gl_Position = uMvp * vec4(aPos, 1.0); }`

const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUv; in vec4 vCol;
uniform vec4 uColor; uniform sampler2D uTex; uniform bool uHasTex;
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float d = 0.32 + 0.72 * max(dot(n, normalize(vec3(0.5, 0.8, 0.6))), 0.0) + 0.25 * max(dot(n, normalize(vec3(-0.6, 0.1, -0.7))), 0.0);
  vec4 base = uColor * vCol;
  if (uHasTex) base *= texture(uTex, vUv);
  o = vec4(base.rgb * d, 1.0);
}`

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]
}

const rotX = (a: number): Mat4 => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]
const rotY = (a: number): Mat4 => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]
const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]

/** Playback state of an animated model; the caller changes it, the renderer advances `time`. */
export interface GlbPlayback {
  playing: boolean
  /** seconds into the clip */
  time: number
  speed: number
  clip: number
  /** keep the camera on the skeleton's root (else the camera stays and the figure travels) */
  follow: boolean
}

/** Lines of a square ground grid at height y around (cx, cz). */
function gridLines(cx: number, y: number, cz: number, half: number, n = 20): Float32Array {
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const k = -half + (2 * half * i) / n
    out.push(cx + k, y, cz - half, cx + k, y, cz + half, cx - half, y, cz + k, cx + half, y, cz + k)
  }
  return new Float32Array(out)
}

/** Draw the model into the canvas with drag-to-orbit and wheel zoom; animated models play `playback`. Returns a disposer. */
export function startGlbRenderer(canvas: HTMLCanvasElement, model: GlbModel, playback?: GlbPlayback): () => void {
  const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false })
  if (!gl) throw new Error('WebGL2 is not available.')
  const shader = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
  const loc = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), uv: gl.getAttribLocation(prog, 'aUv'), col: gl.getAttribLocation(prog, 'aCol') }
  const uni = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, n)
  const u = { mvp: uni('uMvp'), rot: uni('uRot'), color: uni('uColor'), tex: uni('uTex'), hasTex: uni('uHasTex') }

  const buffers: WebGLBuffer[] = []
  const textures: WebGLTexture[] = []
  const vaos: WebGLVertexArrayObject[] = []
  const anim = model.rig && model.rig.clips.length && playback ? model.rig : undefined
  const attr = (l: number, data: Float32Array | undefined, size: number, fallback: number[], dynamic = false): WebGLBuffer | undefined => {
    if (l < 0) return undefined
    if (!data) {
      gl.disableVertexAttribArray(l)
      gl.vertexAttrib4f(l, fallback[0], fallback[1], fallback[2], fallback[3])
      return undefined
    }
    const b = gl.createBuffer()!
    buffers.push(b)
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW)
    gl.enableVertexAttribArray(l)
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0)
    return b
  }
  const draws = model.prims.map((p) => {
    const vao = gl.createVertexArray()!
    vaos.push(vao)
    gl.bindVertexArray(vao)
    const posBuf = attr(loc.pos, p.positions, 3, [0, 0, 0, 1], !!anim)
    const nrmBuf = attr(loc.nrm, p.normals, 3, [0, 1, 0, 0], !!anim)
    attr(loc.uv, p.uvs, 2, [0, 0, 0, 0])
    attr(loc.col, p.colors, 4, [1, 1, 1, 1])
    if (p.indices) {
      const b = gl.createBuffer()!
      buffers.push(b)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.indices, gl.STATIC_DRAW)
    }
    gl.bindVertexArray(null)
    let tex: WebGLTexture | undefined
    if (p.image) {
      tex = gl.createTexture()!
      textures.push(tex)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.image)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
    return { vao, tex, p, posBuf, nrmBuf, count: p.indices ? p.indices.length : p.positions.length / 3 }
  })

  const center = [0, 1, 2].map((c) => (model.min[c] + model.max[c]) / 2)
  const radius = Math.max(1e-6, Math.hypot(model.max[0] - model.min[0], model.max[1] - model.min[1], model.max[2] - model.min[2]) / 2)
  let yaw = anim ? 0.5 : 0.6
  let pitch = -0.25
  let dist = radius * 2.6
  // an animation is easier to read from a steady camera
  let auto = !anim
  let raf = 0

  // animated: a ground grid at the rest pose's feet shows travel and foot contact
  let grid: { vao: WebGLVertexArrayObject; count: number } | undefined
  let rootAt0: number[] | undefined
  if (anim) {
    const vao = gl.createVertexArray()!
    vaos.push(vao)
    gl.bindVertexArray(vao)
    const lines = gridLines(center[0], model.min[1], center[2], radius * 4)
    attr(loc.pos, lines, 3, [0, 0, 0, 1])
    attr(loc.nrm, undefined, 3, [0, 1, 0, 0])
    attr(loc.uv, undefined, 2, [0, 0, 0, 0])
    attr(loc.col, undefined, 4, [1, 1, 1, 1])
    gl.bindVertexArray(null)
    grid = { vao, count: lines.length / 3 }
    const w0 = nodeMatrices(anim, playback!.clip, 0)[anim.root]
    rootAt0 = w0 ? [w0[12], w0[13], w0[14]] : undefined
  }
  let last = performance.now()
  let posed: { time: number; clip: number; world: Mat4[] } | undefined

  const frame = (): void => {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    if (auto) yaw += 0.006
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    let target = center
    if (anim && playback) {
      const clip = anim.clips[playback.clip] ?? anim.clips[0]
      const dur = clip.duration || 0
      if (playback.playing && dur > 0) playback.time = (playback.time + dt * playback.speed) % dur
      playback.time = Math.min(Math.max(0, playback.time), dur)
      const ci = anim.clips.indexOf(clip)
      const fresh = posed?.time !== playback.time || posed.clip !== ci
      const world = fresh ? poseModel(model, ci, playback.time) : posed!.world
      posed = { time: playback.time, clip: ci, world }
      for (const d of fresh ? draws : []) {
        if (d.posBuf) {
          gl.bindBuffer(gl.ARRAY_BUFFER, d.posBuf)
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.p.positions)
        }
        if (d.nrmBuf) {
          gl.bindBuffer(gl.ARRAY_BUFFER, d.nrmBuf)
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.p.normals)
        }
      }
      const r = world[anim.root]
      if (playback.follow && r && rootAt0) target = [center[0] + r[12] - rootAt0[0], center[1], center[2] + r[14] - rootAt0[2]]
    }
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.useProgram(prog)
    const rot = mul(rotX(pitch), rotY(yaw))
    const mvp = mul(perspective(0.8, w / h, radius * 0.01, radius * 100), mul(translate(0, 0, -dist), mul(rot, translate(-target[0], -target[1], -target[2]))))
    gl.uniformMatrix4fv(u.mvp, false, mvp)
    gl.uniformMatrix4fv(u.rot, false, rot)
    gl.uniform1i(u.tex, 0)
    if (grid) {
      gl.uniform4fv(u.color, [0.22, 0.3, 0.36, 1])
      gl.uniform1i(u.hasTex, 0)
      gl.bindVertexArray(grid.vao)
      gl.drawArrays(gl.LINES, 0, grid.count)
    }
    for (const d of draws) {
      gl.uniform4fv(u.color, d.p.color)
      gl.uniform1i(u.hasTex, d.tex ? 1 : 0)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, d.tex ?? null)
      gl.bindVertexArray(d.vao)
      if (d.p.indices) gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0)
      else gl.drawArrays(gl.TRIANGLES, 0, d.count)
    }
    gl.bindVertexArray(null)
    raf = requestAnimationFrame(frame)
  }

  let drag: { x: number; y: number } | null = null
  const down = (e: PointerEvent): void => {
    auto = false
    drag = { x: e.clientX, y: e.clientY }
    canvas.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent): void => {
    if (!drag) return
    yaw += (e.clientX - drag.x) * 0.01
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.01))
    drag = { x: e.clientX, y: e.clientY }
  }
  const up = (): void => {
    drag = null
  }
  const wheel = (e: WheelEvent): void => {
    e.preventDefault()
    auto = false
    dist = Math.max(radius * 0.3, Math.min(radius * 20, dist * Math.exp(e.deltaY * 0.001)))
  }
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  canvas.addEventListener('wheel', wheel, { passive: false })
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    canvas.removeEventListener('pointerdown', down)
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', up)
    canvas.removeEventListener('pointercancel', up)
    canvas.removeEventListener('wheel', wheel)
    for (const b of buffers) gl.deleteBuffer(b)
    for (const t of textures) gl.deleteTexture(t)
    for (const v of vaos) gl.deleteVertexArray(v)
    gl.deleteProgram(prog)
    for (const p of model.prims) p.image?.close()
  }
}
