// Long-lived, dependency-free unit session: lease and fence every Pipeline request.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
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
    timer = setInterval(() => void pool.check(lease.id, lease.token).catch(() => { lost = true; activeRequest?.destroy(); process.stdin.destroy() }), 5000)
    // Another revision open in the slot is closed automatically before switching branches.
    await pool.prepare(lease.id, lease.token, source)
    await pool.validateCopy(lease.id)
    if (process.argv.includes('--open') && !pool.editorAlive(lease.id)) {
      const version = fs.readFileSync(path.join(lease.root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*(\S+)/m)?.[1]
      if (!version || !/^[\w.]+$/.test(version)) throw new Error('Invalid Unity version')
      const executable = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Unity/Hub/Editor', version, 'Editor/Unity.exe')
      if (!fs.existsSync(executable)) throw new Error('Install the slot Unity version with Hub first')
      await pool.check(lease.id, lease.token)
      const child = spawn(executable, ['-automated', '-projectPath', lease.root], { detached: true, stdio: 'ignore', windowsHide: true })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref()
      await pool.recordEditor(lease.id, lease.token, child.pid)
    }
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
        const descriptor = JSON.parse(fs.readFileSync(path.join(lease.root, 'Library/Pipeline/.unity-pipeline-port'), 'utf8'))
        const normalize = p => path.resolve(p).toLowerCase()
        if (!descriptor.projectPath || normalize(descriptor.projectPath) !== normalize(lease.root) || descriptor.mode !== 'editor' || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || !descriptor.evalToken || /[\r\n]/.test(descriptor.evalToken)) throw new Error('No matching slot editor; wait for import')
        const result = await new Promise((resolve, reject) => {
          const body = JSON.stringify({ command: request.command, parameters: request.parameters ?? {}, timeout: 15000 })
          const req = http.request({ hostname: '127.0.0.1', port: descriptor.port, path: '/api/exec', method: 'POST', headers: { Authorization: `Bearer ${descriptor.evalToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
            let size = 0; const chunks = []
            res.on('data', c => { size += c.length; if (size > 16 * 1024 * 1024) req.destroy(); else chunks.push(c) })
            res.on('error', () => reject(new Error('Pipeline response interrupted')))
            res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('Pipeline refused request'); resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(new Error('Invalid Pipeline response')) } })
          })
          activeRequest = req
          const deadline = setTimeout(() => req.destroy(), 20000)
          req.once('close', () => clearTimeout(deadline)); req.on('error', () => reject(new Error('Slot disconnected or lease lost'))); req.end(body)
        })
        await pool.check(lease.id, lease.token)
        output({ id: request.id, result })
      } catch(e) { output({ id: request?.id, error: e.message }) }
    }
  } catch (e) { output({ error: e.message }); process.exitCode = 1 } finally { await close() }
}
