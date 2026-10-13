import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'
import path from 'node:path'
import type { AppCtx } from './services'
import { createChatToolSession, type ChatToolBinding } from './chat-tool-session'

const MAX_BODY = 1024 * 1024
interface LiveBridge { bot: boolean; close(): Promise<void> }
const sessions = new WeakMap<AppCtx, Map<string, Set<LiveBridge>>>()
export interface BridgeAudit { event: 'started' | 'closed' | 'rejected' | 'call'; tool?: string }

/** Called on chat stop/restart, including ally retirement and app shutdown. */
export async function closeChatToolBridges(ctx: AppCtx, chat: string, role?: 'genio' | 'bot'): Promise<void> {
  await Promise.all([...sessions.get(ctx)?.get(chat) ?? []]
    .filter(b => role === undefined || b.bot === (role === 'bot')).map(b => b.close()))
}

/** Creates one authenticated capability per runtime session. The endpoint and
 * bearer token belong only in the child's environment, never argv or prompts.
 */
export async function openChatToolBridge(getCtx: () => AppCtx, binding: ChatToolBinding,
  options: { audit?: (event: BridgeAudit) => void; requestsPerMinute?: number } = {}) {
  if (binding.signal.aborted) throw new Error('Chat already closed')
  const lifetime = new AbortController()
  const session = createChatToolSession(getCtx, { ...binding, signal: lifetime.signal })
  const token = randomBytes(32).toString('hex')
  const expected = Buffer.from(`Bearer ${token}`)
  const sockets = new Set<Socket>()
  let windowStart = Date.now(), requests = 0, active = 0
  let closing: Promise<void> | undefined
  let listening: Promise<void>
  const audit = (event: BridgeAudit) => {
    try {
      if (options.audit) options.audit(event)
      else console.info('[chat-tool-bridge]', event.event, event.tool ?? '')
    } catch { /* observability cannot grant or prevent execution */ }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
    }
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0 }
    if (++requests > (options.requestsPerMinute ?? 120) || active >= 8) { audit({ event: 'rejected' }); send(429, { error: 'Rate limited' }); return }
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (lifetime.signal.aborted || req.socket.remoteAddress !== '127.0.0.1' || req.headers.origin ||
      auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      audit({ event: 'rejected' }); send(403, { error: 'Forbidden' }); return
    }
    if (req.method !== 'POST' || req.url !== '/rpc') { send(404, { error: 'Not found' }); return }
    active++
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY) { send(413, { error: 'Request too large' }); return }
        chunks.push(chunk)
      }
      if (lifetime.signal.aborted) { send(410, { error: 'Chat closed' }); return }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' ||
        (rpc.id !== undefined && typeof rpc.id !== 'number' && typeof rpc.id !== 'string')) {
        send(400, { error: 'Invalid request' }); return
      }
      const reply = (result: unknown) => send(200, { jsonrpc: '2.0', id: rpc.id, result })
      switch (rpc.method) {
        case 'initialize':
          reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'genio', version: '1.0.0' } }); break
        case 'notifications/initialized': case 'notifications/cancelled':
          send(200, {}); break
        case 'ping': reply({}); break
        case 'tools/list': reply({ tools: session.list() }); break
        case 'tools/call': {
          const name = rpc.params?.name
          if (typeof name !== 'string') { send(400, { error: 'Invalid tool name' }); break }
          // Log only registry-owned identifiers, never arbitrary model strings.
          if (session.list().some(t => t.name === name)) audit({ event: 'call', tool: name })
          reply(await session.call(name, rpc.params?.arguments ?? {})); break
        }
        case 'bridge/close': reply({}); void close(); break
        default: send(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } })
      }
    } catch { send(400, { error: 'Invalid bridge request' }) }
    finally { active-- }
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.maxHeadersCount = 16
  server.maxConnections = 32
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('clientError', (_error, socket) => socket.destroy())
  const ctx = getCtx()
  let chats = sessions.get(ctx)
  if (!chats) sessions.set(ctx, chats = new Map())
  let closers = chats.get(binding.home.name)
  if (!closers) chats.set(binding.home.name, closers = new Set())
  const live = { bot: binding.role === 'bot', close }
  const onAbort = () => { void close() }
  function close(): Promise<void> {
    if (closing) return closing
    lifetime.abort()
    binding.signal.removeEventListener('abort', onAbort)
    closers!.delete(live)
    if (!closers!.size) chats!.delete(binding.home.name)
    closing = (async () => {
      await listening.catch(() => undefined)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      audit({ event: 'closed' })
    })()
    return closing
  }
  // Register before yielding so a chat stop during listen cannot miss us.
  listening = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  closers.add(live)
  binding.signal.addEventListener('abort', onAbort, { once: true })
  try { await listening } catch (error) { await close(); throw error }
  if (binding.signal.aborted || lifetime.signal.aborted) { await close(); throw new Error('Chat already closed') }
  const address = server.address()
  if (!address || typeof address === 'string') { await close(); throw new Error('Bridge did not bind') }
  audit({ event: 'started' })
  return {
    env: { GENIO_BRIDGE_URL: `http://127.0.0.1:${address.port}/rpc`, GENIO_BRIDGE_TOKEN: token },
    /** Run with Node, or Electron with ELECTRON_RUN_AS_NODE=1. No worker harness flags. */
    entry: path.join(ctx.appRoot, 'resources', 'genio-chat-mcp.mjs'),
    close
  }
}
