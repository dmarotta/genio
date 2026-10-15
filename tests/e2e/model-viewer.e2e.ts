/** Inventory's 3D viewer in real Chromium/WebGL: frame isolation, glTF cases, playback, and the dispose leak test.
 * Run with npm run test:e2e -- model-viewer. The real genio-viewer:// handler answers through a bridge in this process.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { modelViewerFiles } from '../../src/main/model-viewer'
import { animatedGlb } from '../helpers/anim-glb'

const fixtures = path.resolve('tests/fixtures/models')
let root: string, server: ViteDevServer, results: Record<string, any>, models: Record<string, string>

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-viewer-e2e-'))
  const world = path.join(root, 'world'), dir = path.join(world, 'Assets', 'Models')
  fs.cpSync(fixtures, dir, { recursive: true })
  fs.cpSync(path.join(dir, 'gltf_separate'), path.join(dir, 'gltf_missing'), { recursive: true })
  fs.rmSync(path.join(dir, 'gltf_missing', 'robot_checker.png'))
  fs.cpSync(path.join(dir, 'gltf_separate'), path.join(dir, 'gltf_big'), { recursive: true })
  fs.appendFileSync(path.join(dir, 'gltf_big', 'robot.bin'), Buffer.alloc(300_000))
  fs.writeFileSync(path.join(dir, 'rig_only.glb'), animatedGlb({ mesh: false }))
  fs.writeFileSync(path.join(dir, 'corrupt.glb'), Buffer.from('glTF but not really a binary glTF file'))
  fs.writeFileSync(path.join(dir, 'gltf_separate', 'notes.txt'), 'private')
  fs.mkdirSync(path.join(world, 'Secret'))
  fs.writeFileSync(path.join(world, 'Secret', 'key.png'), 'secret')

  const csp = /content="([^"]+)"/.exec(fs.readFileSync('src/renderer/index.html', 'utf8').split('Content-Security-Policy')[1])![1]
  let files!: ReturnType<typeof modelViewerFiles>
  server = await createServer({
    configFile: false, root: path.resolve('src/renderer'), logLevel: 'error',
    resolve: { alias: { '@shared': path.resolve('src/shared'), '@': path.resolve('src/renderer/src') } },
    plugins: [react(), { name: 'model-viewer-e2e', configureServer(s) {
      s.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname === '/__viewer') {
            const r = await files.handle(new Request(url.searchParams.get('u')!, { method: req.method }))
            res.statusCode = r.status
            r.headers.forEach((v, k) => res.setHeader(k, v))
            res.end(Buffer.from(await r.arrayBuffer()))
          } else if (url.pathname === '/parent.html') {
            // The app window's own CSP, with the frame hosted the way ModelViewer.tsx hosts it.
            res.setHeader('Content-Type', 'text/html')
            res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><body><script>
              window.log = []
              addEventListener('message', e => { const f = document.querySelector('iframe'); if (f && e.source === f.contentWindow) log.push(e.data) })
              window.send = m => document.querySelector('iframe').contentWindow.postMessage(m, '*')
              window.openFrame = () => new Promise(resolve => {
                const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = 'genio-viewer://app/viewer3d.html'
                f.style.cssText = 'width: 640px; height: 480px; border: 0'
                addEventListener('message', e => { if (e.source === f.contentWindow && e.data && e.data.type === 'ready') resolve() })
                document.body.append(f)
              })
            </script></body>`)
          } else if (url.pathname === '/leak.html') {
            res.setHeader('Content-Type', 'text/html')
            res.end(await s.transformIndexHtml(url.pathname, `<!doctype html><body><canvas style="width: 400px; height: 300px"></canvas><script type="module">
              import { createViewer } from '/src/viewer3d/viewer.ts'
              window.runLeak = async (urls, cycles) => {
                const viewer = createViewer(document.querySelector('canvas'), { decoderPath: 'genio-viewer://app/decoders/' })
                viewer.render()
                const baseline = viewer.memory()
                const peak = { textures: 0, geometries: 0 }, outcomes = {}
                for (let i = 0; i < cycles; i++) {
                  const url = urls[i % urls.length]
                  try {
                    await viewer.open(url)
                    viewer.set({ bounds: i % 2 === 0, skeleton: i % 3 === 0, clay: i % 4 === 0, wireframe: i % 5 === 0, upAxis: i % 6 === 0 ? 'z' : 'y' })
                    viewer.render()
                    outcomes[url] = 'loaded'
                  } catch (e) { outcomes[url] = e.code || String(e) }
                  const m = viewer.memory()
                  peak.textures = Math.max(peak.textures, m.textures); peak.geometries = Math.max(peak.geometries, m.geometries)
                  viewer.clear()
                }
                viewer.render()
                const after = viewer.memory()
                viewer.dispose()
                return { baseline, peak, after, outcomes }
              }
            </script></body>`))
          } else next()
        } catch (e) { next(e) }
      })
    } }],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const base = server.resolvedUrls!.local[0].replace(/\/$/, '')
  files = modelViewerFiles({
    projectRoot: w => w === 'zoo' ? world : undefined, rendererDir: path.join(root, 'no-build'), maxBytes: 200_000,
    decoderLibs: path.resolve('node_modules/three/examples/jsm/libs'), devUrl: base
  })
  const grant = (asset: string): Promise<string> => files.grant('zoo', `Assets/Models/${asset}`)
  models = {
    textured: await grant('robot_textured_anim.glb'), draco: await grant('robot_draco.glb'), sideFiles: await grant('gltf_separate/robot.gltf'),
    missingTexture: await grant('gltf_missing/robot.gltf'), rigOnly: await grant('rig_only.glb'), corrupt: await grant('corrupt.glb'), tooLarge: await grant('gltf_big/robot.gltf')
  }
  const side = models.sideFiles.replace(/robot\.gltf$/, '')
  const probes = { sideFile: `${side}robot_checker.png`, notes: `${side}notes.txt`, traversal: `${side}../../Secret/key.png`, encoded: `${side}..%2F..%2FSecret%2Fkey.png`, forged: `genio-media://model/${'0'.repeat(32)}/robot.bin`, viewerHost: models.sideFiles.replace('genio-media://model/', 'genio-viewer://') }
  const resultFile = path.join(root, 'results.json')
  const env: NodeJS.ProcessEnv = { ...process.env, MODEL_VIEWER_E2E: JSON.stringify({ base, bridge: `${base}/__viewer?u=`, models, probes, results: resultFile }) }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  const child = spawn(createRequire(import.meta.url)('electron') as unknown as string, [path.resolve('tests/support/model-viewer-electron.cjs'), `--user-data-dir=${path.join(root, 'profile')}`], { env, windowsHide: true, stdio: 'inherit' })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron model viewer check timed out')) }, 240_000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  results = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  if (process.env.MODEL_VIEWER_RESULTS) fs.copyFileSync(resultFile, process.env.MODEL_VIEWER_RESULTS)
}, 300_000)
afterAll(async () => { await server?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) })

it('loads every glTF case in the sandboxed frame and reports the real reason when it cannot', () => {
  expect(results.error, JSON.stringify(results.console)).toBeUndefined()
  const loaded = (name: string) => results.frame[name].result
  expect(loaded('textured')).toMatchObject({ type: 'loaded', model: { stats: { triangles: 348, meshes: 1, textures: 1, bones: 3 }, clips: [{ name: 'Bend' }, { name: 'Wave' }], clayFallback: 0, missing: [] } })
  expect(loaded('draco')).toMatchObject({ type: 'loaded', model: { stats: { meshes: 1 } } })
  expect(loaded('draco').model.stats.triangles).toBeGreaterThan(0)
  expect(loaded('sideFiles')).toMatchObject({ type: 'loaded', model: { stats: { textures: 1 }, missing: [], clayFallback: 0 } })
  expect(loaded('missingTexture')).toMatchObject({ type: 'loaded', model: { stats: { textures: 0 }, missing: ['robot_checker.png'], clayFallback: 1 } })
  expect(loaded('rigOnly')).toMatchObject({ type: 'loaded', model: { animationOnly: true, stats: { meshes: 0, bones: 0 }, clips: [{ duration: 1 }] } })
  expect(loaded('corrupt')).toMatchObject({ type: 'failed', code: 'unreadable' })
  expect(loaded('corrupt').reason).toMatch(/could not be read as glTF/)
  expect(loaded('tooLarge')).toMatchObject({ type: 'failed', code: 'too-large' })
  expect(loaded('tooLarge').reason).toContain('robot.bin')
})

it('plays clips, shows texture previews and dimension labels', () => {
  const textured = results.frame.textured
  expect(textured.times.length).toBeGreaterThan(2)
  expect(Math.max(...textured.times)).toBeGreaterThan(textured.times[0])
  expect(textured.previews.previews).toHaveLength(1)
  expect(textured.previews.previews[0].url).toMatch(/^data:image\/(webp|png);base64,/)
  expect(textured.labels).toHaveLength(3)
  expect(textured.labels.join(' ')).toMatch(/W .*m/)
})

it('keeps the frame away from the app bridge, genio-media://, the network and files beyond the model', () => {
  expect(results.probes).toMatchObject({
    origin: 'null', ownBridge: 'undefined', parentBridge: 'SecurityError', parentDocument: 'SecurityError',
    media: 'blocked', web: 'blocked', local: 'blocked', popup: 'refused',
    sideFile: 200, notes: 403, traversal: 404, encoded: 400, forged: 404, viewerHost: 'blocked'
  })
})

it('frees every GPU texture and geometry after 100 open/close cycles (the naive dispose leaked 86 textures)', () => {
  const { baseline, peak, after, outcomes } = results.leak
  expect(Object.values(outcomes)).toEqual(expect.arrayContaining(['loaded', 'unreadable', 'too-large']))
  expect(peak.textures).toBeGreaterThan(baseline.textures)
  expect(peak.geometries).toBeGreaterThan(baseline.geometries)
  expect(after).toEqual(baseline)
})
