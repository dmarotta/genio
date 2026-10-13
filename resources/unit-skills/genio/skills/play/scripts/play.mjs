// Long-lived, dependency-free unit session: lease and fence every Pipeline request.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { PlayPool } from './pool.mjs'

const { GENIO_PLAY_DATA: data, GENIO_PLAY_WORLD: world, GENIO_PLAY_SOURCE: source, GENIO_PLAY_ENGINE_ROOT: engineRoot = '', GENIO_TASK_ID: task } = process.env
if (!data || !world || !source || !task) throw new Error('Run this helper from a Genio Unity unit with its Play environment')
const pool = new PlayPool(data, world, engineRoot)
const owner = `unit:${task}`
let lease, timer, activeRequest, lost = false
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
async function close() {
  lost = true; clearInterval(timer); activeRequest?.destroy()
  if (lease) await pool.release(lease.id, lease.token)
  await pool.cancel(owner)
}
process.once('SIGINT', () => void close().finally(() => process.exit(130)))
process.once('SIGTERM', () => void close().finally(() => process.exit(143)))
try {
  while (!(lease = await pool.acquire(owner))) { output({ waiting: true }); await new Promise(r => setTimeout(r, 1000)) }
  timer = setInterval(() => void pool.check(lease.id, lease.token).catch(() => { lost = true; activeRequest?.destroy(); process.stdin.destroy() }), 5000)
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
  }
  output({ ready: true, slot: lease.id, project: lease.root })
  for await (const line of createInterface({ input: process.stdin })) {
    if (lost) throw new Error('Lease lost; session stopped')
    let request
    try {
      request = JSON.parse(line)
      if (!/^[a-z][a-z0-9_]{0,80}$/.test(request.command)) throw new Error('Invalid command')
      if (request.command === 'exit') break
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
} finally { await close() }
