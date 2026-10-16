// Serves Settings in the app's shell (title bar, rail, stage) from Vite with a stand-in preload bridge,
// then runs a Chromium driver against it. Usage: node settings-layout-browser.mjs <results.json> <settings.json> <driver.cjs>
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { assertChildHomes } from './isolated-homes.mjs'

const [resultFile, settingsFile, driverArg] = process.argv.slice(2)
const settings = fs.readFileSync(settingsFile, 'utf8')
const fixture = String.raw`<!doctype html><html><body><div id="root"></div>
<script>
  // Every bridge call resolves, with nothing unless a page needs a shape to render.
  const answers = {
    projectMetadata: {}, projectPushStatus: { ahead: 0, behind: 0 }, falWorld: { config: {} }, uthanaWorld: { config: {} },
    playPool: { cap: 1, slots: [], queue: [] }, playPoolDisk: {}, accounts: [], apiKeys: [], toolchain: [], homePath: 'C:/fixture',
    readMemory: '', dispatchScores: { rows: [], recent: [], log: [] }, modelCatalogue: { routes: [] }
  }
  const call = (name) => (...args) => {
    const a = answers[name]
    return Promise.resolve(typeof a === 'function' ? a(...args) : a)
  }
  window.genio = { api: new Proxy({}, { get: (_, name) => call(name) }), on: () => () => {}, onTerminalData: () => () => {} }
</script>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Systems } from '/src/renderer/src/views/Systems.tsx'
import { Toasts } from '/src/renderer/src/components/Overlays.tsx'
import { getState, setState } from '/src/renderer/src/store.ts'
import '/src/renderer/src/styles/theme.css'
import '/src/renderer/src/styles/app.css'
const h = React.createElement
const project = { name: 'fixture', path: 'C:/games/fixture', engine: 'godot', commands: {}, defaultBranch: 'main', mode: 'local-only', forge: 'none',
  yolo: false, branchPrefix: 'genio/', managed: false, addedAt: '2026-10-01', gitRepo: true }
setState({ booted: true, connected: true, view: 'systems', settings: { ...${settings}, firstRunDone: true, fx: false },
  snap: { ...getState().snap, projects: [project] } })
window.fixture = { getState, setState }
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() { return this.state.error ? h('pre', { id: 'fixture-error' }, String(this.state.error.stack || this.state.error)) : this.props.children }
}
function Shell() {
  return h('div', { className: 'app' },
    h('header', { className: 'titlebar' }, h('span', { className: 'wordmark-text' }, 'GENIO')),
    h('div', { className: 'app-body' },
      h('nav', { className: 'rail' }),
      h('div', { className: 'stage-shell' }, h('main', { className: 'stage' }, h(Boundary, null, h(Systems))))),
    h(Toasts))
}
createRoot(document.getElementById('root')).render(h(Shell))
</script></body></html>`

const driver = path.resolve(driverArg)
const root = path.dirname(resultFile)
const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: 'error',
  resolve: { alias: { '@shared': path.resolve('src/shared') } },
  optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react', 'marked', 'dompurify', '@xterm/xterm', '@xterm/addon-fit'] },
  plugins: [react(), { name: 'settings-layout-fixture', configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/settings-layout.html')) return next()
      try {
        res.setHeader('Content-Type', 'text/html')
        res.end(await s.transformIndexHtml(req.url, fixture))
      } catch (e) { next(e) }
    })
  } }],
  server: { host: '127.0.0.1', port: 0 }
})

let child
try {
  await server.listen()
  const env = { ...process.env, SETTINGS_URL: server.resolvedUrls.local[0] + 'settings-layout.html?project=fixture&wksp=genio', SETTINGS_RESULTS: resultFile }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  assertChildHomes(env)
  const require = createRequire(import.meta.url)
  child = spawn(require('electron'), [driver, '--user-data-dir=' + path.join(root, 'profile')], { env, windowsHide: true, stdio: 'inherit' })
  process.exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Settings layout check timed out')) }, Number(process.env.SETTINGS_BROWSER_TIMEOUT) || 150000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
} finally {
  if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill() })
  await server.close()
}
