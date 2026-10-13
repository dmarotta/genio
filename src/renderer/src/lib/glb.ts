/**
 * Minimal binary glTF (.glb) preview: parses triangle meshes (positions,
 * normals, UVs, vertex colours, base colour factor/texture) with node
 * transforms baked in, and draws them with WebGL2. No dependencies. Compressed
 * meshes (Draco, meshopt) and external buffers are reported as unsupported.
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
}

export interface GlbModel {
  prims: GlbPrim[]
  min: [number, number, number]
  max: [number, number, number]
  triangles: number
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

  const addMesh = async (meshIndex: number, m: Mat4): Promise<void> => {
    for (const p of json.meshes[meshIndex].primitives ?? []) {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue
      const pos = read(p.attributes.POSITION).data as Float32Array
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
    if (node.mesh !== undefined) await addMesh(node.mesh, m)
    for (const c of node.children ?? []) await visit(c, m, depth + 1)
  }

  const scene = json.scenes?.[json.scene ?? 0]
  if (scene?.nodes?.length) for (const n of scene.nodes) await visit(n, IDENTITY, 0)
  else for (let i = 0; i < (json.meshes?.length ?? 0); i++) await addMesh(i, IDENTITY)
  if (!prims.length) throw new Error('No triangle meshes to preview.')
  return { prims, min, max, triangles }
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

/** Draw the model into the canvas with drag-to-orbit and wheel zoom. Returns a disposer. */
export function startGlbRenderer(canvas: HTMLCanvasElement, model: GlbModel): () => void {
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
  const attr = (l: number, data: Float32Array | undefined, size: number, fallback: number[]): void => {
    if (l < 0) return
    if (!data) {
      gl.disableVertexAttribArray(l)
      gl.vertexAttrib4f(l, fallback[0], fallback[1], fallback[2], fallback[3])
      return
    }
    const b = gl.createBuffer()!
    buffers.push(b)
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(l)
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0)
  }
  const draws = model.prims.map((p) => {
    const vao = gl.createVertexArray()!
    vaos.push(vao)
    gl.bindVertexArray(vao)
    attr(loc.pos, p.positions, 3, [0, 0, 0, 1])
    attr(loc.nrm, p.normals, 3, [0, 1, 0, 0])
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
    return { vao, tex, p, count: p.indices ? p.indices.length : p.positions.length / 3 }
  })

  const center = [0, 1, 2].map((c) => (model.min[c] + model.max[c]) / 2)
  const radius = Math.max(1e-6, Math.hypot(model.max[0] - model.min[0], model.max[1] - model.min[1], model.max[2] - model.min[2]) / 2)
  let yaw = 0.6
  let pitch = -0.25
  let dist = radius * 2.6
  let auto = true
  let raf = 0

  const frame = (): void => {
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    if (auto) yaw += 0.006
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    gl.useProgram(prog)
    const rot = mul(rotX(pitch), rotY(yaw))
    const mvp = mul(perspective(0.8, w / h, radius * 0.01, radius * 100), mul(translate(0, 0, -dist), mul(rot, translate(-center[0], -center[1], -center[2]))))
    gl.uniformMatrix4fv(u.mvp, false, mvp)
    gl.uniformMatrix4fv(u.rot, false, rot)
    gl.uniform1i(u.tex, 0)
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
