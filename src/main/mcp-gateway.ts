/**
 * The MCP gateway (docs/mcp-servers.md). Genio's main process is the only MCP
 * client of the player's servers. A Claude or Codex unit, and the Claude chat
 * (chat-mcp.ts), gets one thin stdio
 * relay per server in scope (resources/genio-mcp-relay.mjs), which pipes
 * JSON-RPC to this loopback listener with a per-launch secret bound to that
 * unit and those servers. The gateway then:
 * - starts a local server itself, in the unit's worktree, with only system
 *   variables and that server's own secrets (never the unit's environment: no
 *   FAL, Uthana or OpenRouter key), or calls a remote one over streamable HTTP
 *   with its secret headers, and with the access token of Genio's sign-in for a
 *   server that asks for one (mcp-signin.ts: main is the only refresher, and a
 *   sign-in that no longer works answers 'sign-in needed' with no retry);
 * - logs every tools/call (server, tool, time, ok) and each server's tool
 *   count in the unit's data folder, never arguments or results, and reports a
 *   failed call once as a plain timeline line;
 * - drops a unit's relays when the unit stops, and refuses a server removed
 *   from Settings or out of the unit's project, and a Chat only server to any
 *   caller that is not the chat, whatever its grant names.
 * Units never see a secret value, and no harness sees an HTTP server, so their
 * own OAuth never runs.
 */
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import type { McpServer } from '@shared/mcp'
import { mcpServersFor } from '@shared/mcp'
import { settingsPath } from '@shared/settings-pages'
import { readMcpServers } from './mcp-servers'
import { mcpAccessToken, mcpSignInRefused, mcpTokenRefused } from './mcp-signin'
import { getMcpSecret } from './secrets'
import { appendJsonl, nowIso } from './util'

/** System variables a local server gets (the MCP SDK's default list, plus what Windows programs expect). Nothing else is inherited. */
export const MCP_SYSTEM_ENV = process.platform === 'win32'
  ? ['APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
  : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'TMPDIR']

/** A local server's whole environment: system variables from `base`, then its own secrets. */
export function mcpServerEnv(secrets: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  const wanted = new Set(MCP_SYSTEM_ENV)
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string' && !v.startsWith('()') && wanted.has(k.toUpperCase())) env[k] = v
  }
  return { ...env, ...secrets }
}

export interface McpCaller {
  /** The unit's id, or `chat:<base>` for a Claude chat. */
  id: string
  /** Who reads a refusal: a unit stops and asks with a keyed choice, the chat tells the player. Only the chat gets Chat only servers. Default unit. */
  kind?: 'unit' | 'chat'
  /** Its project: servers scoped to another project are refused. */
  project: string
  /** Its worktree: the cwd of every local server it uses. */
  cwd: string
  /** Main base data folder: the server list and the secret store. */
  dataDir: string
  /** The call log, in the unit's data folder. */
  logFile: string
  /** A failed call, as one plain sentence for the unit's timeline. */
  onFailure?(text: string): void
  /** A tool call that worked. */
  onSuccess?(server: string, tool: string): void
}

export interface McpGrant {
  /** Merged into the unit's environment; the relays read them. */
  env: { GENIO_MCP_GATEWAY: string; GENIO_MCP_SECRET: string }
  servers: McpServer[]
  /** End this launch's access: its relays close and its servers stop. */
  revoke(): void
}

interface Upstream {
  onmessage?: (m: unknown) => void
  onerror?: (e: Error) => void
  onclose?: () => void
  start(): Promise<void>
  send(m: unknown): Promise<void>
  close(): Promise<void>
  setProtocolVersion?(v: string): void
}

interface Grant { caller: McpCaller; servers: Set<string>; sockets: Set<net.Socket> }

/** The caller's servers as Settings has them now: its project's, and Chat only ones for the chat alone. */
const inScope = (caller: McpCaller): McpServer[] => mcpServersFor(readMcpServers(caller.dataDir), caller.project, caller.kind === 'chat' ? 'chat' : 'unit')

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: unknown }; result?: { isError?: boolean; tools?: unknown[]; protocolVersion?: string }; error?: unknown }

const MAX_LINE = 16 * 1024 * 1024

export interface McpGateway {
  /** A per-launch secret for these servers, bound to this caller. Revoke it when the caller stops. */
  grant(caller: McpCaller, servers: McpServer[]): Promise<McpGrant>
  /** Close the caller's relays and its servers; its secret stops working. */
  revoke(callerId: string): void
  close(): Promise<void>
}

export function createMcpGateway(o: { secret?: (s: McpServer, name: string, dataDir: string) => string | undefined; baseEnv?: NodeJS.ProcessEnv } = {}): McpGateway {
  const secretOf = o.secret ?? ((s, name, dataDir) => getMcpSecret(s.id, name, dataDir))
  const grants = new Map<string, Grant>()
  let server: net.Server | undefined
  let port = 0
  let listening: Promise<void> | undefined

  const listen = (): Promise<void> => (listening ??= new Promise<void>((resolve, reject) => {
    server = net.createServer(connection)
    server.maxConnections = 256
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server!.removeListener('error', reject)
      const a = server!.address()
      port = a && typeof a === 'object' ? a.port : 0
      resolve()
    })
  }))

  function connection(sock: net.Socket): void {
    if (sock.remoteAddress !== '127.0.0.1' && sock.remoteAddress !== '::ffff:127.0.0.1') { sock.destroy(); return }
    sock.setEncoding('utf8')
    let buf = ''
    let grant: Grant | undefined
    let srv: McpServer | undefined
    let up: Upstream | undefined
    let ready: Promise<void> | undefined
    let secrets: string[] = []
    /** Access tokens this connection sent: hidden like secrets. */
    const tokens = new Set<string>()
    /** The last request found no working sign-in. */
    let signInNeeded = false
    let closed = false
    /** Requests the server has not answered yet, by JSON-RPC id. */
    const pending = new Map<string, { m: Rpc; tool?: string; at: number }>()
    let answered = false
    const failedOnce = new Set<string>()
    const hide = (text: string): string => [...secrets, ...tokens].reduce((t, v) => (v.length >= 4 ? t.split(v).join('***') : t), text)
    const write = (m: unknown): void => { if (!closed && !sock.destroyed) sock.write(JSON.stringify(m) + '\n') }
    const log = (rec: Record<string, unknown>): void => {
      if (!grant || !srv) return
      try { appendJsonl(grant.caller.logFile, { at: nowIso(), server: srv.name, ...rec }) } catch { /* a log problem never breaks a call */ }
    }
    /** One timeline line per tool (or start) until it works again. */
    const reportFailure = (tool: string, why: string): void => {
      if (failedOnce.has(tool) || !grant?.caller.onFailure || !srv) return
      failedOnce.add(tool)
      try { grant.caller.onFailure(`MCP server ${srv.name}: ${tool ? `${tool} failed` : 'could not start'} (${why}).`) } catch { /* the timeline is best effort */ }
    }
    const shut = (): void => {
      if (closed) return
      closed = true
      grant?.sockets.delete(sock)
      sock.destroy()
      void up?.close().catch(() => undefined)
    }
    /** The server as Settings has it now: removed, moved to another project or made Chat only (for a unit) means refused. */
    const current = (): McpServer | undefined => {
      if (!grant || !srv) return undefined
      const now = inScope(grant.caller).find((s) => s.id === srv!.id)
      return now && grant.servers.has(now.id) ? now : undefined
    }
    const refused = (e: unknown): number | undefined => {
      const status = (e as { code?: unknown })?.code
      return status === 401 || status === 403 ? status : undefined
    }
    /** Why, in a few words for the timeline; never a secret. */
    const reason = (e: unknown): string => {
      if (signInNeeded && refused(e) === 401) return 'sign-in needed'
      const status = refused(e)
      return status ? `the server refused its credentials, HTTP ${status}` : hide(String((e as Error)?.message ?? e)).replace(/\s+/g, ' ').slice(0, 160)
    }
    /** What the caller's model reads: a unit stops and asks with a keyed choice, the chat tells the player in plain words. */
    const unavailable = (e: unknown): string => {
      const chat = grant?.caller.kind === 'chat'
      if (signInNeeded && refused(e) === 401) return chat
        ? `${srv?.name} needs the player to sign in to it again. Do not retry this server; tell the player in plain words to sign in to ${srv?.name} again in ${settingsPath('harnesses')}.`
        : `${srv?.name} needs the player to sign in to it again in Settings. Do not retry this server: append needs-decision [key=mcp-auth] naming ${srv?.name}, then stop.`
      if (refused(e)) return chat
        ? `${srv?.name} refused Genio's credentials (HTTP ${refused(e)}). Do not retry this server; tell the player in plain words to check its secret in ${settingsPath('harnesses')}.`
        : `${srv?.name} refused Genio's credentials (HTTP ${refused(e)}). Do not retry this server; ask the player to check its secret in Settings (needs-decision key=mcp-auth).`
      return `${srv?.name ?? 'The MCP server'} is unavailable: ${hide(String((e as Error)?.message ?? e)).slice(0, 300)}`
    }
    const fail = (m: Rpc, e: unknown): void => {
      const text = unavailable(e)
      if (m.method === 'tools/call') {
        const tool = typeof m.params?.name === 'string' ? m.params.name : '?'
        log({ tool, ok: false, ms: 0 })
        reportFailure(tool, reason(e))
      }
      if (m.id !== undefined && m.id !== null) {
        if (m.method === 'tools/call') write({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text }] } })
        else write({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: text } })
      }
    }
    const fromUpstream = (raw: unknown): void => {
      const m = raw as Rpc
      if (m && m.id !== undefined && m.id !== null && (m.result !== undefined || m.error !== undefined)) {
        const key = JSON.stringify(m.id)
        const p = pending.get(key)
        pending.delete(key)
        answered = true
        if (p?.tool !== undefined) {
          const ok = m.error === undefined && m.result?.isError !== true
          log({ tool: p.tool, ok, ms: Date.now() - p.at })
          if (ok) {
            failedOnce.delete(p.tool)
            try { grant?.caller.onSuccess?.(srv!.name, p.tool) } catch { /* achievements are best effort */ }
          } else reportFailure(p.tool, m.error !== undefined ? 'the server returned an error' : 'the tool reported an error')
        } else if (p?.m.method === 'tools/list' && Array.isArray(m.result?.tools)) log({ tools: m.result!.tools!.length })
        else if (p?.m.method === 'initialize' && typeof m.result?.protocolVersion === 'string') up?.setProtocolVersion?.(m.result.protocolVersion)
      }
      write(m)
    }
    /**
     * Requests to a server with Genio's sign-in carry its current access token. A 401 asks main for
     * one refresh (shared with every other caller) and retries once; no token means no request at all.
     */
    const signedIn = (s: McpServer, dataDir: string) => async (url: string | URL, init?: RequestInit): Promise<Response> => {
      let token = await mcpAccessToken(s.id, dataDir)
      for (let attempt = 0; ; attempt++) {
        if (!token) {
          signInNeeded = true
          return new Response('{"error":"sign_in_required"}', { status: 401, headers: { 'content-type': 'application/json' } })
        }
        tokens.add(token)
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${token}`)
        const res = await fetch(url, { ...init, headers })
        if (res.status !== 401) {
          signInNeeded = false
          return res
        }
        if (attempt) {
          mcpSignInRefused(s.id, token, dataDir)
          signInNeeded = true
          return res
        }
        void res.body?.cancel().catch(() => undefined)
        token = await mcpTokenRefused(s.id, token, dataDir)
      }
    }
    const open = async (): Promise<void> => {
      const s = srv!
      const vals: Record<string, string> = {}
      for (const name of s.secrets) {
        const v = secretOf(s, name, grant!.caller.dataDir)
        if (v) vals[name] = v
      }
      secrets = Object.values(vals)
      if (s.url) {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        up = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: vals }, ...(s.signIn ? { fetch: signedIn(s, grant!.caller.dataDir) } : {}) }) as unknown as Upstream
      } else {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        up = new StdioClientTransport({ command: s.command!, args: s.args ?? [], env: mcpServerEnv(vals, o.baseEnv), cwd: grant!.caller.cwd, stderr: 'ignore' }) as unknown as Upstream
      }
      up.onmessage = fromUpstream
      up.onerror = () => undefined
      // A server that exits still answers every request it was sent, then the relay closes.
      up.onclose = () => {
        const gone = new Error(answered ? 'the server exited' : 'the server exited before it answered')
        if (!answered) reportFailure('', gone.message)
        for (const p of [...pending.values()]) fail(p.m, gone)
        pending.clear()
        shut()
      }
      await up.start()
    }
    const hello = (line: string): void => {
      let h: { secret?: unknown; server?: unknown }
      try { h = JSON.parse(line) } catch { shut(); return }
      grant = typeof h.secret === 'string' ? grants.get(h.secret) : undefined
      const name = typeof h.server === 'string' ? h.server : ''
      srv = grant ? inScope(grant.caller).find((s) => s.name === name && grant!.servers.has(s.id)) : undefined
      if (!grant || !srv) { grant = undefined; shut(); return }
      grant.sockets.add(sock)
      ready = open()
      ready.catch((e) => {
        log({ started: false })
        reportFailure('', reason(e))
      })
    }
    const fromRelay = (line: string): void => {
      let m: Rpc
      try { m = JSON.parse(line) } catch { return }
      if (!m || typeof m !== 'object') return
      const key = m.id !== undefined && m.id !== null && typeof m.method === 'string' ? JSON.stringify(m.id) : undefined
      if (key) pending.set(key, { m, tool: m.method === 'tools/call' ? (typeof m.params?.name === 'string' ? m.params.name : '?') : undefined, at: Date.now() })
      ready!.then(() => {
        if (m.method === 'tools/call' && !current()) {
          if (key) pending.delete(key)
          fail(m, new Error(grant!.caller.kind === 'chat' ? 'the player removed this server or it no longer applies to this project'
            : 'the player removed this server, or it no longer applies to this project or to units'))
          shut()
          return
        }
        return up!.send(m)
      }).catch((e) => {
        if (key) pending.delete(key)
        fail(m, e)
      })
    }
    sock.on('data', (d: string) => {
      buf += d
      if (buf.length > MAX_LINE) { shut(); return }
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\uFEFF/, '').trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        if (!srv) { if (closed) return; hello(line); continue }
        fromRelay(line)
      }
    })
    sock.on('close', shut)
    sock.on('error', shut)
  }

  return {
    async grant(caller, servers) {
      await listen()
      const secret = randomBytes(32).toString('hex')
      // A unit's grant never holds a Chat only server, even when its caller passes one.
      if (caller.kind !== 'chat') servers = servers.filter((s) => !s.chatOnly)
      const g: Grant = { caller, servers: new Set(servers.map((s) => s.id)), sockets: new Set() }
      grants.set(secret, g)
      const revoke = (): void => {
        if (grants.get(secret) === g) grants.delete(secret)
        for (const s of g.sockets) s.destroy()
      }
      return { env: { GENIO_MCP_GATEWAY: `127.0.0.1:${port}`, GENIO_MCP_SECRET: secret }, servers, revoke }
    },
    revoke(callerId) {
      for (const [k, g] of grants) {
        if (g.caller.id !== callerId) continue
        grants.delete(k)
        for (const s of g.sockets) s.destroy()
      }
    },
    async close() {
      for (const g of grants.values()) for (const s of g.sockets) s.destroy()
      grants.clear()
      const s = server
      server = undefined
      listening = undefined
      if (s) await new Promise<void>((r) => s.close(() => r()))
    }
  }
}

let shared: McpGateway | undefined
/** Genio's one gateway, started on the first unit that gets a server. */
export const mcpGateway = (): McpGateway => (shared ??= createMcpGateway())
