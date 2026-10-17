// Stand-in for a Unity editor in Play pool tests; never a real editor.
// Usage: node fake-unity-editor.mjs -projectPath <root> [-endpointDelay ms] [-settleMs ms] [-execError] graceful|stubborn
// It writes Unity's lock and instance files plus a Pipeline descriptor, and keeps an
// "import worker" child. graceful quits on the Pipeline exit eval; stubborn ignores
// polite requests (SIGTERM, taskkill without /F) and only dies to a forced stop.
// -endpointDelay writes the descriptor late (a first import), -settleMs answers /api/status
// "settling" that long after it, and -execError refuses every exec the way Pipeline does
// when the main thread is busy (HTTP 400 with a JSON reason).
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const root = arg('-projectPath'), mode = process.argv.at(-1), token = 'fake-eval-token'
const endpointDelay = Number(arg('-endpointDelay') ?? 0), settleMs = Number(arg('-settleMs') ?? 0), execError = process.argv.includes('-execError')
const files = { lock: path.join(root, 'Temp/UnityLockfile'), instance: path.join(root, 'Library/EditorInstance.json'), port: path.join(root, 'Library/Pipeline/.unity-pipeline-port') }
fs.mkdirSync(path.dirname(files.lock), { recursive: true }); fs.mkdirSync(path.dirname(files.port), { recursive: true })
fs.writeFileSync(files.lock, ''); fs.writeFileSync(files.instance, JSON.stringify({ process_id: process.pid }))
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'AssetImportWorker', '-projectPath', root], { stdio: 'ignore', windowsHide: true })
if (mode === 'stubborn') process.on('SIGTERM', () => {})
let settledAt = Infinity
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end(); return }
    if (req.url === '/api/status') { res.end(JSON.stringify({ status: Date.now() >= settledAt ? 'ready' : 'settling' })); return }
    const quit = mode === 'graceful' && JSON.parse(body).parameters?.code?.includes('EditorApplication.Exit')
    if (execError && !quit) { res.statusCode = 400; res.end(JSON.stringify({ success: false, error: 'Internal Server Error', message: 'Main thread operation timed out after 15000ms' })); return }
    res.end(JSON.stringify({ success: true, result: true }), () => {
      if (!quit) return
      worker.kill(); fs.rmSync(files.lock, { force: true }); fs.rmSync(files.instance, { force: true })
      setTimeout(() => process.exit(0), 50)
    })
  })
})
server.listen(0, '127.0.0.1', () => {
  const endpoint = () => {
    fs.writeFileSync(files.port, JSON.stringify({ port: server.address().port, pid: process.pid, evalToken: token, projectPath: root, mode: 'editor', lastHeartbeat: new Date().toISOString() }))
    settledAt = Date.now() + settleMs
  }
  // Without a delay the descriptor exists before the start line, as tests that remove it rely on.
  if (!endpointDelay) endpoint()
  process.stdout.write(JSON.stringify({ pid: process.pid, worker: worker.pid }) + '\n')
  if (endpointDelay) setTimeout(endpoint, endpointDelay)
})
