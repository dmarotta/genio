import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fake OS-backed encryption: reversible, but never stores the plain text.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (s: string) => Buffer.from('enc:' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b.toString('utf8').slice(4), 'hex').toString('utf8')
  }
}))

import { joinArgs, mcpServerProblem, mcpServersFor, splitArgs, type McpServerInput } from '../src/shared/mcp'
import { mcpServerViews, readMcpServers, removeMcpServer, saveMcpServer } from '../src/main/mcp-servers'
import { getMcpSecret, getSecret, secretStatus, setSecret } from '../src/main/secrets'
import { mcpBriefLines, renderBrief } from '../src/main/brief'

const TOKEN = 'lin_api_SECRET_value_0123456789'
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-mcp-list-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const local = (o: Partial<McpServerInput> = {}): McpServerInput => ({ name: 'linear', command: 'npx', args: ['-y', 'linear-mcp'], secrets: [{ name: 'LINEAR_TOKEN', value: TOKEN }], ...o })
const files = (): string => fs.readdirSync(dir).filter((f) => f !== 'secrets.json').map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')

describe('the Settings list', () => {
  it('adds a server, keeps its secret only in the encrypted store and shows only that it is set', () => {
    const views = saveMcpServer(local(), dir, ['alpha'])
    expect(views).toEqual([expect.objectContaining({ name: 'linear', command: 'npx', args: ['-y', 'linear-mcp'], secrets: ['LINEAR_TOKEN'], secretSet: { LINEAR_TOKEN: true } })])
    expect(views[0].project).toBeUndefined()
    expect(JSON.stringify(views)).not.toContain(TOKEN)
    expect(files()).not.toContain(TOKEN)
    expect(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')).not.toContain(TOKEN)
    expect(getMcpSecret(views[0].id, 'LINEAR_TOKEN', dir)).toBe(TOKEN)
    // The service keys are untouched and the renderer's key list does not grow.
    expect(secretStatus(dir).map((s) => s.id)).toEqual(['fal', 'openrouter', 'uthana'])
  })

  it('edits a server: an empty value keeps the secret, a new value replaces it, a dropped or renamed name deletes it', () => {
    const [s] = saveMcpServer(local({ secrets: [{ name: 'LINEAR_TOKEN', value: TOKEN }, { name: 'OTHER', value: 'other-secret-value' }] }), dir, [])
    let [v] = saveMcpServer({ ...local(), id: s.id, args: ['linear-mcp@2'], secrets: [{ name: 'LINEAR_TOKEN' }, { name: 'RENAMED' }] }, dir, [])
    expect(v).toMatchObject({ id: s.id, args: ['linear-mcp@2'], secrets: ['LINEAR_TOKEN', 'RENAMED'], secretSet: { LINEAR_TOKEN: true, RENAMED: false } })
    expect(getMcpSecret(s.id, 'LINEAR_TOKEN', dir)).toBe(TOKEN)
    expect(getMcpSecret(s.id, 'OTHER', dir)).toBeUndefined()
    ;[v] = saveMcpServer({ ...local(), id: s.id, secrets: [{ name: 'LINEAR_TOKEN', value: 'new-token-value' }] }, dir, [])
    expect(getMcpSecret(s.id, 'LINEAR_TOKEN', dir)).toBe('new-token-value')
    // A switch to a remote server asks for its header values again.
    ;[v] = saveMcpServer({ id: s.id, name: 'linear', url: 'https://mcp.example.com/mcp', secrets: [{ name: 'Authorization' }] }, dir, [])
    expect(v).toMatchObject({ url: 'https://mcp.example.com/mcp', secretSet: { Authorization: false } })
    expect(v.command).toBeUndefined()
    expect(getMcpSecret(s.id, 'LINEAR_TOKEN', dir)).toBeUndefined()
  })

  it('removes a server with its secrets and leaves the service keys alone', () => {
    setSecret('fal', 'fal-key-0000-1111-2222', dir)
    const [a] = saveMcpServer(local(), dir, [])
    saveMcpServer(local({ name: 'sentry', secrets: [] }), dir, [])
    expect(removeMcpServer(a.id, dir).map((s) => s.name)).toEqual(['sentry'])
    expect(getMcpSecret(a.id, 'LINEAR_TOKEN', dir)).toBeUndefined()
    expect(getSecret('fal', dir)).toBe('fal-key-0000-1111-2222')
    expect(removeMcpServer('missing', dir).map((s) => s.name)).toEqual(['sentry'])
  })

  it('scopes a server to one project or all of them', () => {
    saveMcpServer(local({ name: 'everywhere' }), dir, ['alpha', 'beta'])
    saveMcpServer(local({ name: 'alpha-only', project: 'alpha' }), dir, ['alpha', 'beta'])
    expect(() => saveMcpServer(local({ name: 'ghost', project: 'gamma' }), dir, ['alpha'])).toThrow('There is no project called "gamma".')
    const list = readMcpServers(dir)
    expect(mcpServersFor(list, 'alpha').map((s) => s.name)).toEqual(['everywhere', 'alpha-only'])
    expect(mcpServersFor(list, 'beta').map((s) => s.name)).toEqual(['everywhere'])
  })

  it('refuses what a unit or Codex could not use, in plain words', () => {
    const p = (o: Partial<McpServerInput>, others = [{ id: 'x', name: 'linear' }]) => mcpServerProblem(local(o), others, [])
    expect(p({ name: '' })).toMatch(/name/)
    expect(p({ name: 'Linear' })).toMatch(/lower-case/)
    expect(p({ name: 'dot.name' })).toMatch(/lower-case/)
    expect(p({ name: 'genio' })).toMatch(/reserved/)
    expect(p({ name: 'linear' })).toMatch(/already called/)
    expect(p({ name: 'my_srv' }, [{ id: 'x', name: 'my-srv' }])).toMatch(/lower-case/)
    expect(p({ name: 'a'.repeat(33) })).toMatch(/32/)
    expect(p({ name: 'ok', url: 'https://x.example/mcp' })).toMatch(/either a command or a URL/)
    expect(p({ name: 'ok', command: '', url: '' })).toMatch(/either a command or a URL/)
    expect(p({ name: 'ok', command: undefined, url: 'http://mcp.example.com/mcp', secrets: [] })).toMatch(/https/)
    expect(p({ name: 'ok', command: undefined, url: 'http://127.0.0.1:3845/mcp', secrets: [] })).toBeUndefined()
    expect(p({ name: 'ok', command: undefined, url: 'https://u:p@x.example/mcp', secrets: [] })).toMatch(/credentials/)
    expect(p({ name: 'ok', secrets: [{ name: 'BAD-NAME', value: 'v' }] })).toMatch(/environment variable/)
    expect(p({ name: 'ok', command: undefined, url: 'https://x.example/mcp', secrets: [{ name: 'Bad Header' }] })).toMatch(/header/)
    expect(p({ name: 'ok', secrets: [{ name: 'A' }, { name: 'a' }] })).toMatch(/twice/)
    expect(p({ name: 'ok', secrets: [{ name: 'A', value: 'two\nlines' }] })).toMatch(/one line/)
    expect(p({ name: 'ok', args: ['a\nb'] })).toMatch(/one line/)
    expect(p({ name: 'ok' })).toBeUndefined()
    expect(() => saveMcpServer(local({ name: 'genio' }), dir, [])).toThrow(/reserved/)
    expect(fs.existsSync(path.join(dir, 'mcp-servers.json'))).toBe(false)
  })

  it('drops a hand-edited entry that no longer validates', () => {
    fs.writeFileSync(path.join(dir, 'mcp-servers.json'), JSON.stringify([
      { id: 'a1', name: 'fine', command: 'node', args: ['s.mjs'], secrets: [] },
      { id: 'a2', name: 'Bad Name', command: 'node', secrets: [] },
      { id: 'a3', name: 'both', command: 'node', url: 'https://x.example', secrets: [] },
      { id: '../x', name: 'path', command: 'node', secrets: [] }
    ]))
    expect(mcpServerViews(dir).map((s) => s.name)).toEqual(['fine'])
  })

  it('reads arguments the way they are typed', () => {
    expect(splitArgs('-y  "C:\\My Tools\\srv.js" --flag=1 ""')).toEqual(['-y', 'C:\\My Tools\\srv.js', '--flag=1', ''])
    expect(joinArgs(['-y', 'C:\\My Tools\\srv.js', ''])).toBe('-y "C:\\My Tools\\srv.js" ""')
    expect(splitArgs(joinArgs(['a b', 'c']))).toEqual(['a b', 'c'])
  })
})

describe('the brief', () => {
  it('names the servers, never a secret, and only when there are some', () => {
    expect(mcpBriefLines([])).toEqual([])
    const brief = renderBrief({ taskId: 'u1', kind: 'ship', project: 'p', worktree: 'W', branch: 'b', baseBranch: 'main', intent: 'x', statusFile: 'S', inboxDir: 'I', taskDataDir: 'D', mcpServers: ['linear', 'sentry'] })
    expect(brief).toMatch(/# Tools\n\n- MCP servers the player added in Settings: `linear`, `sentry`\./)
    expect(brief).toContain('never to spend money')
    expect(brief).toContain('needs-decision [key=mcp-auth]')
    expect(renderBrief({ taskId: 'u1', kind: 'ship', project: 'p', worktree: 'W', branch: 'b', baseBranch: 'main', intent: 'x', statusFile: 'S', inboxDir: 'I', taskDataDir: 'D' })).not.toContain('MCP')
  })
})
