// Read-only real-project benchmark. Output/profile must be outside the repository, under the unit's scratch directory.
// Usage: node scripts/model-viewer-benchmark.mjs <output-directory> <manifest.json> [baseline-commit]
// Manifest: [{ world, root, asset, size, reuse? }]. No project files are copied or written.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { build } from 'esbuild'

const output = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, ''))
if (!Array.isArray(manifest) || !manifest.length || manifest.some(m => !m.world || !path.isAbsolute(m.root) || !m.asset || !Number.isFinite(m.size))) throw new Error('Expected model manifest entries { world, root, asset, size }')
for (const model of manifest) {
  const relative = path.relative(model.root, output)
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Benchmark output must be outside every source project')
}
fs.mkdirSync(output, { recursive: true })
const root = process.cwd()
// Run the exact same probes against an earlier commit without checking out or modifying its files.
const revision = process.argv[4]
const prior = file => execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
const server = await createServer({
  configFile: false, root: path.join(root, 'src/renderer'),
  resolve: { alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer/src') } },
  plugins: [{
    name: 'benchmark-parent', configureServer(server) {
      server.middlewares.use('/benchmark.html', (_req, res) => {
        res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(new URL('./model-viewer-benchmark.html', import.meta.url), 'utf8'))
      })
    }
  }, {
    name: 'viewer-benchmark-timing', enforce: 'pre',
    transform(code, id) {
      if (revision && /\/(?:viewer3d\/[^?]+\.ts|shared\/model-viewer\.ts)$/.test(id.replaceAll('\\', '/'))) code = prior(path.relative(root, id).replaceAll('\\', '/'))
      if (!/viewer3d\/(?:viewer|formats|textures)\.ts$/.test(id.replaceAll('\\', '/'))) return revision ? code : undefined
      // Same probes for both revisions. gl.finish is ONLY a benchmark probe, never product code.
      const stamp = label => `globalThis.__bench?.(${JSON.stringify(label)});`
      if (id.endsWith('formats.ts')) {
        code = code.replace('const gltf = await ctx.gltfLoader(manager).loadAsync(url)', `const loader = ctx.gltfLoader(manager), parse = loader.parse.bind(loader); loader.parse = (data, path, done, error) => { globalThis.__bench?.('read'); globalThis.__bench?.('parse-start'); parse(data, path, value => { globalThis.__bench?.('parse-end'); done(value) }, error) }; const gltf = await loader.loadAsync(url)`)
        code = code.replace('const gltf = await ctx.gltfLoader(manager).parseAsync(await read(), folder)', `const bytes = await read(); globalThis.__bench?.('parse-start'); const gltf = await ctx.gltfLoader(manager).parseAsync(bytes, folder); globalThis.__bench?.('parse-end')`)
        code = code.replace('return response.arrayBuffer()', `const bytes = await response.arrayBuffer(); ${stamp('read')} return bytes`)
        code = code.replace('new FBXLoader(manager).parse(buffer, folder)', `(globalThis.__bench?.('parse-start'), new FBXLoader(manager).parse(buffer, folder))`)
        code = code.replace('const metres =', `${stamp('parse-end')} const metres =`)
      } else if (id.endsWith('textures.ts')) {
        code = code.replace('const response = await fetch(url', `globalThis.__bench?.('texture-request', url); const response = await fetch(url`)
        code = code.replace('const bytes = await response.arrayBuffer()', `const bytes = await response.arrayBuffer(); globalThis.__bench?.('texture-read', url)`)
        code = code.replace('return this.mark(done, flip)', `globalThis.__bench?.('texture-decoded', url); return this.mark(done, flip)`)
      } else {
        code = code.replace('await idle()', `await idle(); ${stamp('textures-settled')}`)
        code = code.replace('scene.add(pivot)', `scene.add(pivot); ${stamp('geometry-attached')}`)
        code = code.replace('const started = performance.now()', `const started = performance.now(); ${stamp('open-start')}`)
        code = code.replaceAll('renderer.render(scene, camera)', `{ ${stamp('render-start')} renderer.render(scene, camera); renderer.getContext().finish(); ${stamp('render-end')} }`)
      }
      return `globalThis.__bench = (phase, file) => parent.postMessage({ type:'benchmark', phase, file, at:performance.now(), page:performance.timeOrigin, resources:phase === 'render-end' ? performance.getEntriesByType('resource').filter(r=>r.name.startsWith('genio-media://model/')).map(r=>({name:r.name,duration:r.duration,start:r.startTime,end:r.responseEnd})) : undefined }, '*');\n` + code
    }
  }], server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } }
})
await server.listen()
const devUrl = server.resolvedUrls.local[0]
const mainFile = path.join(output, 'benchmark.cjs')
await build({
  stdin: { resolveDir: root, contents: `
    import { app, BrowserWindow, protocol } from 'electron';
    import fs from 'node:fs'; import path from 'node:path';
    import { modelViewerFiles } from './src/main/model-viewer';
    const manifest = ${JSON.stringify(manifest)};
    app.setPath('userData', ${JSON.stringify(path.join(output, 'profile'))});
    protocol.registerSchemesAsPrivileged(['genio-viewer', 'genio-media'].map(scheme => ({ scheme, privileges: { standard:true, secure:true, supportFetchAPI:true, corsEnabled:true, stream:true } })));
    app.whenReady().then(async () => {
      const files = modelViewerFiles({ projectRoot: world => manifest.find(m => m.world === world)?.root, rendererDir:'', devUrl:${JSON.stringify(devUrl)}, decoderLibs:${JSON.stringify(path.join(root, 'node_modules/three/examples/jsm/libs'))} });
      const requests = [];
      protocol.handle('genio-viewer', req => files.handle(req));
      protocol.handle('genio-media', async req => { const t=performance.now(); const response=await files.handle(req); requests.push({url:req.url,setupMs:performance.now()-t,status:response.status}); return response; });
      const win = new BrowserWindow({show:false, width:1100, height:850, webPreferences:{sandbox:true, backgroundThrottling:false}});
      win.showInactive();
      const consoleLog = [];
      win.webContents.on('console-message', event => { if(consoleLog.length < 80) consoleLog.push(event.message); });
      await win.loadURL(${JSON.stringify(devUrl)} + 'benchmark.html');
      for (const entry of manifest) entry.url = await files.grant(entry.world, entry.asset);
      await win.webContents.executeJavaScript('new Promise((resolve,reject) => { let n=0; const t=setInterval(()=>{if(window.runBenchmark){clearInterval(t);resolve()}else if(++n>200){clearInterval(t);reject(new Error("Benchmark module did not start"))}},50) })');
      const results = await win.webContents.executeJavaScript('window.runBenchmark(' + JSON.stringify(manifest) + ')');
      fs.writeFileSync(${JSON.stringify(path.join(output, 'results.json'))}, JSON.stringify(results, null, 2));
      fs.writeFileSync(${JSON.stringify(path.join(output, 'console.json'))}, JSON.stringify(consoleLog, null, 2));
      fs.writeFileSync(${JSON.stringify(path.join(output, 'requests.json'))}, JSON.stringify(requests, null, 2));
      console.log('Benchmark saved: ' + ${JSON.stringify(path.join(output, 'results.json'))}); app.quit();
    }).catch(e => { console.error(e); app.exit(1); });
  ` }, bundle: true, platform: 'node', format: 'cjs', outfile: mainFile,
  alias: { '@shared': path.join(root, 'src/shared') }, external: ['electron', 'node-pty'],
  plugins: revision ? [{ name:'baseline-main', setup(build) {
    build.onLoad({ filter:/[\\/]src[\\/]main[\\/]model-viewer\.ts$/ }, args => ({ contents:prior('src/main/model-viewer.ts'), loader:'ts', resolveDir:path.dirname(args.path) }))
  } }] : []
})
const env = { ...process.env }
for (const [key, folder] of Object.entries({ GENIO_HOME:'genio', CODEX_HOME:'codex', CLAUDE_CONFIG_DIR:'claude', APPDATA:'appdata', LOCALAPPDATA:'localappdata', HOME:'home', USERPROFILE:'home' })) {
  env[key] = path.join(output, folder); fs.mkdirSync(env[key], { recursive:true })
}
delete env.ELECTRON_RUN_AS_NODE
for (const k of Object.keys(env)) if (k.startsWith('GIT_CONFIG_')) delete env[k]
try {
  const child = spawn(createRequire(import.meta.url)('electron'), [mainFile], { env, stdio: 'inherit', windowsHide: true })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (process.exitCode === 0) {
    const results = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'))
    const summary = results.map(result => {
      const p = result.probes, at = phase => p.find(x => x.phase === phase)?.at
      const started = at('open-start'), geometry = at('geometry-attached')
      const render = p.find(x => x.phase === 'render-start' && x.at >= geometry)
      const rendered = p.find(x => x.phase === 'render-end' && x.at >= render?.at)
      const loaded = result.events.find(x => x.type === 'loaded')
      const failed = result.events.find(x => x.type === 'failed')
      const resources = p.flatMap(x => x.resources ?? [])
      const primary = resources.find(x => decodeURIComponent(new URL(x.name).pathname.split('/').pop()) === result.asset.split('/').pop())
      const textureReads = p.filter(x => x.phase === 'texture-read')
      const decoded = p.filter(x => x.phase === 'texture-decoded')
      const decodeMs = decoded.reduce((sum, x) => sum + x.at - p.find(r => r.phase === 'texture-read' && r.file === x.file).at, 0)
      return {
        asset: result.asset, bytes:result.bytes, reuse: result.reuse,
        startupMs: result.events.find(x => x.type === 'ready')?.at ?? 0,
        readTransferMs: at('read') === undefined ? primary?.duration : at('read') - started,
        parseMs: at('parse-end') === undefined ? undefined : at('parse-end') - at('parse-start'),
        firstFrameMs: rendered ? rendered.at - started : undefined,
        uploadAndRenderMs: rendered ? rendered.at - render.at : undefined,
        textureWindowMs: at('textures-settled') === undefined ? undefined : p.some(x=>x.phase==='texture-request') ? at('textures-settled') - (revision ? at('parse-end') ?? started : rendered?.at ?? started) : 0,
        textureReadCount: textureReads.length, decodedCount: decoded.length, summedDecodeMs: decodeMs,
        completeMs: loaded?.model.loadMs, textures: loaded?.model.stats.textures, missing: loaded?.model.missing,
        failure: failed && { code:failed.code, ms:failed.at - (result.events.find(x=>x.type==='ready')?.at ?? 0), reason:failed.reason }
      }
    })
    fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
    console.table(summary.map(s => ({ asset:path.basename(s.asset), warm:s.reuse, read:s.readTransferMs?.toFixed(1), parse:s.parseMs?.toFixed(1), first:s.firstFrameMs?.toFixed(1), decode:s.summedDecodeMs?.toFixed(1), total:s.completeMs, failure:s.failure?.code })))
  }
} finally { await server.close() }
