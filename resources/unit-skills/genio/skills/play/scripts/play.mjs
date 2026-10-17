// Long-lived, dependency-free unit session: lease and fence every Pipeline request.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createInterface } from 'node:readline'
import { PlayPool, stuckMessage } from './pool.mjs'

const { GENIO_PLAY_DATA: data, GENIO_PLAY_WORLD: world, GENIO_PLAY_SOURCE: source, GENIO_PLAY_ENGINE_ROOT: engineRoot = '', GENIO_TASK_ID: task } = process.env
if (!data || !world || !source || !task) throw new Error('Run this helper from a Genio Unity unit with its Play environment')
const pool = new PlayPool(data, world, engineRoot)
const owner = `unit:${task}`
let lease, timer, activeRequest, lost = false, keepEditor = false, closing
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
const report = (id, r) => output(r.kept ? { released: true, slot: id, editor: 'kept' } : r.closed ? { released: true, slot: id, editor: 'closed' } : { released: true, slot: id, editor: 'stuck', pids: r.pids, error: stuckMessage(id, r) })
// Release means the slot editor is closed too, unless the session asked to keep it.
function close() {
  return closing ??= (async () => {
    lost = true; clearInterval(timer); activeRequest?.destroy()
    if (lease) { const r = await pool.release(lease.id, lease.token, { keepEditor }); if (r) report(lease.id, r) }
    await pool.cancel(owner)
    await pool.settle()
  })()
}
const minutes = ms => Math.max(1, Math.round(ms / 60000))
function waitMessage(w) {
  const stuck = w.stuck.map(s => `Slot ${s.slot} is stuck (${s.reason}); report "blocked: Play slot ${s.slot} stuck" to Genio. Never stop Unity processes yourself.`)
  const place = w.position ? `Queued for a shared Play slot: position ${w.position} of ${w.length}${w.estimateMs === null ? '' : `, about ${minutes(w.estimateMs)} min (rough, from recent sessions)`}.` : 'Waiting for a shared Play slot.'
  const capacity = `${w.inUse} of ${w.cap} slot${w.cap === 1 ? '' : 's'} in use.${w.draining.length ? ` Slot ${w.draining.join(', ')} ${w.draining.length === 1 ? 'is' : 'are'} draining above a lowered cap and take${w.draining.length === 1 ? 's' : ''} no new lease.` : ''}`
  return [place, capacity, 'Keep this process running; it takes the slot automatically and you need no other step.', ...stuck].join(' ')
}
const PORT_FILE = 'Library/Pipeline/.unity-pipeline-port'
/** One Pipeline exec in the leased slot: { status, body }. Missing or foreign endpoint files are named, never a bare ENOENT. */
function exec(request) {
  let descriptor
  try { descriptor = JSON.parse(fs.readFileSync(path.join(lease.root, PORT_FILE), 'utf8')) } catch (e) {
    throw new Error(e.code === 'ENOENT'
      ? `The slot editor has no Pipeline endpoint (${PORT_FILE} is missing): it exited, or it is still starting or importing. ${pool.editorAlive(lease.id) ? 'It is still running; retry in a minute.' : 'No editor is running in the slot; stop this session and start a new one.'}`
      : `The slot editor's Pipeline endpoint file is unreadable (${e.message}); retry in a moment.`)
  }
  const normalize = p => path.resolve(p).toLowerCase()
  if (!descriptor.projectPath || normalize(descriptor.projectPath) !== normalize(lease.root) || descriptor.mode !== 'editor' || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !descriptor.evalToken || /[\r\n]/.test(descriptor.evalToken)) throw new Error('No matching slot editor; wait for import')
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command: request.command, parameters: request.parameters ?? {}, timeout: 15000 })
    const req = http.request({ hostname: '127.0.0.1', port: descriptor.port, path: '/api/exec', method: 'POST', headers: { Authorization: `Bearer ${descriptor.evalToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let size = 0; const chunks = []
      res.on('data', c => { size += c.length; if (size > 16 * 1024 * 1024) req.destroy(); else chunks.push(c) })
      res.on('error', () => reject(new Error('Pipeline response interrupted')))
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()) } catch { if (res.statusCode === 200) return reject(new Error('Invalid Pipeline response (HTTP 200, not JSON)')) }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    activeRequest = req
    const deadline = setTimeout(() => req.destroy(), 20000)
    req.once('close', () => clearTimeout(deadline)); req.on('error', () => reject(new Error('Slot disconnected or lease lost'))); req.end(body)
  })
}
/** Pipeline's own reason for a refusal (status, error, details), so a busy editor is not reported as a broken one. */
function refusal(command, { status, body }) {
  const text = [body?.error, body?.message, body?.errorDetails].filter(v => typeof v === 'string' && v).map(v => v.replace(/[\r\n]+/g, ' ').slice(0, 300))
  const busy = /main thread operation timed out|compil|import|domain reload/i.test(text.join(' ')) ? ' The editor is busy (importing, compiling or reloading); retry in a minute.' : ''
  return `Pipeline refused ${command} (HTTP ${status}${text.length ? `: ${[...new Set(text)].join(': ')}` : ', no details'}).${busy}`
}

if (process.argv.includes('--close')) {
  // Recovery for this unit: its own leases, kept editors and stuck slots. Never another unit's.
  try {
    const results = await pool.closeOwned(owner)
    for (const r of results) report(r.slot, r)
    if (!results.length) output({ closed: true, message: 'This unit holds no Play slot or slot editor' })
    if (results.some(r => !r.closed)) process.exitCode = 1
  } finally { await pool.settle() }
} else {
  process.once('SIGINT', () => void close().finally(() => process.exit(130)))
  process.once('SIGTERM', () => void close().finally(() => process.exit(143)))
  try {
    let shown = '', shownAt = 0
    while (!(lease = await pool.acquire(owner))) {
      const w = await pool.waitInfo(owner), message = waitMessage(w)
      if (message !== shown || Date.now() - shownAt > 30000) { output({ waiting: true, position: w.position, queue: w.length, estimatedWaitSeconds: w.estimateMs === null ? null : Math.round(w.estimateMs / 1000), cap: w.cap, inUse: w.inUse, draining: w.draining, stuck: w.stuck, message }); shown = message; shownAt = Date.now() }
      await new Promise(r => setTimeout(r, 1000))
    }
    // Heartbeat plus the dialog watcher: an invisible blocking dialog on the hidden desktop fails the lease with its reason.
    let beating = false
    timer = setInterval(() => {
      if (beating) return
      beating = true
      void pool.check(lease.id, lease.token).then(() => pool.watchEditor(lease.id, lease.token)).then(r => { for (const c of r.clicked ?? []) output({ dialog: c.title, pressed: c.button }) })
        .catch(e => { if (!lost) output({ error: e.message }); lost = true; activeRequest?.destroy(); process.stdin.destroy() }).finally(() => { beating = false })
    }, 5000)
    // Another revision open in the slot is closed automatically before switching branches.
    await pool.prepare(lease.id, lease.token, source)
    await pool.validateCopy(lease.id)
    if (process.argv.includes('--open') && !pool.editorAlive(lease.id)) {
      const version = fs.readFileSync(path.join(lease.root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*(\S+)/m)?.[1]
      if (!version || !/^[\w.]+$/.test(version)) throw new Error('Invalid Unity version')
      const executable = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor', version, 'Editor/Unity.exe')
      if (!fs.existsSync(executable)) throw new Error('Install the slot Unity version with Hub first')
      // Hidden desktop: the editor never shows a window or takes focus. Same arguments and environment as before.
      const launch = await pool.launchEditor(lease.id, lease.token, executable)
      if (launch.warning) output({ warning: launch.warning })
    }
    // Ready means the editor answers, not that it was spawned: wait for its endpoint file and Pipeline's "ready".
    if (pool.editorAlive(lease.id)) await pool.waitReady(lease.id, lease.token, { onProgress: p => output({ waiting: true, slot: lease.id, phase: 'editor', ...p }) })
    output({ ready: true, slot: lease.id, project: lease.root })
    for await (const line of createInterface({ input: process.stdin })) {
      if (lost) throw new Error('Lease lost; session stopped')
      let request
      try {
        request = JSON.parse(line)
        if (!/^[a-z][a-z0-9_]{0,80}$/.test(request.command)) throw new Error('Invalid command')
        if (request.command === 'exit') { keepEditor = request.keep_editor === true || request.parameters?.keep_editor === true; break }
        if (request.command === 'close_editor') break
        await pool.check(lease.id, lease.token)
        // The token rotates and the endpoint file catches up on Pipeline's next heartbeat: one retry after a 401.
        let answer = await exec(request)
        if (answer.status === 401) { await new Promise(r => setTimeout(r, 1500)); await pool.check(lease.id, lease.token); answer = await exec(request) }
        if (answer.status !== 200) throw new Error(refusal(request.command, answer))
        const result = answer.body
        await pool.check(lease.id, lease.token)
        output({ id: request.id, result })
      } catch(e) { output({ id: request?.id, error: e.message }) }
    }
  } catch (e) { output({ error: e.message }); process.exitCode = 1 } finally { await close() }
}
