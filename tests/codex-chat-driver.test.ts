import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_CHAT_DISABLED, CodexChatDriver, codexEffort, type CodexWireEvents, type CodexRpc } from '../src/main/codex-chat-driver'
import type { ChatDriverEvents } from '../src/main/chat-driver'

import { FakeAppServer, MODEL } from './helpers/fake-codex-server'

const drivers: CodexChatDriver[] = []
afterEach(() => { drivers.splice(0).forEach(d => d.stop()) })
function fixture() {
  const server = new FakeAppServer()
  const hooks: ChatDriverEvents = { onMessage: vi.fn(), onDelta: vi.fn(), onActivity: vi.fn(), onTurnEnd: vi.fn(), onSessionId: vi.fn(),
    onError: vi.fn(), onLimit: vi.fn(), onRequeue: vi.fn() }
  const call = vi.fn(async (_name: string, _args: unknown): Promise<any> => ({ content: [{ type: 'text', text: 'done' }] }))
  const unavailable = vi.fn(), usage = vi.fn(), rateLimits = vi.fn(), approve = vi.fn(async () => false)
  const driver = new CodexChatDriver({ wksp: 'main', cwd: process.cwd(), config: () => ({ model: 'gpt-test', effort: 'ultra' }),
    instructions: () => 'Genio contract', approve, usage, rateLimits, unavailable,
    wire: events => { server.events = events; return server },
    bridge: async () => ({ list: async () => [{ name: 'deploy', description: 'Deploy a unit', inputSchema: { type: 'object' } }], call, close: async () => {} })
  }, hooks)
  drivers.push(driver)
  const start = async () => { driver.send({ kind: 'player', prompt: 'hello', msgId: 'p1' }); await vi.waitFor(() => expect(server.turn).toBe(1)) }
  return { driver, server, hooks, call, unavailable, usage, rateLimits, approve, start }
}

describe('Codex chat release gates', () => {
  it('maps recognized bridge consent forms to permission approve/deny and rejects external elicitation', async () => {
    const f = fixture(); await f.start()
    const params = { threadId: 'thread-1', serverName: 'genio', mode: 'form', message: 'Approve this tool?',
      requestedSchema: { properties: { approved: { type: 'boolean' } } } }
    expect(await f.server.events.request('mcpServer/elicitation/request', params)).toEqual({ action: 'decline', content: null })
    f.approve.mockResolvedValueOnce(true)
    expect(await f.server.events.request('mcpServer/elicitation/request', params)).toEqual({ action: 'accept', content: { approved: true } })
    expect(await f.server.events.request('mcpServer/elicitation/request', { ...params, serverName: 'global-plugin' })).toEqual({ action: 'decline', content: null })
    expect(f.approve).toHaveBeenCalledTimes(2)
  })
  it('initializes, confines native tools, disables inherited MCP and excludes ultra', async () => {
    const f = fixture(); await f.start()
    const start = f.server.sent.find(r => r.method === 'thread/start')!.params
    expect(start).toMatchObject({ modelProvider: 'openai', allowProviderModelFallback: false, sandbox: 'read-only',
      approvalPolicy: 'untrusted', approvalsReviewer: 'user', environments: [], selectedCapabilityRoots: [],
      config: { 'mcp_servers.global.enabled': false, model_reasoning_effort: 'high', forced_login_method: 'chatgpt' } })
    expect(start.dynamicTools[0].name).toBe('genio_deploy')
    expect(f.server.sent.find(r => r.method === 'turn/start')!.params.effort).toBe('high')
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
      expect(await f.server.events.request(method, {})).toEqual({ decision: 'decline' })
    }
    expect(await f.server.events.request('item/permissions/requestApproval', {})).toEqual({ permissions: {}, scope: 'turn' })
    for (const tool of ['exec_command', 'apply_patch', 'spawn_agent', 'mcp__genio__deploy', 'unknown']) await expect(f.server.call(tool)).rejects.toThrow()
    expect(f.call).not.toHaveBeenCalled()
  })
  it('refuses a runtime with a native capability enabled before starting any thread', async () => {
    const f = fixture(); f.server.features.multi_agent = true
    f.driver.send({ kind: 'player', prompt: 'test' })
    await vi.waitFor(() => expect(f.unavailable).toHaveBeenCalled())
    expect(f.server.sent.some(r => r.method === 'thread/start')).toBe(false)
    expect(f.driver.queued).toBe(1)
  })
  it('refuses API-key or missing login; retains queue with one notice and no fallback', async () => {
    const f = fixture(); f.server.account = { type: 'apiKey' }
    f.driver.send({ kind: 'player', prompt: 'draft', msgId: 'draft' })
    await vi.waitFor(() => expect(f.hooks.onError).toHaveBeenCalledOnce())
    f.driver.send({ kind: 'player', prompt: 'next' })
    expect(f.driver.queued).toBe(2)
    expect(f.server.turn).toBe(0)
    expect(f.driver.cancel('draft')?.prompt).toBe('draft')
    expect(f.hooks.onError).toHaveBeenCalledOnce()
  })
  it('streams text, tool errors and plan usage without cash charges', async () => {
    const f = fixture(); await f.start()
    f.server.emit('item/agentMessage/delta', { itemId: 'a1', delta: 'Hello' })
    f.server.emit('item/completed', { item: { id: 'a1', type: 'agentMessage', text: 'Hello' } })
    f.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Permission denied' }] })
    expect(await f.server.call('genio_deploy')).toEqual({ success: false, contentItems: [{ type: 'inputText', text: 'Permission denied' }] })
    f.server.emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 12, outputTokens: 3 } } })
    f.server.finish()
    expect(f.hooks.onDelta).toHaveBeenCalledWith('codex-a1', 'Hello')
    expect(f.hooks.onMessage).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Hello', partial: false }), true)
    expect(f.hooks.onTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }), true, 'Hello', 0)
    expect(f.usage).toHaveBeenCalledWith('thread-1', { total: { inputTokens: 12, outputTokens: 3 } })
  })
  it('does not duplicate mutations on duplicate requests, interruption or resume', async () => {
    const f = fixture(); await f.start()
    await Promise.all([f.server.call('genio_deploy'), f.server.call('genio_deploy')])
    expect(f.call).toHaveBeenCalledOnce()
    await f.driver.interrupt()
    await expect(f.server.call('genio_deploy')).rejects.toThrow()
    f.driver.resume()
    f.driver.send({ kind: 'player', prompt: 'new request' })
    await vi.waitFor(() => expect(f.server.turn).toBe(2))
    expect(f.server.sent.filter(r => r.method === 'turn/start').map(r => r.params.input[0].text)).toEqual(['hello', 'new request'])
    expect(f.server.sent.some(r => r.method === 'thread/resume' && r.params.threadId === 'thread-1')).toBe(true)
    expect(f.call).toHaveBeenCalledOnce()
  })
  it('pauses pending work on account limits and never replays an active uncertain turn', async () => {
    const f = fixture(); await f.start()
    await f.server.call('genio_deploy')
    f.driver.send({ kind: 'player', prompt: 'queued' })
    f.server.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100 } } })
    expect(f.driver.queued).toBe(1)
    expect(f.rateLimits).toHaveBeenCalled()
    f.driver.resume()
    await vi.waitFor(() => expect(f.server.turn).toBe(2))
    expect(f.server.sent.filter(r => r.method === 'turn/start').map(r => r.params.input[0].text)).toEqual(['hello', 'queued'])
    expect(f.call).toHaveBeenCalledOnce()
  })
  it('never requeues a turn/start whose reply was lost after execution began', async () => {
    const f = fixture()
    const request = f.server.request.bind(f.server)
    f.server.request = async (method, params) => {
      const result = await request(method, params)
      if (method === 'turn/start') { await f.server.call('genio_deploy'); throw new Error('Reply lost') }
      return result
    }
    f.driver.send({ kind: 'player', prompt: 'mutate' })
    await vi.waitFor(() => expect(f.hooks.onError).toHaveBeenCalled())
    expect(f.driver.queued).toBe(0)
    f.driver.resume()
    expect(f.call).toHaveBeenCalledOnce()
    expect(f.server.sent.filter(r => r.method === 'turn/start')).toHaveLength(1)
  })
  it('a cancelled startup cannot submit its old prompt into a replacement connection', async () => {
    const f = fixture()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const request = f.server.request.bind(f.server)
    let first = true
    f.server.request = async (method, params) => {
      if (method === 'initialize' && first) { first = false; await hold }
      return request(method, params)
    }
    f.driver.send({ kind: 'player', prompt: 'cancelled' })
    await f.driver.interrupt()
    f.driver.send({ kind: 'player', prompt: 'new' })
    release()
    await vi.waitFor(() => expect(f.server.turn).toBe(1))
    expect(f.server.sent.find(r => r.method === 'turn/start')!.params.input[0].text).toBe('new')
    expect(f.hooks.onError).not.toHaveBeenCalled()
  })
  it('sends images through the documented app-server input shape', async () => {
    const f = fixture()
    f.driver.send({ kind: 'player', prompt: 'image', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] })
    await vi.waitFor(() => expect(f.server.turn).toBe(1))
    expect(f.server.sent.find(r => r.method === 'turn/start')!.params.input[1]).toEqual({ type: 'image', url: 'data:image/png;base64,aGVsbG8=' })
  })
  it('explains unsupported images and preserves the unsent turn', async () => {
    const f = fixture(); f.server.model = { ...MODEL, inputModalities: ['text'] }
    f.driver.send({ kind: 'player', prompt: 'image', images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] })
    await vi.waitFor(() => expect(f.hooks.onError).toHaveBeenCalledWith(expect.stringContaining('does not support the attached images')))
    expect(f.server.turn).toBe(0); expect(f.driver.queued).toBe(1)
  })
})
it('resets unsupported efforts to the model default and never selects ultra', () => {
  expect(codexEffort(MODEL, 'max')).toBe('high')
  expect(codexEffort({ ...MODEL, defaultReasoningEffort: 'ultra' }, 'ultra')).toBe('low')
})
