/**
 * Inventory's sandboxed 3D viewer: genio-viewer://app serves the viewer frame (its page, chunks and
 * decoders) and genio-media://model/<token>/ serves one granted model with its side files. The frame's
 * CSP admits only those two hosts, so it reaches neither IPC nor genio-media://world nor the network;
 * a token covers the model's folder and side files, plus basename-matched images in the conventional
 * sibling Textures folder. Each file stays under the size cap and the Inventory real-path guard.
 * A Modeller unit gets one directory token instead (grantUnit): its worktree and its step data, so
 * the live view can scrub through steps without spending a grant per step.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { MODEL_PREVIEW_EXTS, MODEL_PREVIEW_MAX_BYTES, MODEL_SIDE_FILE_EXTS, VIEWER_DECODERS, VIEWER_SCHEME } from '@shared/model-viewer'
import { guardedWorldFile } from './inventory'
import { ignoredAssetPath } from './inventory-query'
import { MEDIA_SCHEME } from './fal-service'
import { modelPreviewPriority } from './model-preview-priority'

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', wasm: 'application/wasm',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream',
  fbx: 'application/octet-stream', obj: 'model/obj', mtl: 'model/mtl', stl: 'model/stl', ply: 'application/octet-stream',
  dae: 'model/vnd.collada+xml', bvh: 'text/plain; charset=utf-8', usda: 'model/vnd.usda', usd: 'application/octet-stream', '3ds': 'application/x-3ds',
  meta: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', ktx2: 'image/ktx2',
  tga: 'image/x-tga', bmp: 'image/bmp', gif: 'image/gif'
}
const TEXTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'ktx2', 'tga', 'bmp', 'gif'])
const MAX_GRANTS = 16
/** The same-name texture search below a model's folder stops after this many entries or levels. */
const FIND_ENTRIES = 5000
const FIND_DEPTH = 4
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

interface Grant { root: string; dir: string; name: string; interactive: boolean; textures?: Promise<Map<string, string>> }

/**
 * Texture files below a model's folder by lower-case name, nearest first. FBX, OBJ and Collada files
 * often store the artist's own disk path, which the frame reduces to the file name; Unity keeps such
 * textures in a Textures folder beside the model.
 */
async function texturesBelow(root: string, dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  // Only the conventional sibling Textures folder is added, never a project-wide basename search.
  const parent = path.posix.dirname(dir)
  const sibling = path.posix.join(parent === '.' ? '' : parent, 'Textures')
  const queue = [{ rel: dir, depth: 0 }, ...(sibling !== dir ? [{ rel: sibling, depth: 0 }] : [])]
  let seen = 0
  const deadline = performance.now() + 1000
  for (let i = 0; i < queue.length && seen < FIND_ENTRIES; i++) {
    if (performance.now() > deadline) break
    const { rel, depth } = queue[i]
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (++seen > FIND_ENTRIES) break
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isFile() && TEXTURE_EXTS.has(path.posix.extname(e.name).slice(1).toLowerCase()) && !found.has(e.name.toLowerCase())) found.set(e.name.toLowerCase(), child)
      else if (e.isDirectory() && !e.isSymbolicLink() && !ignoredAssetPath(child) && depth < FIND_DEPTH) queue.push({ rel: child, depth: depth + 1 })
    }
  }
  return found
}
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
  /** Live grants; older ones expire as new ones are made. */
  maxGrants?: number
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
  /** Directory grants by token, and each unit's token. */
  const unitGrants = new Map<string, { unit: string; roots: Record<string, string> }>()
  const unitTokens = new Map<string, string>()
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
  async function model(u: URL, head: boolean, reqRange: string | null): Promise<Response> {
    const [, token = '', ...parts] = u.pathname.split('/')
    const grant = grants.get(token), unit = unitGrants.get(token)
    if (!grant && !unit) return fail(404, 'not found')
    let rel: string
    try { rel = parts.map(decodeURIComponent).join('/') } catch { return fail(400, 'bad path') }
    const e = ext(rel)
    if (!rel || rel.includes('\\') || rel.split('/').some(s => !s || s === '.' || s === '..')) return fail(400, 'bad path')
    if (unit) {
      // <root key>/<path inside it>: models and their side files only, never scripts, notes or receipts.
      const [key, ...inside] = rel.split('/')
      const root = Object.hasOwn(unit.roots, key) ? unit.roots[key] : undefined
      if (!root || !inside.length) return fail(404, 'not found')
      if (![...MODEL_PREVIEW_EXTS, ...MODEL_SIDE_FILE_EXTS].includes(e as never)) return fail(403, 'not a model or side file')
      const p = await guardedWorldFile(root, inside.join('/'))
      return p ? send(p, rel, e, head, reqRange) : fail(404, 'not found')
    }
    if (!grant) return fail(404, 'not found')
    if (rel !== grant.name && rel !== `${grant.name}.meta` && !(MODEL_SIDE_FILE_EXTS as readonly string[]).includes(e)) return fail(403, 'not a model side file')
    const inFolder = (r: string): string => grant.dir ? `${grant.dir}/${r}` : r
    let p = await guardedWorldFile(grant.root, inFolder(rel))
    if (!p && TEXTURE_EXTS.has(e)) {
      grant.textures ??= texturesBelow(grant.root, grant.dir)
      // A slow filesystem must not keep the frame waiting indefinitely. The shared search is bounded too.
      let timer: ReturnType<typeof setTimeout> | undefined
      const index = await Promise.race([grant.textures, new Promise<Map<string, string>>(resolve => { timer = setTimeout(() => resolve(new Map()), 1200) })]).finally(() => clearTimeout(timer))
      const near = index.get(path.posix.basename(rel).toLowerCase())
      if (near) p = await guardedWorldFile(grant.root, near)
    }
    if (!p) return fail(404, 'not found')
    return send(p, rel, e, head, reqRange)
  }

  async function send(p: string, rel: string, e: string, head: boolean, reqRange: string | null): Promise<Response> {
    const size = (await fsp.stat(p)).size
    if (size > maxBytes) return fail(413, `${path.posix.basename(rel)} is ${size} bytes; the preview limit is ${maxBytes}`)
    const type = TYPES[e] ?? 'application/octet-stream'
    if (head) return new Response(null, { status: 200, headers: headers(type, { 'Content-Length': String(size) }) })
    const range = reqRange?.match(/^bytes=(\d*)-(\d*)$/)
    if (reqRange) {
      const start = range?.[1] ? Number(range[1]) : range?.[2] ? Math.max(0, size - Number(range[2])) : NaN
      const end = range?.[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return new Response(null, { status: 416, headers: headers(type, { 'Content-Range': `bytes */${size}` }) })
      return new Response(Readable.toWeb(fs.createReadStream(p, { start, end })) as ReadableStream, { status: 206, headers: headers(type, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }) })
    }
    return file(p, type, { 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; sandbox" })
  }

  return {
    /** A fresh capability URL for one model; older grants expire as new ones are made. */
    async grant(world: string, asset: string, interactive = false): Promise<string> {
      const root = opts.projectRoot(world)
      if (!root) throw new Error(`Project ${world} is not loaded.`)
      if (!(MODEL_PREVIEW_EXTS as readonly string[]).includes(ext(asset))) throw new Error(`Genio's 3D viewer cannot read .${ext(asset)} files.`)
      if (!await guardedWorldFile(root, asset)) throw new Error('This asset is no longer available.')
      const token = randomBytes(16).toString('hex')
      const dir = path.posix.dirname(asset)
      const name = path.posix.basename(asset)
      grants.set(token, { root, dir: dir === '.' ? '' : dir, name, interactive })
      const sameKind = [...grants].filter(([, g]) => g.interactive === interactive)
      while (sameKind.length > (opts.maxGrants ?? MAX_GRANTS)) {
        const [old] = sameKind.shift()!
        grants.delete(old); modelPreviewPriority.finish(old)
      }
      if (interactive) modelPreviewPriority.begin(token)
      return `${MODELS}/${token}/${encodeURIComponent(name)}`
    },
    /**
     * One directory grant per unit, as a base URL (genio-media://model/<token>/): <key>/<path> reads a
     * model or side file below roots[key]. The same unit and roots keep their token; the oldest units' expire.
     */
    grantUnit(unit: string, roots: Record<string, string>): string {
      const had = unitTokens.get(unit)
      const same = had && JSON.stringify(unitGrants.get(had)?.roots) === JSON.stringify(roots)
      if (had && same) {
        // Most recently used last, so an open live view never expires first.
        const g = unitGrants.get(had)!
        unitGrants.delete(had); unitGrants.set(had, g)
        return `${MODELS}/${had}/`
      }
      if (had) unitGrants.delete(had)
      const token = randomBytes(16).toString('hex')
      unitGrants.set(token, { unit, roots: { ...roots } })
      unitTokens.set(unit, token)
      while (unitGrants.size > (opts.maxGrants ?? MAX_GRANTS)) {
        const [old, g] = unitGrants.entries().next().value!
        unitGrants.delete(old); unitTokens.delete(g.unit)
      }
      return `${MODELS}/${token}/`
    },
    /** Ends a grant at once (a drawn thumbnail), so short-lived grants never expire the inspector's. */
    revoke(url: string, completeOnly = false): void {
      if (!url.startsWith(`${MODELS}/`)) return
      const token = url.slice(MODELS.length + 1).split('/')[0]
      const unit = unitGrants.get(token)
      if (unit) { if (!completeOnly) { unitGrants.delete(token); unitTokens.delete(unit.unit) } return }
      modelPreviewPriority.finish(token)
      if (!completeOnly) grants.delete(token)
    },
    /** genio-viewer://app/... and genio-media://model/<token>/...; anything else is not found. */
    async handle(req: Request): Promise<Response> {
      try {
        const u = new URL(req.url)
        const models = u.protocol === `${MEDIA_SCHEME}:` && u.hostname === 'model'
        if (req.method !== 'GET' && !(req.method === 'HEAD' && models)) return fail(405, 'method not allowed')
        if (u.protocol === `${VIEWER_SCHEME}:` && u.hostname === 'app') return await app(u)
        if (models) return await model(u, req.method === 'HEAD', req.headers.get('range'))
        return fail(404, 'not found')
      } catch { return fail(404, 'not found') }
    }
  }
}
