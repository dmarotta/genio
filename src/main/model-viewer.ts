/**
 * Inventory's sandboxed 3D viewer: genio-viewer://app serves the viewer frame (its page, chunks and
 * decoders) and genio-media://model/<token>/ serves one granted model with its side files. The frame's
 * CSP admits only those two hosts, so it reaches neither IPC nor genio-media://world nor the network;
 * a token covers one model's folder (and below), the model itself plus glTF side-file types, each under
 * the size cap, behind the same path guard as every other Inventory file.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { MODEL_PREVIEW_EXTS, MODEL_PREVIEW_MAX_BYTES, MODEL_SIDE_FILE_EXTS, VIEWER_DECODERS, VIEWER_SCHEME } from '@shared/model-viewer'
import { guardedWorldFile } from './inventory'
import { MEDIA_SCHEME } from './fal-service'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', wasm: 'application/wasm',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', ktx2: 'image/ktx2'
}
const MAX_GRANTS = 16
const MODELS = `${MEDIA_SCHEME}://model`

/**
 * The frame's own policy: wasm and blob workers for Draco/KTX2/meshopt, blob images for embedded
 * textures, granted models only, and no network. Dev adds the Vite client's inline preamble and socket.
 */
export function viewerCsp(dev: boolean): string {
  return [
    "default-src 'none'",
    `script-src ${VIEWER_SCHEME}://app 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}`,
    'worker-src blob:',
    `style-src ${VIEWER_SCHEME}://app 'unsafe-inline'`,
    `img-src ${MODELS} blob: data:`,
    `connect-src ${VIEWER_SCHEME}://app ${MODELS} blob: data:${dev ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

interface Grant { root: string; dir: string; name: string }
export interface ModelViewerFilesOptions {
  /** A project's folder by its Inventory world name. */
  projectRoot(world: string): string | undefined
  /** Built renderer (out/renderer): viewer3d.html and assets/ (its chunks and decoders). */
  rendererDir: string
  /** three's examples/jsm/libs: decoders for a viewer served by the dev server. */
  decoderLibs?: string
  /** Dev server origin (ELECTRON_RENDERER_URL); the viewer's page and modules are proxied there. */
  devUrl?: string
  fetch?: (url: string) => Promise<Response>
  maxBytes?: number
}

export type ModelViewerFiles = ReturnType<typeof modelViewerFiles>
let installed: ModelViewerFiles | undefined
/** The app's one instance, made when the schemes are registered (IPC grants through it). */
export function installModelViewer(opts: ModelViewerFilesOptions): ModelViewerFiles {
  installed = modelViewerFiles(opts)
  return installed
}
export function modelViewer(): ModelViewerFiles {
  if (!installed) throw new Error('The 3D viewer is not ready yet. Try again in a moment.')
  return installed
}

export function modelViewerFiles(opts: ModelViewerFilesOptions) {
  const grants = new Map<string, Grant>()
  const maxBytes = opts.maxBytes ?? MODEL_PREVIEW_MAX_BYTES
  const headers = (type: string, extra: Record<string, string> = {}): Record<string, string> => ({
    'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra
  })
  const fail = (status: number, text: string): Response => new Response(text, { status, headers: headers('text/plain') })
  const file = async (p: string, type: string, extra: Record<string, string> = {}): Promise<Response> => {
    const size = (await fsp.stat(p)).size
    return new Response(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, { status: 200, headers: headers(type, { 'Content-Length': String(size), ...extra }) })
  }
  const ext = (p: string): string => path.posix.extname(p).slice(1).toLowerCase()

  async function app(u: URL): Promise<Response> {
    const page = u.pathname === '/viewer3d.html'
    const decoder = /^\/decoders\/([\w.-]+)$/.exec(u.pathname)?.[1]
    if (decoder) {
      const source = VIEWER_DECODERS[decoder] && opts.decoderLibs && path.join(opts.decoderLibs, VIEWER_DECODERS[decoder])
      return source && fs.existsSync(source) ? file(source, TYPES[ext(decoder)]) : fail(404, 'not found')
    }
    if (opts.devUrl) {
      const upstream = await (opts.fetch ?? fetch)(new URL(u.pathname + u.search, opts.devUrl).href)
      const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
      return new Response(upstream.body, { status: upstream.status, headers: headers(type, page ? { 'Content-Security-Policy': viewerCsp(true) } : {}) })
    }
    if (!page && !/^\/assets\/[\w.-]+\.(?:js|css|wasm)$/.test(u.pathname)) return fail(404, 'not found')
    const p = path.join(opts.rendererDir, ...u.pathname.slice(1).split('/'))
    if (!fs.existsSync(p)) return fail(404, 'not found')
    return file(p, TYPES[ext(p)], page ? { 'Content-Security-Policy': viewerCsp(false) } : {})
  }

  /** HEAD tells the frame why a side file failed (GLTFLoader drops the status). */
  async function model(u: URL, head: boolean): Promise<Response> {
    const [, token = '', ...parts] = u.pathname.split('/')
    const grant = grants.get(token)
    if (!grant) return fail(404, 'not found')
    let rel: string
    try { rel = parts.map(decodeURIComponent).join('/') } catch { return fail(400, 'bad path') }
    const e = ext(rel)
    if (!rel || rel.includes('\\') || rel.split('/').some(s => !s || s === '.' || s === '..')) return fail(400, 'bad path')
    if (rel !== grant.name && !(MODEL_SIDE_FILE_EXTS as readonly string[]).includes(e)) return fail(403, 'not a model side file')
    const p = await guardedWorldFile(grant.root, grant.dir ? `${grant.dir}/${rel}` : rel)
    if (!p) return fail(404, 'not found')
    const size = (await fsp.stat(p)).size
    if (size > maxBytes) return fail(413, `${path.posix.basename(rel)} is ${size} bytes; the preview limit is ${maxBytes}`)
    const type = TYPES[e] ?? 'application/octet-stream'
    if (head) return new Response(null, { status: 200, headers: headers(type, { 'Content-Length': String(size) }) })
    return file(p, type, { 'Content-Security-Policy': "default-src 'none'; sandbox" })
  }

  return {
    /** A fresh capability URL for one model; older grants expire as new ones are made. */
    async grant(world: string, asset: string): Promise<string> {
      const root = opts.projectRoot(world)
      if (!root) throw new Error(`Project ${world} is not loaded.`)
      if (!(MODEL_PREVIEW_EXTS as readonly string[]).includes(ext(asset))) throw new Error('Only glTF and GLB files can be previewed.')
      if (!await guardedWorldFile(root, asset)) throw new Error('This asset is no longer available.')
      const token = randomBytes(16).toString('hex')
      const dir = path.posix.dirname(asset)
      const name = path.posix.basename(asset)
      grants.set(token, { root, dir: dir === '.' ? '' : dir, name })
      while (grants.size > MAX_GRANTS) grants.delete(grants.keys().next().value!)
      return `${MODELS}/${token}/${encodeURIComponent(name)}`
    },
    /** genio-viewer://app/... and genio-media://model/<token>/...; anything else is not found. */
    async handle(req: Request): Promise<Response> {
      try {
        const u = new URL(req.url)
        const models = u.protocol === `${MEDIA_SCHEME}:` && u.hostname === 'model'
        if (req.method !== 'GET' && !(req.method === 'HEAD' && models)) return fail(405, 'method not allowed')
        if (u.protocol === `${VIEWER_SCHEME}:` && u.hostname === 'app') return await app(u)
        if (models) return await model(u, req.method === 'HEAD')
        return fail(404, 'not found')
      } catch { return fail(404, 'not found') }
    }
  }
}
