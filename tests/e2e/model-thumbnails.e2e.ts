/** Inventory's model thumbnails in real Chromium/WebGL: main's hidden window draws every format through the real
 * viewer page and genio-viewer:// handler, never shows or focuses, stops a hung model and is destroyed when idle.
 * Run with npm run test:e2e -- model-thumbnails. MODEL_THUMBS_SHOTS=<dir> keeps each WebP.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { modelViewerFiles } from '../../src/main/model-viewer'

const fixtures = path.resolve('tests/fixtures/models')
let root: string, server: ViteDevServer, results: Record<string, any>
const HANG_MS = 10_000

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-thumbs-e2e-'))
  const world = path.join(root, 'world'), dir = path.join(world, 'Assets', 'Models')
  fs.cpSync(fixtures, dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'corrupt.fbx'), Buffer.from('; FBX 7.4.0 project file\nnot really an FBX'))
  fs.copyFileSync(path.join(dir, 'robot_textured_anim.glb'), path.join(dir, 'hang.glb'))
  const bundle = path.join(root, 'model-thumbnails.cjs')
  await build({ entryPoints: [path.resolve('src/main/model-thumbnails.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], alias: { '@shared': path.resolve('src/shared') }, logLevel: 'error' })

  let files!: ReturnType<typeof modelViewerFiles>
  server = await createServer({
    configFile: false, root: path.resolve('src/renderer'), logLevel: 'error',
    resolve: { alias: { '@shared': path.resolve('src/shared'), '@': path.resolve('src/renderer/src') } },
    plugins: [{ name: 'model-thumbs-e2e', configureServer(s) {
      s.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname !== '/__viewer') return next()
          const target = url.searchParams.get('u')!
          // The hung model's file arrives long after the thumbnail timeout.
          if (target.endsWith('/hang.glb')) await new Promise(r => setTimeout(r, HANG_MS))
          const r = await files.handle(new Request(target, { method: req.method }))
          res.statusCode = r.status
          r.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await r.arrayBuffer()))
        } catch (e) { next(e) }
      })
    } }],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const base = server.resolvedUrls!.local[0].replace(/\/$/, '')
  files = modelViewerFiles({ projectRoot: w => w === 'zoo' ? world : undefined, rendererDir: path.join(root, 'no-build'), maxGrants: 64, decoderLibs: path.resolve('node_modules/three/examples/jsm/libs'), devUrl: base })
  const grant = (asset: string): Promise<string> => files.grant('zoo', `Assets/Models/${asset}`)
  const models = {
    glb: await grant('robot_textured_anim.glb'), draco: await grant('robot_draco.glb'), gltf: await grant('gltf_separate/robot.gltf'),
    fbx: await grant('robot_binary.fbx'), fbxAscii: await grant('crate_ascii.fbx'), obj: await grant('crate.obj'), stl: await grant('crate.stl'),
    ply: await grant('crate.ply'), dae: await grant('dae/robot.dae'), bvh: await grant('robot_wave.bvh'), usda: await grant('usda/robot.usda'),
    tds: await grant('crate.3ds'), corrupt: await grant('corrupt.fbx')
  }
  const resultFile = path.join(root, 'results.json')
  const env: NodeJS.ProcessEnv = { ...process.env, MODEL_THUMBS_E2E: JSON.stringify({ bundle, bridge: `${base}/__viewer?u=`, models, hang: await grant('hang.glb'), results: resultFile, shots: process.env.MODEL_THUMBS_SHOTS }) }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  const child = spawn(createRequire(import.meta.url)('electron') as unknown as string, [path.resolve('tests/support/model-thumbnails-electron.cjs'), `--user-data-dir=${path.join(root, 'profile')}`], { env, windowsHide: true, stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron model thumbnail check timed out')) }, 180_000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  results = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (process.env.MODEL_THUMBS_RESULTS) fs.copyFileSync(resultFile, process.env.MODEL_THUMBS_RESULTS)
}, 240_000)
afterAll(async () => { await server?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

it('draws a 256 px WebP of every format in one hidden window', () => {
  expect(results.error, JSON.stringify(results.console)).toBeUndefined()
  for (const name of ['glb', 'draco', 'gltf', 'fbx', 'fbxAscii', 'obj', 'stl', 'ply', 'dae', 'bvh', 'usda', 'tds']) {
    const t = results.drawn[name]
    expect(t, name).toMatchObject({ width: 256, height: 256 })
    expect(t.bytes, name).toBeLessThan(64 * 1024)
    // The model fills part of the frame: something is drawn, and it is not all model.
    expect(t.lit, name).toBeGreaterThan(name === 'bvh' ? 0.001 : 0.03)
    expect(t.lit, name).toBeLessThan(0.9)
  }
  expect(results.windows[0]).toEqual({ after: 'models', made: 1, live: 1 })
})

it('says why a model cannot be drawn', () => {
  expect(results.drawn.corrupt).toMatchObject({ code: 'unreadable', reason: expect.stringMatching(/^The file could not be read as FBX: /) })
})

it('is never shown or focused, and is destroyed when idle, when a model hangs and when stopped', () => {
  expect(results.seen).toEqual({ visible: false, focused: false })
  expect(results.windows[1]).toEqual({ after: 'idle', live: 0 })
  expect(results.hang).toMatchObject({ code: 'timeout', live: 0 })
  expect(results.hang.ms).toBeLessThan(HANG_MS)
  expect(results.afterHang).toBe('drawn')
  expect(results.windows[2]).toEqual({ after: 'stop', live: 0 })
})
