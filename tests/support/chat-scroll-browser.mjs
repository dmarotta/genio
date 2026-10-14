import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { assertChildHomes } from './isolated-homes.mjs'

const fixture = String.raw`<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Comms } from '/src/renderer/src/views/Comms.tsx'
import { GenioPanel } from '/src/renderer/src/components/GenioPanel.tsx'
import { getState, setState, handleEvent, useStore } from '/src/renderer/src/store.ts'
import '/src/renderer/src/styles/theme.css'
import '/src/renderer/src/styles/app.css'
const messages = Array.from({ length: 320 }, (_, i) => ({ id: 'm-' + i, wksp: 'genio',
  role: i % 3 ? 'genio' : 'player', text: ('Reply ' + i + ' **bold** with real layout.\n\n').repeat(5 + i % 7), ts: '2026-10-14T06:00:00Z' }))
setState({ booted: true, connected: true, chats: { genio: messages }, chatLoaded: { genio: true },
  settings: { gamertag: 'Test', calm: false, fx: false },
  snap: { ...getState().snap, wksps: [{ name: 'genio', displayName: 'Genio', activity: 'idle', costUsd: 0, turns: 0, queued: 0 }] } })
window.fixture = { setState, handleEvent }
function Fixture() {
  const view = useStore(s => s.view)
  return React.createElement('div', { className: 'stage-shell', style: { width: '100vw', height: '100vh' } },
    view === 'comms' ? React.createElement(Comms) : null, React.createElement(GenioPanel))
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture))
</script></body></html>`

const resultFile = process.argv[2]
const root = path.dirname(resultFile)
const server = await createServer({
  configFile: false, root: process.cwd(),
  resolve: { alias: { '@shared': path.resolve('src/shared') } },
  optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react', 'marked', 'dompurify', '@xterm/xterm', '@xterm/addon-fit'] },
  plugins: [react(), { name: 'chat-scroll-fixture', configureServer(s) {
    s.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/chat-scroll.html')) return next()
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
  const env = { ...process.env, CHAT_SCROLL_URL: server.resolvedUrls.local[0] + 'chat-scroll.html?project=fixture&wksp=genio', CHAT_SCROLL_RESULTS: resultFile }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_')) delete env[key]
  assertChildHomes(env)
  const require = createRequire(import.meta.url)
  child = spawn(require('electron'), [path.resolve('tests/support/chat-scroll-electron.cjs'), '--user-data-dir=' + path.join(root, 'profile')], { env, windowsHide: true, stdio: 'inherit' })
  process.exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chromium scroll test timed out')) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
} finally {
  if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill() })
  await server.close()
}
