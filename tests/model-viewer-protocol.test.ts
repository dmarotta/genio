import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modelViewerFiles, viewerCsp } from '../src/main/model-viewer'

let root: string, world: string, renderer: string, libs: string
const write = (rel: string, data: string | Buffer = 'x'): void => { fs.mkdirSync(path.dirname(path.join(world, rel)), { recursive: true }); fs.writeFileSync(path.join(world, rel), data) }
const get = (files: ReturnType<typeof modelViewerFiles>, url: string, method = 'GET'): Promise<Response> => files.handle(new Request(url, { method }))
/** The granted model's folder URL: genio-media://model/<token> */
const folderOf = (url: string): string => url.slice(0, url.lastIndexOf('/'))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-viewer-'))
  world = path.join(root, 'world'); renderer = path.join(root, 'out', 'renderer'); libs = path.join(root, 'libs')
  write('Assets/Models/robot.gltf', '{}')
  write('Assets/Models/robot.bin', Buffer.alloc(64))
  write('Assets/Models/Textures/robot_checker.png', 'png')
  write('Assets/Models/notes.txt', 'private notes')
  write('Assets/Models/script.js', 'alert(1)')
  write('Assets/Secret/key.png', 'secret')
  write('Assets/Models/big.bin', Buffer.alloc(2048))
  write('Assets/Models/crate.fbx', 'fbx')
  write('Assets/Models/crate.fbx.meta', 'ModelImporter:')
  write('Assets/Models/other.fbx.meta', 'ModelImporter:')
  write('Assets/Models/crate.mtl', 'newmtl Crate')
  write('Assets/Models/Textures/wood.tga', 'tga')
  write('Assets/Models/a/b/c/d/e/far.png', 'png')
  write('Assets/Models/robot.blend', 'blend')
  write('Assets/Models/robot.usdz', 'usdz')
  write('robot.glb', 'glb')
  fs.mkdirSync(path.join(renderer, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(renderer, 'viewer3d.html'), '<!doctype html>')
  fs.writeFileSync(path.join(renderer, 'assets', 'viewer3d-abc.js'), 'export {}')
  fs.writeFileSync(path.join(renderer, 'index.html'), 'app')
  fs.mkdirSync(path.join(libs, 'draco', 'gltf'), { recursive: true })
  fs.writeFileSync(path.join(libs, 'draco', 'gltf', 'draco_decoder.wasm'), Buffer.from([0, 97, 115, 109]))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const service = (extra: Partial<Parameters<typeof modelViewerFiles>[0]> = {}) =>
  modelViewerFiles({ projectRoot: w => w === 'zoo' ? world : undefined, rendererDir: renderer, maxBytes: 1024, ...extra })

describe('genio-viewer:// model grants', () => {
  it('streams byte ranges and refuses malformed or unsatisfiable ranges without reading the whole file', async () => {
    write('range.glb', '0123456789')
    const files = service(), url = await files.grant('zoo', 'range.glb')
    const partial = await files.handle(new Request(url, { headers: { Range: 'bytes=2-5' } }))
    expect([partial.status, partial.headers.get('content-range'), partial.headers.get('content-length'), await partial.text()]).toEqual([206, 'bytes 2-5/10', '4', '2345'])
    const suffix = await files.handle(new Request(url, { headers: { Range: 'bytes=-3' } }))
    expect(await suffix.text()).toBe('789')
    for (const range of ['bytes=99-', 'bytes=5-2', 'bytes=-0', 'bytes=0-2,5-6', 'nonsense']) {
      expect((await files.handle(new Request(url, { headers: { Range: range } }))).status).toBe(416)
    }
  })

  it('resolves Unity sibling Textures by basename while keeping unrelated sibling folders private', async () => {
    write('Assets/Pack/Base Mesh/hero.fbx')
    write('Assets/Pack/Textures/Body/Hero.TGA', 'pixels')
    write('Assets/Pack/Private/key.png', 'private')
    const files = service(), url = await files.grant('zoo', 'Assets/Pack/Base Mesh/hero.fbx')
    expect(await (await get(files, `${folderOf(url)}/hero.tga`)).text()).toBe('pixels')
    expect((await get(files, `${folderOf(url)}/key.png`)).status).toBe(404)
  })

  it('keeps the interactive grant alive while thumbnail capabilities roll over', async () => {
    const files = service({ maxGrants: 2 })
    const interactive = await files.grant('zoo', 'robot.glb', true)
    for (let i = 0; i < 5; i++) await files.grant('zoo', 'robot.glb')
    expect((await get(files, interactive)).status).toBe(200)
    files.revoke(interactive, true)
    expect((await get(files, interactive)).status).toBe(200)
    files.revoke(interactive)
    expect((await get(files, interactive)).status).toBe(404)
  })
  it('grants one model per token and serves it with its side files, CORS-readable by the opaque frame', async () => {
    const files = service()
    const url = await files.grant('zoo', 'Assets/Models/robot.gltf')
    expect(url).toMatch(/^genio-media:\/\/model\/[0-9a-f]{32}\/robot\.gltf$/)
    const model = await get(files, url)
    expect(model.status).toBe(200)
    expect(model.headers.get('access-control-allow-origin')).toBe('*')
    expect(model.headers.get('x-content-type-options')).toBe('nosniff')
    expect(model.headers.get('content-type')).toBe('model/gltf+json')
    const base = folderOf(url)
    expect((await get(files, `${base}/robot.bin`)).status).toBe(200)
    const texture = await get(files, `${base}/Textures/robot_checker.png`)
    expect([texture.status, texture.headers.get('content-type'), await texture.text()]).toEqual([200, 'image/png', 'png'])
    const glb = await files.grant('zoo', 'robot.glb')
    expect((await get(files, glb)).status).toBe(200)
  })

  it('refuses everything else: other types, other folders, traversal, unknown tokens and non-GET', async () => {
    const files = service()
    const base = folderOf(await files.grant('zoo', 'Assets/Models/robot.gltf'))
    expect((await get(files, `${base}/notes.txt`)).status).toBe(403)
    expect((await get(files, `${base}/script.js`)).status).toBe(403)
    expect((await get(files, `${base}/crate.fbx`)).status).toBe(403)
    // URL normalisation keeps ../ (also %2e%2e) inside the token's folder; encoded separators are rejected outright.
    expect((await get(files, `${base}/../Secret/key.png`)).status).toBe(404)
    expect((await get(files, `${base}/%2e%2e/Secret/key.png`)).status).toBe(404)
    expect((await get(files, `${base}/..%2FSecret%2Fkey.png`)).status).toBe(400)
    expect((await get(files, `${base}/Textures%5C..%5C..%5CSecret%5Ckey.png`)).status).toBe(400)
    expect((await get(files, `genio-media://model/${'f'.repeat(32)}/robot.bin`)).status).toBe(404)
    expect((await get(files, `${base}/robot.bin`, 'POST')).status).toBe(405)
    expect((await get(files, 'genio-media://world/zoo/Assets/Secret/key.png')).status).toBe(404)
    expect((await get(files, 'genio-viewer://model/' + base.split('/').pop() + '/robot.bin')).status).toBe(404)
  })

  it('answers 413 for files over the preview cap so the frame can say "too large"', async () => {
    const files = service()
    const base = folderOf(await files.grant('zoo', 'Assets/Models/robot.gltf'))
    const big = await get(files, `${base}/big.bin`)
    expect(big.status).toBe(413)
    expect(await big.text()).toContain('big.bin')
    // GLTFLoader drops a failed buffer's status, so the frame asks with HEAD (bodiless, same answer).
    expect((await get(files, `${base}/big.bin`, 'HEAD')).status).toBe(413)
    const head = await get(files, `${base}/robot.bin`, 'HEAD')
    expect([head.status, head.headers.get('content-length'), head.body]).toEqual([200, '64', null])
    expect((await get(files, 'genio-viewer://app/viewer3d.html', 'HEAD')).status).toBe(405)
  })

  it('serves another format with its own Unity .meta, MTL and TGA side files, and finds a texture by name below its folder', async () => {
    const files = service()
    const url = await files.grant('zoo', 'Assets/Models/crate.fbx')
    const base = folderOf(url)
    expect((await get(files, url)).headers.get('content-type')).toBe('application/octet-stream')
    const meta = await get(files, `${base}/crate.fbx.meta`)
    expect([meta.status, meta.headers.get('content-type'), await meta.text()]).toEqual([200, 'text/plain; charset=utf-8', 'ModelImporter:'])
    expect((await get(files, `${base}/other.fbx.meta`)).status).toBe(403)
    expect((await get(files, `${base}/crate.mtl`)).status).toBe(200)
    const tga = await get(files, `${base}/Textures/wood.tga`)
    expect([tga.status, tga.headers.get('content-type')]).toEqual([200, 'image/x-tga'])
    // FBX and OBJ files often store the artist's own path; the frame asks by file name and main looks below.
    expect(await (await get(files, `${base}/wood.tga`)).text()).toBe('tga')
    expect(await (await get(files, `${base}/Old/Path/WOOD.TGA`)).text()).toBe('tga')
    expect((await get(files, `${base}/wood.tga`, 'HEAD')).status).toBe(200)
    // Never above the model's folder, never past the depth limit, never a non-texture by name.
    expect((await get(files, `${base}/key.png`)).status).toBe(404)
    expect((await get(files, `${base}/far.png`)).status).toBe(404)
    expect((await get(files, `${base}/Elsewhere/robot.bin`)).status).toBe(404)
  })

  it('grants only previewable models that exist in a loaded project, and expires old grants', async () => {
    const files = service()
    await expect(files.grant('zoo', 'Assets/Models/robot.blend')).rejects.toThrow('cannot read .blend files')
    await expect(files.grant('zoo', 'Assets/Models/robot.usdz')).rejects.toThrow('cannot read .usdz files')
    await expect(files.grant('zoo', 'Assets/Models/missing.glb')).rejects.toThrow('no longer available')
    await expect(files.grant('zoo', '../outside.glb')).rejects.toThrow('no longer available')
    await expect(files.grant('other', 'robot.glb')).rejects.toThrow('not loaded')
    const first = await files.grant('zoo', 'robot.glb')
    for (let i = 0; i < 16; i++) await files.grant('zoo', 'robot.glb')
    expect((await get(files, first)).status).toBe(404)
  })

  it('revokes a thumbnail\'s grant at once, so drawing many thumbnails never expires the inspector\'s', async () => {
    const files = service()
    const inspector = await files.grant('zoo', 'robot.glb')
    for (let i = 0; i < 40; i++) {
      const thumb = await files.grant('zoo', 'robot.glb')
      expect((await get(files, thumb)).status).toBe(200)
      files.revoke(thumb)
      expect((await get(files, thumb)).status).toBe(404)
    }
    expect((await get(files, inspector)).status).toBe(200)
    files.revoke('genio-media://world/zoo/robot.glb')
    expect((await get(files, inspector)).status).toBe(200)
  })
})

describe('genio-viewer://app', () => {
  it('serves the built viewer page with its own CSP, its assets, and nothing else of the app', async () => {
    const files = service()
    const page = await get(files, 'genio-viewer://app/viewer3d.html')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toBe(viewerCsp(false))
    expect((await get(files, 'genio-viewer://app/assets/viewer3d-abc.js')).headers.get('content-type')).toBe('text/javascript')
    expect((await get(files, 'genio-viewer://app/index.html')).status).toBe(404)
    expect((await get(files, 'genio-viewer://app/assets/../index.html')).status).toBe(404)
    expect((await get(files, 'genio-viewer://app/decoders/draco_decoder.wasm')).status).toBe(404)
  })

  it('proxies the page to the dev server with the dev CSP and serves decoders from three', async () => {
    const seen: string[] = []
    const files = service({ devUrl: 'http://localhost:5173', decoderLibs: libs, fetch: async url => { seen.push(url); return new Response('<html>', { headers: { 'content-type': 'text/html' } }) } })
    const page = await get(files, 'genio-viewer://app/viewer3d.html')
    expect(seen).toEqual(['http://localhost:5173/viewer3d.html'])
    expect(page.headers.get('content-security-policy')).toBe(viewerCsp(true))
    const wasm = await get(files, 'genio-viewer://app/decoders/draco_decoder.wasm')
    expect([wasm.status, wasm.headers.get('content-type')]).toEqual([200, 'application/wasm'])
    expect((await get(files, 'genio-viewer://app/decoders/evil.js')).status).toBe(404)
  })

  it('keeps the frame off the network, genio-media:// and inline script in builds', () => {
    const csp = viewerCsp(false)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src genio-viewer://app 'wasm-unsafe-eval'")
    expect(csp).not.toMatch(/genio-media:(\s|;)|genio-media:\/\/world|https?:|script-src[^;]*'unsafe-inline'/)
    expect(csp).toMatch(/connect-src genio-viewer:\/\/app genio-media:\/\/model blob: data:(;|$)/)
    expect(csp).toMatch(/img-src genio-media:\/\/model blob: data:(;|$)/)
    expect(viewerCsp(true)).toContain("'unsafe-inline'")
  })
})
