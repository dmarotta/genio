/**
 * Genio's own sign-in for the player's remote MCP servers (docs/mcp-servers.md), through the MCP SDK's
 * OAuth client: protected resource and authorization server discovery, dynamic client registration,
 * PKCE S256 and the resource indicator, with the scope the server asks for.
 * - Genio checks a remote server once when it is saved: a 401 that leads to OAuth metadata with a
 *   registration endpoint marks it `signIn`, and Settings shows Sign in. A server without dynamic
 *   registration stays on a token header.
 * - Sign in opens the system browser (never a window of Genio's) and waits on a loopback callback at a
 *   random free port; the state parameter must match. Each sign-in registers again, because the port
 *   is part of the registered redirect URI.
 * - The registration and tokens are kept encrypted in the secret store (secrets.ts), never in the list
 *   file, a log, a brief or a unit's environment.
 * - Main is the only refresher, once per server however many calls saw the same 401. A refresh the
 *   server refuses forgets the sign-in, so Settings shows Sign in again and every later call answers
 *   "sign-in needed" without touching the server: no retry loop.
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServer } from '@shared/mcp'
import { readMcpServers, setMcpSignIn } from './mcp-servers'
import { clearMcpOAuth, getMcpOAuth, getMcpSecret, setMcpOAuth } from './secrets'

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

/** One server's sign-in as main keeps it, encrypted. */
interface SignIn {
  /** The authorization server discovery found, its metadata, and the resource the tokens are for. */
  as: string
  metadata?: AuthorizationServerMetadata
  resource?: string
  client: OAuthClientInformationMixed
  tokens: OAuthTokens
  obtainedAt: number
}

const SIGN_IN_TIMEOUT = 5 * 60_000
const CHECK_TIMEOUT = 8_000
/** A token this close to its expiry is refreshed before use. */
const EXPIRY_MARGIN = 60_000

const sdkAuth = () => import('@modelcontextprotocol/sdk/client/auth.js')

const initializeBody = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Genio', version: '1' } } })

/** The server's answer to an unauthenticated initialize: undefined when it does not ask for a sign-in. */
async function challenge(url: string, headers: Record<string, string>, fetchFn: FetchLike): Promise<{ resourceMetadataUrl?: URL; scope?: string } | undefined> {
  const res = await fetchFn(url, {
    method: 'POST', body: initializeBody, signal: AbortSignal.timeout(CHECK_TIMEOUT),
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  })
  void res.body?.cancel().catch(() => undefined)
  if (res.status !== 401) return undefined
  const { extractWWWAuthenticateParams } = await sdkAuth()
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res)
  return { resourceMetadataUrl, scope }
}

/**
 * Whether a remote server asks for Genio's sign-in: a 401 with OAuth metadata whose authorization
 * server offers dynamic registration. Undefined when the server could not be reached.
 */
export async function mcpSignInOffered(url: string, headers: Record<string, string> = {}, fetchFn: FetchLike = fetch): Promise<boolean | undefined> {
  try {
    const c = await challenge(url, headers, fetchFn)
    if (!c) return false
    const { discoverOAuthServerInfo } = await sdkAuth()
    const info = await discoverOAuthServerInfo(url, { resourceMetadataUrl: c.resourceMetadataUrl, fetchFn })
    return Boolean(info.authorizationServerMetadata?.registration_endpoint)
  } catch {
    return undefined
  }
}

/** Check a saved remote server once and record the answer; an unreachable server keeps what it had. */
export async function checkMcpSignIn(id: string, dataDir: string, fetchFn: FetchLike = fetch): Promise<void> {
  const s = readMcpServers(dataDir).find((x) => x.id === id)
  if (!s?.url) return
  const headers: Record<string, string> = {}
  for (const name of s.secrets) {
    const v = getMcpSecret(s.id, name, dataDir)
    if (v) headers[name] = v
  }
  const offered = await mcpSignInOffered(s.url, headers, fetchFn)
  if (offered !== undefined) setMcpSignIn(id, offered, dataDir)
}

const pending = new Map<string, () => void>()

const page = (text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Genio</title><body style="font:16px system-ui;margin:48px">${text}</body>`

/** Only an http(s) address leaves Genio for the browser: https, or http on this PC. */
function browserSafe(u: URL): boolean {
  return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
}

export interface SignInOptions {
  /** Opens the authorization page in the player's browser (shell.openExternal). */
  open(url: string): Promise<void> | void
  fetchFn?: FetchLike
  timeoutMs?: number
}

/**
 * The player's one sign-in for a server. Resolves 'signed-in', or 'cancelled' when the player declined,
 * started another sign-in for the same server, signed out, or the browser never came back.
 */
export async function mcpSignIn(id: string, dataDir: string, o: SignInOptions): Promise<'signed-in' | 'cancelled'> {
  const s: McpServer | undefined = readMcpServers(dataDir).find((x) => x.id === id)
  if (!s?.url || !s.signIn) throw new Error('That server does not ask for a sign-in.')
  const url = s.url
  const fetchFn = o.fetchFn ?? fetch
  pending.get(id)?.()

  let finish!: (r: { code?: string; cancelled?: boolean }) => void
  const result = new Promise<{ code?: string; cancelled?: boolean }>((r) => { finish = r })
  const state = randomBytes(32).toString('base64url')
  const callback = http.createServer((req, res) => {
    const from = req.socket.remoteAddress
    if (from !== '127.0.0.1' && from !== '::ffff:127.0.0.1') { req.socket.destroy(); return }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return }
    // A callback that is not this sign-in's (a stale tab, a forged link) is refused and the sign-in goes on waiting.
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page('This sign-in link is not the one Genio is waiting for. Start the sign-in again from Genio.'))
      return
    }
    const code = u.searchParams.get('code')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(code ? `Signed in to ${s.name}. You can close this tab.` : 'The sign-in was not completed. You can close this tab.'))
    finish(code ? { code } : { cancelled: true })
  })
  await new Promise<void>((resolve, reject) => {
    callback.once('error', reject)
    callback.listen(0, '127.0.0.1', () => { callback.removeListener('error', reject); resolve() })
  })
  const port = (callback.address() as { port: number }).port
  const redirectUrl = `http://127.0.0.1:${port}/callback`
  const timer = setTimeout(() => finish({ cancelled: true }), o.timeoutMs ?? SIGN_IN_TIMEOUT)
  let dropped = false
  const cancel = (): void => { dropped = true; finish({ cancelled: true }) }
  pending.set(id, cancel)

  // This sign-in's own registration, verifier and tokens: nothing is reused from an earlier one.
  let client: OAuthClientInformationMixed | undefined
  let tokens: OAuthTokens | undefined
  let verifier = ''
  let as = ''
  let metadata: AuthorizationServerMetadata | undefined
  let resource: string | undefined
  const provider = {
    get redirectUrl() { return redirectUrl },
    get clientMetadata() {
      return { client_name: 'Genio', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
    },
    state: () => state,
    clientInformation: () => client,
    saveClientInformation: (c: OAuthClientInformationMixed) => { client = c },
    tokens: () => tokens,
    saveTokens: (t: OAuthTokens) => { tokens = t },
    saveCodeVerifier: (v: string) => { verifier = v },
    codeVerifier: () => verifier,
    saveDiscoveryState: (d: { authorizationServerUrl: string; authorizationServerMetadata?: AuthorizationServerMetadata }) => {
      as = d.authorizationServerUrl
      metadata = d.authorizationServerMetadata
    },
    redirectToAuthorization: async (to: URL) => {
      if (!browserSafe(to)) throw new Error(`${s.name} sent a sign-in address Genio does not open.`)
      resource = to.searchParams.get('resource') ?? undefined
      await o.open(to.href)
    }
  }
  try {
    const { auth } = await sdkAuth()
    const asked = await challenge(url, {}, fetchFn).catch(() => undefined)
    const opts = { serverUrl: url, scope: asked?.scope, resourceMetadataUrl: asked?.resourceMetadataUrl, fetchFn }
    if (await auth(provider, opts) === 'REDIRECT') {
      const r = await result
      if (!r.code) return 'cancelled'
      await auth(provider, { ...opts, authorizationCode: r.code })
    }
    if (!client || !tokens?.access_token) throw new Error(`${s.name} did not give Genio a sign-in.`)
    // Removed, moved to another URL, signed out or signed in again meanwhile: this sign-in is dropped.
    const now = readMcpServers(dataDir).find((x) => x.id === id)
    if (dropped || now?.url !== url) return 'cancelled'
    const signIn: SignIn = { as: as || String((tokens as { issuer?: string }).issuer ?? ''), metadata, resource, client, tokens, obtainedAt: Date.now() }
    setMcpOAuth(id, signIn, dataDir)
    return 'signed-in'
  } finally {
    clearTimeout(timer)
    if (pending.get(id) === cancel) pending.delete(id)
    callback.close()
    callback.closeAllConnections()
  }
}

/** Forget the server's sign-in (and stop one in progress). Its next call answers "sign-in needed". */
export function mcpSignOut(id: string, dataDir: string): void {
  pending.get(id)?.()
  clearMcpOAuth(id, dataDir)
}

const refreshing = new Map<string, Promise<string | undefined>>()

const stale = (s: SignIn): boolean =>
  typeof s.tokens.expires_in === 'number' && Date.now() > s.obtainedAt + s.tokens.expires_in * 1000 - EXPIRY_MARGIN

/** The current access token, refreshed first when it is about to expire; undefined means the player must sign in. */
export async function mcpAccessToken(id: string, dataDir: string, fetchFn: FetchLike = fetch): Promise<string | undefined> {
  const s = getMcpOAuth<SignIn>(id, dataDir)
  if (!s?.tokens?.access_token) return undefined
  return stale(s) ? mcpTokenRefused(id, s.tokens.access_token, dataDir, fetchFn) : s.tokens.access_token
}

/**
 * The server refused `token` (HTTP 401): one refresh, shared by every caller that saw the same token.
 * A caller whose token was already replaced just gets the new one.
 */
export function mcpTokenRefused(id: string, token: string, dataDir: string, fetchFn: FetchLike = fetch): Promise<string | undefined> {
  const running = refreshing.get(id)
  if (running) return running
  const s = getMcpOAuth<SignIn>(id, dataDir)
  if (!s?.tokens?.access_token) return Promise.resolve(undefined)
  if (s.tokens.access_token !== token) return Promise.resolve(s.tokens.access_token)
  const current = (): boolean => getMcpOAuth<SignIn>(id, dataDir)?.tokens?.access_token === token
  const p = (async (): Promise<string | undefined> => {
    if (!s.tokens.refresh_token) {
      clearMcpOAuth(id, dataDir)
      return undefined
    }
    const { refreshAuthorization } = await sdkAuth()
    const { OAuthError } = await import('@modelcontextprotocol/sdk/server/auth/errors.js')
    try {
      const t = await refreshAuthorization(s.as, { metadata: s.metadata, clientInformation: s.client, refreshToken: s.tokens.refresh_token, resource: s.resource, fetchFn })
      if (!current()) return getMcpOAuth<SignIn>(id, dataDir)?.tokens?.access_token
      setMcpOAuth(id, { ...s, tokens: { ...t, refresh_token: t.refresh_token ?? s.tokens.refresh_token }, obtainedAt: Date.now() }, dataDir)
      return t.access_token
    } catch (e) {
      // The server refused the refresh (expired, revoked): the player signs in again. A network
      // problem keeps the sign-in, and only this call fails.
      if (!(e instanceof OAuthError)) throw e
      if (current()) clearMcpOAuth(id, dataDir)
      return undefined
    }
  })()
  refreshing.set(id, p)
  void p.finally(() => { if (refreshing.get(id) === p) refreshing.delete(id) }).catch(() => undefined)
  return p
}

/** The server refused a token it had just been given: the sign-in no longer works. */
export function mcpSignInRefused(id: string, token: string, dataDir: string): void {
  if (getMcpOAuth<SignIn>(id, dataDir)?.tokens?.access_token === token) clearMcpOAuth(id, dataDir)
}
