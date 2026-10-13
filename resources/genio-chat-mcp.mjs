#!/usr/bin/env node
// Dependency-free stdio MCP transport. All authority and execution stay in the
// running Electron app. Never write diagnostics, tokens or arguments to stdout.
import http from 'node:http'

const endpoint = process.env.GENIO_BRIDGE_URL
const token = process.env.GENIO_BRIDGE_TOKEN
delete process.env.GENIO_BRIDGE_TOKEN
delete process.env.GENIO_BRIDGE_URL
let url
try { url = new URL(endpoint) } catch { process.exit(1) }
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc' ||
  url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(token ?? '')) process.exit(1)

function forward(rpc) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rpc)
    const req = http.request(url, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, res => {
      let size = 0
      const chunks = []
      res.on('data', chunk => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) { res.destroy(); reject(new Error('Response too large')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('Bridge unavailable')); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Invalid response')) }
      })
    })
    // Permission dialogs can wait up to ten minutes. Never retry a mutation.
    req.setTimeout(11 * 60_000, () => req.destroy(new Error('Bridge timeout')))
    req.on('error', reject)
    req.end(body)
  })
}
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
let pending = Buffer.alloc(0), active = 0, ending = false
const finish = async () => {
  if (ending) return
  ending = true
  clearInterval(heartbeat)
  // EOF/process shutdown revokes this capability in the app, including requests
  // waiting for approval. A killed process is cleaned up by the chat lifecycle.
  await Promise.race([forward({ jsonrpc: '2.0', id: 'close', method: 'bridge/close' }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 1000))])
  process.exit(0)
}
async function handle(line) {
  let rpc
  try { rpc = JSON.parse(line) } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' ||
    (rpc.id !== undefined && typeof rpc.id !== 'number' && typeof rpc.id !== 'string')) {
    output({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return
  }
  if (active >= 8) {
    if (rpc.id !== undefined) output({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'Too many requests' } })
    return
  }
  active++
  try {
    const response = await forward(rpc)
    if (rpc.id !== undefined) output(response)
  } catch {
    if (rpc.id !== undefined) output({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'Genio bridge unavailable; request was not retried' } })
  } finally { active-- }
}
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk])
  let newline
  while ((newline = pending.indexOf(10)) >= 0) {
    if (newline > 1024 * 1024) { void finish(); return }
    const line = pending.subarray(0, newline).toString('utf8')
    pending = pending.subarray(newline + 1)
    if (line.trim()) void handle(line)
  }
  if (pending.length > 1024 * 1024) void finish()
})
process.stdin.on('end', finish)
process.on('SIGTERM', finish)
process.on('SIGINT', finish)
process.stdout.on('error', finish)
const heartbeat = setInterval(() => {
  void forward({ jsonrpc: '2.0', id: 'heartbeat', method: 'ping' }).catch(() => process.exit(1))
}, 15_000)
heartbeat.unref()
