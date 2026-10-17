// A remote MCP server with its own OAuth 2.1 authorization server, on loopback, for the sign-in tests.
// Trimmed from the MCP Recon's as-server.mjs. It serves RFC 9728 and RFC 8414 metadata and dynamic
// registration (RFC 7591), checks PKCE S256, the redirect URI and the resource, and rotates refresh
// tokens (reusing a spent one kills its family). /authorize approves at once: it stands in for the
// player's consent in the browser. expire() drops every access token; revoke() kills every grant.
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

export interface OAuthLog { path: string; [k: string]: unknown }

export async function startOAuthServer(o: { ttl?: number; registration?: boolean } = {}) {
  const ttl = o.ttl ?? 3600
  const log: OAuthLog[] = []
  /** Every token it ever issued, to check none leaks. */
  const issued: string[] = []
  const clients = new Map<string, { redirect_uris?: string[] }>()
  const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; resource?: string }>()
  const access = new Map<string, { exp: number; family: string }>()
  const refresh = new Map<string, { family: string; used: boolean }>()
  const dead = new Set<string>()
  const rnd = (): string => randomBytes(12).toString('hex')
  const b64url = (b: Buffer): string => b.toString('base64url')
  let base = ''

  const issue = (family: string) => {
    const a = 'at_' + rnd(), r = 'rt_' + rnd()
    issued.push(a, r)
    access.set(a, { exp: Date.now() + ttl * 1000, family })
    refresh.set(r, { family, used: false })
    return { access_token: a, token_type: 'Bearer', expires_in: ttl, refresh_token: r, scope: 'recon' }
  }
  const revoke = (): void => { for (const r of refresh.values()) dead.add(r.family); access.clear() }
  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base)
      const p = url.pathname
      if (p === '/.well-known/oauth-protected-resource/mcp' || p === '/.well-known/oauth-protected-resource') {
        log.push({ path: 'prm' })
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['recon'], bearer_methods_supported: ['header'] })
      }
      if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration') {
        log.push({ path: 'as-metadata' })
        return json(res, 200, {
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          ...(o.registration === false ? {} : { registration_endpoint: `${base}/register` }),
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['recon']
        })
      }
      if (p === '/register' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}') as { client_name?: string; redirect_uris?: string[] }
        const client_id = 'cl_' + rnd()
        clients.set(client_id, body)
        log.push({ path: 'register', client_name: body.client_name, redirect_uris: body.redirect_uris, client_id })
        return json(res, 201, { ...body, client_id, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: 'none' })
      }
      if (p === '/authorize') {
        const q = Object.fromEntries(url.searchParams)
        const c = clients.get(q.client_id)
        const ok = !!c && !!c.redirect_uris?.includes(q.redirect_uri) && q.code_challenge_method === 'S256' && !!q.code_challenge && q.response_type === 'code'
        log.push({ path: 'authorize', redirect: q.redirect_uri, pkce: q.code_challenge_method, resource: q.resource, state: q.state, scope: q.scope, ok })
        if (!ok) return json(res, 400, { error: 'invalid_request' })
        const code = 'code_' + rnd()
        codes.set(code, { client_id: q.client_id, redirect_uri: q.redirect_uri, challenge: q.code_challenge, resource: q.resource })
        const to = new URL(q.redirect_uri)
        to.searchParams.set('code', code)
        if (q.state) to.searchParams.set('state', q.state)
        res.writeHead(302, { location: to.toString() })
        return res.end()
      }
      if (p === '/token' && req.method === 'POST') {
        const f = Object.fromEntries(new URLSearchParams(raw))
        if (f.grant_type === 'authorization_code') {
          const c = codes.get(f.code)
          codes.delete(f.code)
          const pkceOk = !!c && b64url(createHash('sha256').update(f.code_verifier || '').digest()) === c.challenge
          const ok = !!c && pkceOk && c.client_id === f.client_id && c.redirect_uri === f.redirect_uri && c.resource === f.resource
          log.push({ path: 'token', grant: 'authorization_code', pkceOk, resource: f.resource, ok })
          if (!ok) return json(res, 400, { error: 'invalid_grant' })
          return json(res, 200, issue(rnd()))
        }
        if (f.grant_type === 'refresh_token') {
          const r = refresh.get(f.refresh_token)
          if (!r || dead.has(r.family)) { log.push({ path: 'token', grant: 'refresh_token', ok: false }); return json(res, 400, { error: 'invalid_grant' }) }
          if (r.used) { dead.add(r.family); log.push({ path: 'token', grant: 'refresh_token', ok: false, reuse: true }); return json(res, 400, { error: 'invalid_grant' }) }
          r.used = true
          log.push({ path: 'token', grant: 'refresh_token', resource: f.resource, ok: true })
          return json(res, 200, issue(r.family))
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }
      if (p === '/mcp' && req.method === 'POST') {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
        const t = m ? access.get(m[1]) : undefined
        const ok = !!t && t.exp > Date.now() && !dead.has(t.family)
        let rpc: { id?: unknown; method?: string; params?: { protocolVersion?: string; arguments?: { text?: string } } }
        try { rpc = JSON.parse(raw) } catch { return json(res, 400, { error: 'bad json' }) }
        log.push({ path: 'mcp', method: rpc.method, ok })
        if (!ok) return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="recon"` })
        if (rpc.id === undefined) { res.writeHead(202); return res.end() }
        const result = rpc.method === 'initialize' ? { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oauth-mock', version: '1' } }
          : rpc.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
          : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: `OAUTH-OK: ${rpc.params?.arguments?.text ?? ''}` }] }
          : {}
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result })
      }
      if (p === '/mcp') { res.writeHead(405); return res.end() }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    url: `${base}/mcp`,
    log,
    issued,
    expire: (): void => { access.clear() },
    revoke,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
  }
}
