import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice(4), 'hex').toString('utf8')
  }
}))

import { createMcpGateway, type McpCaller, type McpGateway } from '../src/main/mcp-gateway'
import { mcpServerViews, readMcpServers, removeMcpServer, saveMcpServer } from '../src/main/mcp-servers'
import { checkMcpSignIn, mcpAccessToken, mcpSignIn, mcpSignInOffered, mcpSignOut, mcpTokenRefused } from '../src/main/mcp-signin'
import { getMcpOAuth } from '../src/main/secrets'
import { startOAuthServer } from './fixtures/mcp-oauth-server'

const RELAY = path.join(__dirname, '..', 'resources', 'genio-mcp-relay.mjs')

let dir: string, mock: Awaited<ReturnType<typeof startOAuthServer>>, gateway: McpGateway
const relays: ChildProcessWithoutNullStreams[] = []
const failures: string[] = []
/** Everything a relay wrote back to its unit. */
const toUnit: string[] = []
const consoleOut: string[] = []
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mcp-signin-'))
  failures.length = 0
  toUnit.length = 0
  consoleOut.length = 0
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { consoleOut.push(a.map(String).join(' ')) })
  mock = await startOAuthServer()
  gateway = createMcpGateway()
})
afterEach(async () => {
  for (const r of relays.splice(0)) r.kill()
  await gateway.close()
  await mock.close()
  vi.restoreAllMocks()
  // A relay just killed may still hold its folder for a moment on Windows.
  for (let i = 0; ; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break } catch (e) {
      if (i > 30) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
})

const caller = (): McpCaller => ({ id: 'u1', project: 'alpha', cwd: dir, dataDir: dir, logFile: path.join(dir, 'u1', 'mcp-calls.jsonl'), onFailure: (t) => failures.push(t) })

/** Add the remote server and run Genio's check, as a save in Settings does. */
async function addRemote(url = mock.url, name = 'tracker') {
  saveMcpServer({ name, url, secrets: [] }, dir, [])
  const s = readMcpServers(dir).find((x) => x.name === name)!
  await checkMcpSignIn(s.id, dir)
  return readMcpServers(dir).find((x) => x.id === s.id)!
}

/** The player's browser: it follows the authorization page, which the mock approves at once, back to Genio's callback. */
const opened: string[] = []
function browser(o: { before?: (callback: URL) => Promise<void> } = {}) {
  return async (url: string): Promise<void> => {
    opened.push(url)
    const r = await fetch(url, { redirect: 'manual' })
    const callback = new URL(r.headers.get('location')!)
    await o.before?.(callback)
    await fetch(callback)
  }
}

async function signedIn(id: string) {
  expect(await mcpSignIn(id, dir, { open: browser() })).toBe('signed-in')
}

function relay(server: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [RELAY, server], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env }, cwd: dir })
  relays.push(child)
  const waiting = new Map<number, (m: { result?: { content?: { text: string }[]; isError?: boolean }; error?: { message: string } }) => void>()
  createInterface({ input: child.stdout }).on('line', (l) => { toUnit.push(l); const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id) })
  let id = 0
  const rpc = (method: string, params?: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof waiting.get>>>[0]>((resolve) => {
    const n = ++id
    waiting.set(n, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
  })
  const init = async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return r
  }
  const call = (text: string) => rpc('tools/call', { name: 'echo', arguments: { text } })
  return { rpc, init, call }
}

const grants = (kind: string) => mock.log.filter((l) => l.path === 'token' && l.grant === kind)

describe('the check on save', () => {
  it('offers sign-in only for a 401 with OAuth metadata and dynamic registration', async () => {
    expect(await mcpSignInOffered(mock.url)).toBe(true)
    const noRegistration = await startOAuthServer({ registration: false })
    try { expect(await mcpSignInOffered(noRegistration.url)).toBe(false) } finally { await noRegistration.close() }
    // A server that answers without asking for a token stays as it is.
    expect(await mcpSignInOffered(`${mock.base}/not-mcp`)).toBe(false)
    const free = net.createServer()
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', () => r()))
    const port = (free.address() as { port: number }).port
    await new Promise<void>((r) => free.close(() => r()))
    expect(await mcpSignInOffered(`http://127.0.0.1:${port}/mcp`)).toBeUndefined()
  })

  it('marks the server, keeps the mark on an unchanged save and drops the sign-in when the URL changes', async () => {
    const s = await addRemote()
    expect(s.signIn).toBe(true)
    expect(mcpServerViews(dir)[0]).toMatchObject({ signIn: true, signedIn: false })
    await signedIn(s.id)
    expect(mcpServerViews(dir)[0].signedIn).toBe(true)
    saveMcpServer({ id: s.id, name: 'tracker', url: mock.url, secrets: [] }, dir, [])
    expect(mcpServerViews(dir)[0]).toMatchObject({ signIn: true, signedIn: true })
    saveMcpServer({ id: s.id, name: 'tracker', url: `${mock.base}/other`, secrets: [] }, dir, [])
    expect(mcpServerViews(dir)[0]).toMatchObject({ signedIn: false })
    expect(mcpServerViews(dir)[0].signIn).toBeUndefined()
    expect(getMcpOAuth(s.id, dir)).toBeUndefined()
  })
})

describe('Sign in', () => {
  it('runs discovery, dynamic registration and PKCE with the resource, state and the scope the server asks for', async () => {
    const s = await addRemote()
    opened.length = 0
    await signedIn(s.id)
    const paths = mock.log.map((l) => l.path)
    expect(paths).toContain('prm')
    expect(paths).toContain('as-metadata')
    const reg = mock.log.find((l) => l.path === 'register')!
    expect(reg.client_name).toBe('Genio')
    expect(reg.redirect_uris).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)])
    const authz = mock.log.find((l) => l.path === 'authorize')!
    expect(authz).toMatchObject({ ok: true, pkce: 'S256', resource: mock.url, scope: 'recon', redirect: (reg.redirect_uris as string[])[0] })
    expect(String(authz.state)).toMatch(/^[\w-]{40,}$/)
    expect(grants('authorization_code')).toEqual([expect.objectContaining({ pkceOk: true, resource: mock.url, ok: true })])
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]).origin).toBe(mock.base)
    expect(mcpServerViews(dir)[0].signedIn).toBe(true)
  })

  it('refuses a callback with the wrong state and goes on waiting for the right one', async () => {
    const s = await addRemote()
    const statuses: number[] = []
    const r = await mcpSignIn(s.id, dir, {
      open: browser({
        before: async (cb) => {
          const forged = new URL(cb)
          forged.searchParams.set('state', 'forged')
          statuses.push((await fetch(forged)).status)
          const none = new URL(cb)
          none.searchParams.delete('state')
          statuses.push((await fetch(none)).status)
          statuses.push((await fetch(new URL('/other', cb))).status)
        }
      })
    })
    expect(statuses).toEqual([400, 400, 404])
    expect(r).toBe('signed-in')
  })

  it('listens for the callback on loopback only', async () => {
    const s = await addRemote()
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    let tried = false
    await mcpSignIn(s.id, dir, {
      open: browser({
        before: async (cb) => {
          expect(cb.hostname).toBe('127.0.0.1')
          if (!lan) return
          tried = true
          const reached = await new Promise<boolean>((resolve) => {
            const sock = net.connect({ host: lan, port: Number(cb.port) }, () => { sock.destroy(); resolve(true) })
            sock.on('error', () => resolve(false))
            sock.setTimeout(2000, () => { sock.destroy(); resolve(false) })
          })
          expect(reached).toBe(false)
        }
      })
    })
    if (lan) expect(tried).toBe(true)
  })

  it('registers again at each sign-in, because the callback port changes', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    await signedIn(s.id)
    const regs = mock.log.filter((l) => l.path === 'register')
    expect(regs).toHaveLength(2)
    expect(regs[0].client_id).not.toBe(regs[1].client_id)
  })

  it('ends as cancelled when the player declines, signs out meanwhile or never comes back', async () => {
    const s = await addRemote()
    expect(await mcpSignIn(s.id, dir, {
      open: async (url) => {
        const cb = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!)
        cb.searchParams.delete('code')
        cb.searchParams.set('error', 'access_denied')
        await fetch(cb)
      }
    })).toBe('cancelled')
    const waiting = mcpSignIn(s.id, dir, { open: () => undefined })
    await new Promise((r) => setTimeout(r, 100))
    mcpSignOut(s.id, dir)
    expect(await waiting).toBe('cancelled')
    expect(await mcpSignIn(s.id, dir, { open: () => undefined, timeoutMs: 50 })).toBe('cancelled')
    expect(mcpServerViews(dir)[0].signedIn).toBe(false)
  })

  it('is only for a server that asks for it', async () => {
    saveMcpServer({ name: 'plain', url: 'https://example.invalid/mcp', secrets: [] }, dir, [])
    await expect(mcpSignIn(readMcpServers(dir)[0].id, dir, { open: browser() })).rejects.toThrow(/does not ask for a sign-in/)
  })
})

describe('main as the only refresher', () => {
  it('turns five simultaneous 401s into one refresh, and every caller gets the new token', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    const old = (await mcpAccessToken(s.id, dir))!
    mock.expire()
    const got = await Promise.all(Array.from({ length: 5 }, () => mcpTokenRefused(s.id, old, dir)))
    expect(grants('refresh_token')).toEqual([expect.objectContaining({ ok: true, resource: mock.url })])
    expect(new Set(got).size).toBe(1)
    expect(got[0]).not.toBe(old)
    // A late caller with the old token gets the new one without another refresh.
    expect(await mcpTokenRefused(s.id, old, dir)).toBe(got[0])
    expect(grants('refresh_token')).toHaveLength(1)
  })

  it('five units calling through the gateway after expiry share one refresh', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    const units = await Promise.all(Array.from({ length: 5 }, async () => {
      const r = relay('tracker', (await gateway.grant(caller(), [s])).env)
      expect((await r.init()).result).toBeDefined()
      return r
    }))
    mock.expire()
    const results = await Promise.all(units.map((r, i) => r.call(`unit ${i}`)))
    expect(results.map((r) => r.result?.content?.[0].text)).toEqual([0, 1, 2, 3, 4].map((i) => `OAUTH-OK: unit ${i}`))
    expect(grants('refresh_token')).toHaveLength(1)
  })

  it('refreshes a token about to expire before it is used', async () => {
    await mock.close()
    mock = await startOAuthServer({ ttl: 30 })
    const s = await addRemote()
    await signedIn(s.id)
    const stored = getMcpOAuth<{ tokens: { access_token: string } }>(s.id, dir)!.tokens.access_token
    const t = await mcpAccessToken(s.id, dir)
    expect(t).not.toBe(stored)
    expect(grants('refresh_token')).toHaveLength(1)
  })

  it('keeps the sign-in when the refresh cannot reach the server', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    const old = (await mcpAccessToken(s.id, dir))!
    await expect(mcpTokenRefused(s.id, old, dir, async () => { throw new TypeError('fetch failed') })).rejects.toThrow('fetch failed')
    expect(mcpServerViews(dir)[0].signedIn).toBe(true)
  })
})

describe('the gateway with a signed-in server', () => {
  it('adds the access token to remote calls; the unit never sees it', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    // Before this, only the unauthenticated checks of the save and the sign-in reached /mcp.
    const from = mock.log.length
    const r = relay('tracker', (await gateway.grant(caller(), [s])).env)
    await r.init()
    expect((await r.call('hello')).result?.content?.[0].text).toBe('OAUTH-OK: hello')
    const calls = mock.log.slice(from).filter((l) => l.path === 'mcp')
    expect(calls.map((l) => l.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    expect(calls.every((l) => l.ok)).toBe(true)
  })

  it('a revoked sign-in gives one clear stop: one failed refresh, Sign in again, and no further traffic', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    const r = relay('tracker', (await gateway.grant(caller(), [s])).env)
    await r.init()
    expect((await r.call('before')).result?.isError).toBeFalsy()
    mock.revoke()
    const first = await r.call('after')
    expect(first.result?.isError).toBe(true)
    const text = first.result!.content![0].text
    expect(text).toContain('tracker needs the player to sign in to it again in Settings')
    expect(text).toContain('Do not retry this server: append needs-decision [key=mcp-auth] naming tracker, then stop.')
    expect(grants('refresh_token')).toEqual([expect.objectContaining({ ok: false })])
    expect(mcpServerViews(dir)[0]).toMatchObject({ signIn: true, signedIn: false })

    const seen = mock.log.length
    const second = await r.call('again')
    expect(second.result?.content?.[0].text).toBe(text)
    expect(mock.log.length).toBe(seen)
    expect(failures).toEqual(['MCP server tracker: echo failed (sign-in needed).'])

    // Signing in again brings the running unit's tools back.
    await signedIn(s.id)
    expect((await r.call('back')).result?.content?.[0].text).toBe('OAUTH-OK: back')
  })

  it('a server not signed in yet, or signed out, answers sign-in needed without being called', async () => {
    const s = await addRemote()
    const seen = mock.log.length
    const r = relay('tracker', (await gateway.grant(caller(), [s])).env)
    expect((await r.init()).error?.message).toContain('needs-decision [key=mcp-auth]')
    expect(mock.log.length).toBe(seen)

    await signedIn(s.id)
    const r2 = relay('tracker', (await gateway.grant(caller(), [s])).env)
    await r2.init()
    mcpSignOut(s.id, dir)
    const before = mock.log.length
    expect((await r2.call('x')).result?.content?.[0].text).toContain('sign in to it again')
    expect(mock.log.length).toBe(before)
  })

  it('removing the server deletes its sign-in', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    removeMcpServer(s.id, dir)
    expect(getMcpOAuth(s.id, dir)).toBeUndefined()
  })
})

describe('tokens stay in main', () => {
  it('never appear in the call log, the timeline, what the unit reads, the list file, the console or the store in clear', async () => {
    const s = await addRemote()
    await signedIn(s.id)
    const r = relay('tracker', (await gateway.grant(caller(), [s])).env)
    await r.init()
    await r.call('one')
    mock.expire()
    await r.call('two')
    mock.revoke()
    await r.call('three')
    expect(mock.issued.length).toBeGreaterThanOrEqual(4)
    const places = {
      callLog: fs.readFileSync(path.join(dir, 'u1', 'mcp-calls.jsonl'), 'utf8'),
      timeline: failures.join('\n'),
      unit: toUnit.join('\n'),
      list: fs.readFileSync(path.join(dir, 'mcp-servers.json'), 'utf8'),
      views: JSON.stringify(mcpServerViews(dir)),
      console: consoleOut.join('\n'),
      store: fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')
    }
    for (const [where, text] of Object.entries(places)) for (const t of mock.issued) expect(text.includes(t), `${where} holds a token`).toBe(false)
  })
})
