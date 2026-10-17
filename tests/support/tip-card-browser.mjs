// Real renderer components in the project shell, with an inert terminal and a stand-in preload bridge.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { assertChildHomes } from './isolated-homes.mjs'

const [resultFile, settingsFile] = process.argv.slice(2)
const settings = fs.readFileSync(settingsFile, 'utf8')
const fixture = `<!doctype html><html><body><div id="root"></div>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { TipCard } from '/src/renderer/src/components/TipCard.tsx'
import { Answers } from '/src/renderer/src/components/Answers.tsx'
import { Toasts } from '/src/renderer/src/components/Overlays.tsx'
import { Systems } from '/src/renderer/src/views/Systems.tsx'
import { getState, setState, handleEvent, useStore } from '/src/renderer/src/store.ts'
import { openSettings } from '/src/renderer/src/lib/settings-nav.ts'
import '/src/renderer/src/styles/theme.css'
import '/src/renderer/src/styles/app.css'
import '/src/renderer/src/styles/terminal-pane.css'
const h = React.createElement
const settings = { ...${settings}, fx: false }
window.genio = { api: new Proxy({}, { get: (_, name) => async patch => {
  if (name === 'saveSettings') return Object.assign(settings, patch)
  return []
} }), on: () => () => {} }
setState({ booted: true, connected: true, view: 'squad', settings })
const tip = { id: 'play-unit', line: "You can play this build in Play before it lands: pick the unit as the source.", question: "How do I play a unit's build?" }
window.fixture = {
  getState, setState, handleEvent,
  show({ choice = false, toast = false, pane = false, general = false } = {}) {
    document.documentElement.style.setProperty('--term-pane-h', pane ? '110px' : '0px')
    setState(s => ({ tip: undefined, paneOpen: pane, view: general ? 'systems' : 'squad',
      toasts: toast ? [{ id: 1, level: 'info', title: 'Connection restored' }] : [],
      snap: { ...s.snap, decisions: choice ? [{ id: 'choice', key: 'choice', wksp: 'genio', project: 'fixture',
        question: 'Which direction should the market stalls take?', options: ['Timber', 'Stone'], source: 'genio', urgency: 'normal', createdAt: new Date().toISOString() }] : [] } }))
    if (general) openSettings('general')
    else handleEvent({ type: 'tip', project: 'fixture', tip })
  }
}
function Shell() {
  const s = useStore(s => s)
  return h('div', { className: 'app' },
    h('header', { className: 'titlebar' }, h('span', { className: 'wordmark-text' }, 'GENIO')),
    h('div', { className: 'app-body' }, h('nav', { className: 'rail' }),
      h('div', { className: 'stage-column' },
        h('div', { className: 'stage-shell' },
          h('main', { className: 'stage' }, s.view === 'systems' ? h(Systems) : h('div', { className: 'view' },
            h('h2', null, 'Squad'), h('div', { className: 'panel', style: { padding: 16 } }, 'Market stalls: haggling UI'))),
          h(TipCard)),
        h('div', { className: 'term-pane' + (s.paneOpen ? ' open' : ''), style: { height: s.paneOpen ? 110 : 0 } },
          h('header', { className: 'term-pane-bar' }, 'Terminal'), h('pre', null, '> npm run dev')))),
    h(Answers), h(Toasts))
}
createRoot(document.getElementById('root')).render(h(Shell))
</script></body></html>`
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
  resolve: { alias: { '@shared': path.resolve('src/shared') } },
  optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react', 'marked', 'dompurify', '@xterm/xterm', '@xterm/addon-fit'] },
  plugins: [react(), { name: 'tip-card-fixture', configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/tip-card.html')) return next()
      try { res.setHeader('Content-Type', 'text/html'); res.end(await s.transformIndexHtml(req.url, fixture)) }
      catch (error) { next(error) }
    })
  } }], server: { host: '127.0.0.1', port: 0 } })
let child
try {
  await server.listen()
  const env = { ...process.env, TIP_CARD_URL: server.resolvedUrls.local[0] + 'tip-card.html?project=fixture&wksp=genio', TIP_CARD_RESULTS: resultFile }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  assertChildHomes(env)
  child = spawn(createRequire(import.meta.url)('electron'), [path.resolve('tests/support/tip-card-electron.cjs'), '--user-data-dir=' + path.join(path.dirname(resultFile), 'profile')],
    { env, windowsHide: true, stdio: 'inherit' })
  process.exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Tip render check timed out')) }, 150_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
} finally {
  if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill() })
  await server.close()
}
